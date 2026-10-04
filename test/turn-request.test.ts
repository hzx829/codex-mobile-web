import {test} from 'node:test';
import assert from 'node:assert/strict';
import {submitTurn,editTurn} from '../web/turn-request.js';

test('the web send and edit actions preserve the same selected model, effort and approval policy',async()=>{
  const calls:any[]=[];
  const call=async(action:string,payload:any)=>{calls.push({action,payload});};
  const target={threadId:'s',source:'connector' as const,generation:'generation',expectedTurnId:null};
  const selection={model:'gpt-6-astra',effort:'ultra',approvalPolicy:'on-request'};
  await submitTurn(call,target,'new message',[],selection);
  await editTurn(call,target,{turnId:'t',itemId:'u',text:'edited message'},selection);
  for(const request of calls){assert.equal(request.payload.model,'gpt-6-astra');assert.equal(request.payload.effort,'ultra');assert.equal(request.payload.approvalPolicy,'on-request');assert.equal(request.payload.threadId,'s');}
  assert.equal(calls[1].action,'turn.edit');assert.equal(calls[1].payload.turnId,'t');assert.equal(calls[1].payload.itemId,'u');
});

test('web steer retains the active turn settings while an empty edit selection inherits current settings',async()=>{
  const calls:any[]=[];const call=async(action:string,payload:any)=>{calls.push(payload);};
  const target={threadId:'s',source:'desktop' as const,expectedTurnId:'active'};
  await submitTurn(call,target,'additional input',[],{model:'gpt-6-astra',effort:'ultra',approvalPolicy:'never'});
  assert.equal(calls[0].expectedTurnId,'active');assert.equal(calls[0].model,undefined);assert.equal(calls[0].effort,undefined);
  await editTurn(call,{...target,expectedTurnId:null},{turnId:'t',itemId:'u',text:'edited'},{model:'',effort:'',approvalPolicy:''});
  assert.equal(calls[1].model,undefined);assert.equal(calls[1].effort,undefined);
});
