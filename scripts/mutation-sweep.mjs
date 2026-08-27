/**
 * Run the mutation sweep shard by shard, then summarise.
 *
 * `scripts/mutation-shards.mjs` explains why it is sharded rather than run in
 * one pass. Each shard writes its JSON report into reports/mutation/shards/,
 * so a run interrupted half way keeps what it finished and picking it up again
 * with --resume costs only the shards that are missing.
 *
 *   node scripts/mutation-sweep.mjs                 every shard, from scratch
 *   node scripts/mutation-sweep.mjs --resume        only the missing shards
 *   node scripts/mutation-sweep.mjs --shard usb     one shard by name
 *   node scripts/mutation-sweep.mjs --list          what the shards are
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { argv, exit } from 'node:process';

import { REPORT_DIR, SHARDS } from './mutation-shards.mjs';

const args = argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (flag('--list')) {
  for (const shard of SHARDS) console.log(`${shard.name.padEnd(22)} ${shard.mutate.join(', ')}`);
  exit(0);
}

const only = value('--shard');
const selected = only ? SHARDS.filter((shard) => shard.name === only) : SHARDS;
if (selected.length === 0) {
  console.error(`No shard named "${only}". Try --list.`);
  exit(1);
}

mkdirSync(REPORT_DIR, { recursive: true });

const failures = [];
for (const [index, shard] of selected.entries()) {
  const report = `${REPORT_DIR}/${shard.name}.json`;
  if (flag('--resume') && existsSync(report)) {
    console.log(`\n[${index + 1}/${selected.length}] ${shard.name}: already done, skipping`);
    continue;
  }
  console.log(`\n[${index + 1}/${selected.length}] ${shard.name}: ${shard.mutate.join(', ')}`);

  rmSync('reports/mutation/mutation.json', { force: true });
  const result = spawnSync(
    'npx',
    ['stryker', 'run', '--mutate', shard.mutate.join(','), '--reporters', 'clear-text,json'],
    { stdio: 'inherit' },
  );
  if (existsSync('reports/mutation/mutation.json')) {
    renameSync('reports/mutation/mutation.json', report);
  } else {
    failures.push(`${shard.name} produced no report`);
  }
  // A shard exits non-zero when it is below its own threshold. That is worth
  // reporting, but the sweep carries on so one weak shard does not hide the
  // rest — the summary at the end is what decides the build.
  if (result.status !== 0) failures.push(`${shard.name} exited ${result.status}`);
}

console.log('\n=== summary ===');
const summary = spawnSync('node', ['scripts/mutation-summary.mjs'], { stdio: 'inherit' });
for (const failure of failures) console.error(`shard: ${failure}`);
exit(summary.status ?? 1);
