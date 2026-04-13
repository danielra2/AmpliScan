#!/usr/bin/env node
import 'dotenv/config';
import chalk from 'chalk';
import { scrapeDomain } from './src/scraper.js';
import { saveScanResults } from './src/sheets.js';

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const domainArg = args.find((a) => !a.startsWith('--'));
const maxPages = parseInt(args.find((a) => a.startsWith('--pages='))?.split('=')[1]) || 10;
const headless = !args.includes('--headed');

if (!domainArg) {
  console.error(chalk.red('Usage: node index.js <domain> [--pages=N] [--headed]'));
  console.error(chalk.gray('  Example: node index.js zebra.bi --pages=15'));
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log(chalk.bold.cyan('\n╔══════════════════════════════╗'));
console.log(chalk.bold.cyan('║        AmpliScan v1.0        ║'));
console.log(chalk.bold.cyan('╚══════════════════════════════╝'));
console.log(chalk.gray(`  Domain : ${domainArg}`));
console.log(chalk.gray(`  Pages  : up to ${maxPages}`));
console.log(chalk.gray(`  Mode   : ${headless ? 'headless' : 'headed (visible browser)'}\n`));

try {
  // 1. Scrape
  const events = await scrapeDomain(domainArg, { maxPages, headless });

  if (events.length === 0) {
    console.log(chalk.yellow('⚠️  No Amplitude events captured. The site may not use Amplitude, or events fire after login.'));
    process.exit(0);
  }

  // 2. Save to Sheets & get diff
  console.log(chalk.cyan('📊 Saving results to Google Sheets...'));
  const { newEvents, droppedEvents, staleDays, uniqueEventCount } =
    await saveScanResults(domainArg, events, { pagesVisited: maxPages });

  // 3. Print report
  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('  📋 Scan Report'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`  Unique events captured : ${chalk.green(uniqueEventCount)}`);
  console.log(`  New events (vs last)   : ${chalk.green(newEvents.length)}`);
  console.log(`  Dropped events         : ${chalk.red(droppedEvents.length)}`);

  if (staleDays !== null) {
    const staleColor = staleDays > 60 ? chalk.red : staleDays > 30 ? chalk.yellow : chalk.green;
    console.log(`  Data staleness         : ${staleColor(`${staleDays} days since last new event`)}`);
  }

  if (newEvents.length > 0) {
    console.log(chalk.green('\n  🆕 New events:'));
    newEvents.forEach((e) => console.log(chalk.green(`     + ${e}`)));
  }

  if (droppedEvents.length > 0) {
    console.log(chalk.red('\n  ❌ Dropped events:'));
    droppedEvents.forEach((e) => console.log(chalk.red(`     - ${e}`)));
  }

  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.cyan('  ✅ Results saved to Google Sheets'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

} catch (err) {
  console.error(chalk.red(`\n❌ Error: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}