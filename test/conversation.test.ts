import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {ConversationTurn,activitySummary} from '../web/conversation.js';
import type {TurnView} from '../src/shared/types.js';

test('collapsed tool output is mounted only when opened; live updates and actions remain current',async t=>{
  const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
  for(const [key,value] of Object.entries({window,document,IS_REACT_ACT_ENVIRONMENT:true})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
  const root=createRoot(document.getElementById('root')!),copies:string[]=[];
  const turn:TurnView={id:'turn',status:'inProgress',canFork:false,items:[{id:'tool',type:'commandExecution',role:'activity',text:'command\n'+'large output '.repeat(10000)},{id:'answer',type:'agentMessage',role:'assistant',text:'First answer'}]};
  const props={turn,running:true,source:'desktop' as const,latestUser:true,disabled:false,openFile:()=>{},openPreview:()=>{},onFollowup:()=>{},onCopy:(text:string)=>copies.push(text),onEdit:async()=>{},onFork:()=>{},onDiff:()=>{},onBlocked:()=>{}};
  try{
    await act(async()=>root.render(createElement(ConversationTurn,props)));
    assert.equal(document.querySelectorAll('pre').length,0);assert.equal(document.querySelectorAll('.activity').length,0);
    // A group followed by a reply is done even while the turn runs; no separate "in progress" label under the turn.
    assert.equal(document.querySelector('.activity-group summary')!.textContent,'已运行 1 个命令');
    assert.equal(document.querySelector('.turn-status'),null);assert.ok(!document.body.textContent!.includes('进行中'));
    const group=document.querySelector('.activity-group')! as any;
    await act(async()=>{group.open=true;group.dispatchEvent(new window.Event('toggle'));});
    assert.equal(document.querySelectorAll('.activity').length,1);assert.equal(document.querySelectorAll('pre').length,0);
    const item=document.querySelector('.activity')! as any;
    await act(async()=>{item.open=true;item.dispatchEvent(new window.Event('toggle'));});
    assert.equal(document.querySelector('pre')!.textContent,turn.items[0].text);
    const updated={...turn,items:[turn.items[0],{...turn.items[1],text:'Latest answer'}]};
    await act(async()=>root.render(createElement(ConversationTurn,{...props,turn:updated})));
    assert.ok(document.body.textContent.includes('Latest answer'));
    await act(async()=>document.querySelector('[aria-label="复制回复文字"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));
    assert.deepEqual(copies,['Latest answer']);
    await act(async()=>{group.open=false;group.dispatchEvent(new window.Event('toggle'));});
    assert.equal(document.querySelectorAll('pre').length,0);
    // A turn that ended other than by completing still says how.
    await act(async()=>root.render(createElement(ConversationTurn,{...props,running:false,turn:{...updated,status:'interrupted'}})));
    assert.equal(document.querySelector('.turn-status')?.textContent,'已停止');
    await act(async()=>root.render(createElement(ConversationTurn,{...props,running:false,turn:{...updated,status:'completed'}})));
    assert.equal(document.querySelector('.turn-status'),null);
  }finally{await act(async()=>root.unmount());}
});

test('in a running turn only the trailing activity group is live; earlier ones say what they did',async t=>{
  const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
  for(const [key,value] of Object.entries({window,document,IS_REACT_ACT_ENVIRONMENT:true})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
  const root=createRoot(document.getElementById('root')!);
  const turn:TurnView={id:'turn',status:'inProgress',canFork:false,items:[
    {id:'r1',type:'fileRead',role:'activity',text:'a',files:['a.ts']},{id:'r2',type:'fileRead',role:'activity',text:'b',files:['a.ts','b.ts']},{id:'c1',type:'commandExecution',role:'activity',text:'npm test'},
    {id:'m1',type:'agentMessage',role:'assistant',text:'Now the fix'},
    {id:'e1',type:'fileChange',role:'activity',text:'edit',files:['x.ts']},
  ]};
  const props={turn,running:true,source:'desktop' as const,latestUser:true,disabled:false,openFile:()=>{},openPreview:()=>{},onFollowup:()=>{},onCopy:()=>{},onEdit:async()=>{},onFork:()=>{},onDiff:()=>{},onBlocked:()=>{}};
  try{
    await act(async()=>root.render(createElement(ConversationTurn,props)));
    const labels=()=>[...document.querySelectorAll('.activity-group summary')].map(el=>el.textContent);
    assert.deepEqual(labels(),['已读取 2 个文件，已运行 1 个命令','正在处理 · 1 项修改文件']);
    assert.equal(document.querySelectorAll('.activity-label.shimmer').length,1);
    // Once a reply follows it, the last group is done too.
    await act(async()=>root.render(createElement(ConversationTurn,{...props,turn:{...turn,items:[...turn.items,{id:'m2',type:'agentMessage',role:'assistant',text:'Done'}]}})));
    assert.deepEqual(labels(),['已读取 2 个文件，已运行 1 个命令','已编辑 1 个文件']);
    await act(async()=>root.render(createElement(ConversationTurn,{...props,running:false,turn:{...turn,status:'completed'}})));
    assert.equal(document.querySelectorAll('.activity-label.shimmer').length,0);
  }finally{await act(async()=>root.unmount());}
  assert.equal(activitySummary([{id:'1',type:'toolCall',role:'activity',text:''},{id:'2',type:'mcpToolCall',role:'activity',text:''},{id:'3',type:'odd',role:'activity',text:''}]),'已使用 2 个工具，1 项其他活动');
});
