import { Actor, log, KeyValueStore } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter } from 'crawlee';
import type { Page } from 'playwright';

/********************
 * Workable Scraper – fast & parallel (Crawlee 3.15)
 * - JSON-LD first, DOM/shadow fallbacks
 * - No CDP, no networkidle
 * - Tight waits, high concurrency (batches)
 ********************/

await Actor.init();

interface InputSchema {
  keyword: string;
  location?: string; // optional slug like `united-states-of-america` or city slug
  postedDate?: '24h' | '7d' | '30d' | 'anytime';
  resultsWanted?: number; // number of detail pages to save
}

const input = (await Actor.getInput<InputSchema>()) ?? {
  keyword: 'Administrator',
  postedDate: '7d',
  resultsWanted: 50,
};

const resultsWanted = Math.max(1, Math.min(500, input.resultsWanted ?? 50));

// -----------------------
// Helpers
// -----------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildSearchUrl(): string {
  const params = new URLSearchParams({ query: input.keyword });
  if (input.postedDate && input.postedDate !== 'anytime') {
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
    const looksSlug = /^(?:[a-z0-9-]+)(?:\/[a-z0-9-]+)?$/.test(input.location);
    if (looksSlug) base = `https://jobs.workable.com/search/${input.location}`;
  }
  return `${base}?${params.toString()}`;
}

// Deep link collection (DOM + shadow + same-origin iframes)
async function collectViewLinksDeep(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const out = new Set<string>();

    const addLinks = (root: Document | ShadowRoot) => {
      root.querySelectorAll?.('a[href^="/view/"]').forEach((a) => {
        try {
          const hrefAttr = (a as HTMLAnchorElement).getAttribute('href');
          const absolute = (a as HTMLAnchorElement).href || (hrefAttr ? new URL(hrefAttr, location.origin).href : '');
          if (absolute) out.add(absolute);
        } catch {}
      });
    };

    const visit = (root: Document | ShadowRoot) => {
      addLinks(root);
      const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode as Element | null;
      while (node) {
        const sr = (node as any).shadowRoot as ShadowRoot | null | undefined;
        if (sr) {
          addLinks(sr);
          const innerWalker = document.createTreeWalker(sr as any, NodeFilter.SHOW_ELEMENT);
          let inner = innerWalker.currentNode as Element | null;
          while (inner) {
            const innerSr = (inner as any).shadowRoot as ShadowRoot | null | undefined;
            if (innerSr) addLinks(innerSr);
            inner = innerWalker.nextNode() as Element | null;
          }
        }
        node = walker.nextNode() as Element | null;
      }
    };

    visit(document);
    document.querySelectorAll('iframe').forEach((ifr) => {
      try {
        const doc = (ifr as HTMLIFrameElement).contentDocument;
        if (doc) visit(doc);
      } catch {}
    });

    return Array.from(out);
  });
}

// ---- JSON-LD helpers ----
type JobPosting = {
  '@type'?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string } | { name?: string }[];
  jobLocation?:
    | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }
    | { addressLocality?: string; addressRegion?: string; addressCountry?: string }
    | Array<any>;
  employmentType?: string | string[];
  validThrough?: string;
  identifier?: { value?: string } | { value?: string }[];
};

async function parseJobPostingJSONLD(page: Page): Promise<Partial<JobPosting> | null> {
  const blobs = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
    nodes.map((n) => n.textContent || '').filter(Boolean),
  );
  for (const blob of blobs) {
    try {
      const parsed = JSON.parse(blob as string);
      const pick = (obj: any): any => {
        if (!obj) return null;
        if (Array.isArray(obj)) return obj.find((o) => o && (o['@type'] === 'JobPosting' || o.title)) || null;
        if (obj['@type'] === 'JobPosting') return obj;
        if (obj.mainEntityOfPage?.['@type'] === 'JobPosting') return obj.mainEntityOfPage;
        return null;
      };
      const jp = pick(parsed);
      if (jp) return jp as JobPosting;
    } catch {}
  }
  return null;
}

function normalizeEmploymentType(et?: string | string[] | null): string | null {
  if (!et) return null;
  return Array.isArray(et) ? Array.from(new Set(et)).join(', ') : et;
}
function extractLocationFromLD(job: Partial<JobPosting> | null): string | null {
  if (!job?.jobLocation) return null;
  const locs = Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation];
  const first = locs.find(Boolean) as any;
  const addr = (first && (first.address || first)) || null;
  if (!addr) return null;
  const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
