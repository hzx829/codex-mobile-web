import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseHTML} from 'linkedom';
import {SafeMarkdown} from '../web/content.js';
import {fileReference} from '../web/preview-target.js';

const render=(text:string)=>renderToStaticMarkup(createElement(SafeMarkdown,{text,allowFileUrls:true,openFile:()=>{},openPreview:()=>{},onFollowup:()=>{}}));

async function clicks(t:{after:(fn:()=>void)=>void},text:string){
  const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
  for(const [key,value] of Object.entries({window,document,IS_REACT_ACT_ENVIRONMENT:true})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
  const root=createRoot(document.getElementById('root')!),files:{path:string;line?:number}[]=[],previews:string[]=[];
  try{
    await act(async()=>root.render(createElement(SafeMarkdown,{text,allowFileUrls:true,openFile:path=>files.push(fileReference(path)),openPreview:url=>previews.push(url),onFollowup:()=>{}})));
    for(const button of document.querySelectorAll('button'))await act(async()=>button.dispatchEvent(new window.Event('click',{bubbles:true})));
    return {files,previews,links:[...document.querySelectorAll('a')].map(a=>a.getAttribute('href'))};
  }finally{await act(async()=>root.unmount());}
}

test('paths and addresses in inline code open like links',async t=>{
  const result=await clicks(t,[
    '改了 `web/content.tsx:35`，见 `C:\\Users\\me\\My Docs\\plan.md`',
    '本地页面 `http://localhost:5173/app`，线上 `https://example.com/a`',
  ].join('\n\n'));
  assert.deepEqual(result.files,[{path:'web/content.tsx',line:35},{path:'C:\\Users\\me\\My Docs\\plan.md'}]);
  assert.deepEqual(result.previews,['http://localhost:5173/app']);
  assert.deepEqual(result.links,['https://example.com/a']);
});

test('file paths in prose become links, Windows paths keep their escaped backslashes',async t=>{
  const result=await clicks(t,'已修改 web/auto-links.ts:12 和 ./docs/a.md。工作树在 D:\\lingan\\.task-worktrees\\remediation-release\\README.md，另见 C:/work/报告.pdf。');
  assert.deepEqual(result.files,[
    {path:'web/auto-links.ts',line:12},{path:'./docs/a.md'},
    {path:'D:\\lingan\\.task-worktrees\\remediation-release\\README.md'},{path:'C:/work/报告.pdf'},
  ]);
});

test('bare addresses stop before Chinese punctuation',async t=>{
  const html=render('访问 https://example.com/a，然后打开 http://localhost:3000。');
  assert.match(html,/<a href="https:\/\/example.com\/a"[^>]*>https:\/\/example.com\/a<\/a>，然后/);
  const result=await clicks(t,'页面：https://claude.ai/code/artifact/abcdefgh12）');
  assert.deepEqual(result.previews,['https://claude.ai/code/artifact/abcdefgh12']);
});

test('ordinary prose, code and existing links are left alone',()=>{
  for(const text of ['and/or TCP/IP 1/2.5 km/h','`view.running` 和 `npm run build`','`git diff web/a.ts`','见 github.com/org/repo.git','```\nweb/content.tsx:35\nC:\\a\\b.md\n```','[说明](docs/guide.md)']){
    const html=render(text),buttons=html.match(/<button/g)?.length||0;
    assert.equal(buttons,text.startsWith('[')?1:0,text);
    assert.doesNotMatch(html,/<a /,text);
  }
});
