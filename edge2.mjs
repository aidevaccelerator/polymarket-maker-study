import WebSocket from 'ws';
const DUR = Number(process.argv[2] ?? 600);

// pick the token that trades most AND is not an expiring 5-minute binary
const freq = new Map(), title = new Map();
const allRows = [];
for (let i = 0; i < 8; i++) {
  const j = await (await fetch('https://data-api.polymarket.com/v2/trades?limit=200')).json();
  for (const t of (j.data ?? [])) {
    const k = String(t.token_id);
    freq.set(k, (freq.get(k) ?? 0) + 1);
    if (!title.has(k)) title.set(k, t.title);
    allRows.push(t);
  }
  await new Promise((x) => setTimeout(x, 900));
}
// SELECT ON PRICE MOVEMENT, NOT FILL COUNT.
// Most-fills picked a 0.15% long-shot whose mid never moves, so every markout
// came back 0.000c. A maker's edge can only exist where the price travels, so
// candidates are filtered to near-coin-flips by their observed fill price.
const px = new Map();
for (const t of allRows) {
  const k = String(t.token_id);
  if (!px.has(k)) px.set(k, []);
  px.get(k).push(Number(t.price));
}
const band = (k) => {
  const a = px.get(k) ?? [];
  if (a.length < 5) return null;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return m >= 0.35 && m <= 0.65 ? m : null;
};
const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
const cands = ranked.map(([k, c]) => ({ k, c, m: band(k) })).filter((x) => x.m !== null);
console.log('candidates in 0.35-0.65 band:', cands.length, 'of', ranked.length);
for (const x of cands.slice(0, 5)) console.log(`   ${String(x.c).padStart(4)} fills  mid~${x.m.toFixed(3)}  ${(title.get(x.k) ?? '?').slice(0, 58)}`);
const pick = cands[0] ?? ranked[0];
console.log('picked:', pick ? `${title.get(pick.k)}` : 'none');
if (!pick) { console.log('nothing trading'); process.exit(1); }
const TOKEN = pick.k;

const mids = [];
const ws = new WebSocket('wss://ws-live-v2.polymarket.com/ws');
await new Promise((res) => {
  ws.on('open', () => ws.send(JSON.stringify({ op: 'subscribe', rid: 's1', subscriptions: [{ channel: 'price.polymarket', filter: { asset_id: TOKEN } }] })));
  ws.on('message', (m) => { try { const d0 = JSON.parse(m.toString());
      // ws-live-v2 sends an OBJECT per message, not an array. Iterating it
      // directly throws and a try/catch would silently drop every mid sample.
      for (const e of (Array.isArray(d0) ? d0 : [d0])) { if (e.channel !== 'price.polymarket') continue;
      const p = e.payload ?? {}; const bid = Number(p.best_bid), ask = Number(p.best_ask);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) mids.push([Number(e.ts), (bid + ask) / 2]); } } catch {} });
  setTimeout(res, 1500);
});
console.log('subscribed, capturing', DUR, 's\n');

const fills = [], seen = new Set();
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < DUR) {
  try { const j = await (await fetch('https://data-api.polymarket.com/v2/trades?limit=200')).json();
    for (const t of (j.data ?? [])) {
      if (String(t.token_id) !== TOKEN) continue;
      const tsMs = Number(t.timestamp) * 1000;
      if (tsMs < t0 - 5000 || tsMs > Date.now()) continue;          // LIVE ONLY
      const k = t.transaction_hash + ':' + t.size + ':' + t.price + ':' + t.timestamp;
      if (seen.has(k)) continue; seen.add(k);
      fills.push({ tsMs, price: Number(t.price), size: Number(t.size), side: t.side });
    } } catch {}
  await new Promise((x) => setTimeout(x, 2000));
}
const tEnd = Date.now();
console.log(`live fills in window: ${fills.length}   midSamples: ${mids.length}`);

function midAt(target) {
  let lo = 0, hi = mids.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (mids[mid][0] < target) lo = mid + 1; else hi = mid; }
  let bi = -1, bd = Infinity;
  for (const j of [lo - 1, lo, lo + 1]) { if (j < 0 || j >= mids.length) continue;
    const d = Math.abs(mids[j][0] - target); if (d < bd) { bd = d; bi = j; } }
  return bd <= 2000 ? mids[bi][1] : null;
}
for (const HZ of [1, 5, 30]) {
  const a = [];
  for (const f of fills) {
    if (f.tsMs + HZ * 1000 > tEnd) continue;
    const m0 = midAt(f.tsMs), m1 = midAt(f.tsMs + HZ * 1000);
    if (m0 === null || m1 === null) continue;
    a.push({ side: f.side, adverse: (m0 - m1) * 100 });
  }
  if (!a.length) { console.log(`  +${HZ}s  n=0`); continue; }
  const v = a.map(x => x.adverse).sort((p, q) => p - q);
  const q = f => v[Math.min(v.length - 1, Math.floor(f * v.length))];
  const mean = v.reduce((x, y) => x + y, 0) / v.length;
  console.log(`  +${String(HZ).padStart(2)}s  n=${String(a.length).padStart(3)}  mean=${mean.toFixed(3)}c  p50=${q(0.5).toFixed(3)}c  p10=${q(0.1).toFixed(3)}c  p90=${q(0.9).toFixed(3)}c`);
}