function extractCompanyFromLD(job: Partial<JobPosting> | null): string | null {
  if (!job?.hiringOrganization) return null;
  const org = Array.isArray(job.hiringOrganization) ? job.hiringOrganization[0] : job.hiringOrganization;
  return (org as any)?.name || null;
}
async function guessEmploymentTypeFromDOM(page: Page): Promise<string | null> {
  const text = await page.evaluate(() => document.body?.innerText || '');
  const tokens = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Apprenticeship', 'Freelance'];
  const found = tokens.filter((t) => new RegExp(`\\b${t.replace('-', '[- ]?')}\\b`, 'i').test(text));
  return found.length ? Array.from(new Set(found)).join(', ') : null;
}
async function getInnerHTMLDeep(page: Page, selectors: string[]): Promise<string> {
  return await page.evaluate((sels) => {
    const pickHtml = (el: Element | null | undefined) => (el ? (el as HTMLElement).innerHTML : '');
    const tryIn = (root: Document | ShadowRoot): string | null => {
      for (const sel of sels) {
        const el = root.querySelector(sel);
        if (el) return pickHtml(el);
      }
      return null;
    };
    let html = tryIn(document);
    if (html) return html;
    const walk = (root: Document | ShadowRoot): string | null => {
      const tw = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let node = tw.currentNode as Element | null;
      while (node) {
        const sr = (node as any).shadowRoot as ShadowRoot | null | undefined;
        if (sr) {
          const got = tryIn(sr);
          if (got) return got;
          const innerTw = document.createTreeWalker(sr as any, NodeFilter.SHOW_ELEMENT);
          let inner = innerTw.currentNode as Element | null;
          while (inner) {
            const innerSr = (inner as any).shadowRoot as ShadowRoot | null | undefined;
            if (innerSr) {
              const got2 = tryIn(innerSr);
              if (got2) return got2;
            }
            inner = innerTw.nextNode() as Element | null;
          }
        }
        node = tw.nextNode() as Element | null;
      }
      return null;
    };
    html = walk(document);
    if (html) return html;
    for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = (ifr as HTMLIFrameElement).contentDocument;
        if (doc) {
          const attempt = tryIn(doc);
          if (attempt) return attempt;
        }
      } catch {}
    }
    return '';
  }, selectors);
}

// -----------------------
// Router
// -----------------------
let collected = 0;
const seenUrls = new Set<string>();
const router = createPlaywrightRouter();

// LIST: grab links fast, enqueue in bulk
router.addHandler('LIST', async ({ page, request, log, crawler }) => {
  log.info(`Processing list page: ${request.url}`);

  // Block only heavy media (keep CSS/fonts)
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(?:png|jpg|jpeg|gif|webp|ico|mp4|webm)(?:\?|$)/i.test(url)) return route.abort();
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 900 });

  // Light anti-bot (no CDP)
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] as any });
    } catch {}
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Fast nav
  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Cookie banner quick handle
  const cookieButtons = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all cookies")',
    'button[aria-label="Accept cookies"]',
  ];
  for (const sel of cookieButtons) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      await btn.click({ timeout: 2_000 }).catch(() => void 0);
      log.info('Cookie banner handled.');
      break;
    }
  }

  const cardSelector =
    '[data-ui="job-card"], [data-testid="job-card"], li[data-ui="job-card"], div[data-ui="job-card"]';

  // Short wait for results
  await Promise.race([
    page.waitForSelector(cardSelector, { timeout: 8_000, state: 'attached' }),
    page.waitForSelector('a[href^="/view/"]', { timeout: 8_000, state: 'attached' }),
  ]).catch(async (err) => {
    log.warning('Job cards/links not found quickly. Saving HTML + screenshot.');
    await KeyValueStore.setValue('LIST_HTML_DEBUG', await page.content(), { contentType: 'text/html' });
    await KeyValueStore.setValue('LIST_SCREENSHOT_DEBUG', await page.screenshot({ fullPage: true }), {
      contentType: 'image/png',
    });
    throw err;
  });

  // Tight scroll loop (batch-friendly)
  let lastSeen = 0;
  const target = Math.min(resultsWanted, 100);
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.scrollBy(0, 900));
    await sleep(180 + Math.floor(Math.random() * 80));
    const [cardCount, linkCount] = await Promise.all([
      page.locator(cardSelector).count().catch(() => 0),
      page.locator('a[href^="/view/"]').count().catch(() => 0),
    ]);
    const deepCount = (await collectViewLinksDeep(page)).length;
    const seen = Math.max(cardCount, linkCount, deepCount);
    if (seen >= target || seen === lastSeen) break;
    lastSeen = seen;
  }

  // Gather detail links
  const mainLinks: string[] = (await page
    .$$eval('a[href^="/view/"]', (as) =>
      Array.from(new Set(as.map((a) => new URL((a as HTMLAnchorElement).href, location.origin).href))),
    )
    .catch(() => [])) as string[];
  const deepLinks = await collectViewLinksDeep(page);
  const links = Array.from(new Set([...mainLinks, ...deepLinks])).slice(0, resultsWanted);

  if (!links.length) {
    log.warning('No detail links found after scroll. Saving artifacts.');
    await KeyValueStore.setValue('LIST_HTML_DEBUG_EMPTY', await page.content(), { contentType: 'text/html' });
    await KeyValueStore.setValue('LIST_SCREENSHOT_DEBUG_EMPTY', await page.screenshot({ fullPage: true }), {
      contentType: 'image/png',
    });
  }

  // Enqueue in bulk for parallel processing
  const batch = links.filter((u) => u && !seenUrls.has(u));
  batch.forEach((u) => seenUrls.add(u));
  await crawler.addRequests(batch.map((url) => ({ url, label: 'DETAIL' })));
  log.info(`Enqueued ${batch.length} detail pages (total seen: ${seenUrls.size}).`);
});

