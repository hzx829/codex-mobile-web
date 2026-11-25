import type {Json} from '../../src/shared/types';
import type {SyncEntry,SyncFrame,SyncPage,SyncPatch,SyncService,SyncSnapshot} from '../../src/shared/sync';

/**
 * Follows one thread with the subscription protocol of docs/sync/DESIGN.md §5–7. It starts from what was cached (shown as
 * `cached`), opens the thread with the revs it holds, applies numbered frames, and opens again whenever a frame does not
 * follow on: a gap, another epoch, a reconnect. Nothing here uses the DOM or React, so a native app can reuse it.
 */
export interface SyncLink {
  /** Whether requests can go out now; while not, opening waits for {@link onStatus} to say it can. */
  online():boolean;
  request(action:'sync.open'|'sync.page',payload:Json):Promise<any>;
  /** Frames of synced threads from this computer. */
  onFrame(listener:(frame:Json)=>void):()=>void;
  onStatus(listener:(online:boolean)=>void):()=>void;
  /** Which thread the relay should send frames for; null stops. `owner` stops only if it is still that thread. */
  watch(target:{service:SyncService;threadId:string}|null,owner?:{service:SyncService;threadId:string}):void;
}
export type SyncPhase='cached'|'syncing'|'live'|'offline';
export type SyncEntryState={rev?:string;body:Json};
/** What the thread looks like now. A new object after every change. */
export interface SyncView {phase:SyncPhase;head:Json|null;order:string[];entries:ReadonlyMap<string,SyncEntryState>;hasMore:boolean;error:any}
export type SyncSeed={head:Json;order:string[];bodies:Json[];revs?:Record<string,string>;hasMore:boolean};
/** A thread as a store keeps it (web/sync/idb-store.ts; SQLite in a native app). */
export type StoredThread={head:Json;order:string[];entries:ReadonlyMap<string,SyncEntryState>;hasMore:boolean};
export interface ThreadStore {
  /** What is in memory now, for showing a thread at once. */
  get(key:string):StoredThread|null;
  load(key:string):Promise<StoredThread|null>;
  put(key:string,thread:StoredThread):void;
}
/** Where a followed thread is kept: `seed` turns what is stored into what may be shown before the computer answers. */
export type SyncPersist={store:ThreadStore;key:string;seed:(thread:StoredThread)=>SyncSeed|null};

const RENEW_MS=10_000,RETRY_MS=2500;

class Gap extends Error {}

/** Applies item operations from the connector (src/connector/thread-hub.ts entryDiff) to a turn-shaped entry. */
export function applyPatch(body:Json,patch:Pick<SyncPatch,'ops'|'fields'>):Json {
  if(!Array.isArray(body.items))throw new Gap('patch on an entry without items');
  let items:Json[]=body.items;
  for(const op of patch.ops||[]){
    const at=items.findIndex(item=>item.id===op.i);
    if(op.item&&typeof op.item==='object'){items=at<0?[...items,op.item]:items.map((item,index)=>index===at?op.item:item);continue;}
    if(at<0||typeof op.o!=='number'||typeof op.t!=='string')throw new Gap('unknown item');
    const text=items[at].text;
    if(typeof text!=='string'||op.o>text.length)throw new Gap('text not caught up');
    if(op.o+op.t.length<=text.length)continue;
    const next={...items[at],text:text+op.t.slice(text.length-op.o)};
    items=items.map((item,index)=>index===at?next:item);
  }
  const next:Json={...body,items};
  for(const [key,value] of Object.entries(patch.fields||{}))if(value===null)delete next[key];else next[key]=value;
  return next;
}

