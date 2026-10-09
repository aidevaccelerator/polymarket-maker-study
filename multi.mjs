import WebSocket from 'ws';
const RPC='https://polygon-drpc.org'.replace('polygon-drpc','polygon-drp');
const RPCU='https://polygon.drpc.org';
const EX=['0xe111180000d2663c0091e4f400237545b87b996b','0xe2222d279d744050d28e00520010520000310f59'];
const OF='0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee';
const N=Number(process.argv[2]??5), DUR=Number(process.argv[3]??600);
async function rpc(m,p){
  const r=await fetch(RPCU,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});
  const t=await r.text();
  let j; try{ j=JSON.parse(t); }catch{ return null; }   // rate-limit returns HTML
  if(!j||j.error) return null;
  return j.result; }

const tok=new Map();
for(let i=0;i<25;i++){ try{ const j=await (await fetch('https://data-api.polymarket.com/v2/trades?limit=200')).json();
  for(const t of (j.data??[])){ const k=String(t.token_id); if(!tok.has(k))tok.set(k,{p:new Set(),n:0,title:t.title??''});
    const r=tok.get(k); r.n++; r.p.add(Number(t.price).toFixed(4)); } }catch{}
  await new Promise(x=>setTimeout(x,800)); }
const cands=[];
for(const [id,r] of tok){ const p=[...r.p].map(Number); const mean=p.reduce((a,b)=>a+b,0)/p.length;
  const spread=Math.max(...p)-Math.min(...p);
  const sd=/(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i.test(r.title);
  if(spread<0.005||mean<0.08||mean>0.92||sd||r.p.size<3) continue;
  cands.push({id,title:r.title,n:r.n,mean,spread,score:r.n/10+spread*20}); }
cands.sort((a,b)=>b.score-a.score);
// DIVERSIFY. Taking the top-N by score returned two corners of the SAME tennis
// event, which is n=1 market in practice. Family = text before the first colon
// (event/league) so we sample genuinely different markets, not one match.
const fam=t=>t.includes(':')?t.split(':')[0].trim().toLowerCase():t.split(/[\s-]/).slice(0,3).join(' ').toLowerCase();
const seenFam=new Set(); const pick=[];
for(const c of cands){ const f=fam(c.title);
  if(seenFam.has(f)) continue; seenFam.add(f); pick.push(c); if(pick.length>=N) break; }
console.log('candidates passing:',cands.length,' selected:',pick.length);
for(const c of pick) console.log(`  mid${c.mean.toFixed(3)} spr${(c.spread*100).toFixed(1)}c  ${c.title.slice(0,54)}`);
if(!pick.length){process.exit(0);}
const want=new Map(pick.map(c=>[c.id,c]));

const mids=new Map(); for(const c of pick) mids.set(c.id,[]);
const ws=new WebSocket('wss://ws-live-v2.polymarket.com/ws');
await new Promise(res=>{ ws.on('open',()=>ws.send(JSON.stringify({op:'subscribe',rid:'s',
  subscriptions:pick.map(c=>({channel:'price.polymarket',filter:{asset_id:c.id}}))})));
  ws.on('message',(m)=>{try{const d0=JSON.parse(m.toString());
    for(const e of (Array.isArray(d0)?d0:[d0])){ if(e.channel!=='price.polymarket')continue;
      const p=e.payload??{}, aid=String(p.asset_id??''); if(!mids.has(aid))continue;
      const b=Number(p.best_bid),a=Number(p.best_ask);
      if(Number.isFinite(b)&&Number.isFinite(a)&&b>0) mids.get(aid).push([Number(e.ts),b,a]); }}catch{}});
  setTimeout(res,2500); });
console.log('\nsubscribed to',pick.length,'markets; capturing',DUR,'s\n');

const fills=[]; const seen=new Set();
let last=parseInt(await rpc('eth_blockNumber',[]),16);
const t0=Date.now();
while((Date.now()-t0)/1000<DUR){
  const head=parseInt(await rpc('eth_blockNumber',[]),16);
  if(head>last){ for(const a of EX){ let lg=[];
      try{ lg=await rpc('eth_getLogs',[{address:a,fromBlock:'0x'+(last+1).toString(16),toBlock:'0x'+head.toString(16),topics:[OF]}]); }catch{}
      for(const l of lg){ const d=l.data.slice(2);
        const side=BigInt('0x'+d.slice(0,64))===0n?'BUY':'SELL';
        const tid=BigInt('0x'+d.slice(64,128)).toString(); if(!want.has(tid))continue;
        const a1=Number(BigInt('0x'+d.slice(128,192)))/1e6, a2=Number(BigInt('0x'+d.slice(192,256)))/1e6;
        const key=l.transactionHash+':'+l.logIndex; if(seen.has(key))continue; seen.add(key);
        fills.push({tid,side,usd:side==='BUY'?a1:a2,sh:side==='BUY'?a2:a1,block:Number(l.blockNumber)}); } }
    last=head; }
  await new Promise(x=>setTimeout(x,1500));
}
const bts=new Map();
async function bMs(bn){ if(bts.has(bn))return bts.get(bn); const r=await rpc('eth_getBlockByNumber',['0x'+bn.toString(16),false]);
  const v=r&&r.timestamp?Number(r.timestamp)*1000:null; bts.set(bn,v); return v; }
for(const f of fills) f.tsMs=await bMs(f.block);
console.log('fills captured:',fills.length,'  (resolved ts:',fills.filter(f=>f.tsMs>0).length,')');

function quoteAt(list,t){ if(!list.length)return null; let lo=0,hi=list.length-1;
  while(lo<hi){const m=(lo+hi)>>1; if(list[m][0]<t)lo=m+1;else hi=m;}
  let bi=-1,bd=Infinity; for(const j of [lo-1,lo,lo+1]){if(j<0||j>=list.length)continue;const d=Math.abs(list[j][0]-t);if(d<bd){bd=d;bi=j;}}
  if(bi<0||bd>2500) return null; const [,b,a]=list[bi];
  return {bid:b,ask:a,mid:(b+a)/2,half:(a-b)/2}; }
const q=(v,f)=>{const a=v.slice().sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(f*a.length))];};
const mean=v=>v.reduce((x,y)=>x+y,0)/v.length;
const fmt=(lbl,v)=>{ if(!v.length){console.log('    '+lbl.padEnd(18)+'n=0');return;}
  console.log('    '+lbl.padEnd(18)+'n='+String(v.length).padStart(3)+'  mean='+mean(v).toFixed(3)+'c  p10='+q(v,0.1).toFixed(2)+'c  p50='+q(v,0.5).toFixed(2)+'c  p90='+q(v,0.9).toFixed(2)+'c'); };

