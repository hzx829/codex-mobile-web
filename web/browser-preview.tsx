import {useEffect} from 'react';
import {Client} from './client';

export type PreviewSession={sessionId:string;url:string;ticket:string;previewPort:number};

export function previewLink(session:PreviewSession):string {
  const url=new URL(location.href);
  url.port=String(session.previewPort);
  url.pathname='/_bridge/enter';url.search='';url.searchParams.set('ticket',session.ticket);url.hash='';
  return url.toString();
}

export function previewPageLink(session:PreviewSession):string {
  const url=new URL(location.href),target=new URL(session.url);
  url.port=String(session.previewPort);
  url.pathname=target.pathname;url.search=target.search;url.hash=target.hash;
  return url.toString();
}

export function BrowserPreviewPanel({client,session,opened,onOpen,onClose,onEnded}:{client:Client;session:PreviewSession;opened:boolean;onOpen:()=>void;onClose:()=>void;onEnded:()=>void}){
  useEffect(()=>client.onPreview(message=>{
    if(message.type==='preview.ended'&&message.sessionId===session.sessionId)onEnded();
  }),[client,session.sessionId,onEnded]);
  return <section className="browser-preview" aria-label="电脑网页预览">
    <div className="browser-preview-details"><strong>网页预览中</strong><span title={session.url}>{session.url}</span></div>
    <div className="browser-preview-actions"><a href={opened?previewPageLink(session):previewLink(session)} target="_blank" rel="noopener noreferrer" onClick={onOpen}>打开预览</a><button onClick={onClose}>结束</button></div>
  </section>;
}
