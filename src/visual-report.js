import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

// ─── Internal Amplitude system events to filter out for non-technical audience
const INTERNAL_EVENTS = new Set([
  '$identify', '$exposure', '$impression', '$anon_identify',
  '[Amplitude] Page Viewed', '[Amplitude] Viewport Content Updated',
  '[Amplitude] Network Request', 'session_start', 'session_end',
]);

const DB_PATH = './reports/events-db.json';

function loadDB() {
  if (!existsSync(DB_PATH)) return {};
  try { return JSON.parse(readFileSync(DB_PATH, 'utf-8')); } catch { return {}; }
}

/**
 * Groups events by source page, deduplicating by event_type per page.
 */
function groupEventsByPage(events, filterInternal = true) {
  const pageMap = new Map();
  for (const ev of events) {
    const url = ev.source_page;
    if (!url) continue;
    if (filterInternal && INTERNAL_EVENTS.has(ev.event_type)) continue;
    if (!pageMap.has(url)) pageMap.set(url, []);
    const existing = pageMap.get(url);
    if (!existing.find((e) => e.event_type === ev.event_type)) {
      existing.push(ev);
    }
  }
  return pageMap;
}

/**
 * Returns which event names are NEW for this domain vs the DB.
 */
function getNewEventNames(domain) {
  const db = loadDB();
  const previousEvents = db[domain]?.events || {};
  return new Set(Object.keys(previousEvents));
}

/**
 * Returns pages that have at least one new event (for repeat scans).
 * On first scan, returns all pages.
 */
function filterPagesWithNewEvents(pageMap, previousEventNames) {
  if (previousEventNames.size === 0) return pageMap; // first scan — show all

  const filtered = new Map();
  for (const [url, events] of pageMap) {
    const hasNew = events.some((ev) => !previousEventNames.has(ev.event_type));
    if (hasNew) filtered.set(url, events);
  }
  // If nothing is new (e.g. no changes), fall back to showing all pages
  return filtered.size > 0 ? filtered : pageMap;
}

/**
 * Takes a full-page screenshot.
 */
async function screenshotPage(page, url, outputPath) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } catch (err) {
    console.warn(`  ⚠️  Screenshot failed for ${url}: ${err.message}`);
    return false;
  }
}

/**
 * Generates the full HTML report.
 */
