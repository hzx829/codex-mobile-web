import {useState} from 'react';

export type PreviewSession={sessionId:string;url:string;ticket:string;previewPort:number;machineId:string;threadId:string};

export function previewLink(session:PreviewSession):string {
  const url=new URL(location.href);
  url.port=String(session.previewPort);
  url.pathname='/_bridge/enter';url.search='';url.searchParams.set('session',session.sessionId);url.searchParams.set('ticket',session.ticket);url.hash='';
  return url.toString();
}

export function BrowserPreviewPanel({session,onOpen,onClose}:{session:PreviewSession;onOpen:()=>void;onClose:()=>void}){
  return <section className="browser-preview" aria-label="电脑网页预览">
    <div className="browser-preview-details"><strong>网页预览中</strong><span title={session.url}>{session.url}</span></div>
    <div className="browser-preview-actions"><button onClick={onOpen}>打开预览</button><button onClick={onClose}>结束</button></div>
  </section>;
}

export function WebViewer({session,onEnd}:{session:PreviewSession;onEnd:()=>void}){
  const [generation,setGeneration]=useState(0);
  return <div className="web-viewer"><div className="viewer-toolbar"><button onClick={()=>setGeneration(v=>v+1)}>刷新</button><a href={previewLink(session)} target="_blank" rel="noopener noreferrer">独立打开 ↗</a><button onClick={onEnd}>结束预览</button></div>
    <p className="preview-notice">若网页无法在这里显示，请选择“独立打开”。</p>
    <iframe key={generation} title={session.url} src={previewLink(session)} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerPolicy="no-referrer"/>
  </div>;
}
