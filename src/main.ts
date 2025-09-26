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

router.addHandler('LIST', async ({ page, log, crawler }) => {
    log.info(`Processing list page: ${page.url()}`);
    await page.waitForSelector('ul[class*="jobs"]', { timeout: 60000 });
    await page.waitForTimeout(3000);

    const jobsOnPage = await page.evaluate(() => {
        const jobArticles = document.querySelectorAll('li[class*="job"]');
        const jobs = [];
        for (const jobArticle of jobArticles) {
            const titleElement = jobArticle.querySelector('h2 a') as HTMLAnchorElement;
            const title = titleElement?.textContent?.trim() || '';
            const url = titleElement?.href || '';
            const fullUrl = url.startsWith('http') ? url : `https://jobs.workable.com${url}`;
            if (title && fullUrl) {
                jobs.push({ title, url: fullUrl });
            }
        }
        return jobs;
    });

    for (const job of jobsOnPage) {
        if (collectedJobs < maxJobs) {
            await crawler.addRequests([{ url: job.url, label: 'DETAIL', userData: { title: job.title } }]);
            collectedJobs++;
        }
    }

    if (collectedJobs < maxJobs) {
        await page.waitForTimeout(2000);
        const nextPageLink = await page.$eval('a[class*="next-page"]', el => (el as HTMLAnchorElement).href).catch(() => null);
        if (nextPageLink) {
            const absoluteNextPageLink = nextPageLink.startsWith('http') ? nextPageLink : `https://jobs.workable.com${nextPageLink}`;
            log.info(`Found next page, adding to queue: ${absoluteNextPageLink}`);
            await crawler.addRequests([{ url: absoluteNextPageLink, label: 'LIST' }]);
        } else {
            log.info(`No more pages to process.`);
        }
    }
});

router.addHandler('DETAIL', async ({ request, page, log }) => {
    const { title } = request.userData;
    log.info(`Processing job detail page: ${request.url}`);

    try {
        await page.waitForSelector('h1', { timeout: 60000 });

        let company = 'Company not found';
        try {
            company = await page.$eval('a[class*="companyName__link"]', el => el.textContent?.trim()) || 'Company not found';
        } catch (e) {
            log.warning(`Could not find company name on ${request.url}`);
        }

        const details = await page.$$eval('[class*="jobDetails__job-detail"]', (els) => els.map(el => el.textContent?.trim()));
        
        let location = 'Location not found';
        if (details.length > 0) {
            location = details[0] || 'Location not found';
        }

        let jobType = 'Job type not found';
        if (details.length > 1) {
            jobType = details[1] || 'Job type not found';
        }

        let jobPostedDate = 'Job posted date not found';
        try {
            jobPostedDate = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('span, div, p'));
                const postedElement = elements.find(el => el.textContent?.includes('Posted'));
                return postedElement?.textContent?.trim() || 'Job posted date not found';
            });
        } catch (e) {
            log.warning(`Could not find job posted date on ${request.url}`);
        }

        let jobDescriptionHTML = '';
        try {
            jobDescriptionHTML = await page.$eval('div[class*="job-description"]', el => el.innerHTML)
                || await page.$eval('div.job__description', el => el.innerHTML)
                || await page.$eval('.job-description', el => el.innerHTML)
                || await page.$eval('main', el => el.innerHTML?.substring(0, 2000))
                || '';
        } catch (e) {
            log.warning(`Could not find job description HTML on ${request.url}`);
        }

        let jobDescriptionText = 'Description not found';
        try {
            jobDescriptionText = await page.$eval('div[class*="job-description"]', el => el.textContent?.trim())
                || await page.$eval('div.job__description', el => el.textContent?.trim())
                || await page.$eval('.job-description', el => el.textContent?.trim())
                || await page.$eval('main', el => el.textContent?.trim()?.substring(0, 2000))
                || 'Description not found';
        } catch (e) {
            log.warning(`Could not find job description text on ${request.url}`);
        }

        await Dataset.pushData({
            jobTitle: title,
            company,
            location,
            jobType,
            jobPostedDate,
            jobDescriptionHTML,
            jobDescriptionText,
            jobLink: request.url,
        });
        log.info(`Successfully scraped job: ${title}`);
    } catch (error: any) {
        log.error(`Failed to process page ${request.url}: ${error.message}`);
    }
});

const crawler = new PlaywrightCrawler({
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
    maxRequestsPerCrawl: maxJobs + 100, // Allow more pages to be crawled
    requestHandlerTimeoutSecs: 120,
    requestHandler: router,
    failedRequestHandler({ request, log }) {
        log.error(`Failed to process request ${request.url}: ${request.errorMessages.join(', ')}`);
    },
});

await crawler.run([{ url: searchUrl, label: 'LIST' }]);

console.log(`Scraping completed. Collected ${collectedJobs} job listings.`);

await Actor.exit();