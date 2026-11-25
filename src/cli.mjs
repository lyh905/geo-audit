#!/usr/bin/env node
/**
 * geo-audit CLI — human-readable scorecard, or raw JSON with --json.
 */
import { audit } from './audit.mjs';

const HELP = `
geo-audit — how ready is a site to be cited by AI search engines?

Usage
  geo-audit <domain|url> [--json] [--ua <string>] [--timeout <ms>]

Options
  --json            print the full report as JSON
  --ua <string>     override the User-Agent sent with every request
  --timeout <ms>    per-request timeout (default 15000)
  -h, --help        show this help

Examples
  geo-audit example.com
  geo-audit https://example.com --json
  geo-audit medradar.cn --timeout 8000

Exit codes
  0  audit completed (whatever the score)
  1  bad input or the site could not be reached at all
`.trim();

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const gray = paint('90');

const MARK = {
  present: green('✓'),
  absent: red('✗'),
  unknown: yellow('?'),
};

function parseArgs(argv) {
  const opts = { json: false, ua: undefined, timeout: undefined, target: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    else if (arg === '--json') opts.json = true;
    else if (arg === '--ua') opts.ua = argv[++i];
    else if (arg === '--timeout') opts.timeout = Number(argv[++i]);
    else if (arg.startsWith('-')) throw new Error('unknown option: ' + arg);
    else if (!opts.target) opts.target = arg;
    else throw new Error('unexpected argument: ' + arg);
  }
  if (!opts.target) throw new Error('missing target');
  if (opts.timeout !== undefined && !Number.isFinite(opts.timeout)) throw new Error('--timeout needs a number');
  return opts;
}

function render(report) {
  const lines = [];
  lines.push('');
  lines.push(`  ${bold(report.target)}`);
  lines.push(`  ${gray('AI-search readiness')}`);
  lines.push('');

  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status]} ${check.title.padEnd(26)} ${dim(check.detail)}`);
  }

  lines.push('');
  const scoreText = report.score === null ? 'n/a' : `${report.score}/100  (${report.grade})`;
  lines.push(`  ${bold('Score')}     ${report.score === null ? gray(scoreText) : bold(scoreText)}`);
  lines.push(`  ${bold('Coverage')}  ${report.coverage}% of checks could be judged`);
  lines.push(
    `  ${dim(`${report.counts.present} present · ${report.counts.absent} absent · ${report.counts.unknown} unknown`)}`,
  );

  if (report.counts.unknown > 0) {
    lines.push('');
    lines.push(dim('  "unknown" means the check could not run — not that the site lacks it.'));
  }

  const blocked = report.checks.find((c) => c.id === 'ai_crawlers' && c.status === 'absent');
  if (blocked) {
    lines.push('');
    lines.push(`  ${red('Blocking AI crawlers keeps this site out of AI answers.')}`);
  }

  lines.push('');
  return lines.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red('error: ') + err.message);
    console.error(dim('run geo-audit --help'));
    process.exit(1);
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }

  let report;
  try {
    report = await audit(opts.target, { ua: opts.ua, timeout: opts.timeout });
  } catch (err) {
    console.error(red('error: ') + err.message);
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  // Nothing could be fetched at all: the report would be five unknowns, which
  // reads as a finding when it is only a failed request.
  if (report.coverage === 0) {
    console.error(red('error: ') + `could not reach ${report.target} (home page status: ${report.homeStatus || 'no response'})`);
    process.exit(1);
  }

  console.log(render(report));
}

main();
