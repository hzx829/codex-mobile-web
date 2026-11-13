import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {ConversationTurn} from '../web/conversation.js';
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
  }finally{await act(async()=>root.unmount());}
});
