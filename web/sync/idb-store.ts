import type {Json,TurnView} from '../../src/shared/types';
import type {SyncEntryState,SyncSeed,ThreadStore,StoredThread} from './engine';
import {hasInline,offline,withoutImages,type CacheKind} from '../session-cache';

/**
 * Followed threads on this device (docs/sync/DESIGN.md §7): what each thread last looked like, kept as its head and its
 * entries, so opening it shows that at once and asks the computer only for what changed. Recently used threads are in
 * memory; all of them are in IndexedDB (`threads` and `entries`), within {@link BUDGET} bytes, the least recently used
 * dropped first. Only entries that changed are written. A native app keeps the same interface on SQLite.
 */
const DB='codex-mobile-web-sync',VERSION=1,THREADS='threads',ENTRIES='entries';
const MEMORY=40,BUDGET=50*1024*1024,PRELOAD=10,PRELOAD_BYTES=8*1024*1024,FLUSH_MS=1200;

type Index={at:number;bytes:number};
const memory=new Map<string,StoredThread>();
const index=new Map<string,Index>();
/** The revs IndexedDB holds for each thread's entries, so a write skips the ones that did not change. */
const persisted=new Map<string,Map<string,string>>();
const dirty=new Set<string>();
let timer:ReturnType<typeof setTimeout>|undefined;
let database:Promise<IDBDatabase>|null=null;

const entryKey=(key:string,id:string)=>`${key}\u0001${id}`;
function touch(key:string,value:StoredThread){memory.delete(key);memory.set(key,value);while(memory.size>MEMORY)memory.delete(memory.keys().next().value!);}
function open():Promise<IDBDatabase>{
  database??=new Promise<IDBDatabase>((resolve,reject)=>{
    if(typeof indexedDB==='undefined'){reject(Error('IndexedDB unavailable'));return;}
    const request=indexedDB.open(DB,VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(THREADS))db.createObjectStore(THREADS);
      if(!db.objectStoreNames.contains(ENTRIES))db.createObjectStore(ENTRIES);
    };
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=null;};db.onclose=()=>{database=null;};resolve(db);};
    request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('IndexedDB blocked'));
  });
  database.catch(()=>{database=null;});
  return database;
}
const done=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
const ask=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});

/** An entry as stored: without data URL images, and then without its rev, so the computer sends it again in full. */
function storable(entry:SyncEntryState):SyncEntryState{
  if(!hasInline(entry.body as TurnView))return entry;
  return {body:withoutImages(entry.body as TurnView)};
}
async function readThread(db:IDBDatabase,key:string):Promise<StoredThread|null>{
  const tx=db.transaction([THREADS,ENTRIES],'readonly');
  const record=await ask(tx.objectStore(THREADS).get(key)) as Json|undefined;
  if(!record||!Array.isArray(record.order))return null;
  const values=await Promise.all(record.order.map((id:string)=>ask(tx.objectStore(ENTRIES).get(entryKey(key,id)))));
  if(values.some(value=>!value))return null;
  const entries=new Map<string,SyncEntryState>(record.order.map((id:string,at:number)=>[id,values[at] as SyncEntryState]));
  persisted.set(key,new Map(record.order.flatMap((id:string)=>{const rev=entries.get(id)!.rev;return rev?[[id,rev]]:[];})));
  return {head:record.head,order:record.order,entries,hasMore:Boolean(record.hasMore)};
}

/** Reads the index and the most recently used threads. Gives up after `timeout`, so a slow database never delays the app. */
export async function loadThreadStore(timeout=200):Promise<void>{
  const read=async()=>{
    const db=await open(),tx=db.transaction(THREADS,'readonly');
    const [keys,values]=await Promise.all([ask(tx.objectStore(THREADS).getAllKeys()),ask(tx.objectStore(THREADS).getAll())]);
    keys.forEach((key,at)=>{const value=values[at] as Json;index.set(String(key),{at:Number(value?.at)||0,bytes:Number(value?.bytes)||0});});
    let bytes=0;
    for(const [key,info] of [...index].sort((a,b)=>b[1].at-a[1].at).slice(0,PRELOAD)){
      if(bytes+info.bytes>PRELOAD_BYTES)break;
      const thread=await readThread(db,key);if(thread&&!memory.has(key)){memory.set(key,thread);bytes+=info.bytes;}
    }
  };
  try{await Promise.race([read(),new Promise(resolve=>setTimeout(resolve,timeout))]);}catch{/* Private browsing or storage disabled: memory only. */}
}