function generateHTML(domain, pages, meta) {
  const { staleDays, newEventNames, droppedEvents, previousEventNames, isFirstScan } = meta;

  const scannedAt = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const totalUniqueEvents = new Set(pages.flatMap(p => p.events.map(e => e.event_type))).size;
  const totalNewEvents = pages.flatMap(p => p.events).filter(e => !previousEventNames.has(e.event_type)).length;

  // Staleness color
  const staleColor = staleDays === null ? '#6b6b80'
    : staleDays > 60 ? '#ff4d6d'
    : staleDays > 30 ? '#ffd166'
    : '#00d4aa';

  const staleText = staleDays === null
    ? 'First scan'
    : staleDays === 0 ? 'Scanned today'
    : `${staleDays}d since last scan`;

  const ampLogo = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#1A6BFF"/><path d="M6 16L9.5 8L12 13L14 10L18 16" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  // ── Page cards ──
  const pageCards = pages.map((p, i) => {
    const urlDisplay = p.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const screenshotSrc = p.screenshotFile ? `screenshots/${p.screenshotFile}` : null;

    const eventItems = p.events.map((ev) => {
      const isNew = !previousEventNames.has(ev.event_type);
      const props = Object.keys(ev.event_properties || {});
      const propsHtml = props.length
        ? `<div class="props">${props.slice(0, 6).map(k => `<span class="prop-tag">${k}</span>`).join('')}${props.length > 6 ? `<span class="prop-tag more">+${props.length - 6}</span>` : ''}</div>`
        : '';

      return `
        <div class="event-item ${isNew ? 'is-new' : ''}">
          <div class="event-header">
            <span class="amp-dot">${ampLogo}</span>
            <span class="event-name">${ev.event_type}</span>
            ${isNew ? `<span class="new-badge">NEW</span>` : ''}
          </div>
          ${propsHtml}
        </div>`;
    }).join('');

    const newOnPage = p.events.filter(e => !previousEventNames.has(e.event_type)).length;

    return `
      <div class="page-card" style="animation-delay:${i * 0.07}s" id="page-${i}">
        <div class="card-header">
          <div class="page-meta">
            <span class="page-number">${String(i + 1).padStart(2, '0')}</span>
            <div class="page-info">
              <div class="page-url">${urlDisplay}</div>
              <div class="page-counts">
                <span class="event-count">${p.events.length} event${p.events.length !== 1 ? 's' : ''}</span>
                ${newOnPage > 0 ? `<span class="new-count">+${newOnPage} new</span>` : ''}
              </div>
            </div>
          </div>
          <a href="${p.url}" target="_blank" class="visit-link">↗ Open</a>
        </div>
        <div class="card-body">
          <div class="screenshot-col">
            ${screenshotSrc
              ? `<img src="${screenshotSrc}" alt="${urlDisplay}" loading="lazy" />`
              : `<div class="no-screenshot">No screenshot</div>`
            }
          </div>
          <div class="events-col">
            <div class="events-label">Tracked Events</div>
            <div class="events-list">${eventItems}</div>
          </div>
        </div>
      </div>`;
  }).join('');

  // ── Dropped events section ──
  const droppedSection = droppedEvents.length > 0 ? `
    <div class="dropped-section">
      <div class="dropped-title">❌ Dropped Events <span class="dropped-sub">No longer firing since last scan</span></div>
      <div class="dropped-list">
        ${droppedEvents.map(e => `<span class="dropped-tag">${e}</span>`).join('')}
      </div>
    </div>` : '';

  // ── Scan mode banner ──
  const scanModeBanner = isFirstScan
    ? `<div class="mode-banner first">📋 First scan — showing all pages with tracked events</div>`
    : `<div class="mode-banner repeat">🔄 Repeat scan — showing only pages with new events${pages.length === 0 ? ' (none found)' : ''}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>AmpliScan — ${domain}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0a0a0f;--surface:#111118;--surface2:#18181f;
      --border:#2a2a35;--accent:#1A6BFF;--accent2:#00d4aa;
      --text:#e8e8f0;--muted:#6b6b80;--dim:#3a3a4a;
      --red:#ff4d6d;--yellow:#ffd166;--green:#00d4aa;--r:12px;
    }
    html{scroll-behavior:smooth}
    body{font-family:'Syne',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}

    /* Header */
    .header{background:var(--surface);border-bottom:1px solid var(--border);padding:28px 48px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
    .logo{display:flex;align-items:center;gap:12px}
    .logo-icon{width:34px;height:34px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center}
    .logo-text{font-size:19px;font-weight:800;letter-spacing:-.5px}
    .logo-sub{font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);margin-top:2px}
    .header-right{text-align:right}
    .header-domain{font-size:15px;font-weight:700;color:var(--accent2)}
    .header-date{font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);margin-top:3px}

    /* Stats */
    .stats-bar{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border)}
    .stat{flex:1;background:var(--surface);padding:18px 32px;display:flex;flex-direction:column;gap:4px}
    .stat-value{font-size:30px;font-weight:800;letter-spacing:-1px}
    .stat-value.blue{color:var(--accent)}
    .stat-value.green{color:var(--accent2)}
    .stat-label{font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}

    /* Mode banner */
    .mode-banner{padding:12px 48px;font-family:'DM Mono',monospace;font-size:12px;border-bottom:1px solid var(--border)}
    .mode-banner.first{background:rgba(26,107,255,.08);color:var(--accent)}
    .mode-banner.repeat{background:rgba(0,212,170,.08);color:var(--accent2)}

    /* Main */
    .main{padding:40px 48px;max-width:1400px;margin:0 auto;display:flex;flex-direction:column;gap:28px}

    /* Dropped */
    .dropped-section{background:rgba(255,77,109,.06);border:1px solid rgba(255,77,109,.2);border-radius:var(--r);padding:20px 24px}
    .dropped-title{font-size:14px;font-weight:700;color:var(--red);margin-bottom:12px}
    .dropped-sub{font-weight:400;font-size:12px;color:var(--muted);margin-left:8px}
    .dropped-list{display:flex;flex-wrap:wrap;gap:8px}
    .dropped-tag{font-family:'DM Mono',monospace;font-size:11px;padding:4px 10px;border-radius:6px;background:rgba(255,77,109,.1);color:var(--red);border:1px solid rgba(255,77,109,.2)}

    /* Page card */
    .page-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;opacity:0;transform:translateY(14px);animation:fadeUp .35s ease forwards}
    @keyframes fadeUp{to{opacity:1;transform:translateY(0)}}
    .card-header{padding:16px 24px;border-bottom:1px solid var(--border);background:var(--surface2);display:flex;align-items:center;justify-content:space-between}
    .page-meta{display:flex;align-items:center;gap:14px}
    .page-number{font-family:'DM Mono',monospace;font-size:12px;color:var(--dim)}
    .page-url{font-size:14px;font-weight:700;word-break:break-all}
    .page-counts{display:flex;align-items:center;gap:8px;margin-top:3px}
    .event-count{font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)}
    .new-count{font-family:'DM Mono',monospace;font-size:11px;color:var(--accent2);background:rgba(0,212,170,.1);padding:1px 7px;border-radius:4px;border:1px solid rgba(0,212,170,.2)}
    .visit-link{font-family:'DM Mono',monospace;font-size:11px;color:var(--muted);text-decoration:none;padding:5px 10px;border:1px solid var(--border);border-radius:6px;flex-shrink:0;transition:color .15s,border-color .15s}
    .visit-link:hover{color:var(--text);border-color:var(--muted)}

    .card-body{display:grid;grid-template-columns:1fr 320px;min-height:300px}

    /* Screenshot */
    .screenshot-col{border-right:1px solid var(--border);overflow:hidden;background:#000;position:relative}
    .screenshot-col img{width:100%;height:100%;object-fit:cover;object-position:top;display:block;opacity:.88;transition:opacity .2s}
    .screenshot-col:hover img{opacity:1}
    .no-screenshot{display:flex;align-items:center;justify-content:center;height:100%;min-height:280px;color:var(--dim);font-family:'DM Mono',monospace;font-size:12px}

    /* Events */
    .events-col{padding:16px;overflow-y:auto;max-height:460px}
    .events-label{font-family:'DM Mono',monospace;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
    .events-list{display:flex;flex-direction:column;gap:7px}
    .event-item{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 11px;transition:border-color .15s}
    .event-item:hover{border-color:var(--accent)}
    .event-item.is-new{border-color:rgba(0,212,170,.3);background:rgba(0,212,170,.04)}
    .event-header{display:flex;align-items:center;gap:7px}
    .amp-dot{flex-shrink:0;display:flex;align-items:center}
    .event-name{font-family:'DM Mono',monospace;font-size:11px;font-weight:500;color:var(--text);word-break:break-word;flex:1}
    .new-badge{font-family:'DM Mono',monospace;font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(0,212,170,.15);color:var(--accent2);border:1px solid rgba(0,212,170,.3);flex-shrink:0}
    .props{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
    .prop-tag{font-family:'DM Mono',monospace;font-size:9px;padding:2px 5px;border-radius:3px;background:var(--surface2);color:var(--accent2);border:1px solid var(--border)}
    .prop-tag.more{color:var(--muted)}

    /* Footer */
    .footer{text-align:center;padding:36px;border-top:1px solid var(--border);font-family:'DM Mono',monospace;font-size:11px;color:var(--dim)}

    @media(max-width:900px){
      .card-body{grid-template-columns:1fr}
      .screenshot-col{border-right:none;border-bottom:1px solid var(--border);min-height:180px}
      .header,.main,.mode-banner{padding-left:20px;padding-right:20px}
      .stats-bar{flex-wrap:wrap}
    }
  </style>
</head>
<body>

<header class="header">
  <div class="logo">
    <div class="logo-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 18L8.5 7L12 14L15 10L20 18" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div>
      <div class="logo-text">AmpliScan</div>
      <div class="logo-sub">Event Visual Map</div>
    </div>
  </div>
  <div class="header-right">
    <div class="header-domain">${domain}</div>
    <div class="header-date">Generated ${scannedAt}</div>
  </div>
</header>

<div class="stats-bar">
  <div class="stat">
    <div class="stat-value blue">${pages.length}</div>
    <div class="stat-label">Pages Mapped</div>
  </div>
  <div class="stat">
    <div class="stat-value green">${totalUniqueEvents}</div>
    <div class="stat-label">Unique Events</div>
  </div>
  <div class="stat">
    <div class="stat-value" style="color:${staleColor}">${staleText}</div>
    <div class="stat-label">Staleness</div>
  </div>
  ${!isFirstScan ? `
  <div class="stat">
    <div class="stat-value" style="color:var(--accent2)">${totalNewEvents}</div>
    <div class="stat-label">New Events</div>
  </div>` : ''}
</div>

${scanModeBanner}

<main class="main">
  ${droppedSection}
  ${pageCards}
</main>

<footer class="footer">
  AmpliScan · ${domain} · ${scannedAt} · Internal Amplitude system events filtered
</footer>

</body>
</html>`;
}

