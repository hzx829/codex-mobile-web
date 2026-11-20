import type {Json,SessionView} from '../src/shared/types';

/**
 * Recently opened threads and session lists, kept in memory and in IndexedDB so
 * that switching threads or reopening the app shows the last known content at
 * once. A cached view is marked `cached` and is never shown as live: it has no
 * pending requests, queue or running state, and it cannot be acted on until a
 * fresh read replaces it. Logging out clears it.
 */
export type CachedView=SessionView&{cached?:true};

const MEMORY_VIEWS=24,STORED_VIEWS=10,STORED_TURNS=20,STORED_BYTES=6*1024*1024,STORED_LISTS=12;
const DB='codex-mobile-web',STORE='cache',VERSION=1;

const views=new Map<string,SessionView>();
const lists=new Map<string,Json[]>();
const projects=new Map<string,string[]>();
let timer:ReturnType<typeof setTimeout>|undefined;

function touch<T>(map:Map<string,T>,key:string,value:T,limit:number){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);}

/** The last view of a thread, stripped of everything that only holds while it is live. */
export function cachedView(key:string):CachedView|null {
  const view=views.get(key);if(!view)return null;
  touch(views,key,view,MEMORY_VIEWS);
  return {...view,requests:[],queuedMessages:[],running:false,retry:undefined,cached:true};
}
export function rememberView(key:string,view:CachedView|null) {
  if(!view||view.cached||!key.split(':')[1])return;
  touch(views,key,view,MEMORY_VIEWS);schedule(key);
}
export function cachedList(key:string){return lists.get(key)||null;}
export function rememberList(key:string,list:Json[]){touch(lists,key,list,STORED_LISTS);schedule();}
export function cachedProjects(machine:string){return projects.get(machine)||[];}
export function rememberProjects(machine:string,list:string[]){if(!machine)return;touch(projects,machine,list,STORED_LISTS);schedule();}

function stored(view:SessionView):SessionView {
  // Images are data URLs and can be megabytes each; a refresh brings them back.
  return {...view,requests:[],queuedMessages:[],running:false,retry:undefined,
    // A turn without its images must not claim its revision, or the connector would not resend it.
    turns:view.turns.slice(-STORED_TURNS).map(turn=>{
      if(!turn.items.some(item=>item.images?.length))return turn;
      const {revision:_,...rest}=turn;return {...rest,items:turn.items.map(item=>item.images?.length?{...item,images:[]}:item)};
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
        const value=stored(views.get(key)!);
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
