import type {Json,MessageItem,TurnView} from '../shared/types.js';

/**
 * Live push for the running turn.
 *
 * `thread/read` does not return an agent message until it completes, and every read
 * reloads the whole thread. While a phone watches a thread, the connector keeps the
 * running turn from app-server notifications (or the desktop's patched state) and
 * pushes small frames: text appended to an item, an added or replaced item, or a
 * whole turn when the item list changed shape. Snapshots stay the source of truth;
 * the phone requests one whenever a frame does not line up with what it has.
 */

/** Notifications that only change the running turn's items. */
const ITEM_DELTAS=new Set([
  'item/agentMessage/delta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded','item/reasoning/textDelta',
  'item/commandExecution/outputDelta','item/plan/delta','item/fileChange/patchUpdated','item/fileChange/outputDelta',
  'item/mcpToolCall/progress','item/commandExecution/terminalInteraction',
]);

type LiveItem={raw:Json;completedAt:number};
type LiveTurn={turnId:string;complete:boolean;items:LiveItem[]};

/** The running turn of each connector-owned thread, rebuilt from app-server notifications. */
export class RuntimeLive {
  private turns=new Map<string,LiveTurn>();
  private bases=new Map<string,{turn:Json;at:number}>();
  private sequence=0;
  /** Applies a notification. Returns true when it only changed items that a pushed frame can carry. */
  apply(e:Json):boolean {
    const p=e.params||{},threadId=p.threadId;
    if(typeof threadId!=='string')return false;
    const at=++this.sequence;
    if(e.method==='turn/started'){
      if(typeof p.turn?.id==='string')this.turns.set(threadId,{turnId:p.turn.id,complete:true,items:[]});
      return false;
    }
    if(e.method==='turn/completed'||e.method==='thread/closed'){this.turns.delete(threadId);this.bases.delete(threadId);return false;}
    const started=e.method==='item/started',completed=e.method==='item/completed';
    if(!started&&!completed&&!ITEM_DELTAS.has(e.method))return false;
    if(typeof p.turnId!=='string')return false;
    let turn=this.turns.get(threadId);
    // Joined after the turn began: earlier items come from the persisted snapshot.
    if(!turn||turn.turnId!==p.turnId){turn={turnId:p.turnId,complete:false,items:[]};this.turns.set(threadId,turn);}
    if(started||completed){
      if(typeof p.item?.id!=='string')return false;
      const entry={raw:{...p.item},completedAt:completed?at:0},index=turn.items.findIndex(item=>item.raw.id===p.item.id);
      if(index<0)turn.items.push(entry);else turn.items[index]=entry;
      // A partial turn shows completed items from the snapshot, so that needs a fresh read.
      return turn.complete||!completed;
    }
    if(typeof p.itemId!=='string')return false;
    let entry=turn.items.find(item=>item.raw.id===p.itemId);
    if(!entry){entry={raw:{id:p.itemId,type:placeholderType(e.method)},completedAt:0};turn.items.push(entry);}
    const item=entry.raw,delta=typeof p.delta==='string'?p.delta:'';
    switch(e.method){
      case 'item/agentMessage/delta':case 'item/plan/delta':item.text=(typeof item.text==='string'?item.text:'')+delta;break;
      case 'item/reasoning/summaryPartAdded':case 'item/reasoning/summaryTextDelta':{
        const summary=Array.isArray(item.summary)?[...item.summary]:[],index=Number.isInteger(p.summaryIndex)&&p.summaryIndex>=0?p.summaryIndex:summary.length;
        while(summary.length<=index)summary.push('');
        const current=summary[index];summary[index]=(typeof current==='string'?current:current?.text||'')+delta;item.summary=summary;break;
      }
      case 'item/commandExecution/outputDelta':item.aggregatedOutput=(typeof item.aggregatedOutput==='string'?item.aggregatedOutput:'')+delta;break;
      case 'item/fileChange/patchUpdated':if(Array.isArray(p.changes))item.changes=p.changes;break;
      default:return false; // Progress that the phone does not render.
    }
    return true;
  }
  /** Remembers the persisted copy of the running turn from the latest thread read. */
  rememberBase(threadId:string,turn:Json|undefined,requestedAt:number) {
    const live=this.turns.get(threadId);
    if(live&&turn&&(turn.id||turn.turnId)===live.turnId)this.bases.set(threadId,{turn,at:requestedAt});
  }
  /** Sequence number to pass to rememberBase, taken before a thread read starts. */
  mark(){return this.sequence;}
  has(threadId:string){return this.turns.has(threadId);}
  /** Raw turns with the running turn overlaid. Leaves turns untouched when nothing is live. */
  merge(threadId:string,turns:Json[]):Json[] {
    const live=this.turns.get(threadId);if(!live)return turns;
    const index=turns.findIndex(turn=>(turn.id||turn.turnId)===live.turnId);
    if(index<0){
      // A started turn can be missing from thread/read until its first item is written.
      if(!live.complete)return turns;
      return [...turns,{id:live.turnId,status:'inProgress',items:live.items.map(item=>item.raw)}];
    }
    const turn=turns[index],base=this.bases.get(threadId);
    const items=live.complete?live.items.map(item=>item.raw)
      :[...turn.items||[],...live.items.filter(item=>!item.completedAt||!base||item.completedAt>base.at).map(item=>item.raw)];
    const next=[...turns];next[index]={...turn,status:turn.status==='inProgress'||!turn.status?'inProgress':turn.status,items};return next;
  }
  /** The running turn, raw, or null when it cannot be built without a thread read. */
  turn(threadId:string):Json|null {
    const live=this.turns.get(threadId);if(!live)return null;
    if(live.complete)return {id:live.turnId,status:'inProgress',items:live.items.map(item=>item.raw)};
    const base=this.bases.get(threadId);if(!base)return null;
    return this.merge(threadId,[base.turn])[0];
  }
  clear(){this.turns.clear();this.bases.clear();}
}