const byM=new Map();
for(const f of fills){ if(!f.tsMs)continue; if(!byM.has(f.tid))byM.set(f.tid,[]); byM.get(f.tid).push(f); }
console.log('\n=== ADVERSE DRIFT per market (markout + halfspread), positive = price moved WITH the maker ===');
const agg={1:[],5:[],30:[]};
for(const c of pick){ const fs=byM.get(c.id)??[]; if(!fs.length){console.log('\n'+c.title.slice(0,60)+'\n  (no fills)');continue;}
  console.log('\n'+c.title.slice(0,60));
  const mid=mids.get(c.id)??[];
  for(const HZ of [1,5,30]){ const v=[];
    for(const f of fs){
      const q0=quoteAt(mid,f.tsMs);            // quote AT the fill -> halfspread
      const qF=quoteAt(mid,f.tsMs+HZ*1000);     // quote HZ later
      if(q0===null||qF===null) continue;
      const fp=f.usd/f.sh; if(!Number.isFinite(fp)||fp<=0) continue;
      // makerMarkout has a -halfspread baseline by construction (selling at the
      // bid vs a later mid). adverseDrift removes it: what the price did TO us.
      const mark = f.side==='BUY' ? (fp-qF.mid)*100 : (qF.mid-fp)*100;
      v.push(mark + q0.half*100); }
    fmt('+' + HZ + 's',v); agg[HZ].push(...v); } }
console.log('\n=== AGGREGATE ADVERSE DRIFT across markets ===');
for(const HZ of [1,5,30]) fmt('+' + HZ + 's',agg[HZ]);
