// Feasibility probe: does the best price on the tracked universe EVER move?
//
// This is the discriminating test for the fill-model question. A fill at the
// touch consumes the level and OCCASIONALLY exhausts it, moving the best price.
// A cancellation does not. So a run of "0 best-price moves" over many sweeps is
// evidence that the size drops being recorded are cancellations, not fills --
// which would mean the study is unanswerable as designed with public data.
//
// Standalone on purpose: it must not depend on the collector's parquet output,
// because the answer is needed BEFORE the fill rule is chosen, and reading it
// back out of a dataset that has to be written, flushed and queried would add
// hours to a question that takes minutes to answer.
//
// Usage: node scripts/priceMoveProbe.mjs [seconds]
const DURATION_S = Number(process.argv[2] ?? 3600);
const POLL_MS = 5000;
const CLOB = 'https://clob.polymarket.com';

// Discovers the universe with the COLLECTOR's own compiled module rather than
// reading data/quality/manifest.json, because the collector only writes that
// file on shutdown -- during a run there is nothing to read, and waiting for a
// stop/start cycle to answer a five-minute question would be absurd.
const { discoverUniverse } = await import('../dist/collector/gamma.js');
const universe = await discoverUniverse({ maxMarkets: 30 });
const tokens = universe.markets.map((m) => m.tokenId);
console.log(
  `tracking ${tokens.length} tokens for ${DURATION_S}s, polling every ${POLL_MS / 1000}s\n` +
    `universe: ${universe.seen} seen, ${universe.markets.length} accepted, ` +
    `${universe.duplicateMarkets} duplicate, ${universe.unparseable} unparseable`,
);

const prev = new Map();
let sweeps = 0;
const perToken = new Map(tokens.map((t) => [t, { moves: 0, samples: 0 }]));
const startedAt = Date.now();

async function sweep() {
  const res = await fetch(`${CLOB}/books`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(tokens.map((token_id) => ({ token_id }))),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) return;
  sweeps += 1;
  for (const entry of body) {
    const id = entry?.asset_id;
    // REST /book returns levels as {price,size} OBJECTS, not [price,size] tuples
    // -- same shape the collector's parseLevels reads. Reading bids[0][0] here
    // silently yields undefined and skips every sample.
    // CRITICAL: /book returns bids ASCENDING and asks DESCENDING -- the reverse
    // of what "best" means. bids[0] is the WORST bid. parseBook sorts descending
    // before reading the first level; skipping that made an earlier version of
    // this probe track the outer edges of the book, which never move, and report
    // a confident 0. Sort exactly as parseBook does.
    const bids = (entry?.bids ?? []).map((l) => Number(l?.price)).filter(Number.isFinite);
    const asks = (entry?.asks ?? []).map((l) => Number(l?.price)).filter(Number.isFinite);
    bids.sort((a, b) => b - a);
    asks.sort((a, b) => a - b);
    const bid = bids[0];
    const ask = asks[0];
    if (typeof id !== 'string' || bid == null || ask == null) continue;
    const rec = perToken.get(id);
    if (rec === undefined) continue;
    rec.samples += 1;
    const was = prev.get(id);
    if (was !== undefined) {
      const [pb, pa] = was;
      if (Number(bid) < pb || Number(ask) > pa) rec.moves += 1;
    }
    prev.set(id, [Number(bid), Number(ask)]);
  }
}

let totalMoves = 0;
let totalSamples = 0;
function report() {
  const recs = [...perToken.values()];
  const moves = recs.reduce((a, r) => a + r.moves, 0);
  const samples = recs.reduce((a, r) => a + r.samples, 0);
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(
    `[${mins}m] sweeps=${sweeps} samples=${samples} moves=${moves} ` +
      `rate=${samples ? ((100 * moves) / samples).toFixed(4) : '-'}% ` +
      `tokensWithAMove=${recs.filter((r) => r.moves > 0).length}/${recs.length}`,
  );
  if (moves > totalMoves) {
    const top = [...perToken.entries()].filter(([, r]) => r.moves > 0).slice(0, 5);
    for (const [id, r] of top) console.log(`    ${id.slice(0, 14)}… moves=${r.moves}/${r.samples}`);
  }
  totalMoves = moves;
  totalSamples = samples;
}

let failures = 0;
while ((Date.now() - startedAt) / 1000 < DURATION_S) {
  try {
    await sweep();
  } catch (err) {
    failures += 1;
    console.error(`sweep failed: ${err.message}`);
  }
  report();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
console.log(`\ndone. sweeps=${sweeps} failures=${failures} samples=${totalSamples} moves=${totalMoves}`);
console.log(
  totalMoves === 0
    ? 'VERDICT SO FAR: no best-price move observed. Every size drop so far is equally consistent with a cancellation.'
    : `VERDICT SO FAR: best-price moves DO occur at ${((100 * totalMoves) / totalSamples).toFixed(4)}% of samples. Drops include real fills.`,
);