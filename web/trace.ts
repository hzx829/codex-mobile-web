/**
 * Timing records for measuring where time goes (docs/sync/IMPLEMENTATION.md, M0). Off unless
 * `localStorage['cmw-trace']` is '1'; opening the page with `?trace=1` or `?trace=0` turns it on or off. Kept in memory only; `cmwTrace()` in the console prints
 * p50/p95 per kind, `cmwTrace.export()` returns the records as JSON, `cmwTrace.clear()` empties them.
 *
 * Requests: the relay adds `relayMs` (forwarded to received back), the connector `handleMs`, its own
 * clock `now` and named `steps`. Each part is measured on one clock, so no clocks are compared, except
 * for live frames, whose delay uses the clock offset estimated from traced requests.
 */
export type TraceRecord={kind:string;name:string;ms:number;at:number;bytes?:number;parts?:Record<string,number>};

const LIMIT=500;
const records:TraceRecord[]=[];
const offsets:number[]=[];

export function tracing(){try{return localStorage.getItem('cmw-trace')==='1';}catch{return false;}}
export function record(entry:Omit<TraceRecord,'at'>){
  if(!tracing())return;
  records.push({...entry,at:Date.now()});
  if(records.length>LIMIT)records.splice(0,records.length-LIMIT);
}

/** A traced request's answer: splits its time into the phone's link, the computer's link and the computer's work. */
export function recordRequest(action:string,sentAt:number,receivedAt:number,sentWall:number,bytes:number,trace:any){
  const total=receivedAt-sentAt,parts:Record<string,number>={};
  if(trace&&typeof trace==='object'){
    const relay=Number(trace.relayMs),handle=Number(trace.handleMs);
    if(Number.isFinite(relay)){parts.phoneLink=total-relay;parts.relay=relay;}
    if(Number.isFinite(relay)&&Number.isFinite(handle))parts.computerLink=relay-handle;
    if(Number.isFinite(handle))parts.computer=handle;
    if(trace.steps&&typeof trace.steps==='object')for(const [key,value] of Object.entries(trace.steps))if(typeof value==='number')parts['step.'+key]=value;
    // The computer answered about halfway through; its clock minus ours, kept for live frame delays.
    const now=Number(trace.now);
    if(Number.isFinite(now)&&Number.isFinite(handle)){offsets.push(now-handle/2-(sentWall+total/2));if(offsets.length>21)offsets.shift();}
  }
  record({kind:'request',name:action,ms:total,bytes,parts});
}
/** The computer's clock minus this one's, or null before any traced request. */
export function clockOffset(){
  if(!offsets.length)return null;
  const sorted=[...offsets].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];
}
/** A live frame: from the runtime's change on the computer (`at`, its clock) to here. */
export function recordLive(frame:{at?:unknown;queuedMs?:unknown},bytes:number,service:string){
  if(!tracing())return;
  const offset=clockOffset(),at=Number(frame.at);
  const parts:Record<string,number>={};
  if(Number.isFinite(Number(frame.queuedMs)))parts.queued=Number(frame.queuedMs);
  record({kind:'live',name:service,ms:offset===null||!Number.isFinite(at)?NaN:Date.now()-(at-offset),bytes,parts});
}

const opens=new Map<string,number>();
/** Opening a conversation: `start` when it is chosen, then `cached` and `fresh` when each first shows. */
export function traceOpen(service:string,key:string,phase:'start'|'cached'|'fresh'){
  if(!tracing())return;
  const id=`${service}:${key}`;
  if(phase==='start'){opens.set(id,performance.now());return;}
  const started=opens.get(id);if(started===undefined)return;
  if(phase==='fresh')opens.delete(id);
  record({kind:'open',name:`${service}.${phase}`,ms:performance.now()-started});
}

/** A whole file sent or received; `ms` covers every chunk. */
export function recordTransfer(direction:'upload'|'download',bytes:number,ms:number){
  record({kind:'transfer',name:direction,ms,bytes,parts:{mbps:ms>0?bytes/1024/1024/(ms/1000):NaN}});
}

function percentile(values:number[],p:number){
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return NaN;
  return sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))];
}
const round=(value:number)=>Number.isFinite(value)?Math.round(value*10)/10:null;
/** p50 and p95 of the time, size and each part, per kind and name. */
export function summary(){
  const groups=new Map<string,TraceRecord[]>();
  for(const entry of records){const key=`${entry.kind} ${entry.name}`;groups.set(key,[...groups.get(key)||[],entry]);}
  return [...groups].map(([key,list])=>{
    const row:Record<string,number|string|null>={key,count:list.length,p50:round(percentile(list.map(r=>r.ms),.5)),p95:round(percentile(list.map(r=>r.ms),.95))};
    const bytes=list.map(r=>r.bytes??NaN);if(bytes.some(Number.isFinite))row.bytes50=round(percentile(bytes,.5));
    const names=new Set(list.flatMap(r=>Object.keys(r.parts||{})));
    for(const name of names)row[name+'50']=round(percentile(list.map(r=>r.parts?.[name]??NaN),.5));
    return row;
  });
}

if(typeof window!=='undefined'){
  // A phone has no console at hand: the address turns tracing on or off, then drops the parameter.
  try{
    const url=new URL(location.href),flag=url.searchParams.get('trace');
    if(flag==='1'||flag==='0'){
      if(flag==='1')localStorage.setItem('cmw-trace','1');else localStorage.removeItem('cmw-trace');
      url.searchParams.delete('trace');history.replaceState(history.state,'',url.pathname+url.search+url.hash);
    }
  }catch{}
  const api=Object.assign(()=>{const rows=summary();console.table(rows);return rows;},{
    export:()=>JSON.stringify({clockOffset:clockOffset(),userAgent:navigator.userAgent,records},null,2),
    clear:()=>{records.length=0;offsets.length=0;},
    on:()=>{try{localStorage.setItem('cmw-trace','1');}catch{}},
    off:()=>{try{localStorage.removeItem('cmw-trace');}catch{}},
  });
  (window as any).cmwTrace=api;
}
