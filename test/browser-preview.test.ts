import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BrowserPreview,localPreviewUrl} from '../src/connector/browser-preview.js';
import {belongsToThread,openThreadPreview,previewUrlKey} from '../web/thread-preview.js';

test('browser preview starts only at a local HTTP page',()=>{
  assert.equal(localPreviewUrl('http://127.0.0.1:5173/agents'),'http://127.0.0.1:5173/agents');
  assert.equal(localPreviewUrl('http://localhost:3000/'),'http://localhost:3000/');
  for(const url of ['https://example.com','file:///C:/secret','http://user:pass@localhost:5173','http://192.168.1.2:5173'])assert.throws(()=>localPreviewUrl(url));
});

test('preview address and visibility belong to both the machine and thread',()=>{
  const keys=[['pc','a'],['pc','b'],['other','a'],['pc:a','b'],['pc','a:b']].map(([machine,thread])=>previewUrlKey(machine,thread));
  assert.equal(new Set(keys).size,keys.length);
  assert.ok(keys.every(key=>key!=='browser-preview-url'));
  const session={machineId:'pc',threadId:'a',sessionId:'s',url:'http://localhost:5173',ticket:'t',previewPort:3341};
  assert.equal(belongsToThread(session,'pc','a'),true);
  for(const [machine,thread] of [['pc','b'],['other','a'],['pc','']])assert.equal(belongsToThread(session,machine,thread),false);
  assert.equal(belongsToThread(null,'pc','a'),false);
});

test('opening a preview requires an existing thread and carries its owner',async()=>{
  const calls:any[]=[];
  const request=async(action:string,payload:any,machineId:string)=>{calls.push({action,payload,machineId});return {sessionId:'s',threadId:'a',url:payload.url,ticket:'t',previewPort:3341};};
  await assert.rejects(openThreadPreview(request,'pc','','http://localhost:5173',()=>true));
  assert.equal(calls.length,0);
  const result=await openThreadPreview(request,'pc','a','http://localhost:5173',()=>true);
  assert.equal(result?.machineId,'pc');assert.equal(result?.threadId,'a');
  assert.deepEqual(calls,[{action:'preview.start',payload:{threadId:'a',url:'http://localhost:5173'},machineId:'pc'}]);
});

test('a start response after leaving a thread cleans up only its original preview',async()=>{
  let here=true,resolve!:(value:any)=>void;const calls:any[]=[];
  const request=async(action:string,payload:any,machineId:string)=>{
    calls.push({action,payload,machineId});
    return action==='preview.start'?new Promise(r=>{resolve=r;}):{stopped:true};
  };
  const opening=openThreadPreview(request,'pc-a','thread-a','http://localhost:5173',()=>here);
  here=false;resolve({sessionId:'old-preview',threadId:'thread-a',url:'http://localhost:5173',ticket:'t',previewPort:3341});
  assert.equal(await opening,null);
  assert.deepEqual(calls[1],{action:'preview.stop',payload:{sessionId:'old-preview',threadId:'thread-a'},machineId:'pc-a'});
});

test('a response without the requested thread cannot appear in its preview pane',async()=>{
  const calls:any[]=[];
  const request=async(action:string,payload:any)=>{calls.push({action,payload});return {sessionId:'wrong',threadId:'other'};};
  await assert.rejects(openThreadPreview(request,'pc','a','http://localhost:5173',()=>true),/会话不匹配/);
  assert.deepEqual(calls[1],{action:'preview.stop',payload:{sessionId:'wrong',threadId:'a'}});
});

test('connector preview lifecycle checks the thread and exact session before stopping',()=>{
  const local=new BrowserPreview(),ended:any[]=[];local.on('ended',event=>ended.push(event));
  assert.throws(()=>local.start('http://localhost:5173',undefined));
  const a=local.start('http://localhost:5173','a');assert.equal(a.threadId,'a');
  assert.equal(local.stopForThread(a.sessionId,'b'),false);assert.equal(ended.length,0);
  assert.throws(()=>local.stopForThread(a.sessionId,undefined));
  const b=local.start('http://localhost:3000','b');
  assert.deepEqual(ended,[{sessionId:a.sessionId,threadId:'a'}]);
  assert.equal(local.stopForThread(a.sessionId,'a'),false);
  assert.equal(local.stopForThread(b.sessionId,'a'),false);
  assert.equal(local.stopForThread(b.sessionId,'b'),true);
  assert.deepEqual(ended[1],{sessionId:b.sessionId,threadId:'b'});
});
