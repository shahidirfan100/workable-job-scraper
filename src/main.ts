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
    
    const jobCardSelector = 'li.whr-item';
    try {
        log.info(`Waiting for job cards to appear using selector: ${jobCardSelector}`);
        await page.waitForSelector(jobCardSelector, { timeout: 45000 });
        log.info('Job cards found. Extracting data...');
    } catch (error) {
        const html = await page.content();
        await Actor.setValue('DEBUG-LIST-FAILURE.html', html, { contentType: 'text/html' });
        log.warning(`Could not find job cards on page: ${page.url()}. Saved HTML for debugging.`);
        return;
    }

    const jobsOnPage = await page.evaluate((selector) => {
        const jobCards = document.querySelectorAll(selector);
        const jobs = [];
        for (const card of jobCards) {
            const linkElement = card.querySelector('h3.whr-title a') as HTMLAnchorElement;
            if (linkElement) {
                const title = linkElement.textContent?.trim() || '';
                const url = linkElement.href || '';
                if (title && url) {
                    jobs.push({ title, url });
                }
            }
        }
        return jobs;
    }, jobCardSelector);

    log.info(`Found ${jobsOnPage.length} job links on the page.`);

    for (const job of jobsOnPage) {
        if (collectedJobs < maxJobs) {
            await crawler.addRequests([{ url: job.url, label: 'DETAIL', userData: { title: job.title } }]);
            collectedJobs++;
        }
    }

    if (collectedJobs < maxJobs) {
        const nextPageLink = await page.$eval('button[aria-label="Next page"]', el => el.closest('a')?.href).catch(() => null);
        if (nextPageLink) {
            log.info(`Found next page, adding to queue: ${nextPageLink}`);
            await crawler.addRequests([{ url: nextPageLink, label: 'LIST' }]);
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
        // Wait for the main content to be available by waiting for the title
        await page.waitForSelector('h1', { timeout: 60000 });

        // Handle cookie banner
        try {
            await page.click('button:has-text("Accept all cookies")', { timeout: 5000 });
            log.info('Accepted cookie banner.');
        } catch (e) {
            log.info('Cookie banner not found or could not be clicked, continuing...');
        }

        const company = await page.evaluate(() => {
            const el = document.querySelector('[data-ui="company-name"]');
            return el?.textContent?.trim() || 'Company not found';
        });

        const jobPostedDate = await page.evaluate(() => {
            const el = document.querySelector('time, .whr-date');
            return el?.textContent?.trim() || 'Job posted date not found';
        });

        const jobDescriptionHTML = await page.evaluate(() => {
            const el = document.querySelector('.job-description, div#description');
            return el?.innerHTML || '';
        });
        
        const jobDescriptionText = await page.evaluate(() => {
            const el = document.querySelector('.job-description, div#description');
            return el?.textContent?.trim() || 'Description not found';
        });

        // New robust logic for location, job type, and workplace type
        const details = await page.evaluate(() => {
            const result = {
                location: 'Location not found',
                jobType: 'Job type not found',
                workplaceType: 'Workplace type not found',
            };
            
            const locationElement = document.querySelector('[data-ui="job-location"]');
            if(locationElement) result.location = locationElement.textContent?.trim() || 'Location not found';

            const jobTypeElement = document.querySelector('[data-ui="job-type"]');
            if(jobTypeElement) result.jobType = jobTypeElement.textContent?.trim() || 'Job type not found';

            const workplaceTypeElement = document.querySelector('[data-ui="workplace-type"]');
            if(workplaceTypeElement) result.workplaceType = workplaceTypeElement.textContent?.trim() || 'Workplace type not found';

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
    navigationTimeoutSecs: 120, // Increased navigation timeout
    preNavigationHooks: [
        async ({ page }) => {
            // Block images, fonts, and CSS to speed up loading
            await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', (route) => route.abort());
        },
    ],
    maxRequestsPerCrawl: maxJobs + 100,
    requestHandlerTimeoutSecs: 120,
    failedRequestHandler({ request, log }) {
        log.error(`Request ${request.url} failed too many times.`);
    },
});

await crawler.run([{ url: searchUrl, label: 'LIST' }]);

console.log(`Scraping completed. Collected ${collectedJobs} job listings.`);

await Actor.exit();