async function flush():Promise<void>{
  clearTimeout(timer);timer=undefined;
  if(!dirty.size)return;
  const keys=[...dirty];dirty.clear();
  try{
    const db=await open(),tx=db.transaction([THREADS,ENTRIES],'readwrite'),threads=tx.objectStore(THREADS),entries=tx.objectStore(ENTRIES);
    for(const key of keys){
      const thread=memory.get(key);if(!thread)continue;
      const before=persisted.get(key)||new Map<string,string>(),after=new Map<string,string>();
      let bytes=0;
      for(const id of thread.order){
        const entry=storable(thread.entries.get(id)!),size=JSON.stringify(entry.body).length;
        bytes+=size;
        if(entry.rev)after.set(id,entry.rev);
        if(!entry.rev||before.get(id)!==entry.rev)entries.put(entry,entryKey(key,id));
      }
      for(const id of before.keys())if(!thread.order.includes(id))entries.delete(entryKey(key,id));
      const at=Date.now();
      threads.put({head:thread.head,order:thread.order,hasMore:thread.hasMore,at,bytes},key);
      index.set(key,{at,bytes});persisted.set(key,after);
    }
    // Over the budget, the threads used longest ago go, entries and all.
    let total=[...index.values()].reduce((sum,info)=>sum+info.bytes,0);
    for(const [key,info] of [...index].sort((a,b)=>a[1].at-b[1].at)){
      if(total<=BUDGET)break;
      threads.delete(key);entries.delete(IDBKeyRange.bound(entryKey(key,''),entryKey(key,'￿')));
      index.delete(key);persisted.delete(key);memory.delete(key);total-=info.bytes;
    }
    await done(tx);
  }catch{/* Kept in memory; written with the next change. */}
}

/** The store behind followed threads. `kind` says what live state a stored head must not show again. */
export const threadStore:ThreadStore={
  get:key=>{const thread=memory.get(key);if(thread)touch(key,thread);return thread||null;},
  load:async key=>{
    const known=memory.get(key);if(known)return known;
    if(!index.has(key))return null;
    try{const thread=await readThread(await open(),key);if(thread)touch(key,thread);return thread;}catch{return null;}
  },
  put:(key,thread)=>{touch(key,thread);dirty.add(key);if(!timer)timer=setTimeout(()=>void flush(),FLUSH_MS);},
};
export const flushThreadStore=flush;
export async function clearThreadStore(){
  clearTimeout(timer);timer=undefined;memory.clear();index.clear();persisted.clear();dirty.clear();
  try{const db=await open(),tx=db.transaction([THREADS,ENTRIES],'readwrite');tx.objectStore(THREADS).clear();tx.objectStore(ENTRIES).clear();await done(tx);}catch{}
}

/** A stored thread as the seed of a followed thread: shown as cached, without what only held while it was live. */
export function storedSeed(kind:CacheKind,thread:StoredThread|null):SyncSeed|null{
  if(!thread)return null;
  const head=offline[kind]({...thread.head});
  return {head,order:thread.order,bodies:thread.order.map(id=>thread.entries.get(id)!.body),
    revs:Object.fromEntries(thread.order.flatMap(id=>{const rev=thread.entries.get(id)!.rev;return rev?[[id,rev]]:[];})),hasMore:thread.hasMore};
}
export const threadKey=(kind:CacheKind,machine:string,id:string)=>`${kind}|${machine}|${id}`;
