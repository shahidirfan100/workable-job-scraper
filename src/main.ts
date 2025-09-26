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
    
    const jobCardSelector = 'li[data-ui="job-card"]';
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
            const linkElement = card.querySelector('h3[data-ui="job-title"] a') as HTMLAnchorElement;
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
        const nextPageLink = await page.$eval('a[data-ui="next-page"]', (el) => (el as HTMLAnchorElement).href).catch(() => null);
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
        
        // Combined evaluation for better performance and robustness
        const jobDetails = await page.evaluate(() => {
            // Handle cookie banner inside the browser context
            const cookieButton = document.querySelector('button:has-text("Accept all cookies")') as HTMLButtonElement | null;
            if (cookieButton) {
                cookieButton.click();
            }
            
            const getText = (selector: string) => document.querySelector(selector)?.textContent?.trim() || `${selector} not found`;
            const getHtml = (selector: string) => document.querySelector(selector)?.innerHTML || '';
            
            const company = getText('[data-ui="company-name"]');
            const jobPostedDate = getText('time[data-ui="job-posted-at"]');
            const location = getText('[data-ui="job-location"]');
            const jobType = getText('[data-ui="job-type"]');
            const workplaceType = getText('[data-ui="workplace-type"]');
            
            const jobDescriptionHTML = getHtml('[data-ui="job-description"]');
            const jobDescriptionText = getText('[data-ui="job-description"]');
            
            return {
                company,
                jobPostedDate,
                location,
                jobType,
                workplaceType,
                jobDescriptionHTML,
                jobDescriptionText,
                location: 'Location not found',
                jobType: 'Job type not found',
                workplaceType: 'Workplace type not found',
            };
        });

        await Dataset.pushData({
            jobTitle: title,
            ...jobDetails,
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