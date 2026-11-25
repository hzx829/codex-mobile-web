import type {Json,MessageItem,SessionView,TurnView} from '../src/shared/types';

/** A pushed change to the running turn; see src/connector/live.ts. */
export type LiveFrame={threadId:string;generation:string;turnId:string;ops?:Json[];fields?:Json;turn?:TurnView};

/** The view without the turn's revision: the connector must resend a turn this phone assembled itself. */
/** Array.prototype.with is missing on older phone browsers. */
const replaceAt=<T>(list:readonly T[],index:number,value:T):T[]=>{const next=[...list];next[index<0?next.length+index:index]=value;return next;};
const assembled=({revision:_,...turn}:TurnView):TurnView=>turn;

/**
 * Applies live frames to the open thread. `resync` asks for a snapshot when a frame
 * does not line up with this view: an unknown turn or item, or text this view has
 * not caught up to. Repeated text is skipped, so a frame that overlaps a newer
 * snapshot is harmless.
 */
/** A replacement item keeps the sender the last read gave it; live frames from older connectors carry none. */
const withSender=(old:MessageItem|undefined,item:MessageItem)=>item.sender||!old?.sender||old.id!==item.id?item:{...item,sender:old.sender};
function keepSenders(old:TurnView,turn:TurnView):TurnView{
  if(!old.items.some(item=>item.sender))return turn;
  const known=new Map(old.items.map(item=>[item.id,item]));
  return {...turn,items:turn.items.map(item=>withSender(known.get(item.id),item))};
}
export function applyLiveFrames(view:SessionView|null,frames:LiveFrame[]):{view:SessionView|null;resync:boolean} {
  let resync=false,turns=view?.turns,running=view?.running;
  for(const frame of frames) {
    if(!view||!turns||frame.threadId!==view.id)continue;
    if(frame.generation!==view.generation){resync=true;continue;}
    const index=turns.findIndex(turn=>turn.id===frame.turnId);
    if(index<0) {
      // A turn that started after this view was read; the snapshot fills in the rest.
      if(frame.turn&&(!turns.length||turns.at(-1)!.status!=='inProgress')){turns=[...turns,assembled(frame.turn)];running=true;}
      resync=true;continue;
    }
    if(frame.turn){turns=replaceAt(turns,index,assembled(keepSenders(turns[index],frame.turn)));continue;}
    const turn=turns[index];let items=turn.items,changed=false;
    for(const op of frame.ops||[]) {
      const at=items.findIndex(item=>item.id===op.i);
      if(op.item) {
        items=at<0?[...items,op.item as MessageItem]:replaceAt(items,at,withSender(items[at],op.item as MessageItem));changed=true;continue;
      }
      if(at<0||typeof op.o!=='number'||typeof op.t!=='string'){resync=true;continue;}
      const item=items[at],length=item.text.length;
      if(op.o>length){resync=true;continue;}
      if(op.o+op.t.length<=length)continue;
      items=replaceAt(items,at,{...item,text:item.text+op.t.slice(length-op.o)});changed=true;
    }
    const fields=frame.fields&&Object.keys(frame.fields).length?Object.fromEntries(Object.entries(frame.fields).map(([key,value])=>[key,value??undefined])):null;
    if(changed||fields)turns=replaceAt(turns,index,assembled({...turn,...fields,items}));
  }
  if(!view||turns===view.turns)return {view,resync};
  return {view:{...view,turns:turns!,running},resync};
}

/**
 * A snapshot can be read before frames that were already applied here. While the
 * turn runs, keep text that only extends the snapshot's copy.
 */
export function keepLiveText(current:SessionView|null,next:SessionView):SessionView {
  if(!current||current.id!==next.id||current.generation!==next.generation||current.source!==next.source)return next;
  const last=next.turns.at(-1);
  if(!last||last.status!=='inProgress')return next;
  const local=current.turns.find(turn=>turn.id===last.id);
  if(!local||local===last)return next;
  const byId=new Map(local.items.map(item=>[item.id,item]));
  let changed=false;
  const items=last.items.map(item=>{
    const mine=byId.get(item.id);
    if(!mine||mine.text.length<=item.text.length||!mine.text.startsWith(item.text)||mine.type!==item.type)return item;
    changed=true;return {...item,text:mine.text};
  });
  return changed?{...next,turns:replaceAt(next.turns,-1,assembled({...last,items}))}:next;
}
