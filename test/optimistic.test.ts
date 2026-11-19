import {test} from 'node:test';
import assert from 'node:assert/strict';
import {optimisticDelivered,optimisticMessage} from '../web/optimistic.js';
import {cachedView,rememberView} from '../web/session-cache.js';
import type {SessionView} from '../src/shared/types.js';

const view=(users:string[]):SessionView=>({id:'t',sessionId:'t',title:'',cwd:'',model:'',provider:'',source:'desktop',activeTurnId:null,canControl:true,requests:[{id:1}],queuedMessages:[{id:'q',text:'',imageCount:0,state:'queued'}],running:true,
  turns:[{id:'u',status:'completed',canFork:true,revision:'r',items:users.map(id=>({id,type:'userMessage',role:'user',text:id,images:['data:image/png;base64,AA']}))}]});

test('a sent message stays until the conversation shows a new user message after acceptance',()=>{
  const message=optimisticMessage('pc:t',view(['a']),'hello',[],[]);
  assert.equal(optimisticDelivered(message,view(['a','b'])),false,'Not before the send is accepted.');
  const accepted={...message,acceptedAt:Date.now()};
  assert.equal(optimisticDelivered(accepted,view(['a'])),false);
  assert.equal(optimisticDelivered(accepted,view(['a','b'])),true);
});

test('a cached thread is shown without live state and never replaces itself',()=>{
  rememberView('pc:t',view(['a']));
  const cached=cachedView('pc:t')!;
  assert.equal(cached.cached,true);assert.deepEqual(cached.requests,[]);assert.deepEqual(cached.queuedMessages,[]);assert.equal(cached.running,false);
  assert.equal(cached.turns[0].items[0].images?.length,1,'Memory keeps images.');
  rememberView('pc:t',{...cached,title:'stale'});
  assert.equal(cachedView('pc:t')!.title,'','A cached view is not stored again.');
  assert.equal(cachedView('pc:missing'),null);
});
