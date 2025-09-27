import { Actor, log, KeyValueStore } from 'apify';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter } from 'crawlee';
import type { Page } from 'playwright';

/********************
 * Workable Scraper – Single-file main.ts
 * - Robust against SPA + Shadow DOM
 * - JSON-LD first (JobPosting), DOM/shadow fallbacks
 * - Anti-bot hardening (UA, headers, timezone)
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

// Traverse document + shadow roots + iframes to grab links to /view/
async function collectViewLinksDeep(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const out = new Set<string>();

    const addLinks = (root: Document | ShadowRoot) => {
      root.querySelectorAll?.('a[href^="/view/"]').forEach((a) => {
        try {
          const href = (a as HTMLAnchorElement).href || (a as HTMLAnchorElement).getAttribute('href')!;
          if (href) out.add(new URL(href, location.origin).href);
        } catch {}
      });
    };

    const visit = (root: Document | ShadowRoot) => {
      addLinks(root);
      const walker = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode as Element | null;
      while (node) {
        const sr = (node as any).shadowRoot as ShadowRoot | null;
        if (sr) {
          addLinks(sr);
          const innerWalker = document.createTreeWalker(sr as any, NodeFilter.SHOW_ELEMENT);
          let inner = innerWalker.currentNode as Element | null;
          while (inner) {
            const innerSr = (inner as any).shadowRoot as ShadowRoot | null;
            if (innerSr) addLinks(innerSr);
            inner = innerWalker.nextNode() as Element | null;
          }
        }
        node = walker.nextNode() as Element | null;
      }
    };

    visit(document);

    // same-origin iframes
    document.querySelectorAll('iframe').forEach((ifr) => {
      try {
        const doc = (ifr as HTMLIFrameElement).contentDocument;
        if (doc) visit(doc);
      } catch {}
    });

    return Array.from(out);
  });
}

async function humanize(page: Page) {
  try {
    await page.mouse.move(100 + Math.random() * 200, 120 + Math.random() * 120, { steps: 10 });
    await sleep(100 + Math.random() * 200);
    await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 300));
    await sleep(120 + Math.random() * 240);
  } catch {}
}

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

// ---- JSON-LD parser (JobPosting) ----
type JobPosting = {
  '@type'?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string } | { name?: string }[];
  jobLocation?: (
    | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }
    | { addressLocality?: string; addressRegion?: string; addressCountry?: string }
  ) | Array<any>;
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
      const parsed = JSON.parse(blob);
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
  const addr = first?.address || first;
  if (!addr) return null;
  const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function extractCompanyFromLD(job: Partial<JobPosting> | null): string | null {
  if (!job?.hiringOrganization) return null;
  const org = Array.isArray(job.hiringOrganization) ? job.hiringOrganization[0] : job.hiringOrganization;
  return (org as any)?.name || null;
}

// Shadow-aware HTML picker (for description fallback)
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

    // document first
    let html = tryIn(document);
    if (html) return html;

    // walk shadow roots
    const walk = (root: Document | ShadowRoot): string | null => {
      const tw = document.createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT);
      let node = tw.currentNode as Element | null;
      while (node) {
        const sr = (node as any).shadowRoot as ShadowRoot | null;
        if (sr) {
          const got = tryIn(sr);
          if (got) return got;
          const innerTw = document.createTreeWalker(sr as any, NodeFilter.SHOW_ELEMENT);
          let inner = innerTw.currentNode as Element | null;
          while (inner) {
            const innerSr = (inner as any).shadowRoot as ShadowRoot | null;
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

    // last resort: same-origin iframes
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

// Text fallback for job type if LD missing (looks for common tokens)
async function guessEmploymentTypeFromDOM(page: Page): Promise<string | null> {
  const text = await page.evaluate(() => document.body?.innerText || '');
  const tokens = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Apprenticeship', 'Freelance'];
  const found = tokens.filter((t) => new RegExp(`\\b${t.replace('-', '[- ]?')}\\b`, 'i').test(text));
  return found.length ? Array.from(new Set(found)).join(', ') : null;
}

let collected = 0;
const seenUrls = new Set<string>();

const router = createPlaywrightRouter();

router.addHandler('LIST', async ({ page, request, log, crawler }) => {
  log.info(`Processing list page: ${request.url}`);

  // Only abort heavy media. DO NOT block CSS or fonts.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(?:png|jpg|jpeg|gif|webp|ico|mp4|webm)(?:\?|$)/i.test(url)) return route.abort();
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 900 });

  // Anti-bot hints before any site JS runs
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] as any });
      Object.defineProperty(Notification, 'permission', { get: () => 'denied' as any });
    } catch {}
  });

  // Set UA, headers, timezone; Chromium-only CDP
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await cdp.send('Network.setExtraHTTPHeaders', {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-CH-UA': '"Chromium";v="120", "Not=A?Brand";v="99", "Google Chrome";v="120"',
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-CH-UA-Mobile': '?0',
      },
    });
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/London' });
  } catch {}

  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle').catch(() => void 0);

  // Cookie banners
  const cookieButtons = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all cookies")',
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

  await humanize(page);

  const cardSelector =
    '[data-ui="job-card"], [data-testid="job-card"], li[data-ui="job-card"], div[data-ui="job-card"]';

  // Wait for any evidence of results
  try {
    await Promise.race([
      page.waitForSelector(cardSelector, { timeout: 60_000, state: 'attached' }),
      page.waitForSelector('a[href^="/view/"]', { timeout: 60_000, state: 'attached' }),
    ]);
  } catch (err) {
    log.warning('Job cards/links not found within timeout. Saving HTML + screenshot.');
    const html = await page.content();
    await KeyValueStore.setValue('LIST_HTML_DEBUG', html, { contentType: 'text/html' });
    const screenshot = await page.screenshot({ fullPage: true });
    await KeyValueStore.setValue('LIST_SCREENSHOT_DEBUG', screenshot, { contentType: 'image/png' });
    throw err;
  }

  // Real window scrolling until stable or we have enough
  let lastSeen = 0;
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.max(600, Math.random() * 900)));
    await sleep(700 + Math.floor(Math.random() * 500));

    const [cardCount, linkCount] = await Promise.all([
      page.locator(cardSelector).count().catch(() => 0),
      page.locator('a[href^="/view/"]').count().catch(() => 0),
    ]);
    const deepCount = (await collectViewLinksDeep(page)).length;
    const seen = Math.max(cardCount, linkCount, deepCount);

    if (seen >= resultsWanted || seen === lastSeen) break;
    lastSeen = seen;
  }

  // Collect links from main DOM + shadows + iframes
  const mainLinks: string[] = (await page
    .$$eval('a[href^="/view/"]', (as) =>
      Array.from(new Set(as.map((a) => new URL((a as HTMLAnchorElement).href, location.origin).href))),
    )
    .catch(() => [])) as string[];
  const deepLinks = await collectViewLinksDeep(page);
  const links = Array.from(new Set([...mainLinks, ...deepLinks]));

  if (!links.length) {
    log.warning('No detail links found after scroll. Saving artifacts.');
    const html = await page.content();
    await KeyValueStore.setValue('LIST_HTML_DEBUG_EMPTY', html, { contentType: 'text/html' });
    const screenshot = await page.screenshot({ fullPage: true });
    await KeyValueStore.setValue('LIST_SCREENSHOT_DEBUG_EMPTY', screenshot, { contentType: 'image/png' });
  }

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

  // Keep media abort, allow CSS/fonts
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(?:png|jpg|jpeg|gif|webp|ico|mp4|webm)(?:\?|$)/i.test(url)) return route.abort();
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await cdp.send('Network.setExtraHTTPHeaders', {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-CH-UA': '"Chromium";v="120", "Not=A?Brand";v="99", "Google Chrome";v="120"',
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-CH-UA-Mobile': '?0',
      },
    });
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/London' });
  } catch {}

  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle').catch(() => void 0);

  // --- Extraction with JSON-LD first + DOM/shadow fallbacks ---
  const ld = await parseJobPostingJSONLD(page);

  const title =
    ld?.title ?? (await page.locator('h1, h2').first().textContent().catch(() => ''))?.trim() ?? '';

  const datePosted = ld?.datePosted ?? null;

  // Company
  let company =
    extractCompanyFromLD(ld) ??
    (
      await page
        .locator('[data-ui="company-name"], [data-testid="company-name"], a[href*="/company/"]')
        .first()
        .textContent()
        .catch(() => '')
    )?.trim() ??
    '';

  // Location
  let locationText =
    extractLocationFromLD(ld) ??
    (
      await page
        .locator('[data-ui="job-location"], [data-testid="job-location"], [data-ui="location"], header a[href*="/search/"]')
        .first()
        .textContent()
        .catch(() => '')
    )?.trim() ??
    '';

  // Employment type / Job type
  let employmentType =
    normalizeEmploymentType(ld?.employmentType ?? null) ??
    (await guessEmploymentTypeFromDOM(page));

  // HTML Description (prefer LD if it’s HTML, else DOM-shadow fallback)
  let descriptionHtml: string;
  if (ld?.description && /<\w+/.test(ld.description)) {
    descriptionHtml = ld.description;
  } else {
    descriptionHtml =
      (await getInnerHTMLDeep(page, [
        '[data-ui="job-description"]',
        '[data-ui="description"]',
        'article',
      ])) ||
      (`<p>${(await page.locator('article').first().textContent().catch(() => '')).trim()}</p>`);
  }

  const validThrough = (ld as any)?.validThrough ?? null;
  const externalId =
    (Array.isArray((ld as any)?.identifier)
      ? (ld as any).identifier[0]?.value
      : (ld as any)?.identifier?.value) ?? null;

  const item = {
    url: request.url,
    title,
    company,
    location: locationText,
    datePosted,
    employmentType: employmentType ?? null,
    validThrough,
    externalId,
    descriptionHtml,
    scrapedAt: new Date().toISOString(),
  };

  await Dataset.pushData(item);
  collected++;
  log.info(`Saved job (${collected}/${resultsWanted}).`);
});

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
  maxConcurrency: 2,
  requestHandlerTimeoutSecs: 120,
  maxRequestsPerCrawl: resultsWanted + 50,
  failedRequestHandler: async ({ request }) => {
    log.error(`Request failed too many times: ${request.url}`);
  },
});

const searchUrl = buildSearchUrl();
log.info(`Search URL: ${searchUrl}`);

await crawler.run([{ url: searchUrl, label: 'LIST' }]);

log.info(`Scraping completed. Collected ${collected} job listing(s).`);

await Actor.exit();
