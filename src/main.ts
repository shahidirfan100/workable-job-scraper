import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

await Actor.init();

interface InputSchema {
    keyword: string;
    location?: string;
    postedDate?: '24h' | '7d' | '30d' | 'anytime';
    resultsWanted: number;
}

const input = (await Actor.getInput<InputSchema>()) || { keyword: 'developer', resultsWanted: 10 };

// Build the search URL with parameters - using correct Workable URL structure
let searchUrl = `https://jobs.workable.com/search?query=${encodeURIComponent(input.keyword)}`;

// Add location if provided
if (input.location) {
    searchUrl += `&location=${encodeURIComponent(input.location)}`;
}

// Add posted date filter if provided
if (input.postedDate && input.postedDate !== 'anytime') {
    if (input.postedDate === '24h') {
        searchUrl += '&day_range=1';
    } else if (input.postedDate === '7d') {
        searchUrl += '&day_range=7';
    } else if (input.postedDate === '30d') {
        searchUrl += '&day_range=30';
    }
}

// Counter for tracking collected job listings
let collectedJobs = 0;
const maxJobs = input.resultsWanted;

const crawler = new PlaywrightCrawler({
    launchContext: {
        // Use Chrome browser for better compatibility with Workable
        launchOptions: {
            headless: true,
        },
    },
    maxRequestsPerCrawl: 100, // Allow more pages to be crawled
    requestHandlerTimeoutSecs: 120,
    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);
        
        // Wait for job listings container to load
        await page.waitForSelector('ul[class*="jobs"]', { timeout: 60000 });
        
        // Wait a bit more for job cards to fully load
        await page.waitForTimeout(3000);
        
        // Extract job listings from the current page
        const jobsOnPage = await page.evaluate(() => {
            const jobArticles = document.querySelectorAll('li[class*="job"]');
            const jobs = [];

            for (const jobArticle of jobArticles) {
                // Extract job title
                const titleElement = jobArticle.querySelector('h2 a') as HTMLAnchorElement;
                const title = titleElement?.textContent?.trim() || '';
                const url = titleElement?.href || '';
                
                // Extract company, location, and job type from the same container
                const detailsContainer = jobArticle.querySelector('div:has(> span[class*="company"])');
                const company = detailsContainer?.querySelector('span:nth-child(1)')?.textContent?.trim() || 'Company not found';
                const location = detailsContainer?.querySelector('span:nth-child(2)')?.textContent?.trim() || 'Location not found';
                const jobType = detailsContainer?.querySelector('span:nth-child(3)')?.textContent?.trim() || 'Not specified';
                
                // Extract posted date - this selector seems to work
                const dateElement = jobArticle.querySelector('span[class*="date"]');
                const datePosted = dateElement?.textContent?.trim() || 'Date not found';
                
                // Construct full URL if relative
                const fullUrl = url.startsWith('http') ? url : `https://jobs.workable.com${url}`;
                
                if (title && fullUrl) { // Only add if we have a title and URL
                    jobs.push({
                        title,
                        url: fullUrl,
                        company,
                        location,
                        jobType,
                        datePosted
                    });
                }
            }
            
            return jobs;
        });

        // Process each job listing
        for (const job of jobsOnPage) {
            if (collectedJobs >= maxJobs) {
                log.info(`Reached the requested number of jobs (${maxJobs}). Stopping.`);
                await crawler.autoscaledPool?.abort();
                return;
            }

            try {
                // Navigate to the job detail page to get full description
                const jobPage = await page.context().newPage();
                await jobPage.goto(job.url, { waitUntil: 'networkidle', timeout: 60000 });
                
                // Wait for the job description to load
                await jobPage.waitForSelector('div[class*="job-description"] > div', { timeout: 60000 });
                
                // Extract job description as HTML
                const jobDescription = await jobPage.$eval('div[class*="job-description"] > div', el => el.innerHTML.trim())
                    || 'Description not found';

                // Push complete job data to dataset
                await Dataset.pushData({
                    jobTitle: job.title,
                    company: job.company,
                    location: job.location,
                    jobType: job.jobType,
                    jobDescription: jobDescription,
                    postedDate: job.datePosted,
                    jobLink: job.url
                });

                collectedJobs++;
                log.info(`Collected job #${collectedJobs}: ${job.title}`);

                if (collectedJobs >= maxJobs) {
                    log.info(`Reached the requested number of jobs (${maxJobs}). Stopping.`);
                    await jobPage.close();
                    await crawler.autoscaledPool?.abort();
                    return;
                }

                await jobPage.close();
            } catch (error: any) {
                log.warning(`Failed to process job page ${job.url}: ${error.message}`);
                // Continue with next job even if one fails
            }
        }

        // Check for next page and continue crawling if needed
        if (collectedJobs < maxJobs) {
            await page.waitForTimeout(2000); // Wait before looking for next page
            
            // Look for next page link and add it to the crawler if needed
            const nextPageLink = await page.$eval('a[class*="next-page"]', el => (el as HTMLAnchorElement).href).catch(() => null);
            
            if (nextPageLink && collectedJobs < maxJobs) {
                // Make sure the next page URL is absolute
                const absoluteNextPageLink = nextPageLink.startsWith('http') ? nextPageLink : `https://jobs.workable.com${nextPageLink}`;
                log.info(`Found next page, adding to queue: ${absoluteNextPageLink}`);
                await crawler.addRequests([absoluteNextPageLink]);
            } else {
                if (collectedJobs < maxJobs) {
                    log.info(`No more pages to process but haven't reached desired number of jobs. Found ${collectedJobs} jobs.`);
                }
            }
        }
    },
    failedRequestHandler({ request, log }) {
        log.error(`Failed to process request ${request.url}: ${request.errorMessages.join(', ')}`);
    },
});

// Run the crawler and rely on log messages from within the crawler
await crawler.run([searchUrl]);

// Final message using standard console since we're outside crawler context
console.log(`Scraping completed. Collected ${collectedJobs} job listings.`);

await Actor.exit();
