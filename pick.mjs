import WebSocket from 'ws';
// TIGHTENED scorer. Reject <1c spread outright (pinned mid = nothing to capture),
// weight distinct fills, keep the expiry penalty on 5-minute binaries.
const tok = new Map();
for (let i = 0; i < 30; i++) {
  try { const j = await (await fetch('https://data-api.polymarket.com/v2/trades?limit=200')).json();
    for (const t of (j.data ?? [])) {
      const k = String(t.token_id);
      if (!tok.has(k)) tok.set(k, { prices: new Set(), n: 0, title: t.title ?? '' });
      const r = tok.get(k); r.n++; r.prices.add(Number(t.price).toFixed(4));
    } } catch {}
  await new Promise((x) => setTimeout(x, 900));
}
const cands = [];
for (const [id, r] of tok) {
  const p = [...r.prices].map(Number);
  const mean = p.reduce((a, b) => a + b, 0) / p.length;
  const spread = Math.max(...p) - Math.min(...p);
  const shortDated = /(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i.test(r.title);
  if (spread < 0.01) continue;                 // pinned mid, reject
  if (mean < 0.10 || mean > 0.90) continue;    // settled/dead
  if (shortDated) continue;                     // latency war
  if (r.prices.size < 3) continue;              // needs real price variety
  cands.push({ id, title: r.title, n: r.n, distinct: r.prices.size, mean, spread, score: r.n / 10 + spread * 20 });
}
cands.sort((a, b) => b.score - a.score);
console.log('candidates passing tightened filters:', cands.length, 'of', tok.size);
for (const c of cands.slice(0, 8)) console.log(`  ${c.score.toFixed(1).padStart(5)} ${String(c.n).padStart(4)}fills ${c.distinct}px mid${c.mean.toFixed(3)} spr${(c.spread*100).toFixed(1)}c  ${c.title.slice(0,52)}`);
if (!cands.length) { console.log('none qualify'); process.exit(0); }
const T = cands[0];
console.log('\nTARGET:', T.title, '| token', T.id.slice(0,18));

const mids = [];
const ws = new WebSocket('wss://ws-live-v2.polymarket.com/ws');
await new Promise((res) => {
  ws.on('open', () => ws.send(JSON.stringify({ op: 'subscribe', rid: 's1', subscriptions: [{ channel: 'price.polymarket', filter: { asset_id: T.id } }] })));
  ws.on('message', (m) => { try { const d0 = JSON.parse(m.toString());
      for (const e of (Array.isArray(d0) ? d0 : [d0])) { if ( e.channel !== 'price.polymarket') continue;
        const p = e.payload ?? {}; const bid = Number(p.best_bid), ask = Number(p.best_ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) mids.push([Number(e.ts), (bid + ask) / 2]); } } catch {} });
  setTimeout(res, 2000);
});
const DUR = Number(process.argv[2] ?? 600);
console.log('capturing', DUR, 's\n');
const fills = [], seen = new Set(); const t0 = Date.now();
while ((Date.now() - t0) / 1000 < DUR) {
  try { const j = await (await fetch('https://data-api.polymarket.com/v2/trades?limit=200')).json();
    for (const t of (j.data ?? [])) { if (String(t.token_id) !== T.id) continue;
      const tsMs = Number(t.timestamp) * 1000;
      if (tsMs < t0 - 5000 || tsMs > Date.now()) continue;
      const k = t.transaction_hash + ':' + t.size + ':' + t.price + ':' + t.timestamp;
      if (seen.has(k)) continue; seen.add(k);
      fills.push({ tsMs, price: Number(t.price), size: Number(t.size), side: t.side }); } } catch {}
  await new Promise((x) => setTimeout(x, 2000));
}
const tEnd = Date.now();
console.log(`live fills ${fills.length}   midSamples ${mids.length}`);
function midAt(t) { let lo=0,hi=mids.length-1; while(lo<hi){const m=(lo+hi)>>1; if(mids[m][0]<t)lo=m+1;else hi=m;}
  let bi=-1,bd=Infinity; for(const j of [lo-1,lo,lo+1]){ if(j<0||j>=mids.length)continue; const d=Math.abs(mids[j][0]-t); if(d<bd){bd=d;bi=j;} }
  return bd<=2000?mids[bi][1]:null; }
for (const HZ of [1,5,30]) {
  const a=[]; for (const f of fills){ if(f.tsMs+HZ*1000>tEnd) continue; const m0=midAt(f.tsMs), m1=midAt(f.tsMs+HZ*1000); if(m0===null||m1===null) continue;
    a.push((m0-m1)*100); }
  if(!a.length){console.log(`  +${HZ}s n=0`);continue;}
  const v=a.sort((x,y)=>x-y); const q=f=>v[Math.min(v.length-1,Math.floor(f*v.length))];
  console.log(`  +${String(HZ).padStart(2)}s n=${String(a.length).padStart(3)} mean=${(v.reduce((x,y)=>x+y,0)/v.length).toFixed(3)}c p10=${q(0.1).toFixed(3)} p50=${q(0.5).toFixed(3)} p90=${q(0.9).toFixed(3)}`);
}
