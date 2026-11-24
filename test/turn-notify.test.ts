import {test} from 'node:test';
import assert from 'node:assert/strict';
import {turnChange,turnEndNotice,waitingNotice} from '../web/turn-notify.js';

test('only a running turn that stops in the same conversation counts as an end',()=>{
  assert.equal(turnChange({key:'a',running:true,waiting:0},{key:'a',running:false,waiting:0}),'end');
  assert.equal(turnChange({key:'a',running:false,waiting:0},{key:'a',running:false,waiting:0}),null);
  assert.equal(turnChange({key:'a',running:false,waiting:0},{key:'a',running:true,waiting:0}),null,'A turn starting is not notified.');
  assert.equal(turnChange({key:'a',running:true,waiting:0},{key:'b',running:false,waiting:0}),null,'Switching conversations is not an end.');
  assert.equal(turnChange({key:'a',waiting:0},{key:'a',running:false,waiting:0}),null,'Opening a conversation is not an end.');
  assert.equal(turnChange({key:'a',running:true,waiting:0},{key:'a',waiting:0}),null,'Not read yet says nothing.');
});

test('a new approval waiting is notified, one answered is not',()=>{
  assert.equal(turnChange({key:'a',running:true,waiting:0},{key:'a',running:true,waiting:1}),'waiting');
  assert.equal(turnChange({key:'a',running:true,waiting:2},{key:'a',running:true,waiting:1}),null);
  assert.equal(turnChange({key:'a',running:true,waiting:1},{key:'a',running:false,waiting:0}),'end','An end wins over the count.');
});

test('the notice names the conversation, the outcome and the start of the reply',()=>{
  assert.deepEqual(turnEndNotice({service:'Codex',title:'修复登录',status:'completed',reply:'已修好。\n\n改了两个文件'}),{title:'修复登录',body:'Codex 已完成：已修好。 改了两个文件'});
  assert.deepEqual(turnEndNotice({service:'Claude Code',status:'failed',error:'额度用完',reply:'先看看'}),{title:'Claude Code',body:'Claude Code 出错了：额度用完'});
  assert.equal(turnEndNotice({service:'Codex',title:'t',status:'interrupted'}).body,'Codex 已停止');
  const long=turnEndNotice({service:'Codex',title:'x'.repeat(80),reply:'y'.repeat(300)});
  assert.equal(long.title.length,60);assert.ok(long.title.endsWith('…'));
  assert.equal(long.body.length,'Codex 已完成：'.length+140);
  assert.deepEqual(waitingNotice('Antigravity','部署'),{title:'部署',body:'Antigravity 正在等待你确认'});
});
