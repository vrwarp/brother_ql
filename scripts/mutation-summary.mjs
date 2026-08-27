/**
 * Merge the shard reports written by `npm run mutation` into one score.
 *
 * Reads every JSON report under reports/mutation/shards/, prints a per-file
 * table, and exits non-zero if the total falls below the threshold. Shards may
 * be produced on one machine or across a CI matrix; a file split across two
 * shards by line range is summed, which is why this counts mutants rather than
 * averaging the scores the shards report.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { argv, cwd, exit } from 'node:process';

import { REPORT_DIR } from './mutation-shards.mjs';

const threshold = Number(argv[2] ?? 90);
const dir = argv[3] ?? REPORT_DIR;

let reports;
try {
  reports = readdirSync(dir).filter((name) => name.endsWith('.json'));
} catch {
  console.error(`No shard reports in ${dir}. Run \`npm run mutation\` first.`);
  exit(1);
}
if (reports.length === 0) {
  console.error(`No shard reports in ${dir}. Run \`npm run mutation\` first.`);
  exit(1);
}

const perFile = new Map();
for (const name of reports) {
  const report = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));
  for (const [path, file] of Object.entries(report.files ?? {})) {
    const relative = path.replace(`${cwd()}/`, '');
    const counts = perFile.get(relative) ?? { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
    for (const mutant of file.mutants) {
      if (mutant.status === 'Killed') counts.killed += 1;
      else if (mutant.status === 'Timeout') counts.timeout += 1;
      else if (mutant.status === 'Survived') counts.survived += 1;
      else if (mutant.status === 'NoCoverage') counts.noCoverage += 1;
      else if (mutant.status === 'Ignored') counts.ignored += 1;
    }
    perFile.set(relative, counts);
  }
}

const score = ({ killed, timeout, survived, noCoverage }) => {
  const scored = killed + timeout + survived + noCoverage;
  return scored === 0 ? 100 : ((killed + timeout) / scored) * 100;
};

const total = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
const rows = [...perFile.entries()].sort(([a], [b]) => a.localeCompare(b));

console.log(` ${'score'.padStart(7)}  killed  timeout  survived  no cov  ignored  file`);
for (const [path, counts] of rows) {
  for (const key of Object.keys(total)) total[key] += counts[key];
  console.log(
    ` ${`${score(counts).toFixed(1)}%`.padStart(7)}  ${String(counts.killed).padStart(6)}` +
      `  ${String(counts.timeout).padStart(7)}  ${String(counts.survived).padStart(8)}` +
      `  ${String(counts.noCoverage).padStart(6)}  ${String(counts.ignored).padStart(7)}  ${path}`,
  );
}

const scored = total.killed + total.timeout + total.survived + total.noCoverage;
const overall = score(total);
console.log('-'.repeat(80));
console.log(
  ` ${`${overall.toFixed(2)}%`.padStart(7)}  ${String(total.killed).padStart(6)}` +
    `  ${String(total.timeout).padStart(7)}  ${String(total.survived).padStart(8)}` +
    `  ${String(total.noCoverage).padStart(6)}  ${String(total.ignored).padStart(7)}` +
    `  ${rows.length} files, ${scored} mutants scored`,
);
console.log(
  `\n${total.ignored} mutant(s) ignored: each carries a \`// Stryker disable\` comment ` +
    'in the source arguing why no test can distinguish it.',
);

if (overall < threshold) {
  console.error(`\nMutation score ${overall.toFixed(2)}% is below the ${threshold}% threshold.`);
  exit(1);
}
console.log(`\nMutation score ${overall.toFixed(2)}% meets the ${threshold}% threshold.`);
