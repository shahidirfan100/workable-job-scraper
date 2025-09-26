
import { PlaywrightCrawler, Dataset, RequestQueue, log, KeyValueStore, BrowserPool } from 'crawlee';

type Input = {
    keyword: string;
    location?: string;
    postedDate?: '24h' | '7d' | '30d' | 'anytime';
    resultsWanted: number;
};

const WORKABLE_SEARCH_BASE = 'https://jobs.workable.com/search';

function buildSearchUrl(keyword: string, location?: string, page?: number) {
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword);
    if (location) params.set('location', location);
    if (page && page > 1) params.set('page', String(page));
    return `${WORKABLE_SEARCH_BASE}?${params.toString()}`;
}

function postedDateFilterAccept(postedText: string | null, postedDateFilter: Input['postedDate']) {
    // postedText examples: "Posted 2 days ago", "Posted today", "Posted 3 weeks ago", "Posted 1 month ago"
    if (!postedDateFilter || postedDateFilter === 'anytime') return true;
    if (!postedText) return true;
    const now = new Date();
    const lower = postedText.toLowerCase();
    const match = lower.match(/posted\s*(.*)/);
    let deltaDays = 0;
    if (match && match[1]) {
        const part = match[1].trim();
        if (part.includes('today')) deltaDays = 0;
        else if (part.includes('yesterday')) deltaDays = 1;
        else {
            const numMatch = part.match(/(\d+)/);
            if (numMatch) {
                const num = parseInt(numMatch[1], 10);
                if (part.includes('day')) deltaDays = num;
                else if (part.includes('week')) deltaDays = num * 7;
                else if (part.includes('month')) deltaDays = num * 30;
                else deltaDays = num;
            }
        }
    }
    if (postedDateFilter === '24h') return deltaDays <= 1;
    if (postedDateFilter === '7d') return deltaDays <= 7;
    if (postedDateFilter === '30d') return deltaDays <= 30;
    return true;
}

export async function main() {
    const input: Input = await KeyValueStore.getValue('INPUT') as Input || { keyword: '', resultsWanted: 100 };

    if (!input.keyword || !input.resultsWanted) {
        log.error('Missing required input fields. Please provide "keyword" and "resultsWanted" in INPUT.');
        return;
    }

    const requestQueue = await RequestQueue.open();
    const dataset = await Dataset.open();

    // seed first search page
    await requestQueue.addRequest({ url: buildSearchUrl(input.keyword, input.location, 1), userData: { label: 'SEARCH', page: 1 } });

    let collected = 0;
    const maxResults = input.resultsWanted;

    const crawler = new PlaywrightCrawler({
        launchContext: {
            // Apify will provide Chrome in the environment; use default launch options.
            // You can set launchOptions here if needed.
        },
        requestQueue,
        maxConcurrency: 5,
        handlePageTimeoutSecs: 60,
        async handlePageFunction({ page, request, enqueueLinks, response, log, crawler }) {
            const label = request.userData?.label;
            if (label === 'SEARCH') {
                // On search page: extract job cards and their links, posted text
                await page.waitForLoadState('domcontentloaded');
                // Select job link elements - Workable uses 'a.job-link' or similar; we'll try robust selectors.
                const jobAnchors = await page.$$('[data-test="job-link"], a[href*="/jobs/"], a.job-link');
                for (const anchor of jobAnchors) {
                    try {
                        const href = await anchor.getAttribute('href');
                        if (!href) continue;
                        const absolute = href.startsWith('http') ? href : new URL(href, 'https://jobs.workable.com').toString();
                        // attempt to find posted label near the anchor (fallback null)
                        const parent = await anchor.evaluateHandle((el) => el.closest('li, .job, .job-listing') || el.parentElement);
                        let postedText = null;
                        if (parent) {
                            try {
                                postedText = await parent.evaluate((el:any) => {
                                    const q = el.querySelector('[data-test="job-posted"], .posting-date, .posted, time, .job-date');
                                    return q ? (q.textContent || q.innerText).trim() : null;
                                });
                            } catch(e) { postedText = null; }
                        }
                        // filter by postedDate if needed
                        if (!postedDateFilterAccept(postedText, input.postedDate)) continue;

                        // Respect resultsWanted
                        if (collected >= maxResults) break;

                        await requestQueue.addRequest({ url: absolute, userData: { label: 'JOB' } });
                    } catch (err) {
                        // ignore individual anchor errors
                    }
                }

                // enqueue next search page if needed
                const currentPage = request.userData?.page || 1;
                if (collected < maxResults) {
                    const nextPage = currentPage + 1;
                    // Basic heuristic: try next page up to a reasonable limit (e.g., 50)
                    if (nextPage <= 50) {
                        const nextUrl = buildSearchUrl(input.keyword, input.location, nextPage);
                        await requestQueue.addRequest({ url: nextUrl, userData: { label: 'SEARCH', page: nextPage } });
                    }
                }
            } else if (label === 'JOB') {
                // Job detail page: extract required fields
                await page.waitForLoadState('networkidle');
                // Extract fields with robust selectors
                const title = await page.$eval('h1, [data-test="job-title"], .job-title', el => (el.textContent || '').trim()).catch(() => '');
                const company = await page.$eval('.company, [data-test="company-name"], .job-company', el => (el.textContent || '').trim()).catch(() => '');
                const location = await page.$eval('.location, [data-test="location"], .job-location', el => (el.textContent || '').trim()).catch(() => '');
                const posted = await page.$eval('time, [data-test="job-posted"], .posting-date, .job-date', el => (el.textContent || '').trim()).catch(() => '');

                // Description: try common container selectors
                const descHandle = await page.$('.description, [data-test="job-description"], .job-description, .posting-body') ;
                let descriptionHtml = '';
                let descriptionText = '';
                if (descHandle) {
                    descriptionHtml = await descHandle.evaluate((el:any) => el.innerHTML).catch(() => '');
                    descriptionText = await descHandle.evaluate((el:any) => el.innerText).catch(() => '');
                } else {
                    // fallback: take main content
                    const bodyHtml = await page.$eval('main, body', el => (el.innerHTML || '')).catch(() => '');
                    descriptionHtml = bodyHtml;
                    descriptionText = (descriptionHtml.replace(/<[^>]+>/g, ' ') || '').slice(0, 10000);
                }

                const item = {
                    url: request.url,
                    title,
                    company,
                    location,
                    posted,
                    descriptionHtml,
                    descriptionText,
                    collectedAt: new Date().toISOString()
                };

                await dataset.pushData(item);
                collected += 1;

                // If we've reached maxResults, abort crawling gracefully
                if (collected >= maxResults) {
                    log.info(`Collected desired number of results (${maxResults}). Closing crawler.`);
                    await crawler?.autoscaledPool?.autoscaledPool?.close?.(); // best-effort
                    // Note: PlaywrightCrawler will finish processing current tasks.
                }
            } else {
                // Unknown label - attempt generic extraction, but do nothing special.
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            log.error(`Request ${request.url} failed too many times.`);
        }
    });

    await crawler.run();
    log.info('Crawler finished.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
