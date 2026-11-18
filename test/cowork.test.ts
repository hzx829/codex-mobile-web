import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {coworkThreadUrl} from '../src/shared/cowork.js';
import {home,parseLocation} from '../web/route-state.js';

const project='/project/12345678-1234-1234-1234-123456789abc';
const thread='/cowork/cse_01MExample1234';
const sidebar='/cowork/cse_01Pinned1234';
const source=readFileSync('src/chatgpt-extension/cowork-page.js','utf8');

function snapshot(html:string,path:string,kind:string,expectedPath=''){
  const {document,HTMLElement}=parseHTML(html);
  Object.defineProperty(HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
  const value=runInNewContext(source+'\ncoworkSnapshot(kind,expectedPath)',{
    document, location:{origin:'https://claude.ai',pathname:path}, URL,kind,expectedPath,
  });
  return JSON.parse(JSON.stringify(value));
}

test('Cowork catalog reads project links and sidebar sessions from the paired origin',()=>{
  const value=snapshot(`<nav>
    <a href="${sidebar}">Codex mobile web integration</a>
    <a href="${sidebar}?ignored=1">Duplicate</a>
    <a href="https://elsewhere.invalid${thread}">External</a>
    <a href="${thread}" hidden>Hidden</a>
    <a href="/chat/12345678-1234-1234-1234-123456789abc">Ordinary chat</a>
  </nav><main>
    <a href="${project}">岭安 (LingAn)</a>
    <a href="${thread}">Link in page content</a>
  </main>`,'/projects','catalog','/projects');
  assert.deepEqual(value,{data:[{id:sidebar,title:'Codex mobile web integration'}],projects:[{id:project,name:'岭安 (LingAn)'}]});
});

test('Cowork project cards exclude unrelated sidebar threads',()=>{
  const value=snapshot(`<nav><a href="${sidebar}">Pinned</a></nav><main><a href="${thread}">Project task</a></main>`,project,'project',project);
  assert.deepEqual(value,{data:[{id:thread,title:'Project task'}],projects:[]});
});

test('Cowork reads rendered message text only from the requested conversation',()=>{
  const html='<html><head><title>Task | Claude</title></head><body><aside data-testid="assistant-message">Unrelated</aside><main><div data-testid="user-message">Question</div><article data-testid="assistant-message"><div class="font-claude-response"><div class="standard-markdown">Answer</div></div></article></main></body></html>';
  assert.deepEqual(snapshot(html,thread,'thread',thread),{title:'Task',messages:[{id:'0',role:'user',text:'Question'},{id:'1',role:'assistant',text:'Answer'}]});
  assert.deepEqual(snapshot(html,sidebar,'thread',thread),{failure:'loading'});
  assert.deepEqual(snapshot(html,'/login','thread',thread),{failure:'login'});
});

test('Cowork routes restore project and conversation and constrain the external link',()=>{
  const route={...home,project,cowork:thread};
  assert.deepEqual(parseLocation({cmwRoute:route,cmwMachine:'pc'}),{route,machine:'pc'});
  assert.equal(parseLocation({cmwRoute:{...route,cowork:'//other.invalid/x'},cmwMachine:'pc'}),null);
  assert.equal(coworkThreadUrl(thread),'https://claude.ai'+thread);
  assert.equal(coworkThreadUrl(thread+'?token=bad'),'');
});
