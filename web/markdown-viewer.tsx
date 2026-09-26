import {useEffect,useRef,useState} from 'react';
import Markdown,{defaultUrlTransform} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {FilePreview} from '../src/shared/types';
import {localDocumentLink} from './preview-target';

function LocalImage({path,alt,readFile}:{path:string;alt:string;readFile:(path:string)=>Promise<FilePreview>}){
  const [file,setFile]=useState<FilePreview|null>(null),[error,setError]=useState('');
  const read=useRef(readFile);read.current=readFile;
  useEffect(()=>{let active=true;setFile(null);setError('');read.current(path).then(next=>{if(active){if(next.data&&/^image\/(png|jpeg|webp|gif)$/.test(next.mime))setFile(next);else setError(next.notice||'图片无法预览');}}).catch(()=>{if(active)setError('图片读取失败');});return()=>{active=false;};},[path]);
  return file?<img src={`data:${file.mime};base64,${file.data}`} alt={alt}/>:<span className="muted">[{alt||'图片'}：{error||'加载中…'}]</span>;
}

export function MarkdownViewer({file,openFile,readFile}:{file:FilePreview;openFile:(path:string)=>void;readFile?:(path:string)=>Promise<FilePreview>}){
  return <article className="document-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={(url,key)=>/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(url)&&(key==='href'||key==='src')?url:defaultUrlTransform(url)}
    components={{
      a:({href,children})=>{
        if(!href)return <span>{children}</span>;
        if(/^https?:\/\//i.test(href))return <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
        const path=localDocumentLink(href,file.path);
        return path?<button className="inline-link" onClick={()=>openFile(encodeURI(path))}>{children}</button>:<span>{children}</span>;
      },
      img:({src,alt})=>{
        const path=typeof src==='string'?localDocumentLink(src,file.path):null;
        return path&&readFile?<LocalImage path={path} alt={alt||''} readFile={readFile}/>:<span className="muted">[图片：{alt||'外部图片'}]</span>;
      },
    }}>{file.text||''}</Markdown></article>;
}
