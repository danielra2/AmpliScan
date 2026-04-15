#!/usr/bin/env node
import 'dotenv/config';
import chalk from 'chalk';
import { scrapeDomain } from './src/scraper.js';
import { saveScanResults } from './src/storage.js';

const args = process.argv.slice(2);
const domainArg = args.find((a) => !a.startsWith('--'));
const maxPages = parseInt(args.find((a) => a.startsWith('--pages='))?.split('=')[1]) || 10;
const headless = !args.includes('--headed');

if (!domainArg) {
  console.error(chalk.red('Usage: node index.js <domain> [--pages=N] [--headed]'));
  console.error(chalk.gray('  Example: node index.js zebrabi.com --pages=15'));
  process.exit(1);
}

console.log(chalk.bold.cyan('\n╔══════════════════════════════╗'));
console.log(chalk.bold.cyan('║        AmpliScan v1.0        ║'));
console.log(chalk.bold.cyan('╚══════════════════════════════╝'));
console.log(chalk.gray(`  Domain : ${domainArg}`));
console.log(chalk.gray(`  Pages  : up to ${maxPages}`));
console.log(chalk.gray(`  Mode   : ${headless ? 'headless' : 'headed (visible browser)'}\n`));

try {
  const events = await scrapeDomain(domainArg, { maxPages, headless });

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
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

} catch (err) {
  console.error(chalk.red(`\n❌ Error: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}