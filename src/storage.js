import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const DB_PATH = './reports/events-db.json';

// ─── Load / Save local DB ─────────────────────────────────────────────────────

function loadDB() {
  if (!existsSync('./reports')) mkdirSync('./reports');
  if (!existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveDB(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Saves scan results locally and returns a diff vs previous scan.
 */
export async function saveScanResults(domain, events, scanMeta = {}) {
  const db = loadDB();
  const scannedAt = new Date().toISOString();
  const scanId = `${domain}-${Date.now()}`;

  // ── 1. Deduplicate captured events ────────────────────────────────────────
  const uniqueMap = new Map();
  for (const ev of events) {
    const key = ev.event_type;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, { ...ev, count: 1 });
    } else {
      uniqueMap.get(key).count++;
    }
  }

  // ── 2. Load previous events for this domain ───────────────────────────────
  const previousEvents = db[domain]?.events || {};
  const previousEventNames = new Set(Object.keys(previousEvents));
  const currentEventNames = new Set(uniqueMap.keys());

  // ── 3. Diff ───────────────────────────────────────────────────────────────
  const newEvents = [...currentEventNames].filter((e) => !previousEventNames.has(e));
  const droppedEvents = [...previousEventNames].filter((e) => !currentEventNames.has(e));

  // Staleness
  const lastScanDate = db[domain]?.lastScan ? new Date(db[domain].lastScan) : null;
  const staleDays = lastScanDate
    ? Math.floor((Date.now() - lastScanDate) / 86_400_000)
    : null;

  // ── 4. Update DB ──────────────────────────────────────────────────────────
  if (!db[domain]) db[domain] = { events: {}, scans: [] };

  for (const [eventType, ev] of uniqueMap) {
    if (db[domain].events[eventType]) {
      db[domain].events[eventType].last_seen = scannedAt;
      db[domain].events[eventType].times_seen += ev.count;
    } else {
      db[domain].events[eventType] = {
        event_type: eventType,
        first_seen: scannedAt,
        last_seen: scannedAt,
        times_seen: ev.count,
        sample_properties: ev.event_properties || {},
        platform: ev.platform || null,
        app_version: ev.app_version || null,
      };
    }
  }

  db[domain].lastScan = scannedAt;
  db[domain].scans.push({
    scan_id: scanId,
    scanned_at: scannedAt,
    pages_visited: scanMeta.pagesVisited || 0,
    total_events: events.length,
    unique_events: uniqueMap.size,
    new_events: newEvents,
    dropped_events: droppedEvents,
  });

  saveDB(db);

  // ── 5. Save a per-scan JSON report ────────────────────────────────────────
  const reportPath = `./reports/${domain}-${scannedAt.split('T')[0]}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        domain,
        scanned_at: scannedAt,
        unique_events: uniqueMap.size,
        new_events: newEvents,
        dropped_events: droppedEvents,
        stale_days: staleDays,
        events: [...uniqueMap.values()],
      },
      null,
      2
    )
  );

  return { newEvents, droppedEvents, staleDays, scanId, uniqueEventCount: uniqueMap.size, reportPath };
}