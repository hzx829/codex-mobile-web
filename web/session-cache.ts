import type {Json,SessionView,TurnView} from '../src/shared/types';

/**
 * Recently opened threads and session lists, kept in memory and in IndexedDB so
 * that switching threads or reopening the app shows the last known content at
 * once. A cached view is marked `cached` and is never shown as live: it has no
 * pending requests, queue or running state, and it cannot be acted on until a
 * fresh read replaces it. Logging out clears it.
 *
 * Codex threads are keyed `machine:thread`; Claude Code and Antigravity ones by
 * {@link threadKey}, which also says how their views are trimmed.
 */
export type CachedView=SessionView&{cached?:true};
export type CacheKind='codex'|'claude'|'antigravity';

const MEMORY_VIEWS=40,STORED_VIEWS=20,STORED_TURNS=20,STORED_MESSAGES=200,STORED_BYTES=6*1024*1024,STORED_LISTS=24;
const DB='codex-mobile-web',STORE='cache',VERSION=1;

const views=new Map<string,Json>();
const lists=new Map<string,Json[]>();
const projects=new Map<string,string[]>();
let timer:ReturnType<typeof setTimeout>|undefined;

/** The cache key of a thread. Machine IDs hold neither `:` nor `|`, so the forms cannot collide. */
export function threadKey(kind:CacheKind,machine:string,id:string){return kind==='codex'?`${machine}:${id}`:`${kind}|${machine}|${id}`;}
function parse(key:string):{kind:CacheKind;id:string}{
  if(!key.includes('|'))return {kind:'codex',id:key.split(':')[1]||''};
  const [kind,,id='']=key.split('|');
  return {kind:kind==='claude'||kind==='antigravity'?kind:'codex',id};
}
/** The key of an app's session list (or its project list, with `projects`) in {@link cachedList}. */
export const listKey=(listAction:string,machine:string,project:string)=>`${listAction}|${machine}|${project}`;

/** What only holds while a thread is live, cleared from what the cache gives back (also web/sync/idb-store.ts). */
export const offline:Record<CacheKind,(view:Json)=>Json>={
  codex:view=>({...view,requests:[],queuedMessages:[],running:false,retry:undefined}),
  // `revision` starts the panel's watch; without it the first fresh read comes first.
  claude:view=>({...view,requests:[],queuedMessages:[],running:false,error:'',revision:undefined,controlled:false,external:false,externalStatus:'',
    waitingFor:undefined,heldBy:undefined,notice:'',suggestion:''}),
  antigravity:view=>({...view,requests:[],queuedMessages:[],backgroundTasks:[],running:false,notIdle:false,issue:null,revision:undefined,canSend:true,notice:''}),
};

function touch<T>(map:Map<string,T>,key:string,value:T,limit:number){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);}

/** The last view of a thread, stripped of everything that only holds while it is live. */
export function cachedView<T extends Json=CachedView>(key:string):(T&{cached:true})|null {
  const view=views.get(key);if(!view)return null;
  touch(views,key,view,MEMORY_VIEWS);
  return {...offline[parse(key).kind](view),cached:true} as T&{cached:true};
}
export function rememberView(key:string,view:Json|null) {
  if(!view||view.cached||!parse(key).id)return;
  touch(views,key,view,MEMORY_VIEWS);schedule(key);
}
export function cachedList(key:string){return lists.get(key)||null;}
export function rememberList(key:string,list:Json[]){touch(lists,key,list,STORED_LISTS);schedule();}
export function cachedProjects(machine:string){return projects.get(machine)||[];}
export function rememberProjects(machine:string,list:string[]){if(!machine)return;touch(projects,machine,list,STORED_LISTS);schedule();}

/** Images given as data URLs can be megabytes each and are not stored; a refresh brings them back. References stay. */
const inline=(url:unknown)=>typeof url==='string'&&url.startsWith('data:');
export const hasInline=(entry:Json)=>
  Array.isArray(entry?.items)?entry.items.some((item:Json)=>Array.isArray(item.images)&&item.images.some(inline))
  :Array.isArray(entry?.images)&&entry.images.some(inline);
