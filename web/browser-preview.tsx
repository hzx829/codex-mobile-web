import {useEffect,useRef,useState} from 'react';
import {DESKTOP_WIDTHS,desktopFrame,previewWidthKey} from './thread-preview';

export type PreviewSession={sessionId:string;url:string;ticket:string;previewPort:number;machineId:string;threadId:string;filePath?:string};

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

function savedWidth(key:string){try{const width=Number(localStorage.getItem(key));return DESKTOP_WIDTHS.includes(width)?width:0;}catch{return 0;}}

/**
 * A live page in a frame. `width` lays it out as wide as a desktop window and shrinks it to fit, so its desktop layout
 * shows on a phone; taps land where they appear because the browser maps them through the scaling.
 */
export function PageViewer({src,address,widthKey,onEnd,endLabel='结束预览'}:{src:string;address:string;widthKey:string;onEnd:()=>void;endLabel?:string}){
  const [generation,setGeneration]=useState(0),[width,setWidth]=useState(()=>savedWidth(widthKey)),[box,setBox]=useState({width:0,height:0}),[immersive,setImmersive]=useState(false);
  const root=useRef<HTMLDivElement>(null),stage=useRef<HTMLDivElement>(null),ownFullscreen=useRef(false);
  useEffect(()=>{
    const node=stage.current;if(!node||typeof ResizeObserver==='undefined')return;
    const measure=()=>setBox(old=>old.width===node.clientWidth&&old.height===node.clientHeight?old:{width:node.clientWidth,height:node.clientHeight});
    const observer=new ResizeObserver(measure);observer.observe(node);measure();
    return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    // Leaving the system's full screen by its own gesture also leaves ours.
    const changed=()=>{if(document.fullscreenElement===root.current)ownFullscreen.current=true;else if(ownFullscreen.current){ownFullscreen.current=false;setImmersive(false);}};
    document.addEventListener('fullscreenchange',changed);
    return()=>{document.removeEventListener('fullscreenchange',changed);if(document.fullscreenElement&&document.fullscreenElement===root.current)void document.exitFullscreen().catch(()=>{});};
  },[]);
  function choose(next:number){setWidth(next);try{if(next)localStorage.setItem(widthKey,String(next));else localStorage.removeItem(widthKey);}catch{}}
  // iPhone has no element full screen and cannot be turned by a page: there this only covers the app and the user turns the phone.
  function enter(){
    setImmersive(true);
    const node=root.current as (HTMLDivElement&{requestFullscreen?:()=>Promise<void>})|null;
    if(!node?.requestFullscreen)return;
    void node.requestFullscreen().then(()=>{if(width)return (screen.orientation as any)?.lock?.('landscape');}).catch(()=>{});
  }
  function leave(){
    setImmersive(false);
    try{(screen.orientation as any)?.unlock?.();}catch{}
    if(document.fullscreenElement&&document.fullscreenElement===root.current)void document.exitFullscreen().catch(()=>{});
  }
  const frame=desktopFrame(box.width,box.height,width);
  return <div className={`web-viewer${immersive?' immersive':''}`} ref={root}>
    <div className="viewer-toolbar"><button onClick={()=>setGeneration(v=>v+1)}>刷新</button><a href={src} target="_blank" rel="noopener noreferrer">独立打开 ↗</a><button onClick={enter}>全屏</button>
      <select aria-label="页面宽度" value={width} onChange={e=>choose(Number(e.target.value))}><option value={0}>适应屏幕</option>{DESKTOP_WIDTHS.map(value=><option key={value} value={value}>桌面 {value}</option>)}</select>
      <button onClick={onEnd}>{endLabel}</button></div>
    <p className="preview-notice">若网页无法在这里显示，请选择“独立打开”。</p>
    <div className="web-stage" ref={stage}>
      <iframe key={generation} title={address} src={src} style={frame?{width:frame.width,height:frame.height,transform:`scale(${frame.scale})`}:undefined} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerPolicy="no-referrer"/>
    </div>
    {immersive&&<button className="web-exit" onClick={leave}>退出全屏</button>}
  </div>;
}

export function WebViewer({session,onEnd}:{session:PreviewSession;onEnd:()=>void}){
  return <PageViewer src={previewLink(session)} address={session.url} widthKey={previewWidthKey(session.machineId,session.threadId)} onEnd={onEnd}/>;
}
