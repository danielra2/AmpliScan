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

async function installInteractionTracker(context) {
  await context.addInitScript(() => {
    function selectorFor(el) {
      if (!el || !el.tagName) return 'unknown';
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;

      const classes = Array.from(el.classList || []).slice(0, 2).join('.');
      if (classes) return `${el.tagName.toLowerCase()}.${classes}`;

      const parent = el.parentElement;
      if (!parent) return el.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter((n) => n.tagName === el.tagName);
      const index = Math.max(1, siblings.indexOf(el) + 1);
      return `${el.tagName.toLowerCase()}:nth-of-type(${index})`;
    }

    function storeInteraction(target, clientX = null, clientY = null) {
      if (!target) return;

      const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
      const x = typeof clientX === 'number' ? clientX : rect ? rect.left + rect.width / 2 : null;
      const y = typeof clientY === 'number' ? clientY : rect ? rect.top + rect.height / 2 : null;

      window.__ampliscanLastInteraction = {
        ts: Date.now(),
        pageUrl: window.location.href,
        selector: selectorFor(target),
        tag: target.tagName ? target.tagName.toLowerCase() : null,
        text: (target.innerText || target.textContent || '').trim().slice(0, 80),
        x,
        y,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    }

    document.addEventListener(
      'click',
      (event) => {
        storeInteraction(event.target, event.clientX, event.clientY);
      },
      { capture: true }
    );

    document.addEventListener(
      'submit',
      (event) => {
        const form = event.target;
        if (!form) return;
        const rect = form.getBoundingClientRect ? form.getBoundingClientRect() : null;
        storeInteraction(form, rect ? rect.left + rect.width / 2 : null, rect ? rect.top + rect.height / 2 : null);
      },
      { capture: true }
    );
  });
}

async function performLogin(page, username, password, loginUrl) {
  try {
    console.log(`🔐 Attempting login at ${loginUrl}`);
    
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);

    // Common email/username field selectors
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[id*="email"]',
      'input[id*="username"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
    ];

    // Common password field selectors
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[id*="password"]',
    ];

    // Common submit button selectors
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'button:has-text("Login")',
      '[role="button"]:has-text("Log in")',
    ];

    // Try to fill email field
    let emailFilled = false;
    for (const selector of emailSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.fill(username);
          emailFilled = true;
          console.log(`  ✓ Filled email/username field`);
          break;
        }
      } catch { }
    }

    if (!emailFilled) {
      console.warn(`  ⚠️  Could not find email/username field`);
      return false;
    }

    // Try to fill password field
    let passwordFilled = false;
    for (const selector of passwordSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.fill(password);
          passwordFilled = true;
          console.log(`  ✓ Filled password field`);
          break;
        }
      } catch { }
    }

    if (!passwordFilled) {
      console.warn(`  ⚠️  Could not find password field`);
      return false;
    }

    // Click submit button
    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          submitted = true;
          console.log(`  ✓ Clicked login button`);
          break;
        }
      } catch { }
    }

    if (!submitted) {
      console.warn(`  ⚠️  Could not find submit button`);
      return false;
    }

    // Wait for navigation after login
    try {
      await page.waitForNavigation({ timeout: 10000 });
    } catch {
      // Navigation might not happen, that's ok
    }

    await page.waitForTimeout(2000);
    console.log(`  ✅ Login successful, starting authenticated crawl`);
    return true;
  } catch (err) {
    console.error(`  ❌ Login failed: ${err.message}`);
    return false;
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
  const { maxPages = 10, headless = true, waitMs = 5000, username = null, password = null, loginUrl = null } = options;

  const startUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const capturedEvents = [];
  const visitedUrls = new Set();
  let queuedUrls = [startUrl];

  console.log(`\n🔍 Starting scan of ${domain}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  await installInteractionTracker(context);

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
      const lastInteraction = await page
        .evaluate(() => window.__ampliscanLastInteraction || null)
        .catch(() => null);
      const now = Date.now();

      for (const ev of events) {
        if (!ev || !ev.event_type) continue;

        const isRecentInteraction =
          lastInteraction &&
          lastInteraction.pageUrl === page.url() &&
          typeof lastInteraction.ts === 'number' &&
          now - lastInteraction.ts <= 5000;

        capturedEvents.push({
          event_type: ev.event_type,
          event_properties: ev.event_properties || {},
          user_properties: ev.user_properties || {},
          platform: ev.platform || null,
          os_name: ev.os_name || null,
          app_version: ev.app_version || null,
          captured_at: new Date().toISOString(),
          source_page: page.url(),
          interaction: isRecentInteraction
            ? {
                selector: lastInteraction.selector || null,
                tag: lastInteraction.tag || null,
                text: lastInteraction.text || null,
                x: lastInteraction.x,
                y: lastInteraction.y,
                viewport_width: lastInteraction.viewportWidth || null,
                viewport_height: lastInteraction.viewportHeight || null,
              }
            : null,
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

  // Perform login if credentials provided
  if (username && password && loginUrl) {
    const loginSuccess = await performLogin(page, username, password, loginUrl);
    if (!loginSuccess) {
      console.warn(`\n⚠️  Login failed, proceeding with anonymous crawl`);
    }
  }

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