export class ThreadSync {
  private head:Json|null=null;
  private order:string[]=[];
  private entries=new Map<string,SyncEntryState>();
  private hasMore=false;
  private phase:SyncPhase;
  private error:any=null;
  private epoch='';
  private seq=-1;
  private opening:Promise<void>|null=null;
  private again=false;
  private buffered:SyncFrame[]=[];
  private listeners=new Set<(view:SyncView)=>void>();
  private stops:(()=>void)[]=[];
  private renew:ReturnType<typeof setInterval>|undefined;
  private retry:ReturnType<typeof setTimeout>|undefined;
  private closed=false;
  private current:SyncView;
  constructor(private link:SyncLink,readonly service:SyncService,readonly threadId:string,seed?:SyncSeed|null,private persist?:SyncPersist){
    const stored=persist?.store.get(persist.key);
    seed=(stored&&persist!.seed(stored))||seed;
    if(seed)this.adopt(seed);
    this.phase=seed?'cached':'syncing';
    this.current=this.view();
    // Not in memory: shown from the store as soon as it is read, unless the computer answered first.
    if(!seed&&persist)void persist.store.load(persist.key).then(thread=>{
      const found=thread&&persist.seed(thread);
      if(!found||this.closed||this.head||this.phase!=='syncing')return;
      this.adopt(found);this.phase='cached';this.emit();
    }).catch(()=>{});
  }
  private adopt(seed:SyncSeed){
    this.head=seed.head;this.order=[...seed.order];this.hasMore=seed.hasMore;
    this.entries=new Map(seed.bodies.map(body=>[body.id,{body,rev:seed.revs?.[body.id]}]));
  }
  get snapshot(){return this.current;}
  subscribe(listener:(view:SyncView)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}

  /** Starts following: opens now, again every {@link RENEW_MS} (which also keeps the subscription), and after reconnecting. */
  start(){
    const target={service:this.service,threadId:this.threadId};
    this.link.watch(target);
    this.stops.push(this.link.onFrame(frame=>this.receive(frame)));
    this.stops.push(this.link.onStatus(online=>{
      if(online){this.link.watch(target);void this.open();}
      else{this.epoch='';this.seq=-1;this.buffered=[];if(this.phase==='live')this.set('offline');}
    }));
    this.renew=setInterval(()=>void this.open(),RENEW_MS);
    void this.open();
  }
  close(){
    this.closed=true;clearInterval(this.renew);clearTimeout(this.retry);
    for(const stop of this.stops)stop();this.stops=[];this.listeners.clear();
    this.link.watch(null,{service:this.service,threadId:this.threadId});
  }

  /** Asks for what this view lacks. Calls during one ask make one more after it. */
  open():Promise<void> {
    if(this.closed||!this.link.online())return Promise.resolve();
    if(this.opening){this.again=true;return this.opening;}
    const run=(async()=>{
      do{
        this.again=false;
        // Frames that arrive while asking wait for the answer, which says where they continue from.
        this.epoch='';this.seq=-1;
        const have:Record<string,string>={};
        for(const [id,entry] of this.entries)if(entry.rev)have[id]=entry.rev;
        try{
          const snapshot:SyncSnapshot=await this.link.request('sync.open',{service:this.service,threadId:this.threadId,have,...this.order.length?{from:this.order[0]}:{}});
          if(this.closed)return;
          this.applySnapshot(snapshot);
        }catch(error){
          if(this.closed)return;
          this.error=error;
          if(this.phase==='live')this.set('offline');else this.emit();
          clearTimeout(this.retry);this.retry=setTimeout(()=>void this.open(),RETRY_MS);
          return;
        }
      }while(this.again&&!this.closed);
    })().finally(()=>{this.opening=null;});
    this.opening=run;
    return run;
  }
  /** Loads `limit` entries before the oldest shown. */
  async page(limit:number):Promise<void> {
    const before=this.order[0];if(!before||!this.hasMore)return;
    const page:SyncPage=await this.link.request('sync.page',{service:this.service,threadId:this.threadId,before,limit});
    if(this.closed||this.order[0]!==before)return;
    for(const entry of page.entries)this.entries.set(entry.id,{rev:entry.rev,body:entry.body});
    if(page.order.some(id=>!this.entries.has(id)))throw new Error('会话同步不完整，请重新打开会话');
    this.order=[...page.order.filter(id=>!this.order.includes(id)),...this.order];
    this.hasMore=page.hasMore;
    this.emit();
  }

