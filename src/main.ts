import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

await Actor.init();

interface InputSchema {
    keyword: string;
    location?: string;
    postedDate?: string;
    maxItems?: number;
}

const input = (await Actor.getInput<InputSchema>()) || { keyword: 'developer' };

const crawler = new PlaywrightCrawler({
    requestHandler: async ({ page, request, log }) => {
        log.info(`Processing: ${request.url}`);
        const jobs = await page.$$eval('a[data-ui="job-card-title"]', els =>
            els.map(el => ({
                title: el.textContent?.trim() || '',
                url: (el as HTMLAnchorElement).href,
            }))
        );

        for (const job of jobs) {
            await Dataset.pushData(job);
        }
    },
});

const searchUrl = `https://jobs.workable.com/search?query=${encodeURIComponent(input.keyword)}`;
await crawler.run([searchUrl]);

await Actor.exit();
