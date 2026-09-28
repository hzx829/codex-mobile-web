import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,truncate,utimes,rename,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {removeTestTemp} from '../scripts/test-temp.js';
import {readProjectFile,downloadProjectFile} from '../src/connector/project.js';
import {FILE_CHUNK_SIZE,MAX_DOWNLOAD_SIZE,type FilePreview} from '../src/shared/types.js';
import {receiveFile} from '../web/file-download.js';
import {SafeMarkdown} from '../web/content.js';
import {FilePreviewPanel} from '../web/file-preview.js';
import {fileReference,fileViewer} from '../web/preview-target.js';

test('Windows drive links remain file actions; unsafe protocols and embedded images stay inert',()=>{
  const render=(text:string)=>renderToStaticMarkup(createElement(SafeMarkdown,{text,openFile:()=>{},openPreview:()=>{},onFollowup:()=>{}}));
  for(const path of ['D:/project/Pitch-v2.2.pptx','C:/project/My%20Deck.pptx',String.raw`C:\project\deck.pptx`,'C:%5Cproject%5Cdeck.pptx','<D:/project/My Deck.pptx>','/project/deck.pptx','/C:/Users/NINGMEI/Documents/delegate/codex-mobile-web/.local/config.json','/D:/lingan/lyz-editor-backend/docs/features/organization/WORKSPACE_REVIEW_2026-09-26.md','docs/deck.pptx','C:/project/app.ts:12:3']) {
    assert.match(render(`[文件](${path})`),/<button class="inline-link">文件<\/button>/);
  }
  for(const path of ['javascript:alert%281%29','data:text/html,evil','vbscript:evil','file:///C:/private.txt']) {
    assert.doesNotMatch(render(`[危险](${path})`),/<a |<button/);
  }
  assert.match(render('![演示视频](D:/grab-fin/deliverables/demo-video/Shop-Agent-GrabMart-Clay-v2.mp4)'),/<button class="inline-link" type="button">\[视频：演示视频\]<\/button>/);
  assert.match(render('![成品图](images/cover.png)'),/<button class="inline-link" type="button">\[图片：成品图\]<\/button>/);
  assert.match(render('[官网](https://example.com)'),/<a href="https:\/\/example.com" target="_blank" rel="noreferrer noopener">/);
  assert.match(render('**http://127.0.0.1:5191/**'),/<button class="inline-link" type="button">http:\/\/127\.0\.0\.1:5191\/ · 打开预览<\/button>/);
  assert.match(render('[本机页面](http://localhost:5173/app)'),/<button class="inline-link" type="button">本机页面 · 打开预览<\/button>/);
  assert.match(render('[IPv6 页面](http://[::1]:5173/)'),/<button class="inline-link" type="button">IPv6 页面 · 打开预览<\/button>/);
  assert.doesNotMatch(render('[其他主机](http://localhost.example.com/)'),/打开预览/);
  assert.doesNotMatch(render('![image](https://example.com/image.png)\n<script>alert(1)</script>'),/<img|<script/);
});

test('Codex /C:/ links can open a dot-directory JSON file on Windows',async()=>{
  if(process.platform!=='win32')return;
  const dir=await mkdtemp(join(tmpdir(),'cmw-local-path-'));
  try{
    await mkdir(join(dir,'.local'));
    const target=join(dir,'.local','config.json');await writeFile(target,'{"sample":true}');
    const reference=`/${target.replace(/\\/g,'/')}`;
    const file=await readProjectFile(dir,fileReference(reference).path);
    assert.equal(file.text,'{"sample":true}');assert.equal(fileViewer(file),'code');
  }finally{await removeTestTemp(dir);}
});

test('binary, empty and active text files have a download entry while text/image previews stay usable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-files-'));
  try {
    for(const [path,data] of [['deck.pptx',Buffer.from('PK\x03\x04\x00')],['empty.txt',Buffer.alloc(0)],['index.html',Buffer.from('<script>alert(1)</script>')],['photo.png',Buffer.from([137,80,78,71,0])]] as const) {
      await writeFile(join(dir,path),data);
      const file=await readProjectFile(dir,path);
      assert.equal(file.name,path);assert.equal(file.size,data.length);
      const html=renderToStaticMarkup(createElement(FilePreviewPanel,{file,connected:true,read:async offset=>downloadProjectFile(dir,path,file.revision,offset)}));
      assert.match(html,/下载文件/);assert.doesNotMatch(html,/<script>/);
      if(path==='deck.pptx'){assert.equal(file.text,undefined);assert.match(file.notice!,/不支持预览/);}
      if(path==='index.html')assert.equal(file.text,data.toString());
      if(path==='photo.png')assert.equal(file.data,data.toString('base64'));
      if(path==='empty.txt')assert.equal(file.text,'');
      const blob=await receiveFile(file,offset=>downloadProjectFile(dir,path,file.revision,offset),new AbortController().signal);
      assert.equal(blob.type,'application/octet-stream');assert.deepEqual(Buffer.from(await blob.arrayBuffer()),data);
    }
  }finally{await removeTestTemp(dir);}
});

