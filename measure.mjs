import WebSocket from 'ws';
// Measure markout on passive fills for ONE chosen token.
// Fills come from eth_getLogs filtered to this token — every fill, no polling
// bias. data-api/v2/trades cannot be used: limit=200 is global across all
// markets and its token_id filter is silently ignored, so fast markets crowd
// slow ones out of the window entirely.
const RPC='https://polygon.drpc.org';
const EXCHANGES=['0xe111180000d2663c0091e4f400237545b87b996b','0xe2222d279d744050d28e00520010520000310f59'];
const OF='0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee';
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result;}

// pick target: strictly scored long-dated, liquid, moving market
const tok=new Map();
for(let i=0;i<25;i++){ try{ const j=await (await fetch('https://data-api.polymarket.com/v2/trades?limit=200')).json();
  for(const t of (j.data??[])){ const k=String(t.token_id);
    if(!tok.has(k))tok.set(k,{p:new Set(),n:0,title:t.title??''});
    const r=tok.get(k); r.n++; r.p.add(Number(t.price).toFixed(4)); } }catch{}
  await new Promise(x=>setTimeout(x,800)); }
const cands=[];
for(const [id,r] of tok){ const p=[...r.p].map(Number);
  const mean=p.reduce((a,b)=>a+b,0)/p.length, spread=Math.max(...p)-Math.min(...p);
  const sd=/(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i.test(r.title);
  if(spread<0.01||mean<0.10||mean>0.90||sd||r.p.size<3) continue;
  cands.push({id,title:r.title,n:r.n,mean,spread,score:r.n/10+spread*20}); }
cands.sort((a,b)=>b.score-a.score);
console.log('candidates:',cands.length,'of',tok.size);
for(const c of cands.slice(0,5))console.log(`  ${c.score.toFixed(1).padStart(5)} ${String(c.n).padStart(4)}fills mid${c.mean.toFixed(3)} spr${(c.spread*100).toFixed(1)}c  ${c.title.slice(0,50)}`);
if(!cands.length){console.log('none qualify');process.exit(0);}
const T=cands[0];
console.log('\nTARGET:',T.title,'\ntoken',T.id);

const mids=[];
const ws=new WebSocket('wss://ws-live-v2.polymarket.com/ws');
await new Promise(res=>{ ws.on('open',()=>ws.send(JSON.stringify({op:'subscribe',rid:'s',subscriptions:[{channel:'price.polymarket',filter:{asset_id:T.id}}]})));
  ws.on('message',(m)=>{try{const d0=JSON.parse(m.toString());
    for(const e of (Array.isArray(d0)?d0:[d0])){if(e.channel!=='price.polymarket')continue;
      const p=e.payload??{},b=Number(p.best_bid),a=Number(p.best_ask);
      if(Number.isFinite(b)&&Number.isFinite(a)&&b>0)mids.push([Number(e.ts),(b+a)/2]);}}catch{}});
  setTimeout(res,2000); });

const DUR=Number(process.argv[2]??600);
const want=BigInt(T.id);
const fills=[]; const seen=new Set();
let last=parseInt(await rpc('eth_blockNumber',[]),16);
console.log('capturing',DUR,'s from block',last,'\n');
const t0=Date.now();
while((Date.now()-t0)/1000<DUR){
  const head=parseInt(await rpc('eth_blockNumber',[]),16);
  if(head>last){ for(const a of EXCHANGES){ let lg=[];
      try{ lg=await rpc('eth_getLogs',[{address:a,fromBlock:'0x'+(last+1).toString(16),toBlock:'0x'+head.toString(16),topics:[OF]}]); }catch{}
      for(const l of lg){ const d=l.data.slice(2);
        const side=BigInt('0x'+d.slice(0,64))===0n?'BUY':'SELL';
        const tid=BigInt('0x'+d.slice(64,128)); if(tid!==want) continue;
        const usdc=Number(BigInt('0x'+d.slice(128,192)))/1e6, sh=Number(BigInt('0x'+d.slice(192,256)))/1e6;
        const key=l.transactionHash+':'+l.logIndex; if(seen.has(key))continue; seen.add(key);
        // settle amount depends on side: BUY pays USDC, SELL receives it
        const usd = side==='BUY'? usdc : sh;
        fills.push({block:Number(l.blockNumber), tsMs:0, side, usd, shares:side==='BUY'?sh:usdc, logIndex:l.logIndex}); } }
    last=head; }
  await new Promise(x=>setTimeout(x,1500));
}
console.log(`fills for target token: ${fills.length}   midSamples: ${mids.length}`);
// Resolve REAL block timestamps. blockNumber*1000 is a fabricated value and
// never aligns with websocket mid samples, which silently yields n=0.
const bts=new Map();
async function blockMs(bn){ if(bts.has(bn)) return bts.get(bn);
  const r=await rpc('eth_getBlockByNumber',['0x'+bn.toString(16),false]);
  const v=r&&r.timestamp?Number(r.timestamp)*1000:null; bts.set(bn,v); return v; }
for(const f of fills){ const t=await blockMs(f.block); f.tsMs=t??0; }
const good=fills.filter(f=>f.tsMs>0);
console.log('fills with resolved timestamps:',good.length,'of',fills.length);
if(good.length>1){const sp=(good[good.length-1].tsMs-good[0].tsMs)/1000;
  console.log('time span:',sp.toFixed(0),'s over',new Set(good.map(f=>f.block)).size,'blocks');}
for(const f of fills) if(!f.tsMs) continue;
// block time ~2s: fill ts is block-granular, so use observed block spacing
if(fills.length&&mids.length){
  const b0=fills[0].tsMs, bN=fills[fills.length-1].tsMs;
  console.log('fill block span:',((bN-b0)/1000).toFixed(0),'s   (on-chain ts is block-granular, ~2s)');
}
function midAt(t){let lo=0,hi=mids.length-1;while(lo<hi){const m=(lo+hi)>>1;if(mids[m][0]<t)lo=m+1;else hi=m;}
  let bi=-1,bd=Infinity;for(const j of [lo-1,lo,lo+1]){if(j<0||j>=mids.length)continue;const d=Math.abs(mids[j][0]-t);if(d<bd){bd=d;bi=j;}}
  return bd<=2500?mids[bi][1]:null;}
// MAKER MARKOUT, not mid movement. `side` is the side of the BOOK consumed,
// so it identifies the PASSIVE maker: side BUY => an aggressor hit our bid and
// the maker SOLD at `fillPrice`; side SELL => an aggressor lifted our ask and the
// maker BOUGHT at `fillPrice`. Positive = favourable to the maker.
const stats={BUY:[],SELL:[]};
for(const HZ of [1,5,30]){ stats['BUY_'+HZ]=[]; stats['SELL_'+HZ]=[]; }
for(const f of fills){
  if(!f.tsMs) continue;
  const m1=midAt(f.tsMs+ (0) );           // mid AT the fill
  if(m1===null) continue;
  for(const HZ of [1,5,30]){
    const mF=midAt(f.tsMs+HZ*1000); if(mF===null) continue;
    const fillPx = f.usd/f.shares;       // price the passive maker transacted at
    const c = f.side==='BUY' ? (fillPx-mF)*100 : (mF-fillPx)*100;
    stats[f.side].push(c); stats[f.side+'_'+HZ].push(c);
  }
}
const q=(v,f)=>{const a=v.slice().sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(f*a.length))];};
const mean=v=>v.reduce((x,y)=>x+y,0)/v.length;
const line=(lbl,v)=>{ if(!v.length){console.log('  '+lbl.padEnd(22)+'n=0');return;}
  console.log('  '+lbl.padEnd(22)+'n='+String(v.length).padStart(3)+'  mean='+mean(v).toFixed(3)+'c  p10='+q(v,0.1).toFixed(2)+'c  p50='+q(v,0.5).toFixed(2)+'c  p90='+q(v,0.9).toFixed(2)+'c  worst='+Math.min(...v).toFixed(2)+'c'); };
console.log('\nMAKER MARKOUT (positive = favourable to the passive maker)');
for(const HZ of [1,5,30]){ console.log(' +'+HZ+'s'); line('maker SOLD (book BUY)',stats['BUY_'+HZ]); line('maker BOUGHT (book SELL)',stats['SELL_'+HZ]); line('ALL',stats['BUY_'+HZ].concat(stats['SELL_'+HZ])); }
console.log('\nfill price vs mid at fill (edge capture per fill, cents):');
for(const f of fills.slice(0,8)){ const m=midAt(f.tsMs); if(m===null)continue;
  const fp=f.usd/f.shares; console.log('  '+f.side.padEnd(5)+' fill='+fp.toFixed(3)+'  mid='+m.toFixed(3)+'  edge='+((f.side==='BUY'?fp-m:m-fp)*100).toFixed(2)+'c'); }
