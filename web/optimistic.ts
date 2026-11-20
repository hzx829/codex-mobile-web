import type {SessionView} from '../src/shared/types';

/**
 * A message shown in the conversation as soon as it is sent. It stays until the
 * conversation shows a user message that was not there before, or a while after
 * acceptance if that never happens. A failed send restores the composer.
 */
export type OptimisticMessage={
  key:string;text:string;images:string[];fileNames:string[];
  state:'sending'|'uncertain';acceptedAt:number|null;baseline:string[];at:number;
};

/** How long an accepted message waits for the conversation before it is hidden. */
export const OPTIMISTIC_ACCEPTED_MS=15_000;

export function userItemIds(view:SessionView|null):string[] {
  return view?view.turns.flatMap(turn=>turn.items.filter(item=>item.role==='user').map(item=>item.id)):[];
}

export function optimisticMessage(key:string,view:SessionView|null,text:string,images:string[],fileNames:string[]):OptimisticMessage {
  return {key,text,images,fileNames,state:'sending',acceptedAt:null,baseline:userItemIds(view),at:Date.now()};
}

/** True when the conversation now shows a user message that was not there when this one was sent. */
export function optimisticDelivered(message:OptimisticMessage,view:SessionView|null):boolean {
  if(!message.acceptedAt||!view)return false;
  const before=new Set(message.baseline);
  return userItemIds(view).some(id=>!before.has(id));
}