// DETAIL: parallelized, short waits, no CDP
router.addHandler('DETAIL', async ({ page, request, log }) => {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(?:png|jpg|jpeg|gif|webp|ico|mp4|webm)(?:\?|$)/i.test(url)) return route.abort();
    return route.continue();
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });

  const ld = await parseJobPostingJSONLD(page);

  const title =
    (ld?.title ?? (await page.locator('h1, h2').first().textContent().catch(() => null)) ?? '')
      .toString()
      .trim() || null;

  const companyDom =
    (await page
      .locator('[data-ui="company-name"], [data-testid="company-name"], a[href*="/company/"]')
      .first()
      .textContent()
      .catch(() => null)) ?? '';
  const company = extractCompanyFromLD(ld) ?? (companyDom ? companyDom.toString().trim() : null);

  const locDom =
    (await page
      .locator('[data-ui="job-location"], [data-testid="job-location"], [data-ui="location"], header a[href*="/search/"]')
      .first()
      .textContent()
      .catch(() => null)) ?? '';
  const locationText = extractLocationFromLD(ld) ?? (locDom ? locDom.toString().trim() : null);

  const employmentType =
    normalizeEmploymentType(ld?.employmentType ?? null) ??
    (await guessEmploymentTypeFromDOM(page));

  const ldDesc = (ld?.description ?? '') as string;
  const descriptionHtml =
    (/<\w+/.test(ldDesc) && ldDesc) ||
    (await getInnerHTMLDeep(page, ['[data-ui="job-description"]', '[data-ui="description"]', 'article'])) ||
    `<p>${((await page.locator('article').first().textContent().catch(() => '')) ?? '')
      .toString()
      .trim()}</p>`;

  const externalId = (() => {
    const id = (ld as any)?.identifier;
    if (!id) return null;
    if (Array.isArray(id)) return (id[0] && id[0].value) ? (id[0].value as string) : null;
    return (id.value ?? null) as string | null;
  })();

  await Dataset.pushData({
    url: request.url,
    title,
    company,
    location: locationText,
    datePosted: ld?.datePosted ?? null,
    employmentType: employmentType ?? null,
    validThrough: (ld as any)?.validThrough ?? null,
    externalId,
    descriptionHtml,
    scrapedAt: new Date().toISOString(),
  });

  collected++;
  log.info(`Saved job (${collected}/${resultsWanted}).`);
});

// -----------------------
// Crawler (parallel batches)
// -----------------------
const crawler = new PlaywrightCrawler({
  requestHandler: router,
  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US',
      ],
    },
  },
  maxConcurrency: 10,            // ↑ parallel detail pages (batching effect)
  requestHandlerTimeoutSecs: 45, // short per-request cap
  maxRequestsPerCrawl: resultsWanted + 50,
  // keep memory/CPU in check; the pool will throttle if overloaded
  failedRequestHandler: async ({ request, error }: any) => {
    const msg = error && typeof error === 'object' && 'message' in error ? String((error as any).message) : '';
    console.error(`Request failed: ${request.url} ${msg ? `- ${msg}` : ''}`);
  },
});

const searchUrl = buildSearchUrl();
log.info(`Search URL: ${searchUrl}`);

await crawler.run([{ url: searchUrl, label: 'LIST' }]);

log.info(`Scraping completed. Collected ${collected} job listing(s).`);

await Actor.exit();
