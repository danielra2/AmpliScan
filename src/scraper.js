import { chromium } from 'playwright';

const AMPLITUDE_HOSTS = [
  'api.amplitude.com',
  'api2.amplitude.com',
  'api3.amplitude.com',
  'cdn.amplitude.com',
];

/**
 * Decodes an Amplitude network request payload into a list of events.
 * Amplitude sends events as either:
 *  - JSON body: { e: [...] } or { events: [...] }
 *  - URLencoded: e=<base64> or checksum=...&e=...
 */
function decodeAmplitudePayload(body, contentType) {
  try {
    // JSON payload
    if (contentType && contentType.includes('application/json')) {
      const json = JSON.parse(body);
      const events = json.e || json.events || [];
      return Array.isArray(events) ? events : [json];
    }

    // URL-encoded payload (classic SDK)
    const params = new URLSearchParams(body);
    const encoded = params.get('e') || params.get('event');
    if (encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const events = JSON.parse(decoded);
      return Array.isArray(events) ? events : [events];
    }

    // Fallback: try raw JSON
    const json = JSON.parse(body);
    const events = json.e || json.events || [json];
    return Array.isArray(events) ? events : [events];
  } catch {
    return [];
  }
}

/**
 * Scrapes a domain by visiting a set of pages and intercepting all
 * Amplitude requests. Returns an array of normalised event objects.
 */
export async function scrapeDomain(domain, options = {}) {
  const {
    maxPages = 10,
    headless = true,
    waitMs = 3000,
  } = options;

  const startUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const capturedEvents = [];
  const visitedUrls = new Set();
  const queuedUrls = [startUrl];

  console.log(`\n🔍 Starting scan of ${domain}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Intercept all requests
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
    } catch {
      // silently skip malformed payloads
    }
  });

  let pagesVisited = 0;

  while (queuedUrls.length > 0 && pagesVisited < maxPages) {
    const url = queuedUrls.shift();
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);

    try {
      console.log(`\n  📄 Visiting: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(waitMs);

      // Scroll to trigger lazy-loaded tracking
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);

      pagesVisited++;

      // Collect same-domain links
      if (pagesVisited < maxPages) {
        const links = await page.evaluate((base) => {
          return Array.from(document.querySelectorAll('a[href]'))
            .map((a) => a.href)
            .filter((href) => href.startsWith(base) && !href.includes('#'))
            .slice(0, 20);
        }, startUrl);

        for (const link of links) {
          if (!visitedUrls.has(link)) queuedUrls.push(link);
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  Could not load ${url}: ${err.message}`);
    }
  }

  await browser.close();

  console.log(
    `\n✔ Scan complete. ${capturedEvents.length} events captured across ${pagesVisited} pages.\n`
  );

  return capturedEvents;
}