import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedList,cachedView,listKey,rememberList,rememberView,threadKey} from '../web/session-cache.js';

const turn=(id:string,images:string[]=[])=>({id,status:'completed',canFork:true,items:[{id:id+'-u',type:'userMessage',role:'user',text:'hi',images}]});

test('thread keys keep the apps apart and Codex keeps its older form', () => {
  assert.equal(threadKey('codex','pc','t'),'pc:t');
  assert.notEqual(threadKey('claude','pc','t'),threadKey('antigravity','pc','t'));
  rememberView(threadKey('claude','pc','same'),{id:'same',title:'claude',turns:[]});
  rememberView(threadKey('antigravity','pc','same'),{id:'same',title:'antigravity',messages:[]});
  assert.equal(cachedView(threadKey('claude','pc','same'))!.title,'claude');
  assert.equal(cachedView(threadKey('antigravity','pc','same'))!.title,'antigravity');
});

test('a cached Claude Code view holds no live state and no revision', () => {
  const key=threadKey('claude','pc','c1');
  rememberView(key,{id:'c1',title:'t',revision:'r1',running:true,controlled:true,external:true,externalStatus:'busy',heldBy:{app:'Claude',pid:1},
    requests:[{id:'q'}],queuedMessages:[{id:'m'}],error:'boom',notice:'n',suggestion:'s',turns:[turn('a')]});
  const view=cachedView<any>(key)!;
  assert.equal(view.cached,true);
  assert.equal(view.revision,undefined,'Without a revision the panel reads before it watches.');
  assert.deepEqual([view.running,view.controlled,view.external,view.externalStatus,view.heldBy,view.error,view.notice,view.suggestion],[false,false,false,'',undefined,'','','']);
  assert.deepEqual([view.requests,view.queuedMessages],[[],[]]);
  assert.equal(view.turns.length,1);
});

test('a cached Antigravity view holds no live state and no revision', () => {
  const key=threadKey('antigravity','pc','a1');
  rememberView(key,{id:'a1',revision:'r',running:true,canSend:false,notIdle:true,issue:{kind:'error'},requests:[{id:'q'}],backgroundTasks:[{id:'b'}],queuedMessages:[{id:'m'}],
    messages:[{id:'1',role:'user',text:'hi'}]});
  const view=cachedView<any>(key)!;
  assert.equal(view.cached,true);
  assert.deepEqual([view.revision,view.running,view.canSend,view.notIdle,view.issue],[undefined,false,true,false,null]);
  assert.deepEqual([view.requests,view.backgroundTasks,view.queuedMessages],[[],[],[]]);
  assert.equal(view.messages.length,1);
});

test('cached views are not stored again and threads without an ID are skipped', () => {
  const key=threadKey('claude','pc','c2');
  rememberView(key,{id:'c2',title:'fresh',turns:[]});
  rememberView(key,{...cachedView<any>(key)!,title:'stale'});
  assert.equal(cachedView(key)!.title,'fresh');
  rememberView(threadKey('claude','pc',''),{id:'',title:'none',turns:[]});
  assert.equal(cachedView(threadKey('claude','pc','')),null);
});

test('session lists are kept per app, computer and project', () => {
  rememberList(listKey('claude.list','pc',''),[{id:'x'}]);
  rememberList(listKey('antigravity.list','pc',''),[{id:'y'}]);
  assert.deepEqual(cachedList(listKey('claude.list','pc','')),[{id:'x'}]);
  assert.deepEqual(cachedList(listKey('antigravity.list','pc','')),[{id:'y'}]);
  assert.equal(cachedList(listKey('claude.list','other','')),null);
});

test('what is stored keeps the latest Claude Code turns without images and the latest Antigravity messages', async () => {
  const {stored}=await import('../web/session-cache.js');
  const turns=Array.from({length:25},(_,i)=>turn('t'+i,i===24?['data:image/png;base64,AAAA']:[]));
  const claude=stored(threadKey('claude','pc','c'),{id:'c',revision:'r',running:true,turns,truncated:false});
  assert.equal(claude.turns.length,20);
  assert.equal(claude.turns[0].id,'t5');
  assert.equal(claude.truncated,true,'The view offers to load what was left out.');
  assert.deepEqual(claude.turns.at(-1).items[0].images,[]);
  assert.deepEqual([claude.revision,claude.running],[undefined,false]);
  const messages=Array.from({length:250},(_,i)=>({id:String(i),role:'assistant',text:'x'}));
  const antigravity=stored(threadKey('antigravity','pc','a'),{id:'a',revision:'r',messages});
  assert.equal(antigravity.messages.length,200);
  assert.equal(antigravity.messages[0].id,'50');
  assert.equal(antigravity.revision,undefined);
});
