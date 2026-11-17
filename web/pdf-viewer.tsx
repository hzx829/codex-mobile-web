import {useEffect,useRef,useState} from 'react';
import type {PDFDocumentLoadingTask,PDFDocumentProxy,RenderTask} from 'pdfjs-dist';

function PdfPage({pdf,page,width}:{pdf:PDFDocumentProxy;page:number;width:number}){
  const canvas=useRef<HTMLCanvasElement>(null);
  const [busy,setBusy]=useState(true),[error,setError]=useState('');
  useEffect(()=>{
    let active=true,render:RenderTask|undefined,release=()=>{};
    void (async()=>{
      try{
        const documentPage=await pdf.getPage(page);
        if(!active)return;
        release=()=>{documentPage.cleanup();};
        const viewport=documentPage.getViewport({scale:width/documentPage.getViewport({scale:1}).width});
        // Bound the backing canvas on phones, even for unusually tall PDF pages.
        const ratio=Math.min(window.devicePixelRatio||1,2,4096/viewport.width,4096/viewport.height);
        const target=canvas.current!;
        target.width=Math.max(1,Math.floor(viewport.width*ratio));target.height=Math.max(1,Math.floor(viewport.height*ratio));
        target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;
        render=documentPage.render({canvas:target,viewport,transform:[ratio,0,0,ratio,0,0]});
        await render.promise;
        if(active)setBusy(false);
      }catch{
        if(active){setBusy(false);setError('此页无法显示，请保存到设备打开。');}
      }finally{release();}
    })();
    return()=>{active=false;render?.cancel();};
  },[pdf,page,width]);
  return <>
    {busy&&<p className="preview-notice" role="status">正在显示第 {page} 页…</p>}
    {error&&<p className="preview-notice error" role="alert">{error}</p>}
    <canvas ref={canvas} hidden={busy||Boolean(error)} role="img" aria-label={`PDF 第 ${page} 页`}/>
  </>;
}

export function PdfViewer({blob}:{blob:Blob}){
  const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[zoom,setZoom]=useState(false),[error,setError]=useState(''),[width,setWidth]=useState(0);
  const container=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let active=true,task:PDFDocumentLoadingTask|undefined;
    setPdf(null);setPage(1);setError('');
    void (async()=>{
      try{
        const [library,data]=await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'),blob.arrayBuffer()]);
        if(!active)return;
        library.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs',import.meta.url).href;
        task=library.getDocument({data:new Uint8Array(data),cMapUrl:'/pdfjs/cmaps/',standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/',iccUrl:'/pdfjs/iccs/',disableWorkerRendering:true});
        const document=await task.promise;
        if(active)setPdf(document);
      }catch(error){
        if(active)setError((error as Error).name==='PasswordException'?'此 PDF 需要密码，请保存到设备打开。':'PDF 无法预览，请保存到设备打开。');
      }
    })();
    return()=>{active=false;void task?.destroy().catch(()=>{});};
  },[blob]);
  useEffect(()=>{
    const observer=new ResizeObserver(entries=>{const next=Math.floor(entries[0].contentRect.width);if(next>0)setWidth(next);});
    observer.observe(container.current!);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{if(container.current){container.current.scrollTop=0;container.current.scrollLeft=0;}},[page]);
  return <div className="pdf-viewer">
    {pdf&&<div className="viewer-toolbar pdf-toolbar">
      <button disabled={page===1} onClick={()=>setPage(value=>value-1)}>上一页</button>
      <span aria-live="polite">{page} / {pdf.numPages}</span>
      <button disabled={page===pdf.numPages} onClick={()=>setPage(value=>value+1)}>下一页</button>
      <button aria-pressed={zoom} onClick={()=>setZoom(value=>!value)}>{zoom?'适应宽度':'放大'}</button>
    </div>}
    {error?<p className="preview-notice error" role="alert">{error}</p>:!pdf&&<p className="preview-notice" role="status">正在打开 PDF…</p>}
    <div className="pdf-pages" ref={container}>
      {pdf&&width>0&&<PdfPage key={`${page}:${width}:${zoom}`} pdf={pdf} page={page} width={Math.max(1,width-24)*(zoom?2:1)}/>}
    </div>
  </div>;
}
