#!/usr/bin/env node
import 'dotenv/config';
import chalk from 'chalk';
import { scrapeDomain } from './src/scraper.js';
import { saveScanResults } from './src/storage.js';
import { generateVisualReport } from './src/visual-report.js';

const args = process.argv.slice(2);
const domainArg = args.find((a) => !a.startsWith('--'));
const maxPages = parseInt(args.find((a) => a.startsWith('--pages='))?.split('=')[1]) || 10;
const headless = !args.includes('--headed');
const makeVisualMap = args.includes('--visual-map');
const visualPageLimit = parseInt(args.find((a) => a.startsWith('--visual-pages='))?.split('=')[1]) || 8;
const username = args.find((a) => a.startsWith('--username='))?.split('=')[1];
const password = args.find((a) => a.startsWith('--password='))?.split('=')[1];
const loginUrl = args.find((a) => a.startsWith('--loginUrl='))?.split('=')[1];

if (!domainArg) {
  console.error(chalk.red('Usage: node index.js <domain> [--pages=N] [--headed] [--username=USER] [--password=PASS] [--loginUrl=URL] [--visual-map] [--visual-pages=N]'));
  console.error(chalk.gray('  Example: node index.js example.com --pages=15 --visual-map --visual-pages=6 --username=test@example.com --password=abc123 --loginUrl=https://example.com/login'));
  process.exit(1);
}

console.log(chalk.bold.cyan('\n╔══════════════════════════════╗'));
console.log(chalk.bold.cyan('║        AmpliScan v1.0        ║'));
console.log(chalk.bold.cyan('╚══════════════════════════════╝'));
console.log(chalk.gray(`  Domain : ${domainArg}`));
console.log(chalk.gray(`  Pages  : up to ${maxPages}`));
console.log(chalk.gray(`  Mode   : ${headless ? 'headless' : 'headed (visible browser)'}`));
console.log(chalk.gray(`  Visual : ${makeVisualMap ? `enabled (top ${visualPageLimit} pages)` : 'disabled'}`));
if (username) console.log(chalk.gray(`  Login  : ${username} @ ${loginUrl || domainArg}\n`));
else console.log(chalk.gray(`  Login  : anonymous\n`));

try {
  const events = await scrapeDomain(domainArg, { maxPages, headless, username, password, loginUrl });

  if (events.length === 0) {
    console.log(chalk.yellow('⚠️  No Amplitude events captured. The site may not use Amplitude, or events fire after login.'));
    process.exit(0);
  }

  console.log(chalk.cyan('\n💾 Saving results locally...'));
  const { newEvents, droppedEvents, staleDays, uniqueEventCount, reportPath } =
    await saveScanResults(domainArg, events, { pagesVisited: maxPages });

  // Print full event list
  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('  📋 All Captured Events'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

  const uniqueMap = new Map();
  for (const ev of events) {
    if (!uniqueMap.has(ev.event_type)) uniqueMap.set(ev.event_type, ev);
  }

  [...uniqueMap.entries()].forEach(([name, ev], i) => {
    const props = Object.keys(ev.event_properties || {});
    console.log(
      chalk.white(`  ${String(i + 1).padStart(2, '0')}. `) +
      chalk.green(name) +
      (props.length ? chalk.gray(` [${props.slice(0, 4).join(', ')}${props.length > 4 ? '...' : ''}]`) : '')
    );
  });

  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('  📊 Scan Summary'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`  Unique events    : ${chalk.green(uniqueEventCount)}`);
  console.log(`  New (vs last)    : ${chalk.green(newEvents.length)}`);
  console.log(`  Dropped          : ${chalk.red(droppedEvents.length)}`);

  if (staleDays !== null) {
    const staleColor = staleDays > 60 ? chalk.red : staleDays > 30 ? chalk.yellow : chalk.green;
    console.log(`  Staleness        : ${staleColor(`${staleDays} days since last scan`)}`);
  }

  if (newEvents.length > 0) {
    console.log(chalk.green('\n  🆕 New events:'));
    newEvents.forEach((e) => console.log(chalk.green(`     + ${e}`)));
  }

  if (droppedEvents.length > 0) {
    console.log(chalk.red('\n  ❌ Dropped events:'));
    droppedEvents.forEach((e) => console.log(chalk.red(`     - ${e}`)));
  }

  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.cyan(`  ✅ Full report saved to: ${reportPath}`));

  if (makeVisualMap) {
    console.log(chalk.cyan('\n🖼️  Building visual event map...'));
    const visual = await generateVisualReport(domainArg, events, {
      pageLimit: visualPageLimit,
      headless,
    });

    if (visual) {
      console.log(chalk.cyan(`  ✅ Visual map saved to: ${visual.reportPath}`));
      console.log(chalk.gray(`  ↳ Pages mapped: ${visual.pagesAnalyzed} | Events considered: ${visual.totalEvents}`));
    } else {
      console.log(chalk.yellow('  ⚠️  Visual map skipped: no page-level event URLs found in captured data.'));
    }
  }

  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

} catch (err) {
  console.error(chalk.red(`\n❌ Error: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}