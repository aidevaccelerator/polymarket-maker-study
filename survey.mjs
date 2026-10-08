// Market scoring survey: rank Polymarket markets by whether a passive maker
// could actually earn there. Four criteria, all from endpoints we already know:
//   flow   - fills observed in the sample window
//   band   - mean fill price near 0.5; deep long-shots are pinned and dead
//   motion - dispersion of fill PRICES; a market where every fill prints the
//            same price has a stationary mid and nothing to capture
//   life   - time to expiry, from the title's window if it has one
// No websocket: trade-price dispersion is a usable proxy for mid movement.
const SAMPLES = Number(process.argv[2] ?? 40);

const tok = new Map();   // id -> {n, prices[], first, last, title}
for (let i = 0; i < SAMPLES; i++) {
  try {
    const j = await (await fetch('https://data-api.polymarket.com/v2/trades?limit=200')).json();
    for (const t of (j.data ?? [])) {
      const k = String(t.token_id);
      if (!tok.has(k)) tok.set(k, { n: 0, prices: [], first: Infinity, last: -Infinity, title: t.title ?? '' });
      const r = tok.get(k);
      const ts = Number(t.timestamp) * 1000;
      r.n += 1; r.prices.push(Number(t.price));
      if (ts < r.first) r.first = ts;
      if (ts > r.last) r.last = ts;
    }
  } catch {}
  await new Promise((x) => setTimeout(x, 900));
}

const rows = [];
for (const [id, r] of tok) {
  const mean = r.prices.reduce((a, b) => a + b, 0) / r.n;
  const lo = Math.min(...r.prices), hi = Math.max(...r.prices);
  const spread = hi - lo;
  // dedupe repeats so n reflects distinct fills, not feed re-delivery
  const distinct = new Set(r.prices.map((p) => p.toFixed(4))).size;
  const w = (r.title.match(/(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i));
  const shortDated = w ? true : false;
  const spanMin = (r.last - r.first) / 60000;
  let score = 0;
  if (r.n >= 3) score += Math.min(3, r.n / 10);
  if (mean >= 0.15 && mean <= 0.85) score += 2; else score -= 2;
  if (spread >= 0.03) score += 3; else if (spread >= 0.01) score += 1; else score -= 2;
  if (!shortDated) score += 2; else score -= 2;          // avoid the latency war
  if (spanMin >= 2) score += 1;
  rows.push({ id, title: r.title, n: r.n, mean, spread, shortDated, distinct, spanMin, score });
}
rows.sort((a, b) => b.score - a.score || b.n - a.n);

const pass = rows.filter((r) => r.score > 0);
console.log(`sampled ${tok.size} tokens over ${SAMPLES} polls`);
console.log(`scored positive: ${pass.length}\n`);
console.log('score  fills  mid    spread  shortExpiry  span(min)  market');
for (const r of rows.slice(0, 26)) {
  console.log(
    String(r.score.toFixed(1)).padStart(5) + String(r.n).padStart(7) +
    r.mean.toFixed(3).padStart(7) + (r.spread * 100).toFixed(1).padStart(8) +
    String(r.shortDated).padStart(12) + r.spanMin.toFixed(1).padStart(11) + '  ' + r.title.slice(0, 46),
  );
}
