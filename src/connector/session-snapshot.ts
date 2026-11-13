import {createHash} from 'node:crypto';
import {BridgeError,MAX_FRAME,type SessionView,type Json} from '../shared/types.js';

// Each response stands on its own unless the phone explicitly names the revisions it has.
// Keep older, image-heavy turns reachable through pagination instead of overflowing a frame.
export function sessionSnapshot(view:SessionView,known?:Json):SessionView&{turnOrder:string[]} {
  const revisions=known?.generation===view.generation&&known?.source===view.source&&known?.id===view.id?known.turns:null;
  const changed=[];const order:string[]=[];
  let size=Buffer.byteLength(JSON.stringify({...view,turns:[]}))+4096;
  for(let i=view.turns.length-1;i>=0;i--){
    const turn=view.turns[i],serialized=JSON.stringify(turn),revision=createHash('sha256').update(serialized).digest('hex');
    const same=revisions?.[turn.id]===revision;
    const bytes=(same?0:Buffer.byteLength(serialized)+revision.length+16)+Buffer.byteLength(JSON.stringify(turn.id))+1;
    if(size+bytes>MAX_FRAME){if(!order.length)throw new BridgeError('too_large','这一轮内容超过传输上限，请在电脑查看');break;}
    size+=bytes;order.unshift(turn.id);
    if(!same)changed.unshift({...turn,revision});
  }
  const trimmed=order.length<view.turns.length;
  return {...view,turns:changed,turnOrder:order,...trimmed?{hasMore:true,nextCursor:{before:order[0]}}:{}};
}
