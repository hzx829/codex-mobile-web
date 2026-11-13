import type {SessionView} from '../src/shared/types';

export function knownSnapshot(view:SessionView|null){
  if(!view)return undefined;
  return {id:view.id,source:view.source,generation:view.generation,turns:Object.fromEntries(view.turns.slice(-100).filter(turn=>turn.revision).map(turn=>[turn.id,turn.revision]))};
}
export function restoreSnapshot(previous:SessionView|null,snapshot:SessionView&{turnOrder?:string[]}):SessionView {
  const {turnOrder,...view}=snapshot;
  if(!turnOrder)return view; // Older connectors still return complete snapshots.
  const same=previous?.id===view.id&&previous.source===view.source&&previous.generation===view.generation;
  const turns=new Map(same?previous.turns.map(turn=>[turn.id,turn]):[]);
  for(const turn of view.turns)turns.set(turn.id,turn);
  return {...view,turns:turnOrder.map(id=>{const turn=turns.get(id);if(!turn)throw Error('会话同步不完整，请重新打开会话');return turn;})};
}