/**
 * Main export.
 */
export async function generateVisualReport(domain, events, options = {}) {
  const { pageLimit = 8, headless = true, staleDays = null, droppedEvents = [] } = options;

  // Load previous event names for diff
  const previousEventNames = getNewEventNames(domain);
  const isFirstScan = previousEventNames.size === 0;

  // Group by page, filter internal events
  const pageMap = groupEventsByPage(events, true);
  if (pageMap.size === 0) return null;

  // On repeat scans: only show pages with new events
  const filteredPageMap = filterPagesWithNewEvents(pageMap, previousEventNames);

  // Sort by event count, apply limit
  const sortedPages = [...filteredPageMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, pageLimit);

  if (sortedPages.length === 0) {
    console.log('  ℹ️  No pages with new events found — skipping visual report.');
    return null;
  }

  // Create dirs
  const reportDir = `./reports/visual-${domain}-${new Date().toISOString().split('T')[0]}`;
  const screenshotsDir = `${reportDir}/screenshots`;
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true });

  console.log(`\n  📸 ${isFirstScan ? 'First scan' : 'Repeat scan'} — screenshotting ${sortedPages.length} page(s)...`);

  // Screenshots
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const pagesData = [];
  for (const [url, pageEvents] of sortedPages) {
    const safeName = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').slice(0, 60);
    const filename = `${safeName}.png`;
    const filepath = `${screenshotsDir}/${filename}`;
    console.log(`  📸 ${url}`);
    const success = await screenshotPage(page, url, filepath);
    pagesData.push({ url, events: pageEvents, screenshotFile: success ? filename : null });
  }

  await browser.close();

  // Generate report
  const html = generateHTML(domain, pagesData, {
    staleDays,
    newEventNames: new Set(),
    droppedEvents,
    previousEventNames,
    isFirstScan,
  });

  const reportPath = `${reportDir}/index.html`;
  writeFileSync(reportPath, html);
  console.log(`\n  ✅ Visual report → ${reportPath}`);

  return { reportPath, pagesAnalyzed: pagesData.length, totalEvents: events.length };
}