import type {Json,RequestAction,SessionView} from '../src/shared/types';

type Call=(action:RequestAction,payload:Json)=>Promise<any>;
type Target={threadId:string;source:SessionView['source'];generation?:string;expectedTurnId:string|null};
export type TurnSelection={model:string;effort:string;approvalPolicy:string};
const settings=(selection:TurnSelection)=>({model:selection.model||undefined,effort:selection.effort||undefined,approvalPolicy:selection.approvalPolicy||undefined});

export function submitTurn(call:Call,target:Target,text:string,images:string[],selection:TurnSelection) {
  return call('turn.send',{...target,text,images,...(!target.expectedTurnId?settings(selection):{})});
}

export function editTurn(call:Call,target:Target,message:{turnId:string;itemId:string;text:string},selection:TurnSelection) {
  return call('turn.edit',{...target,...message,...settings(selection)});
}
