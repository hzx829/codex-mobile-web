import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';

const id='12345678-1234-1234-1234-123456789abc';
const source=readFileSync('src/chatgpt-extension/content.js','utf8');
function fixture(extra=''){
  const {window,document}=parseHTML(`<html><head><title>Example chat</title></head><body><aside><a href="/c/${id}">Existing ChatGPT chat</a><a href="https://evil.example/c/${id}">ignore</a></aside><main><div data-message-author-role="user" data-message-id="u1">hello</div><div data-message-author-role="assistant" data-message-id="a1">answer</div><a href="/c/00000000-0000-0000-0000-000000000000">message link, not sidebar</a></main><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>${extra}</form></body></html>`);
  let listener:any,clock=Date.now();
  Object.assign(window.HTMLElement.prototype,{getClientRects(this:HTMLElement):object[]{return this.hidden?[]:[{}];},focus(){}});
  const context={document,URL,location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},HTMLTextAreaElement:window.HTMLTextAreaElement,Event:window.Event,
    getComputedStyle:()=>({visibility:'visible',overflowY:'visible'}),Date:class extends Date{static now(){return clock;}},
    setTimeout:(fn:()=>void,ms:number)=>{clock+=ms;queueMicrotask(fn);},
    chrome:{runtime:{id:'extension',onMessage:{addListener(fn:any){listener=fn;}}}}};
  runInNewContext(source,context);
  const call=(action:string,payload:any={})=>new Promise<any>(resolve=>listener({type:'chatgpt.bridge',action,payload},{id:'extension'},resolve));
  return {document,call};
}
test('page adapter reads ordinary chats and text, not scripts or arbitrary page links',async()=>{
  const {document,call}=fixture();
  document.body.insertAdjacentHTML('beforeend','<script>secret-cookie</script>');
  const list=await call('list');assert.equal(list.result.data.length,1);assert.equal(list.result.data[0].id,id);
  await new Promise(resolve=>setImmediate(resolve));
  const read=await call('read',{conversationId:id});assert.equal(read.result.messages.length,2);assert.equal(read.result.messages[1].text,'answer');assert.ok(!JSON.stringify(read).includes('secret-cookie'));
});
test('page adapter refuses wrong conversation, existing drafts and active generation',async()=>{
  const wrong=fixture();assert.equal((await wrong.call('send',{conversationId:'different',text:'hello'})).error.code,'wrong_conversation');
  const draft=fixture();draft.document.querySelector('textarea')!.value='keep my draft';
  assert.equal((await draft.call('send',{conversationId:id,text:'new'})).error.code,'draft_exists');assert.equal(draft.document.querySelector('textarea')!.value,'keep my draft');
  const running=fixture('<button data-testid="stop-button">Stop</button>');assert.equal((await running.call('send',{conversationId:id,text:'new'})).error.code,'active');
});
test('send receipt requires a new matching user message; existing text is not confirmation',async()=>{
  const accepted=fixture();let clicks=0;
  accepted.document.querySelector('[data-testid="send-button"]')!.addEventListener('click',()=>{
    clicks++;accepted.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div data-message-author-role="user" data-message-id="u2">hello</div>');
  });
  assert.equal((await accepted.call('send',{conversationId:id,text:'hello'})).result.submitted,true);assert.equal(clicks,1);
  const uncertain=fixture();
  const result=await uncertain.call('send',{conversationId:id,text:'hello'});assert.equal(result.error.uncertain,true);assert.equal(result.error.code,'uncertain');
});
test('stop generation targets only the matching conversation',async()=>{
  const {document,call}=fixture('<button data-testid="stop-button">Stop</button>');
  const stop=document.querySelector('[data-testid="stop-button"]')!;stop.addEventListener('click',()=>stop.remove());
  assert.equal((await call('stop',{conversationId:id})).result.stopped,true);
});
