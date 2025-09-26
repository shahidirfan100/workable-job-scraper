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

        const jobDetails = await page.evaluate(() => {
            const details = {
                location: 'Location not found',
                jobType: 'Job type not found',
                workplaceType: 'Workplace type not found'
            };

            const ICONS = {
                LOCATION: 'M12 2C8.13 2 5 5.13 5 9c0',
                JOB_TYPE: 'M20 6h-4V4c0-1.1',
                WORKPLACE: 'M10 20v-6h4v6h5v-8h3L12 3'
            };

            const detailElements = document.querySelectorAll('[data-ui="job-detail"]');

            for (const el of detailElements) {
                const text = el.textContent?.trim();
                if (!text) continue;

                const svg = el.querySelector('svg');
                if (svg) {
                    const path = svg.querySelector('path');
                    if (path) {
                        const d = path.getAttribute('d') || '';
                        if (d.startsWith(ICONS.LOCATION)) {
                            details.location = text;
                        } else if (d.startsWith(ICONS.JOB_TYPE)) {
                            details.jobType = text;
                        } else if (d.startsWith(ICONS.WORKPLACE)) {
                            details.workplaceType = text;
                        }
                    }
                }
            }

            if (details.location === 'Location not found' && details.jobType === 'Job type not found' && details.workplaceType === 'Workplace type not found') {
                for (const el of detailElements) {
                    const text = el.textContent?.trim();
                    if (!text) continue;
                    if (/(full-time|part-time|contract)/i.test(text)) details.jobType = text;
                    else if (/(on-site|hybrid|remote)/i.test(text)) details.workplaceType = text;
                    else if (text.includes(',')) details.location = text;
                }
            }

            return details;
        });

        let jobPostedDate = 'Job posted date not found';
        try {
            jobPostedDate = await page.$eval('time', el => el.textContent?.trim()) || 'Job posted date not found';
        } catch (e) {
            try {
                jobPostedDate = await page.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll('p, span, div'));
                    for (const el of elements) {
                        if (el.textContent?.toLowerCase().includes('posted')) {
                            if (el.childElementCount < 2 && el.textContent.length < 100) {
                                return el.textContent.trim();
                            }
                        }
                    }
                    return 'Job posted date not found';
                });
            } catch (e2) {
                log.warning(`Could not find job posted date on ${request.url}`);
            }
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
            location: jobDetails.location,
            jobType: jobDetails.jobType,
            workplaceType: jobDetails.workplaceType,
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