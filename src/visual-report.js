import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

function sanitizeForFile(input) {
  return String(input || 'page')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function eventPageUrl(event) {
  const props = event.event_properties || {};
  return (
    normalizeUrl(event.source_page) ||
    normalizeUrl(props['[Amplitude] Page URL']) ||
    normalizeUrl(props['[Amplitude] Page Location']) ||
    normalizeUrl(props.url) ||
    normalizeUrl(props.page_url) ||
    normalizeUrl(props.pageUrl)
  );
}

function clip(text, max = 120) {
  const raw = String(text ?? '');
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}...`;
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarizeEventsByPage(events) {
  const pages = new Map();

  for (const event of events) {
    const pageUrl = eventPageUrl(event);
    if (!pageUrl) continue;

    if (!pages.has(pageUrl)) {
      pages.set(pageUrl, {
        url: pageUrl,
        totalEvents: 0,
        eventsByType: new Map(),
      });
    }

    const page = pages.get(pageUrl);
    page.totalEvents += 1;

    const key = event.event_type || 'unknown_event';
    if (!page.eventsByType.has(key)) {
      page.eventsByType.set(key, {
        eventType: key,
        count: 0,
        properties: event.event_properties || {},
        interactions: [],
      });
    }

    const typed = page.eventsByType.get(key);
    typed.count += 1;

    const interaction = event.interaction;
    if (
      interaction &&
      Number.isFinite(interaction.x) &&
      Number.isFinite(interaction.y) &&
      Number.isFinite(interaction.viewport_width) &&
      Number.isFinite(interaction.viewport_height)
    ) {
      typed.interactions.push({
        x: interaction.x,
        y: interaction.y,
        viewportWidth: interaction.viewport_width,
        viewportHeight: interaction.viewport_height,
        selector: interaction.selector || null,
        text: interaction.text || null,
      });
    }
  }

  return [...pages.values()]
    .map((page) => {
      const groupedEvents = [...page.eventsByType.values()].sort((a, b) => b.count - a.count);
      return {
        ...page,
        groupedEvents,
      };
    })
    .sort((a, b) => b.totalEvents - a.totalEvents);
}

function markerForEvent(eventGroup, screenshotInfo) {
  if (!eventGroup.interactions.length) return null;

  let totalX = 0;
  let totalY = 0;

  for (const sample of eventGroup.interactions) {
    const scaleX = screenshotInfo.width / sample.viewportWidth;
    const scaleY = screenshotInfo.height / sample.viewportHeight;
    totalX += sample.x * scaleX;
    totalY += sample.y * scaleY;
  }

  const avgX = totalX / eventGroup.interactions.length;
  const avgY = totalY / eventGroup.interactions.length;
  const leftPct = Math.max(1, Math.min(99, (avgX / screenshotInfo.width) * 100));
  const topPct = Math.max(2, Math.min(98, (avgY / screenshotInfo.height) * 100));

  return {
    leftPct,
    topPct,
    selector: eventGroup.interactions[0]?.selector || null,
    text: eventGroup.interactions[0]?.text || null,
  };
}

async function capturePageScreenshots(pageGroups, outputDir, options = {}) {
  const viewport = options.viewport || DEFAULT_VIEWPORT;
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const screenshots = new Map();

  for (let i = 0; i < pageGroups.length; i += 1) {
    const pageGroup = pageGroups[i];
    const fileName = `${String(i + 1).padStart(2, '0')}-${sanitizeForFile(new URL(pageGroup.url).pathname || 'home')}.png`;
    const targetPath = path.join(outputDir, fileName);

    try {
      await page.goto(pageGroup.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: targetPath, fullPage: false });

      const details = await page.evaluate(() => ({
        title: document.title || '',
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      screenshots.set(pageGroup.url, {
        fileName,
        title: details.title,
        width: details.width,
        height: details.height,
      });
    } catch (error) {
      screenshots.set(pageGroup.url, {
        fileName: null,
        title: null,
        width: viewport.width,
        height: viewport.height,
        error: error.message,
      });
    }
  }

  await browser.close();
  return screenshots;
}

function buildHtml(domain, createdAt, pages, screenshots) {
  const sections = pages
    .map((page, index) => {
      const shot = screenshots.get(page.url);
      const topEvents = page.groupedEvents.slice(0, 15);

      let markerIndex = 1;
      const withMarker = [];
      const withoutMarker = [];

      for (const eventGroup of topEvents) {
        const marker = shot?.fileName ? markerForEvent(eventGroup, shot) : null;
        if (marker) {
          withMarker.push({ eventGroup, marker, markerIndex });
          markerIndex += 1;
        } else {
          withoutMarker.push(eventGroup);
        }
      }

      const markersHtml = withMarker
        .map(
          ({ marker, markerIndex: idx }) => `
            <div class="marker" style="left:${marker.leftPct}%;top:${marker.topPct}%;" title="${htmlEscape(marker.selector || '')}">
              <span>${idx}</span>
            </div>
          `
        )
        .join('');

      const listHtml = topEvents
        .map((eventGroup, idx) => {
          const marker = withMarker.find((m) => m.eventGroup === eventGroup);
          const tag = marker ? `<span class="badge">#${marker.markerIndex}</span>` : '<span class="badge muted">list</span>';
          const propertyPreview = Object.entries(eventGroup.properties || {})
            .slice(0, 4)
            .map(([k, v]) => `${clip(k, 22)}: ${clip(typeof v === 'string' ? v : JSON.stringify(v), 40)}`)
            .join(' | ');

          return `
            <li>
              ${tag}
              <strong>${htmlEscape(eventGroup.eventType)}</strong>
              <span class="count">${eventGroup.count} hits</span>
              <div class="props">${htmlEscape(propertyPreview || 'No sample properties')}</div>
            </li>
          `;
        })
        .join('');

      const screenshotBlock = shot?.fileName
        ? `
          <div class="shot-wrap">
            <img src="screenshots/${htmlEscape(shot.fileName)}" alt="Screenshot ${index + 1}" />
            ${markersHtml}
          </div>
        `
        : `<div class="shot-missing">Screenshot unavailable${shot?.error ? `: ${htmlEscape(shot.error)}` : ''}</div>`;

      const unplacedText = withoutMarker.length
        ? `<p class="hint">${withoutMarker.length} events were captured without a confident click coordinate and are listed as "list" items.</p>`
        : '';

      return `
        <section class="page-section">
          <header>
            <h2>Page ${index + 1}: ${htmlEscape(new URL(page.url).pathname || '/')}</h2>
            <p><a href="${htmlEscape(page.url)}" target="_blank" rel="noreferrer">${htmlEscape(page.url)}</a></p>
            <p class="meta">${page.totalEvents} events captured${shot?.title ? ` | ${htmlEscape(shot.title)}` : ''}</p>
          </header>
          <div class="layout">
            ${screenshotBlock}
            <aside>
              <h3>Tracked events</h3>
              <ol>${listHtml}</ol>
              ${unplacedText}
            </aside>
          </div>
        </section>
      `;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AmpliScan Visual Map - ${htmlEscape(domain)}</title>
  <style>
    :root {
      --bg: #f5f3ef;
      --card: #fffdf8;
      --ink: #1e1b16;
      --muted: #7d746a;
      --accent: #ff5a1f;
      --accent-2: #0b6e4f;
      --line: #e7dfd4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      background: radial-gradient(circle at 20% 0%, #fff7e8 0, transparent 40%), var(--bg);
      color: var(--ink);
    }
    main { max-width: 1400px; margin: 0 auto; padding: 28px 20px 60px; }
    .hero {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px 20px;
      box-shadow: 0 12px 24px rgba(31, 20, 10, 0.06);
      margin-bottom: 22px;
    }
    .hero h1 { margin: 0 0 8px; font-size: 1.8rem; }
    .hero p { margin: 6px 0; color: var(--muted); }
    .page-section {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 20px;
    }
    .page-section h2 { margin: 0 0 6px; }
    .page-section p { margin: 4px 0; }
    .meta { color: var(--muted); font-size: 0.95rem; }
    .layout { display: grid; grid-template-columns: minmax(320px, 2fr) minmax(250px, 1fr); gap: 16px; margin-top: 12px; }
    .shot-wrap {
      position: relative;
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: #fbfaf7;
    }
    .shot-wrap img { width: 100%; display: block; }
    .marker {
      position: absolute;
      width: 30px;
      height: 30px;
      border-radius: 999px;
      transform: translate(-50%, -50%);
      background: var(--accent);
      border: 2px solid #fff;
      display: grid;
      place-items: center;
      color: white;
      font-weight: 700;
      box-shadow: 0 8px 20px rgba(255, 90, 31, 0.4);
    }
    .shot-missing {
      border: 1px dashed var(--line);
      border-radius: 12px;
      padding: 20px;
      color: var(--muted);
    }
    aside {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: #fff;
      max-height: 80vh;
      overflow: auto;
    }
    aside h3 { margin: 0 0 10px; }
    ol { margin: 0; padding: 0 0 0 20px; }
    li { margin: 0 0 10px; }
    .badge {
      display: inline-block;
      min-width: 34px;
      margin-right: 8px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #ffe6dc;
      color: #a53711;
      font-size: 0.75rem;
      text-align: center;
      font-weight: 700;
    }
    .badge.muted { background: #eef3f0; color: #34594b; }
    .count { color: var(--muted); font-size: 0.85rem; margin-left: 8px; }
    .props { color: #534c45; font-size: 0.84rem; margin-top: 3px; }
    .hint { color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--line); padding-top: 8px; }
    @media (max-width: 1020px) {
      .layout { grid-template-columns: 1fr; }
      aside { max-height: none; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>AmpliScan Visual Event Map</h1>
      <p><strong>Domain:</strong> ${htmlEscape(domain)}</p>
      <p><strong>Generated:</strong> ${htmlEscape(createdAt)}</p>
      <p>This report maps captured events to page screenshots. Numbered dots show events with a likely UI interaction location.</p>
    </section>
    ${sections}
  </main>
</body>
</html>`;
}

export async function generateVisualReport(domain, events, options = {}) {
  const createdAt = new Date().toISOString();
  const pageLimit = Number.isFinite(options.pageLimit) ? options.pageLimit : 8;
  const grouped = summarizeEventsByPage(events).slice(0, pageLimit);

  if (!grouped.length) {
    return null;
  }

  const runKey = createdAt.replace(/[:.]/g, '-');
  const rootDir = path.resolve('reports', 'visual', `${sanitizeForFile(domain)}-${runKey}`);
  const screenshotsDir = path.join(rootDir, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });

  const screenshots = await capturePageScreenshots(grouped, screenshotsDir, {
    headless: options.headless ?? true,
  });

  const html = buildHtml(domain, createdAt, grouped, screenshots);
  const reportPath = path.join(rootDir, 'index.html');
  writeFileSync(reportPath, html, 'utf8');

  return {
    reportPath,
    pagesAnalyzed: grouped.length,
    totalEvents: events.length,
  };
}
