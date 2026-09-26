import {useEffect,useRef,useState} from 'react';
import {MAX_DOWNLOAD_SIZE,type FilePreview,type FileChunk} from '../src/shared/types';
import {receiveFile} from './file-download';
import {fileViewer} from './preview-target';
import {CodeViewer} from './code-viewer';
import {MarkdownViewer} from './markdown-viewer';

export function FilePreviewPanel({file,read,connected,line,openFile=()=>{},readFile}:{file:FilePreview;read:(offset:number)=>Promise<FileChunk>;connected:boolean;line?:number;openFile?:(path:string)=>void;readFile?:(path:string)=>Promise<FilePreview>}) {
  const [bytes,setBytes]=useState(0),[busy,setBusy]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState('');
  const [source,setSource]=useState(false),[zoom,setZoom]=useState(false);
  const transfer=useRef<AbortController|null>(null);
  const active=useRef(true),kind=fileViewer(file);
  useEffect(()=>{active.current=true;return()=>{active.current=false;transfer.current?.abort();};},[]);
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
  useEffect(()=>{if(!connected)transfer.current?.abort();},[connected]);
  async function download() {
    if(transfer.current)return;
    const controller=new AbortController();transfer.current=controller;setBusy(true);setBytes(0);setError('');
    try {
      const blob=await receiveFile(file,read,controller.signal,setBytes);
      if(!controller.signal.aborted)setUrl(URL.createObjectURL(kind==='video'?blob.slice(0,blob.size,file.mime):blob));
    }catch(e){
      if(!controller.signal.aborted){const failure=e as {code?:string;message?:string};setError(failure?.code==='offline'?'连接中断，请重新打开文件后下载':failure?.code==='timeout'?'接收超时，请重新打开文件后下载':failure?.message||'下载失败，请重试');}
    }
    finally{if(transfer.current===controller){transfer.current=null;if(active.current)setBusy(false);}}
  }
  return <>
    <div className="file-download viewer-toolbar">
      <small>{file.size<1024?`${file.size} B`:file.size<1024*1024?`${(file.size/1024).toFixed(1)} KiB`:`${(file.size/1024/1024).toFixed(2)} MiB`}</small>
      {file.size>MAX_DOWNLOAD_SIZE?<p className="muted">预览与下载上限为 100 MiB，请在电脑获取此文件。</p>:url?<a className="primary" href={url} download={file.name}>保存到设备</a>:<button className="primary" disabled={busy||!connected} onClick={()=>void download()}>{busy?`正在接收 ${file.size?Math.floor(bytes/file.size*100):0}%`:kind==='video'?'加载视频':'下载文件'}</button>}
      {busy&&<button onClick={()=>transfer.current?.abort()}>取消</button>}
      {kind==='markdown'&&<button aria-pressed={source} onClick={()=>setSource(v=>!v)}>{source?'阅读':'查看原文'}</button>}
      {kind==='image'&&<button aria-pressed={zoom} onClick={()=>setZoom(v=>!v)}>{zoom?'适应宽度':'原始大小'}</button>}
    </div>
    {!connected&&<p className="preview-notice">电脑连接已断开，当前显示已接收的内容。</p>}
    {error&&<p className="preview-notice error" role="alert">{error}</p>}
    {file.notice&&kind==='unsupported'&&<p className="preview-notice">{file.notice}</p>}
    {kind==='image'&&<div className={`image-viewer${zoom?' original':''}`}><img className="preview-image" src={`data:${file.mime};base64,${file.data}`} alt={file.name}/></div>}
    {kind==='video'&&url&&<div className="video-viewer"><video controls playsInline preload="metadata" src={url} onError={()=>setError('浏览器不支持该视频编码，请保存到设备打开。')}>浏览器无法播放此视频。</video></div>}
    {kind==='markdown'&&!source&&<MarkdownViewer file={file} openFile={openFile} readFile={readFile}/>}
    {(kind==='code'||kind==='markdown'&&source)&&<CodeViewer text={file.text!} name={file.name} line={line}/>}
  </>;
}
