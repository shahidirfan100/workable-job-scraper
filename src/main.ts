import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter } from 'crawlee';

await Actor.init();

interface InputSchema {
    keyword: string;
    location?: string;
    postedDate?: '24h' | '7d' | '30d' | 'anytime';
    resultsWanted: number;
}

const input = (await Actor.getInput<InputSchema>()) || { keyword: 'developer', resultsWanted: 10 };

let searchUrl = `https://jobs.workable.com/search?query=${encodeURIComponent(input.keyword)}`;
if (input.location) {
    searchUrl += `&location=${encodeURIComponent(input.location)}`;
}
if (input.postedDate && input.postedDate !== 'anytime') {
    if (input.postedDate === '24h') {
        searchUrl += '&day_range=1';
    } else if (input.postedDate === '7d') {
        searchUrl += '&day_range=7';
    } else if (input.postedDate === '30d') {
        searchUrl += '&day_range=30';
    }
}

let collectedJobs = 0;
const maxJobs = input.resultsWanted;

const router = createPlaywrightRouter();

// LIST handler: Simplified to only find job links and enqueue them.
router.addHandler('LIST', async ({ page, log, crawler }) => {
    log.info(`Processing list page: ${page.url()}`);
    
    const jobItemSelector = 'li[data-ui="job"] a';
    try {
        log.info(`Waiting for job links to appear using selector: ${jobItemSelector}`);
        await page.waitForSelector(jobItemSelector, { timeout: 45000 });
        log.info('Job links found. Extracting URLs...');
    } catch (error) {
        const html = await page.content();
        await Actor.setValue('DEBUG-LIST-FAILURE.html', html, { contentType: 'text/html' });
        log.warning(`Could not find job links on page: ${page.url()}. Saved HTML for debugging.`);
        return;
    }

    const jobsOnPage = await page.evaluate((selector) => {
        const jobLinks = document.querySelectorAll(selector);
        const jobs = [];
        for (const link of jobLinks) {
            const title = link.textContent?.trim() || '';
            const url = (link as HTMLAnchorElement).href || '';
            if (title && url) {
                jobs.push({ title, url });
            }
        }
        return jobs;
    }, jobItemSelector);

    log.info(`Found ${jobsOnPage.length} job links on the page.`);

    for (const job of jobsOnPage) {
        if (collectedJobs < maxJobs) {
            await crawler.addRequests([{ url: job.url, label: 'DETAIL', userData: { title: job.title } }]);
            collectedJobs++;
        }
    }

    if (collectedJobs < maxJobs) {
        const nextPageLink = await page.$eval('a[data-ui="next-page"]', el => (el as HTMLAnchorElement).href).catch(() => null);
        if (nextPageLink) {
            const absoluteNextPageLink = new URL(nextPageLink, page.url()).href;
            log.info(`Found next page, adding to queue: ${absoluteNextPageLink}`);
            await crawler.addRequests([{ url: absoluteNextPageLink, label: 'LIST' }]);
        } else {
            log.info('No more pages to process.');
        }
    }
});

// DETAIL handler: Responsible for extracting all job details.
router.addHandler('DETAIL', async ({ request, page, log }) => {
    const { title } = request.userData;
    log.info(`Processing job detail page: ${title}`);

    try {
        // Wait for the main content to be available
        await page.waitForSelector('main[class*="job-view-styles__main"]', { timeout: 60000 });

        // Handle cookie banner
        try {
            await page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', { timeout: 5000 });
            log.info('Accepted cookie banner.');
        } catch (e) {
            log.info('Cookie banner not found or could not be clicked, continuing...');
        }

        const company = await page.evaluate(() => {
            const el = document.querySelector('a[data-ui="company-name"]');
            return el?.textContent?.trim() || 'Company not found';
        });

        const jobPostedDate = await page.evaluate(() => {
            const el = document.querySelector('time');
            return el?.textContent?.trim() || 'Job posted date not found';
        });

        const jobDescriptionHTML = await page.evaluate(() => {
            const el = document.querySelector('div[class*="job-view-styles__description"]');
            return el?.innerHTML || '';
        });
        
        const jobDescriptionText = await page.evaluate(() => {
            const el = document.querySelector('div[class*="job-view-styles__description"]');
            return el?.textContent?.trim() || 'Description not found';
        });

        // New robust logic for location, job type, and workplace type
        const details = await page.evaluate(() => {
            const result = {
                location: 'Location not found',
                jobType: 'Job type not found',
                workplaceType: 'Workplace type not found',
            };
            
            // These details are usually in a list. Let's find the container.
            // The container seems to be a 'ul' that is a sibling of the h1 title's container.
            const titleElement = document.querySelector('h1');
            const detailsContainer = titleElement?.closest('div')?.nextElementSibling;

            if (detailsContainer) {
                const detailItems = detailsContainer.querySelectorAll('li');
                for (const item of detailItems) {
                    const text = item.textContent?.trim() || '';
                    if (/(full-time|part-time|contract)/i.test(text)) {
                        result.jobType = text;
                    } else if (/(on-site|hybrid|remote)/i.test(text)) {
                        result.workplaceType = text;
                    } else if (text) { // Assume the remaining item is location
                        result.location = text;
                    }
                }
            }
            return result;
        });

        await Dataset.pushData({
            jobTitle: title,
            company,
            location: details.location,
            jobType: details.jobType,
            workplaceType: details.workplaceType,
            jobPostedDate,
            jobDescriptionHTML,
            jobDescriptionText,
            jobLink: request.url,
        });
        log.info(`Successfully scraped job: ${title}`);

    } catch (error: any) {
        log.error(`Failed to process page ${request.url}: ${error.message}`);
        await Actor.pushData({ "failed_url": request.url, "error": error.message });
    }
});

const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxRequestsPerCrawl: maxJobs + 100,
    requestHandlerTimeoutSecs: 120,
    failedRequestHandler({ request, log }) {
        log.error(`Request ${request.url} failed too many times.`);
    },
});

await crawler.run([{ url: searchUrl, label: 'LIST' }]);

console.log(`Scraping completed. Collected ${collectedJobs} job listings.`);

await Actor.exit();
