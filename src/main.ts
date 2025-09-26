import { Actor, log, KeyValueStore } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter } from 'crawlee';

await Actor.init();

interface InputSchema {
  keyword: string;
  location?: string; // e.g. "united-states-of-america" or free text
  postedDate?: '24h' | '7d' | '30d' | 'anytime';
  resultsWanted?: number; // total detail pages to save
}

const input = (await Actor.getInput<InputSchema>()) || {
  keyword: 'Administrator',
  postedDate: '7d',
  resultsWanted: 50,
};

const resultsWanted = Math.max(1, Math.min(500, input.resultsWanted ?? 50));

// Build Workable search URL
const params = new URLSearchParams({ query: input.keyword });
if (input.postedDate && input.postedDate !== 'anytime') {
  // Workable expects numeric days via day_range
  const map: Record<NonNullable<InputSchema['postedDate']>, string> = {
    '24h': '1',
    '7d': '7',
    '30d': '30',
    anytime: '',
  };
  const dayRange = map[input.postedDate];
  if (dayRange) params.set('day_range', dayRange);
}
let base = 'https://jobs.workable.com/search';
if (input.location) {
  // Workable location segments are like /search/united-states-of-america/data-analyst-jobs
  // If user typed free text, keep query param approach; if it looks slug-like, add to path.
  const looksSlug = /^(?:[a-z0-9-]+)(?:\/[a-z0-9-]+)?$/.test(input.location);
  if (looksSlug) base = `https://jobs.workable.com/search/${input.location}`;
}
const searchUrl = `${base}?${params.toString()}`;

log.info(`Search URL: ${searchUrl}`);

let collected = 0;
const seenUrls = new Set<string>();

const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, request, enqueueLinks, log }) => {
  log.info(`Default handler for: ${request.url}`);
});

router.addHandler('LIST', async ({ page, request, log, crawler }) => {
  log.info(`Processing list page: ${request.url}`);

  // Do not block CSS, only heavy media. Blocking CSS can keep elements "invisible" for Playwright.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm)(?:\?|$)/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // Cookie banners (variations)
  const cookieButtons = [
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("I accept")',
    'button[aria-label="Accept cookies"]',
  ];
  for (const sel of cookieButtons) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      await btn.click({ timeout: 5_000 }).catch(() => void 0);
      log.info('Cookie banner handled.');
      break;
    }
  }

  // Wait for job cards to be attached (not necessarily visible, in case CSS is blocked by site)
  const cardSelector = '[data-ui="job-card"]';
  await page.waitForLoadState('networkidle').catch(() => void 0);
  await page.waitForSelector(cardSelector, { timeout: 60_000, state: 'attached' })
    .catch(async (err) => {
      log.warning('Job cards not found within timeout. Saving HTML for debugging.');
      const html = await page.content();
      await KeyValueStore.setValue('LIST_HTML_DEBUG', html, { contentType: 'text/html' });
      throw err;
    });

  // Infinite scroll / pagination – keep scrolling until we reach resultsWanted or no growth
  let lastCount = 0;
  for (let i = 0; i < 20; i++) {
    const count = await page.locator(cardSelector).count();
    if (count >= resultsWanted || count === lastCount) break;
    lastCount = count;
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(1200);
  }

  // Collect detail links from cards
  const links = await page.$$eval(cardSelector, (els) => {
    const out: string[] = [];
    for (const el of els) {
      const a = el.querySelector('a[href^="/view/"]') as HTMLAnchorElement | null;
      if (a) out.push(new URL(a.getAttribute('href')!, location.origin).href);
    }
    return out;
  });

  let enqueued = 0;
  for (const url of links) {
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    await crawler.addRequests([{ url, label: 'DETAIL' }]);
    enqueued++;
    if (seenUrls.size >= resultsWanted) break;
  }

  log.info(`Enqueued ${enqueued} detail pages (total seen: ${seenUrls.size}).`);
});

router.addHandler('DETAIL', async ({ page, request, log }) => {
  log.info(`Detail: ${request.url}`);

  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle').catch(() => void 0);

  // Prefer structured data (JSON-LD)
  const ldJson = await page.$$eval('script[type="application/ld+json"]', (nodes) => nodes.map((n) => n.textContent || '').filter(Boolean));

  type JobPosting = {
    '@type'?: string;
    title?: string;
    description?: string;
    datePosted?: string;
    hiringOrganization?: { name?: string };
    jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } } | Array<any>;
    employmentType?: string | string[];
    validThrough?: string;
    identifier?: { value?: string };
  };

  let data: Partial<JobPosting> | undefined;
  for (const blob of ldJson) {
    try {
      const parsed = JSON.parse(blob) as any;
      const candidate = Array.isArray(parsed) ? parsed.find((o) => o['@type'] === 'JobPosting') : parsed;
      if (candidate && (candidate['@type'] === 'JobPosting' || candidate.title)) {
        data = candidate as JobPosting;
        break;
      }
    } catch { /* ignore */ }
  }

  // Fallbacks from DOM
  const title = data?.title ?? (await page.locator('h1, h2').first().textContent().catch(() => null))?.trim();
  const company = data?.hiringOrganization?.name ?? (await page.locator('[data-ui="company-name"], a[href*="/company/"]').first().textContent().catch(() => null))?.trim();
  const locationText = (() => {
    if (data?.jobLocation) {
      const a = Array.isArray(data.jobLocation) ? data.jobLocation[0]?.address : (data.jobLocation as any).address;
      const parts = [a?.addressLocality, a?.addressRegion, a?.addressCountry].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
    return null;
  })() ?? (await page.locator('[data-ui="job-location"], [data-ui="location"], a[href*="/search/"]').first().textContent().catch(() => null))?.trim();

  const descriptionHtml = data?.description ?? (await page.locator('[data-ui="job-description"], [data-ui="description"], article').innerHTML().catch(() => ''));
  const datePosted = data?.datePosted ?? null;

  const item = {
    url: request.url,
    title: title || null,
    company: company || null,
    location: locationText || null,
    datePosted,
    employmentType: data?.employmentType ?? null,
    validThrough: data?.validThrough ?? null,
    externalId: (data as any)?.identifier?.value ?? null,
    descriptionHtml,
    scrapedAt: new Date().toISOString(),
  };

  await Dataset.pushData(item);
  collected++;
  log.info(`Saved job (${collected}/${resultsWanted}).`);
});

const crawler = new PlaywrightCrawler({
  requestHandler: router,
  // Make the browser a bit more "real"
  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    },
  },
  // Conservative concurrency; Workable can rate-limit
  maxConcurrency: 2,
  requestHandlerTimeoutSecs: 120,
  maxRequestsPerCrawl: resultsWanted + 50,
  failedRequestHandler: async ({ request }) => {
    log.error(`Request failed too many times: ${request.url}`);
  },
});

await crawler.run([{ url: searchUrl, label: 'LIST' }]);

log.info(`Scraping completed. Collected ${collected} job listing(s).`);

await Actor.exit();
