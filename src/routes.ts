import { createPlaywrightRouter, Dataset } from 'crawlee';

export const router = createPlaywrightRouter();

// Default handler for job listing pages
router.addDefaultHandler(async ({ page, request, log, crawler }) => {
    log.info(`Processing job search page: ${request.url}`);

    // Wait for the page to load job listings
    await page.waitForSelector('[data-ui="job-card-title"]', { timeout: 30000 }).catch(() => {
        log.warning('Job cards not found on page');
        return;
    });

    // Extract job listings from the current page
    const jobsOnPage = await page.evaluate(() => {
        const jobCards = document.querySelectorAll('a[data-ui="job-card-title"]');
        const jobs = [];

        for (const card of jobCards) {
            const titleElement = card.querySelector('h2') || card;
            const title = titleElement.textContent?.trim() || '';
            
            // Find parent card to get other data
            const jobCard = card.closest('[data-ui="job-card"]') || card.parentElement?.closest('[data-ui="job-card"]');
            
            let location = '';
            let department = '';
            let datePosted = '';
            let company = '';
            
            if (jobCard) {
                // Extract location
                const locationElement = jobCard.querySelector('[data-ui="job-card-location"]');
                if (locationElement) {
                    location = locationElement.textContent?.trim() || '';
                }
                
                // Extract department
                const departmentElement = jobCard.querySelector('[data-ui="job-card-department"]');
                if (departmentElement) {
                    department = departmentElement.textContent?.trim() || '';
                }
                
                // Extract date posted
                const dateElement = jobCard.querySelector('[data-ui="job-card-date"]');
                if (dateElement) {
                    datePosted = dateElement.textContent?.trim() || '';
                }
                
                // Extract company name
                const companyElement = jobCard.querySelector('[data-ui="job-card-company"]');
                if (companyElement) {
                    company = companyElement.textContent?.trim() || '';
                }
            }
            
            jobs.push({
                title,
                url: (card as HTMLAnchorElement).href,
                location,
                department,
                datePosted,
                company
            });
        }
        
        return jobs;
    });

    // For each job, navigate to the job page to get full description
    for (const job of jobsOnPage) {
        try {
            // Create a new page to get job details
            const jobPage = await page.context().newPage();
            await jobPage.goto(job.url, { waitUntil: 'networkidle', timeout: 60000 });
            
            // Extract job description
            const jobDescription = await jobPage.$eval('[data-ui="job-content"]', el => el.textContent?.trim()) 
                || await jobPage.$eval('div.job__description', el => el.textContent?.trim())
                || await jobPage.$eval('.job-description', el => el.textContent?.trim())
                || await jobPage.$eval('.job__description', el => el.textContent?.trim())
                || 'Description not found';

            // Extract full location if available on job page
            let fullLocation = job.location;
            const locationElement = await jobPage.$('[data-ui="job-location"]');
            if (locationElement) {
                const locText = await locationElement.textContent();
                if (locText) fullLocation = locText.trim();
            }

            // Push complete job data to dataset
            await Dataset.pushData({
                jobTitle: job.title,
                company: job.company || 'Workable',
                location: fullLocation,
                jobDescription,
                postedDate: job.datePosted,
                jobLink: job.url
            });

            await jobPage.close();
        } catch (error: any) {
            log.warning(`Failed to process job page ${job.url}: ${error.message}`);
        }
    }

    // Look for next page and enqueue it if it exists
    await page.waitForTimeout(2000); // Wait a bit before looking for next page
    
    // Look for next page button and follow it
    const nextPageButton = await page.$('a[rel="next"]');
    if (nextPageButton) {
        const nextPageUrl = await nextPageButton.getAttribute('href');
        if (nextPageUrl) {
            await crawler.addRequests([new URL(nextPageUrl, request.loadedUrl).toString()]);
        }
    }
});

// Handler for job detail pages (if needed for separate processing)
router.addHandler('job-detail', async ({ request, page, log }) => {
    log.info(`Processing job detail page: ${request.loadedUrl}`);
    
    // Extract detailed job information
    const jobData = await page.evaluate(() => {
        // Extract title
        const titleEl = document.querySelector('h1') || document.querySelector('[data-ui="job-title"]');
        const title = titleEl?.textContent?.trim() || 'Title not found';
        
        // Extract company
        const companyEl = document.querySelector('[data-ui="job-company"]') || document.querySelector('.job-company');
        const company = companyEl?.textContent?.trim() || 'Company not found';
        
        // Extract location
        const locationEl = document.querySelector('[data-ui="job-location"]') || document.querySelector('.job-location');
        const location = locationEl?.textContent?.trim() || 'Location not found';
        
        // Extract description
        const descEl = document.querySelector('[data-ui="job-content"]') 
            || document.querySelector('div.job__description')
            || document.querySelector('.job-description');
        const description = descEl?.textContent?.trim() || 'Description not found';
        
        // Extract posted date
        const dateEl = document.querySelector('[data-ui="job-date"]') || document.querySelector('.job-date');
        const date = dateEl?.textContent?.trim() || 'Date not found';
        
        return {
            jobTitle: title,
            company,
            location,
            jobDescription: description,
            postedDate: date,
            jobLink: window.location.href
        };
    });

    await Dataset.pushData(jobData);
});