export const withoutImages=<T extends Json>(entry:T):T=>{
  if(!hasInline(entry))return entry;
  if(Array.isArray(entry.items))return {...entry,items:entry.items.map((item:Json)=>Array.isArray(item.images)&&item.images.some(inline)?{...item,images:item.images.filter((url:unknown)=>!inline(url))}:item)};
  return {...entry,images:entry.images.filter((url:unknown)=>!inline(url))};
};
/** What goes to IndexedDB: the latest turns or messages, without live state. */
export function stored(key:string,view:Json):Json {
  const kind=parse(key).kind;
  if(kind==='codex')return storedCodex(view as SessionView);
  const base=offline[kind](view);
  if(kind==='claude'){
    const turns:TurnView[]=base.turns||[],kept=turns.slice(-STORED_TURNS).map(withoutImages);
    // A turn stored without its images must not claim its rev, or the connector would not send it again (web/sync/engine.ts).
    const revs:Record<string,string>=base.revs&&typeof base.revs==='object'?base.revs:{};
    const keptRevs=Object.fromEntries(kept.flatMap((turn,index)=>turn===turns.at(index-kept.length)&&revs[turn.id]?[[turn.id,revs[turn.id]]]:[]));
    return {...base,turns:kept,truncated:Boolean(base.truncated)||turns.length>STORED_TURNS,revs:keptRevs};
  }
  const raw:Json[]=(base.messages||[]).slice(-STORED_MESSAGES),messages=raw.map(withoutImages);
  const revs:Record<string,string>=base.revs&&typeof base.revs==='object'?base.revs:{};
  return {...base,messages,revs:Object.fromEntries(messages.flatMap((message,index)=>message===raw[index]&&revs[message.id]?[[message.id,revs[message.id]]]:[]))};
}
function storedCodex(view:SessionView):SessionView {
  // Images are data URLs and can be megabytes each; a refresh brings them back. A synced view's revs (web/sync/engine.ts)
  // stay only for turns stored unchanged.
  const kept=view.turns.slice(-STORED_TURNS),revs:Record<string,string>=(view as Json).revs&&typeof (view as Json).revs==='object'?(view as Json).revs:{};
  const keptRevs=Object.fromEntries(kept.flatMap(turn=>!hasInline(turn)&&revs[turn.id]?[[turn.id,revs[turn.id]]]:[]));
  return {...view,requests:[],queuedMessages:[],running:false,retry:undefined,...(view as Json).revs?{revs:keptRevs}:{},
    // A turn without its images must not claim its revision, or the connector would not resend it.
    turns:view.turns.slice(-STORED_TURNS).map(turn=>{
      if(!hasInline(turn))return turn;
      const {revision:_,...rest}=withoutImages(turn);return rest;
    }),
    hasMore:view.hasMore||view.turns.length>STORED_TURNS,nextCursor:view.turns.length>STORED_TURNS?{before:view.turns.at(-STORED_TURNS)!.id}:view.nextCursor};
}

let database:Promise<IDBDatabase>|null=null;
function open():Promise<IDBDatabase> {
  // One connection for the page, so a flush when the page hides starts its transaction at once.
  database??=new Promise<IDBDatabase>((resolve,reject)=>{
    if(typeof indexedDB==='undefined'){reject(Error('IndexedDB unavailable'));return;}
    const request=indexedDB.open(DB,VERSION);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=null;};db.onclose=()=>{database=null;};resolve(db);};
    request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('IndexedDB blocked'));
  });
  database.catch(()=>{database=null;});
  return database;
}
function done(tx:IDBTransaction){return new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
const get=(store:IDBObjectStore,key:string)=>new Promise<any>((resolve,reject)=>{const request=store.get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});

/** Reads the stored cache. Gives up after `timeout` so a slow or blocked database never delays the app. */
export async function loadCache(timeout=200):Promise<void> {
  const read=async()=>{
    const db=await open(),tx=db.transaction(STORE,'readonly'),store=tx.objectStore(STORE);
    const meta=await get(store,'meta');
    if(!meta||meta.version!==VERSION)return;
    const stored=await Promise.all((meta.views as string[]).map(async key=>[key,await get(store,`view:${key}`)] as const));
    for(const [key,view] of stored)if(view&&!views.has(key))views.set(key,view);
    for(const [key,list] of meta.lists||[])if(!lists.has(key))lists.set(key,list);
    for(const [key,list] of meta.projects||[])if(!projects.has(key))projects.set(key,list);
  };
  try{await Promise.race([read(),new Promise(resolve=>setTimeout(resolve,timeout))]);}
  catch{/* Private browsing or storage disabled: keep the memory cache only. */}
}

const dirty=new Set<string>();let metaDirty=false;
function schedule(key?:string){
  if(key)dirty.add(key);else metaDirty=true;
  if(!timer)timer=setTimeout(()=>{timer=undefined;void flushCache();},1200);
}
/** Writes what changed: the touched threads and the small index. Older threads beyond the limit are dropped. */
export async function flushCache():Promise<void> {
  clearTimeout(timer);timer=undefined;
  if(!dirty.size&&!metaDirty)return;
  const keys=[...views.keys()].slice(-STORED_VIEWS),write=[...dirty].filter(key=>keys.includes(key));
  dirty.clear();metaDirty=false;
  try{
    const db=await open(),tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
    const previous:string[]=(await get(store,'meta'))?.views||[];
    const kept:string[]=[];
    for(const key of keys){
      if(write.includes(key)){
        const value=stored(key,views.get(key)!);
        // Skip a thread too large to be worth storing; it is still kept in memory.
        if(JSON.stringify(value).length>STORED_BYTES/2){store.delete(`view:${key}`);continue;}
        store.put(value,`view:${key}`);
      }else if(!previous.includes(key))continue;
      kept.push(key);
    }
    for(const key of previous)if(!kept.includes(key))store.delete(`view:${key}`);
    store.put({version:VERSION,views:kept,lists:[...lists],projects:[...projects]},'meta');
    await done(tx);
  }catch{}
}

export async function clearCache():Promise<void> {
  clearTimeout(timer);timer=undefined;views.clear();lists.clear();projects.clear();dirty.clear();metaDirty=false;
  try{const db=await open(),tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();await done(tx);}catch{}
}