test('downloads reject a changed or replaced file and report missing files explicitly',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-files-')),path=join(dir,'deck.pptx');
  try {
    await writeFile(path,Buffer.alloc(FILE_CHUNK_SIZE+8,1));
    const file=await readProjectFile(dir,'deck.pptx');
    const first=await downloadProjectFile(dir,'deck.pptx',file.revision,0);assert.equal(Buffer.from(first.data,'base64').length,FILE_CHUNK_SIZE);
    await writeFile(path,Buffer.alloc(file.size,2));await utimes(path,new Date(1000),new Date(1000));
    await assert.rejects(downloadProjectFile(dir,'deck.pptx',file.revision,FILE_CHUNK_SIZE),(e:any)=>e.code==='changed');
    const next=await readProjectFile(dir,'deck.pptx');
    await rename(path,join(dir,'old.pptx'));await writeFile(path,Buffer.alloc(file.size,3));
    await assert.rejects(downloadProjectFile(dir,'deck.pptx',next.revision,0),(e:any)=>e.code==='changed');
    await unlink(path);
    await assert.rejects(readProjectFile(dir,'deck.pptx'),(e:any)=>e.code==='not_found');
    await assert.rejects(downloadProjectFile(dir,'deck.pptx',next.revision,0),(e:any)=>e.code==='not_found');
    await assert.rejects(readProjectFile(dir,'.'),(e:any)=>e.code==='invalid');
  }finally{await removeTestTemp(dir);}
});

test('download bounds reject invalid offsets and files exceeding the browser memory limit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-files-')),path=join(dir,'large.bin');
  try {
    await writeFile(path,'abc');const small=await readProjectFile(dir,'large.bin');
    for(const offset of [-1,0.5,4,NaN,Infinity,undefined,'0'])await assert.rejects(downloadProjectFile(dir,'large.bin',small.revision,offset as number),(e:any)=>e.code==='invalid');
    await truncate(path,MAX_DOWNLOAD_SIZE+1);const large=await readProjectFile(dir,'large.bin');
    assert.equal(large.data,undefined);assert.equal(large.text,undefined);
    await assert.rejects(downloadProjectFile(dir,'large.bin',large.revision,0),(e:any)=>e.code==='too_large');
    await assert.rejects(receiveFile(large,async()=>{throw Error('must not request');},new AbortController().signal),/100 MiB/);
  }finally{await removeTestTemp(dir);}
});

test('incomplete, out-of-order, interrupted and cancelled downloads never produce a saveable file',async()=>{
  const file:FilePreview={path:'deck.pptx',name:'deck.pptx',size:FILE_CHUNK_SIZE+3,revision:'test',mime:'application/octet-stream'};
  const first=Buffer.alloc(FILE_CHUNK_SIZE).toString('base64');
  for(const chunk of [{offset:1,data:first},{offset:0,data:'YQ=='},{offset:0,data:'!'.repeat(first.length)}]) {
    await assert.rejects(receiveFile(file,async()=>chunk,new AbortController().signal));
  }
  let calls=0;
  await assert.rejects(receiveFile(file,async offset=>{calls++;if(offset)throw Error('电脑连接中断');return {offset,data:first};},new AbortController().signal),/连接中断/);
  assert.equal(calls,2);
  const controller=new AbortController();calls=0;
  await assert.rejects(receiveFile(file,async offset=>{calls++;controller.abort();return {offset,data:first};},controller.signal),(e:any)=>e.name==='AbortError');
  assert.equal(calls,1);
  const waiting=new AbortController(),pending=receiveFile(file,()=>new Promise(()=>{}),waiting.signal);
  waiting.abort();await assert.rejects(pending,(e:any)=>e.name==='AbortError');
});

test('video files expose playable metadata and transfer through the existing chunk protocol',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-video-'));
  try{
    for(const name of ['recording.mp4','capture.webm']){
      const data=Buffer.alloc(2*1024*1024+17,0x51);
      await writeFile(join(dir,name),data);
      const file=await readProjectFile(dir,name);
      assert.equal(fileViewer(file),'video');
      assert.equal(file.mime,name.endsWith('.mp4')?'video/mp4':'video/webm');
      assert.equal(file.data,undefined);assert.equal(file.text,undefined);assert.equal(file.notice,undefined);
      const html=renderToStaticMarkup(createElement(FilePreviewPanel,{file,connected:true,read:offset=>downloadProjectFile(dir,name,file.revision,offset)}));
      assert.match(html,/加载视频/);assert.doesNotMatch(html,/<video/);
      const blob=await receiveFile(file,offset=>downloadProjectFile(dir,name,file.revision,offset),new AbortController().signal);
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()),data);
      assert.equal(blob.slice(0,blob.size,file.mime).type,file.mime);
    }
  }finally{await removeTestTemp(dir);}
});
