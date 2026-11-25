import {useEffect,useRef,useState} from 'react';
import type {Json} from '../src/shared/types';
import type {SyncService} from '../src/shared/sync';
import {ThreadSync,type StoredThread,type SyncLink,type SyncSeed,type SyncView} from './sync/engine';
import {storedSeed,threadKey as storeKey,threadStore} from './sync/idb-store';

/**
 * Follows a thread with {@link ThreadSync} while `link` and `threadId` are set. Coming back to the page asks for what changed
 * at once instead of waiting for the next renewal. `link` must stay the same object for the same computer.
 */
export function useThreadSync(link:SyncLink|undefined,service:SyncService,threadId:string,seed:()=>SyncSeed|null,machine=''){
  const [view,setView]=useState<SyncView|null>(null);
  const engine=useRef<ThreadSync|null>(null);
  const firstSeed=useRef(seed);firstSeed.current=seed;
  useEffect(()=>{
    if(!link||!threadId){engine.current=null;setView(null);return;}
    // Kept on this device by computer and thread (web/sync/idb-store.ts).
    const persist=machine?{store:threadStore,key:storeKey(service,machine,threadId),seed:(thread:StoredThread)=>storedSeed(service,thread)}:undefined;
    const sync=new ThreadSync(link,service,threadId,firstSeed.current(),persist);
    engine.current=sync;setView(sync.snapshot);
    const stop=sync.subscribe(setView);sync.start();
    const visible=()=>{if(document.visibilityState==='visible')void sync.open();};
    document.addEventListener('visibilitychange',visible);
    return()=>{stop();document.removeEventListener('visibilitychange',visible);sync.close();if(engine.current===sync)engine.current=null;};
  },[link,service,threadId,machine]);
  return {view,engine};
}

/**
 * Puts a followed thread into a panel: its view, and a failed open as a message until one succeeds, leaving other
 * messages alone. `unsupported`: what to say when the connector cannot follow this app.
 */
export function useSyncedPanel(sync:SyncView|null,list:'turns'|'messages',setView:(view:Json)=>void,setError:(update:(old:string)=>string)=>void,unsupported:string){
  const failure=useRef<unknown>(null),message=useRef('');
  useEffect(()=>{
    if(!sync)return;
    const next=viewOf(sync,list);if(next)setView(next);
    if(sync.error===failure.current)return;
    failure.current=sync.error;
    const shown=message.current;
    message.current=sync.error?sync.error.code==='unsupported'?unsupported:sync.error.message||'与电脑的会话同步中断，正在重连…':'';
    setError(old=>message.current||(old===shown?'':old));
  },[sync]);
}

/** The seed of a cached view whose entries are `list` (turns or messages); `revs` holds the revs the cache kept. */
export function seedOf(view:Json|null,list:'turns'|'messages'):SyncSeed|null {
  if(!view||!Array.isArray(view[list]))return null;
  const {[list]:bodies,revs,cached:_,truncated,...head}=view;
  return {head,order:bodies.map((body:Json)=>body.id),bodies,revs:revs&&typeof revs==='object'?revs:undefined,hasMore:Boolean(truncated)};
}
/** The view a panel shows: the head, its entries under `list`, the revs to cache with it, and `cached` until the first answer. */
export function viewOf(sync:SyncView,list:'turns'|'messages'):Json|null {
  if(!sync.head)return null;
  const bodies:Json[]=[],revs:Record<string,string>={};
  for(const id of sync.order){const entry=sync.entries.get(id);if(!entry)continue;bodies.push(entry.body);if(entry.rev)revs[id]=entry.rev;}
  return {...sync.head,[list]:bodies,truncated:sync.hasMore,revs,...sync.phase==='cached'?{cached:true}:{}};
}

/** The view of a thread kept on this device, marked cached, for showing it before its panel has followed it. */
export function storedView(service:SyncService,machine:string,threadId:string,list:'turns'|'messages'):Json|null{
  const seed=storedSeed(service,threadStore.get(storeKey(service,machine,threadId)));
  if(!seed)return null;
  return {...seed.head,[list]:seed.bodies,truncated:seed.hasMore,revs:seed.revs,cached:true};
}
