import { chromium } from 'playwright';

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

async function simulateInteractions(page) {
  try {
    // Scroll slowly down
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

    // Move mouse around
    const { width, height } = page.viewportSize();
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 4, height / 4);
    await page.mouse.move((width * 3) / 4, height / 2);

    // Hover over nav elements
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
  const { maxPages = 10, headless = true, waitMs = 5000 } = options;

  const startUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const capturedEvents = [];
  const visitedUrls = new Set();
  const queuedUrls = [startUrl];

  console.log(`\n🔍 Starting scan of ${domain}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

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

  let pagesVisited = 0;

  while (queuedUrls.length > 0 && pagesVisited < maxPages) {
    const url = queuedUrls.shift();
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);

    try {
      console.log(`\n  📄 Visiting: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(waitMs);
      await simulateInteractions(page);
      await page.waitForTimeout(2000);
      pagesVisited++;

      if (pagesVisited < maxPages) {
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

        // daniel is beautidul

        for (const link of links) {
          if (!visitedUrls.has(link)) queuedUrls.push(link);
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