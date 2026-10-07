#!/usr/bin/env node
/**
 * Test runner + under-reporting guard. Dependency-free; uses only node built-ins.
 *
 * Usage:
 *   node scripts/run-tests.mjs dist/shared dist/collector
 *   node scripts/run-tests.mjs dist
 *
 * `node --test` is honest about what it ran, but it is silent about what it did
 * NOT run: a glob that matches nothing, or a set of paths where some emitted
 * test files were dropped, still prints a summary line and still exits 0. Two
 * real bugs in this repo were exactly that:
 *
 *   1. `rm -rf dist/analysis && npm run test:all` reported "tests 27" and exited
 *      0, because the surviving build info suppressed the re-emit of dist/analysis
 *      and the glob then matched only the collector half.
 *   2. `rm -rf dist && npm test` reported "tests 0, pass 0, fail 0" and exited 0 —
 *      a vacuous green.
 *
 * So this runner asserts three things before it trusts the summary:
 *
 *   A. SOURCE COVERAGE — every `*.test.ts` under the mirrored `src/` roots has a
 *      corresponding emitted `*.test.js` in the given `dist/` roots. This catches
 *      a missing emitted file AND a wholly missing directory, which is the F1
 *      failure mode regardless of what the build info believed.
 *   B. NON-EMPTY — at least one test file was found, so "0 tests" can never be a
 *      pass (the F2 failure mode).
 *   C. COUNT RECONCILIATION — the aggregate `# tests N` equals the sum of the
 *      per-file `# tests N`. If the runner ever drops a file from the aggregate
 *      while still counting it here, this fails.
 *
 * It then forwards the aggregate TAP output verbatim and exits with the runner's
 * own exit code, so a genuine test failure still fails the command.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const DIST_ROOT = 'dist';
const SRC_ROOT = 'src';
const TEST_SOURCE_SUFFIX = '.test.ts';
const TEST_EMITTED_SUFFIX = '.test.js';

/**
 * Recursive walk collecting files ending in `suffix`, sorted. A missing root
 * yields no files rather than throwing: that is precisely the "dist/analysis was
 * deleted" case, and the caller reports it as a coverage gap rather than a crash.
 */
function collectFiles(root, suffix) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(suffix)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Run `node --test` over `files` and return `{ exitCode, stdout }`.
 * `--test-reporter=tap` is used because its final `# tests N` line is a stable,
 * machine-readable aggregate count.
 */
function runTests(files) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files],
    { encoding: 'utf8' },
  );
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '' };
}

/** The last `# tests N` line is the aggregate; nested subtests also emit one. */
function parseTestCount(tap) {
  const matches = [...tap.matchAll(/^# tests (\d+)$/gm)];
  const last = matches.at(-1);
  return last === undefined ? null : Number(last[1]);
}

const distRoots = process.argv.slice(2);
if (distRoots.length === 0) {
  console.error('usage: node scripts/run-tests.mjs <dist-root>...');
  process.exit(2);
}

/**
 * Roots may be `dist` or a subdirectory of it (`dist/shared`), so the caller can
 * scope a run to one half of the project. Every root must live under dist/, which
 * is what makes the dist->src mirroring below well-defined.
 */
function toSourceRoot(distRoot) {
  const relative = path.relative(DIST_ROOT, distRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`expected a path under "${DIST_ROOT}", got "${distRoot}"`);
  }
  return relative === '' ? SRC_ROOT : path.join(SRC_ROOT, relative);
}

let emittedFiles;
let sourceFiles;
try {
  emittedFiles = distRoots.flatMap((root) => collectFiles(root, TEST_EMITTED_SUFFIX));
  sourceFiles = distRoots.flatMap((root) => collectFiles(toSourceRoot(root), TEST_SOURCE_SUFFIX));
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(2);
}

const problems = [];

if (emittedFiles.length === 0) {
  problems.push(
    `no emitted test files found under ${distRoots.join(', ')} — ` +
      'refusing to report a vacuous green. Run the build first.',
  );
}

const emittedSet = new Set(emittedFiles.map((file) => path.resolve(file)));
for (const source of sourceFiles) {
  const expected = path.resolve(
    source.replace(`${SRC_ROOT}/`, `${DIST_ROOT}/`).replace(TEST_SOURCE_SUFFIX, TEST_EMITTED_SUFFIX),
  );
  if (!emittedSet.has(expected)) {
    problems.push(`test source "${source}" has no emitted test file at "${expected}"`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

// (C) Reconcile the aggregate count against the per-file counts.
let perFileTotal = 0;
for (const file of emittedFiles) {
  const single = runTests([file]);
  const count = parseTestCount(single.stdout);
  if (count === null) {
    console.error(`::error::no "# tests" count in TAP output for "${file}"`);
    process.exit(1);
  }
  perFileTotal += count;
}

const aggregate = runTests(emittedFiles);
process.stdout.write(aggregate.stdout);

const aggregateCount = parseTestCount(aggregate.stdout);
if (aggregateCount === null) {
  console.error('::error::no "# tests" count in aggregate TAP output');
  process.exit(1);
}

if (aggregateCount !== perFileTotal) {
  console.error(
    `::error::aggregate test count ${aggregateCount} != sum of per-file counts ` +
      `${perFileTotal} across ${emittedFiles.length} files — the suite under-reported.`,
  );
  process.exit(1);
}

console.error(
  `[run-tests] ${emittedFiles.length} files, aggregate ${aggregateCount} tests ` +
    `= sum of per-file counts. OK.`,
);

process.exit(aggregate.exitCode);