import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {act,createElement,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {FilePreviewPanel} from '../web/file-preview.js';
import {FILE_CHUNK_SIZE,type FileChunk} from '../src/shared/types.js';

test('PDF transfer starts on open and cancellation/unmount ignore late file chunks',async t=>{
  const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
  for(const [key,value] of Object.entries({window,document,IS_REACT_ACT_ENVIRONMENT:true})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
  const root=createRoot(document.getElementById('root')!),pending:((chunk:FileChunk)=>void)[]=[],offsets:number[]=[];
  const file={path:'report.pdf',name:'report.pdf',mime:'application/pdf',size:FILE_CHUNK_SIZE+1,revision:'v1'};
  const read=(offset:number)=>{offsets.push(offset);return new Promise<FileChunk>(resolve=>pending.push(resolve));};
  try{
    await act(async()=>root.render(createElement(StrictMode,null,createElement(FilePreviewPanel,{file,connected:true,read}))));
    assert.ok(offsets.length>0);assert.ok(offsets.every(offset=>offset===0));
    assert.match(document.body.textContent,/正在接收/);
    const cancel=Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='取消')!;
    await act(async()=>cancel.dispatchEvent(new window.Event('click',{bubbles:true})));
    assert.match(document.body.textContent,/打开 PDF/);
    const calls=offsets.length;
    await act(async()=>{for(const resolve of pending)resolve({offset:0,data:Buffer.alloc(FILE_CHUNK_SIZE).toString('base64')});});
    assert.equal(offsets.length,calls);assert.equal(document.querySelector('a[download]'),null);
    await act(async()=>document.querySelector('button')!.dispatchEvent(new window.Event('click',{bubbles:true})));
    assert.equal(offsets.length,calls+1);
    await act(async()=>root.unmount());
    pending.at(-1)!({offset:0,data:Buffer.alloc(FILE_CHUNK_SIZE).toString('base64')});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(offsets.length,calls+1);
  }finally{if(document.getElementById('root')!.childNodes.length)await act(async()=>root.unmount());}
});

test('bundled PDF engine parses and renders multiple pages and rejects invalid documents',async()=>{
  const library=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const streams=['1 0 0 rg 0 0 100 100 re f','0 0 1 rg 0 0 100 100 re f'];
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',...streams.flatMap((stream,index)=>[
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents ${4+index*2} 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ])];
  let source='%PDF-1.7\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(source));source+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(source);
  source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const loading=library.getDocument({data:new Uint8Array(Buffer.from(source)),standardFontDataUrl:join(root,'standard_fonts')+'/',disableWorkerRendering:true});
  try{
    const pdf=await loading.promise;assert.equal(pdf.numPages,2);
    for(const number of [1,2]){
      const page=await pdf.getPage(number),viewport=page.getViewport({scale:1});
      const factory=pdf.canvasFactory as {create:(width:number,height:number)=>{canvas:HTMLCanvasElement;context:CanvasRenderingContext2D};destroy:(target:unknown)=>void};
      const target=factory.create(viewport.width,viewport.height);
      await page.render({canvas:target.canvas,viewport}).promise;
      assert.deepEqual([...target.context.getImageData(50,50,1,1).data],number===1?[255,0,0,255]:[0,0,255,255]);
      factory.destroy(target);page.cleanup();
    }
  }finally{await loading.destroy();}
  const invalid=library.getDocument({data:new Uint8Array([0,1,2,3])});
  try{await assert.rejects(invalid.promise);}finally{await invalid.destroy();}
});
