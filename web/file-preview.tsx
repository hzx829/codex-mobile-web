import {useEffect,useRef,useState,type ReactNode} from 'react';
import {MAX_DOWNLOAD_SIZE,type FilePreview,type FileChunk} from '../src/shared/types';
import {receiveFile,receiveStream} from './file-download';
import {resetBlobSession} from './blob';

/** The file on the relay's data channel (web/blob.ts): its address, and `ready` once this device is signed in to it. */
export type FileStreamSource={url:(download:boolean)=>string;ready:()=>Promise<boolean>};
import {fileViewer} from './preview-target';
import {CodeViewer} from './code-viewer';
import {MarkdownViewer} from './markdown-viewer';
import {PdfViewer} from './pdf-viewer';

export function FilePreviewPanel({file,read,connected,line,openFile=()=>{},readFile,htmlPreview,openHtml,htmlError,allowFileUrls=false,stream}:{stream?:FileStreamSource;allowFileUrls?:boolean;htmlPreview?:ReactNode;openHtml?:()=>void;htmlError?:string;file:FilePreview;read:(offset:number)=>Promise<FileChunk>;connected:boolean;line?:number;openFile?:(path:string)=>void;readFile?:(path:string)=>Promise<FilePreview>}) {
  const [bytes,setBytes]=useState(0),[busy,setBusy]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState('');
  const [source,setSource]=useState(false),[zoom,setZoom]=useState(false);
  const [pdf,setPdf]=useState<Blob|null>(null);
  const transfer=useRef<AbortController|null>(null);
  const active=useRef(true),kind=fileViewer(file);
  // With the data channel, videos play and files save straight from the relay; `streamOn` is null until that is known.
  const [streamOn,setStreamOn]=useState<boolean|null>(stream?null:false);
  useEffect(()=>{
    active.current=true;
    if(stream)void stream.ready().then(ok=>{if(active.current)setStreamOn(ok);});
    return()=>{active.current=false;transfer.current?.abort();transfer.current=null;};
  },[]);
  useEffect(()=>{if(streamOn!==null&&kind==='pdf'&&connected&&file.size<=MAX_DOWNLOAD_SIZE)void download();},[streamOn===null]);
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
  useEffect(()=>{if(!connected)transfer.current?.abort();},[connected]);
  async function download() {
    if(transfer.current)return;
    const controller=new AbortController();transfer.current=controller;setBusy(true);setBytes(0);setError('');
    try {
      let blob:Blob;
      if(streamOn&&stream)try{blob=await receiveStream(stream.url(false),file.size,controller.signal,setBytes);}
        catch(error){
          // Signed out of the data channel (the relay restarted): this time in chunks, next time signed in again.
          if((error as {code?:string})?.code!=='blob_auth')throw error;
          resetBlobSession();setStreamOn(false);blob=await receiveFile(file,read,controller.signal,setBytes);
        }
      else blob=await receiveFile(file,read,controller.signal,setBytes);
      if(!controller.signal.aborted&&active.current){
        setUrl(URL.createObjectURL(kind==='video'?blob.slice(0,blob.size,file.mime):blob));
        if(kind==='pdf')setPdf(blob);
      }
    }catch(e){
      if(!controller.signal.aborted){const failure=e as {code?:string;message?:string};setError(failure?.code==='offline'?'连接中断，请重新打开文件后下载':failure?.code==='timeout'?'接收超时，请重新打开文件后下载':failure?.message||'下载失败，请重试');}
    }
    finally{if(transfer.current===controller){transfer.current=null;if(active.current)setBusy(false);}}
  }
  return <>
    <div className="file-download viewer-toolbar">
      <small>{file.size<1024?`${file.size} B`:file.size<1024*1024?`${(file.size/1024).toFixed(1)} KiB`:`${(file.size/1024/1024).toFixed(2)} MiB`}</small>
      {file.size>MAX_DOWNLOAD_SIZE?<p className="muted">预览与下载上限为 100 MiB，请在电脑获取此文件。</p>:streamOn&&stream?<a className="primary" href={stream.url(true)} download={file.name}>保存到设备</a>:url?<a className="primary" href={url} download={file.name}>保存到设备</a>:<button className="primary" disabled={busy||!connected} onClick={()=>void download()}>{busy?`正在接收 ${file.size?Math.floor(bytes/file.size*100):0}%`:kind==='pdf'?'打开 PDF':kind==='video'?'加载视频':'下载文件'}</button>}
      {busy&&<button onClick={()=>transfer.current?.abort()}>取消</button>}
      {(kind==='markdown'||kind==='html'&&file.text!==undefined)&&<button aria-pressed={source} onClick={()=>setSource(v=>!v)}>{source?'阅读':'查看原文'}</button>}
      {kind==='image'&&<button aria-pressed={zoom} onClick={()=>setZoom(v=>!v)}>{zoom?'适应宽度':'原始大小'}</button>}
    </div>
    {!connected&&<p className="preview-notice">电脑连接已断开，当前显示已接收的内容。</p>}
    {error&&<p className="preview-notice error" role="alert">{error}</p>}
    {file.notice&&kind==='unsupported'&&<p className="preview-notice">{file.notice}</p>}
    {kind==='pdf'&&pdf&&<PdfViewer blob={pdf}/>}
    {kind==='image'&&<div className={`image-viewer${zoom?' original':''}`}><img className="preview-image" src={`data:${file.mime};base64,${file.data}`} alt={file.name}/></div>}
    {kind==='video'&&(streamOn&&stream||url)&&<div className="video-viewer"><video controls playsInline preload="metadata" src={streamOn&&stream?stream.url(false):url} onError={()=>setError('浏览器不支持该视频编码，请保存到设备打开。')}>浏览器无法播放此视频。</video></div>}
    {kind==='html'&&!source&&(htmlPreview||<div className="preview-empty">{htmlError&&<p role="alert">{htmlError}</p>}<button disabled={!connected} onClick={openHtml}>打开网页演示</button></div>)}
    {kind==='markdown'&&!source&&<MarkdownViewer allowFileUrls={allowFileUrls} file={file} openFile={openFile} readFile={readFile}/>}
    {(kind==='code'||(kind==='markdown'||kind==='html')&&source)&&<CodeViewer text={file.text!} name={file.name} line={line}/>}
  </>;
}