  private applySnapshot(snapshot:SyncSnapshot){
    const known=new Map(this.entries);
    for(const entry of snapshot.entries)known.set(entry.id,{rev:entry.rev,body:entry.body});
    // Entries before the answer's first one stay when the answer joins onto them (earlier pages this view loaded).
    const at=snapshot.order.length?this.order.indexOf(snapshot.order[0]):-1;
    const order=at>0?[...this.order.slice(0,at),...snapshot.order]:snapshot.order;
    if(order.some(id=>!known.has(id))){
      // The answer counted on an entry this view no longer has; ask again without any.
      this.entries.clear();this.order=[];this.again=true;return;
    }
    this.entries=new Map(order.map(id=>[id,known.get(id)!]));
    this.order=order;this.head=snapshot.head;
    this.hasMore=at>0?this.hasMore:snapshot.hasMore;
    this.epoch=snapshot.epoch;this.seq=snapshot.seq;
    const waiting=this.buffered.filter(frame=>frame.epoch===snapshot.epoch&&frame.seq>snapshot.seq).sort((a,b)=>a.seq-b.seq);
    this.buffered=[];
    this.phase='live';
    for(const frame of waiting)if(!this.apply(frame))break;
    this.error=null;clearTimeout(this.retry);
    this.emit();
  }

  private receive(frame:Json){
    if(this.closed||frame.service!==this.service||frame.threadId!==this.threadId)return;
    const value=frame as SyncFrame;
    if(this.opening||!this.epoch){this.buffered.push(value);if(this.buffered.length>200)this.buffered.shift();return;}
    if(value.epoch===this.epoch&&value.seq<=this.seq)return;
    if(this.apply(value))this.emit();
  }
  /** Applies a frame that follows on; anything else opens the thread again. */
  private apply(frame:SyncFrame):boolean {
    if(frame.epoch!==this.epoch||frame.seq!==this.seq+1){void this.reopen();return false;}
    try{
      const entries=new Map(this.entries);let order=this.order;
      for(const entry of frame.entries||[])entries.set(entry.id,{rev:entry.rev,body:entry.body});
      for(const patch of frame.patches||[]){
        const old=entries.get(patch.id);if(!old)throw new Gap('patch for an unknown entry');
        entries.set(patch.id,{rev:patch.rev,body:applyPatch(old.body,patch)});
      }
      if(frame.order){
        if(!frame.order.length)order=[];
        else{
          const at=order.indexOf(frame.order[0]);
          if(at<0&&order.length)throw new Gap('order does not join');
          order=[...order.slice(0,Math.max(0,at)),...frame.order];
        }
      }else{
        const added=[...frame.entries||[]].map(entry=>entry.id).filter(id=>!order.includes(id));
        if(added.length)order=[...order,...added];
      }
      if(order.some(id=>!entries.has(id)))throw new Gap('missing entry');
      for(const id of [...entries.keys()])if(!order.includes(id))entries.delete(id);
      let head=this.head;
      if(frame.head){head={...head};for(const [key,value] of Object.entries(frame.head))if(value===null)delete head[key];else head[key]=value;}
      this.entries=entries;this.order=order;this.head=head;this.seq=frame.seq;
      return true;
    }catch(error){
      if(!(error instanceof Gap))throw error;
      void this.reopen();return false;
    }
  }
  private reopen(){this.epoch='';this.seq=-1;return this.open();}

  private set(phase:SyncPhase){this.phase=phase;this.emit();}
  private view():SyncView{return {phase:this.phase,head:this.head,order:this.order,entries:this.entries,hasMore:this.hasMore,error:this.error};}
  private emit(){
    this.current=this.view();
    // Only what the computer said is kept; a view shown from the store is not written back.
    if(this.persist&&this.head&&(this.phase==='live'||this.phase==='offline'))this.persist.store.put(this.persist.key,{head:this.head,order:this.order,entries:this.entries,hasMore:this.hasMore});
    for(const listener of this.listeners)listener(this.current);
  }
}
