import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {DraftSave,flushAllDrafts,hasPendingDrafts} from '../web/draft-save.js';
import {clearDraftAttachments,flushDraftAttachments,hasDraftAttachments,readDraftAttachments,writeDraftAttachments} from '../web/composer-attachments.js';

test('typing coalesces writes; flush and thread changes preserve the latest draft exactly once',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const saved:[string,string][]=[];const draft=new DraftSave((key,text)=>saved.push([key,text]));
  for(let i=0;i<100;i++)draft.write('first',`draft ${i}`);
  assert.equal(saved.length,0);t.mock.timers.tick(300);assert.deepEqual(saved,[['first','draft 99']]);
  draft.write('first','before navigation');draft.write('second','new thread');
  assert.deepEqual(saved.at(-1),['first','before navigation']);
  draft.flush();draft.flush();t.mock.timers.tick(300);
  assert.deepEqual(saved.at(-1),['second','new thread']);assert.equal(saved.length,3);
  draft.write('second','send now');draft.flush();saved.push(['second','']);
  t.mock.timers.tick(1000);assert.deepEqual(saved.at(-1),['second',''],'A delayed timer must not restore a sent draft.');
});

test('draft attachments stay per conversation across switches and clear when sent or logged out',()=>{
  clearDraftAttachments();
  writeDraftAttachments('antigravity:pc:new',['data:image/png;base64,AA=='],[{id:'f1',name:'spec.pdf',size:12}]);
  writeDraftAttachments('antigravity:pc:other',['data:image/png;base64,BB=='],[]);
  assert.deepEqual(readDraftAttachments('antigravity:pc:new'),{images:['data:image/png;base64,AA=='],files:[{id:'f1',name:'spec.pdf',size:12}]});
  assert.deepEqual(readDraftAttachments('antigravity:pc:other'),{images:['data:image/png;base64,BB=='],files:[]});
  writeDraftAttachments('antigravity:pc:new',[],[]);
  assert.deepEqual(readDraftAttachments('antigravity:pc:new'),{images:[],files:[]});
  clearDraftAttachments();
  assert.deepEqual(readDraftAttachments('antigravity:pc:other'),{images:[],files:[]});
});

test('flushAllDrafts flushes every pending composer draft immediately before hot-deploy reload',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const saved:[string,string][]=[];
  const a=new DraftSave((key,text)=>saved.push([key,text]));
  const b=new DraftSave((key,text)=>saved.push([key,text]));
  assert.equal(hasPendingDrafts(),false);
  a.write('codex:pc:t1','unfinished codex thought');
  b.write('antigravity:pc:c1','unfinished ag thought');
  assert.equal(hasPendingDrafts(),true);
  assert.equal(saved.length,0);
  flushAllDrafts();
  assert.equal(hasPendingDrafts(),false);
  assert.deepEqual(saved,[['codex:pc:t1','unfinished codex thought'],['antigravity:pc:c1','unfinished ag thought']]);
});

test('draft attachments persist to IndexedDB and survive reload',async()=>{
  clearDraftAttachments();
  await flushDraftAttachments();
  assert.equal(hasDraftAttachments(),false);
  writeDraftAttachments('codex:pc:t1',['data:image/png;base64,CC=='],[{id:'f2',name:'notes.pdf',size:42}]);
  assert.equal(hasDraftAttachments(),true);
  await flushDraftAttachments();
  // Simulate reloading into a fresh module memory map by calling a separate read via IndexedDB
  const {loadDraftAttachments:reloadDrafts,readDraftAttachments:readAfter}=await import(`../web/composer-attachments.js?reload=${Date.now()}`);
  assert.deepEqual(readAfter('codex:pc:t1'),{images:[],files:[]});
  await reloadDrafts();
  assert.deepEqual(readAfter('codex:pc:t1'),{images:['data:image/png;base64,CC=='],files:[{id:'f2',name:'notes.pdf',size:42}]});
  clearDraftAttachments();
  await flushDraftAttachments();
});
