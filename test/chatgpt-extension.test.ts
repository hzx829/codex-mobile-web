import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const source=readFileSync('src/chatgpt-extension/background.js','utf8');
function worker(local:Record<string,any>,sendMessage:(id:number,payload:any)=>Promise<any>){
  const storage=(values:Record<string,any>)=>({get:async(key:string)=>key?{[key]:values[key]}:values,set:async(patch:any)=>Object.assign(values,patch),remove:async(keys:string|string[])=>{for(const key of [keys].flat())delete values[key];}});
  const context=createContext({crypto,TextEncoder,Uint8Array,URL,Error,setTimeout:()=>0,setInterval:()=>0,clearInterval(){},
    chrome:{runtime:{id:'ext',getURL:(path:string)=>path,onMessage:{addListener(){}}},storage:{local:storage(local),session:storage({tabId:1})},tabs:{get:async()=>({id:1,url:'https://chatgpt.com/'}),sendMessage,onRemoved:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}},
    fetch:async()=>({json:async()=>({url:'ws://127.0.0.1:3342/chatgpt',token:'a'.repeat(64)})}),WebSocket:class{static OPEN=1;readyState=0;}});
  runInContext(source,context);return (action:string,payload:any)=>{context.action=action;context.payload=payload;return runInContext('execute(action,payload)',context);};
}
test('extension receipts survive worker restart without storing message text or resending',async()=>{
  const local:Record<string,any>={};let clicks=0;
  const page=async()=>{clicks++;return {result:{submitted:true}};};
  const payload={conversationId:'chat',opId:`${Date.now()}:12345678-1234-1234-1234-123456789abc`,text:'private message'};
  assert.equal((await worker(local,page)('send',payload)).submitted,true);
  assert.equal((await worker(local,page)('send',payload)).submitted,true);assert.equal(clicks,1);
  assert.ok(!JSON.stringify(local).includes('private message'));
  await assert.rejects(worker(local,page)('send',{...payload,text:'changed'}),{code:'conflict'});
});
test('extension treats a lost page response as uncertain and never repeats it',async()=>{
  const local:Record<string,any>={};let calls=0;
  const page=async()=>{calls++;throw Error('Receiving end does not exist');};
  const payload={conversationId:'chat',opId:`${Date.now()}:12345678-1234-1234-1234-123456789abc`,text:'hello'};
  await assert.rejects(worker(local,page)('send',payload),{uncertain:true});
  await assert.rejects(worker(local,page)('send',payload),{uncertain:true});assert.equal(calls,1);
});
