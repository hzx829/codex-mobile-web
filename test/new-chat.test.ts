import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFirstTurn} from '../web/new-chat.js';
const input={cwd:'project',text:'task',images:[],createId:'create',sendId:'send'};
test('new chat creates then sends once to the confirmed session',async()=>{
  const calls:any[]=[];let saved='';
  const result=await createFirstTurn(async(action,payload)=>{
    calls.push({action,payload});
    if(action==='session.create')return {state:'accepted',threadId:'s'};
    if(action==='session.read'){assert.equal(saved,'s');return {canControl:true,activeTurnId:null,source:'connector',generation:'g'};}
    return {state:'accepted'};
  },input,id=>{saved=id;});
  assert.equal(result.stage,'send');assert.equal(result.result.state,'accepted');
  assert.deepEqual(calls.map(c=>c.action),['session.create','session.read','turn.send']);
  assert.equal(calls[2].payload.threadId,'s');assert.equal(calls[2].payload.opId,'send');assert.equal(calls[2].payload.generation,'g');
});
test('uncertain creation never sends; failed snapshot keeps the new draft unsent',async()=>{
  let count=0;
  const uncertain=await createFirstTurn(async()=>{count++;throw {uncertain:true,message:'lost receipt'};},input,()=>assert.fail('no confirmed session'));
  assert.equal(count,1);assert.equal(uncertain.stage,'create');assert.equal(uncertain.result.state,'uncertain');
  const unreadable=await createFirstTurn(async(action)=>{if(action==='session.create')return {state:'accepted',threadId:'s'};throw {uncertain:true,message:'read failed'};},input,()=>{});
  assert.equal(unreadable.stage,'send');assert.equal(unreadable.threadId,'s');assert.equal(unreadable.result.state,'failed');
});
test('lost send receipt is uncertain and never automatically resent',async()=>{
  let sends=0;
  const result=await createFirstTurn(async(action)=>{
    if(action==='session.create')return {state:'accepted',threadId:'s'};
    if(action==='session.read')return {canControl:true,activeTurnId:null,source:'connector',generation:'g'};
    sends++;throw {uncertain:true,message:'lost receipt'};
  },input,()=>{});
  assert.equal(sends,1);assert.equal(result.threadId,'s');assert.equal(result.result.state,'uncertain');
});
