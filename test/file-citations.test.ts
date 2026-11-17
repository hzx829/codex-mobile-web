import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseHTML} from 'linkedom';
import {SafeMarkdown} from '../web/content.js';
import {fileReference} from '../web/preview-target.js';

const render=(text:string)=>renderToStaticMarkup(createElement(SafeMarkdown,{text,openFile:()=>{},openPreview:()=>{},onFollowup:()=>{}}));

test('Codex file citations become file links in prose and lists, retaining nearby Markdown',()=>{
  const citation=':codex-file-citation{path="D:/lingan/docs/growth-and-venture-strategy-2026-07/output/pdf/岭安制造业AI安全检查_河北企业与园区交流.pdf" purpose="output"}';
  const html=render(`已做好 **4 页销售介绍册**。\n\n${citation}\n\n另附 [微信介绍](docs/介绍.md)。\n\n- :codex-file-citation{purpose="output" path="docs/My Deck.pptx"}`);
  assert.match(html,/<strong>4 页销售介绍册<\/strong>/);
  assert.match(html,/<button class="inline-link">岭安制造业AI安全检查_河北企业与园区交流.pdf<\/button>/);
  assert.match(html,/<li><button class="inline-link">My Deck.pptx<\/button><\/li>/);
  assert.match(html,/>微信介绍<\/button>/);assert.doesNotMatch(html,/codex-file-citation|purpose=/);
});

test('file citations in code and incomplete or unsafe directives stay inert',()=>{
  const citation=':codex-file-citation{path="D:/work/report.pdf" purpose="output"}';
  for(const text of ['`'+citation+'`','```text\n'+citation+'\n```','    '+citation,':codex-file-citation{path="D:/unfinished.pdf"',':codex-file-citation{purpose="output"}',':codex-file-citation{path=""}',...['https://example.com/a.pdf','javascript:alert(1)','file:///D:/work/report.pdf','//server/share/report.pdf'].map(path=>`:codex-file-citation{path="${path}"}`)]){
    const html=render(text);assert.match(html,/codex-file-citation/);assert.doesNotMatch(html,/<button/);
  }
});

test('clicking citations opens exact Chinese, space, percent and Windows paths',async t=>{
  const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
  for(const [key,value] of Object.entries({window,document,IS_REACT_ACT_ENVIRONMENT:true})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
  const root=createRoot(document.getElementById('root')!),opened:string[]=[];
  const paths=['D:/work/中文 My 100%20.pdf',String.raw`C:\work\报告.pdf`,'docs/guide.md'];
  try{
    await act(async()=>root.render(createElement(SafeMarkdown,{text:paths.map(path=>`:codex-file-citation{path="${path}" purpose="output"}`).join(' 和 '),openFile:path=>opened.push(fileReference(path).path),openPreview:()=>{},onFollowup:()=>{}})));
    for(const button of document.querySelectorAll('button'))await act(async()=>button.dispatchEvent(new window.Event('click',{bubbles:true})));
    assert.deepEqual(opened,paths);
  }finally{await act(async()=>root.unmount());}
});
