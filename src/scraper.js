import { chromium } from 'playwright';
import * as readline from 'readline';

const AMPLITUDE_HOSTS = [
  'api.amplitude.com',
  'api2.amplitude.com',
  'api3.amplitude.com',
  'cdn.amplitude.com',
  'api.eu.amplitude.com',
];

function decodeAmplitudePayload(body, contentType) {
  try {
    if (contentType && contentType.includes('application/json')) {
      const json = JSON.parse(body);
      const events = json.e || json.events || [];
      return Array.isArray(events) ? events : [json];
    }
    const params = new URLSearchParams(body);
    const encoded = params.get('e') || params.get('event');
    if (encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const events = JSON.parse(decoded);
      return Array.isArray(events) ? events : [events];
    }
    const json = JSON.parse(body);
    const events = json.e || json.events || [json];
    return Array.isArray(events) ? events : [events];
  } catch {
    return [];
  }
}

/**
 * Fetches all URLs from a sitemap or sitemap index.
 */
async function fetchSitemapUrls(domain) {
  const sitemapUrl = `https://${domain}/sitemap.xml`;
  console.log(`\n  🗺️  Fetching sitemap: ${sitemapUrl}`);

  try {
    const res = await fetch(sitemapUrl);
    if (!res.ok) return null;
    const xml = await res.text();

    const urls = [];
    const isIndex = xml.includes('<sitemapindex');

    if (isIndex) {
      const subSitemaps = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
      console.log(`  🗺️  Found sitemap index with ${subSitemaps.length} sub-sitemaps`);

      const results = await Promise.allSettled(
        subSitemaps.map(async (subUrl) => {
          try {
            const r = await fetch(subUrl);
            if (!r.ok) return [];
            const subXml = await r.text();
            return [...subXml.matchAll(/<loc>(.*?)<\/loc>/g)]
              .map(m => m[1].trim())
              .filter(u => u.startsWith('http') && !u.endsWith('.xml'));
          } catch { return []; }
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') urls.push(...r.value);
      }
    } else {
      const found = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)]
        .map(m => m[1].trim())
        .filter(u => u.startsWith('http') && !u.endsWith('.xml'));
      urls.push(...found);
    }

    const unique = [...new Set(urls)];
    console.log(`  🗺️  Found ${unique.length} URLs in sitemap`);
    return unique;
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch sitemap: ${err.message}`);
    return null;
  }
}

/**
 * Waits for the user to press Enter in the terminal.
 */
function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function simulateInteractions(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let scrolled = 0;
        const interval = setInterval(() => {
          window.scrollBy(0, 200);
          scrolled += 200;
          if (scrolled >= document.body.scrollHeight) {
            clearInterval(interval);
            resolve();
          }
        }, 150);
      });
    });

    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const { width, height } = page.viewportSize();
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 4, height / 4);
    await page.mouse.move((width * 3) / 4, height / 2);

    const safeSelectors = [
      'nav a', 'header a', '.nav a',
      '[role="navigation"] a',
      'button:not([type="submit"])',
      '[class*="nav"] a',
      '[class*="menu"] a',
    ];

    for (const selector of safeSelectors) {
      try {
        const elements = await page.$$(selector);
        for (const el of elements.slice(0, 2)) {
          const isVisible = await el.isVisible();
          if (isVisible) {
            await el.hover();
            await page.waitForTimeout(300);
            break;
          }
        }
      } catch { }
    }

    await page.waitForTimeout(2000);
  } catch { }
}

export async function scrapeDomain(domain, options = {}) {
  const { maxPages = 10, headless = true, waitMs = 5000, manualLogin = false } = options;

  const startUrl = `https://${domain}`;
  const capturedEvents = [];
  const visitedUrls = new Set();

  console.log(`\n🔍 Starting scan of ${domain}`);

  // Try sitemap first
  let urlQueue = [];
  const sitemapUrls = await fetchSitemapUrls(domain);

  if (sitemapUrls && sitemapUrls.length > 0) {
    urlQueue = sitemapUrls.slice(0, maxPages);
    console.log(`  ✅ Using sitemap — will visit ${urlQueue.length} of ${sitemapUrls.length} pages`);
  } else {
    console.log(`  ℹ️  No sitemap found — crawling from homepage`);
    urlQueue = [startUrl];
  }

  // Manual login requires headed mode
  const launchHeadless = manualLogin ? false : headless;

  const browser = await chromium.launch({ headless: launchHeadless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // ── Manual login flow ────────────────────────────────────────────────────
  if (manualLogin) {
    console.log('\n' + '═'.repeat(50));
    console.log('  🔐 MANUAL LOGIN MODE');
    console.log('═'.repeat(50));
    console.log('  A browser window has opened.');
    console.log(`  1. Navigate to the login page on ${domain}`);
    console.log('  2. Log in with your credentials');
    console.log('  3. Once you are fully logged in, come back here');
    console.log('  4. Press ENTER to start scanning\n');

    // Open the homepage so the user has a starting point
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await waitForEnter('  ✋ Press ENTER when you are logged in and ready to scan...');

    console.log('\n  ✅ Login confirmed — starting scan!\n');
    console.log('═'.repeat(50) + '\n');
  }

  // ── Event interceptor ────────────────────────────────────────────────────
  page.on('request', async (request) => {
    const url = request.url();
    const isAmplitude = AMPLITUDE_HOSTS.some((h) => url.includes(h));
    if (!isAmplitude) return;
    try {
      const postData = request.postData() || '';
      const headers = request.headers();
      const contentType = headers['content-type'] || '';
      const events = decodeAmplitudePayload(postData, contentType);
      for (const ev of events) {
        if (!ev || !ev.event_type) continue;
        capturedEvents.push({
          event_type: ev.event_type,
          event_properties: ev.event_properties || {},
          user_properties: ev.user_properties || {},
          platform: ev.platform || null,
          os_name: ev.os_name || null,
          app_version: ev.app_version || null,
          captured_at: new Date().toISOString(),
          source_page: page.url(),
        });
        console.log(`  ✅ Event: ${ev.event_type}`);
      }
    } catch { }
  });

  page.on('response', async (response) => {
    const url = response.url();
    const isAmplitude = AMPLITUDE_HOSTS.some((h) => url.includes(h));
    if (!isAmplitude) return;
    console.log(`  📡 Amplitude endpoint hit: ${url.split('?')[0]}`);
  });

  // ── Crawl pages ──────────────────────────────────────────────────────────
  let pagesVisited = 0;

  while (urlQueue.length > 0 && pagesVisited < maxPages) {
    const url = urlQueue.shift();
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);

    try {
      console.log(`\n  📄 [${pagesVisited + 1}/${Math.min(urlQueue.length + pagesVisited + 1, maxPages)}] Visiting: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(waitMs);
      await simulateInteractions(page);
      await page.waitForTimeout(2000);
      pagesVisited++;

      // If NOT using sitemap, discover links normally
      if (!sitemapUrls && pagesVisited < maxPages) {
        const links = await page.evaluate((base) => {
          return Array.from(document.querySelectorAll('a[href]'))
            .map((a) => a.href)
            .filter((href) => {
              try {
                const u = new URL(href);
                const b = new URL(base);
                return u.hostname === b.hostname && !href.includes('#');
              } catch { return false; }
            })
            .slice(0, 20);
        }, startUrl);

        for (const link of links) {
          if (!visitedUrls.has(link)) urlQueue.push(link);
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  Could not load ${url}: ${err.message}`);
    }
  }

  await browser.close();
  console.log(`\n✔ Scan complete. ${capturedEvents.length} events captured across ${pagesVisited} pages.\n`);
  return capturedEvents;
}