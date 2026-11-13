import type {SessionView,TurnCursor,TurnView} from '../src/shared/types';

export const HISTORY_PAGE_SIZE=20;

const sameStrings=(left:string[]|undefined,right:string[]|undefined)=>left===right||Boolean(left&&right&&left.length===right.length&&left.every((value,index)=>value===right[index]));
function sameTurn(left:TurnView,right:TurnView):boolean {
  return left===right||left.revision===right.revision&&left.id===right.id&&left.status===right.status&&left.canFork===right.canFork&&left.diff===right.diff&&left.error===right.error&&left.items.length===right.items.length&&left.items.every((item,index)=>{
    const other=right.items[index];
    return item===other||item.id===other.id&&item.type===other.type&&item.role===other.role&&item.text===other.text&&sameStrings(item.files,other.files)&&sameStrings(item.images,other.images);
  });
}

export function refreshHistory(current:SessionView|null,next:SessionView):SessionView {
  if(!current||current.id!==next.id||current.source!==next.source||current.generation!==next.generation)return next;
  const previous=new Map(current.turns.map(turn=>[turn.id,turn]));
  const incoming=next.turns.map(turn=>{const old=previous.get(turn.id);return old&&sameTurn(old,turn)?old:turn;});
  const first=next.hasMore?current.turns.findIndex(turn=>turn.id===next.turns[0]?.id):-1;
  // No overlap means we missed a page (or the thread was reverted). Start a fresh window.
  const merged=first<0?incoming:[...current.turns.slice(0,first),...incoming];
  const turns=merged.length===current.turns.length&&merged.every((turn,index)=>turn===current.turns[index])?current.turns:merged;
  const result=first<0?{...next,turns}:{...next,turns,hasMore:current.hasMore,nextCursor:current.nextCursor};
  // Polling an unchanged snapshot must not rerender the page or move the scroll position.
  const keys=new Set([...Object.keys(current),...Object.keys(result)] as (keyof SessionView)[]);
  if(turns===current.turns&&[...keys].every(key=>current[key]===result[key]||key!=='turns'&&JSON.stringify(current[key])===JSON.stringify(result[key])))return current;
  return result;
}

export function prependHistory(current:SessionView|null,page:SessionView,cursor:TurnCursor):SessionView|null {
  if(!current||current.id!==page.id||current.source!==page.source||current.generation!==page.generation||current.turns[0]?.id!==cursor.before)return current;
  const ids=new Set(current.turns.map(turn=>turn.id));
  const older=page.turns.filter(turn=>!ids.has(turn.id));
  return {...current,turns:[...older,...current.turns],hasMore:page.hasMore&&older.length>0,nextCursor:older.length?page.nextCursor:null};
}