function placeholderType(method:string){
  if(method.startsWith('item/reasoning/'))return 'reasoning';
  if(method.startsWith('item/commandExecution/'))return 'commandExecution';
  if(method.startsWith('item/fileChange/'))return 'fileChange';
  if(method==='item/plan/delta')return 'plan';
  if(method.startsWith('item/mcpToolCall/'))return 'mcpToolCall';
  return 'agentMessage';
}

export type LiveOp={i:string;o:number;t:string}|{i:string;item:MessageItem};
export type TurnFields=Partial<Pick<TurnView,'status'|'error'|'diff'|'canFork'>>;
export interface LiveFrame {threadId:string;generation:string;turnId:string;ops?:LiveOp[];fields?:TurnFields;turn?:TurnView}

const sameList=(left?:string[],right?:string[])=>left===right||(left?.length||0)===(right?.length||0)&&(left||[]).every((value,index)=>value===right![index]);
const sameShape=(left:MessageItem,right:MessageItem)=>left.type===right.type&&left.role===right.role&&sameList(left.files,right.files)&&sameList(left.images,right.images);

/** Differences between two versions of the same turn, or null when only a whole turn can express them. */
export function diffTurn(previous:TurnView,next:TurnView):{ops:LiveOp[];fields:TurnFields}|null {
  if(previous.id!==next.id||next.items.length<previous.items.length)return null;
  const ops:LiveOp[]=[];
  for(const [index,item] of next.items.entries()){
    const old=previous.items[index];
    if(!old){ops.push({i:item.id,item});continue;}
    if(old.id!==item.id)return null;
    if(old===item||old.text===item.text&&sameShape(old,item))continue;
    if(sameShape(old,item)&&item.text.length>old.text.length&&item.text.startsWith(old.text))ops.push({i:item.id,o:old.text.length,t:item.text.slice(old.text.length)});
    else ops.push({i:item.id,item});
  }
  const fields:TurnFields={};
  for(const key of ['status','error','diff','canFork'] as const)if(previous[key]!==next[key])(fields as Json)[key]=next[key]??null;
  return {ops,fields};
}

/** What the phones last received for each watched thread, and the frame that brings them to the current turn. */
export class LiveDiff {
  private sent=new Map<string,{generation:string;turn:TurnView}>();
  /** Records the running turn a phone just read, so the next frame only carries what changed after it. */
  prime(threadId:string,generation:string,turn:TurnView|null|undefined) {
    if(turn&&turn.status==='inProgress')this.sent.set(threadId,{generation,turn});
    else this.sent.delete(threadId);
  }
  frame(threadId:string,generation:string,turn:TurnView|null):LiveFrame|null {
    const previous=this.sent.get(threadId);
    if(!turn){this.sent.delete(threadId);return null;}
    this.sent.set(threadId,{generation,turn});
    if(!previous||previous.generation!==generation||previous.turn.id!==turn.id)return {threadId,generation,turnId:turn.id,turn};
    if(previous.turn===turn)return null;
    const diff=diffTurn(previous.turn,turn);
    if(!diff)return {threadId,generation,turnId:turn.id,turn};
    const hasFields=Object.keys(diff.fields).length>0;
    if(!diff.ops.length&&!hasFields)return null;
    return {threadId,generation,turnId:turn.id,...diff.ops.length?{ops:diff.ops}:{},...hasFields?{fields:diff.fields}:{}};
  }
  forget(threadId:string){this.sent.delete(threadId);}
  clear(){this.sent.clear();}
}
