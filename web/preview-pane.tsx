import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {Icon} from './icons';

export const PREVIEW_BREAKPOINT='(max-width: 1000px)';
export function useCompactPreview(){
  const [compact,setCompact]=useState(()=>window.matchMedia(PREVIEW_BREAKPOINT).matches);
  useEffect(()=>{const media=window.matchMedia(PREVIEW_BREAKPOINT),update=()=>setCompact(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  return compact;
}

export function PreviewPane({title,subtitle,compact,covered,close,children}:{title:string;subtitle?:string;compact:boolean;covered:boolean;close:()=>void;children:ReactNode}){
  const [expanded,setExpanded]=useState(false),[width,setWidth]=useState(520);
  const panel=useRef<HTMLElement>(null),onClose=useRef(close),start=useRef({x:0,y:0,width:0}),dragged=useRef(false);
  const maxWidth=Math.max(320,window.innerWidth-550);
  onClose.current=close;
  useEffect(()=>{
    if(covered)return;
    const previous=document.activeElement as HTMLElement|null;
    panel.current?.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();onClose.current();return;}
      if(!compact||event.key!=='Tab')return;
      const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),iframe,[tabindex="0"]')||[]).filter(el=>el.getClientRects().length);
      const first=nodes[0],last=nodes.at(-1),active=document.activeElement;
      if(!nodes.length){event.preventDefault();panel.current?.focus();}
      else if(event.shiftKey&&(active===first||active===panel.current||!panel.current?.contains(active))){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(active===last||!panel.current?.contains(active))){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('keydown',key);if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[compact,covered]);
  return <>
    {compact&&<div className="preview-backdrop" onClick={close} aria-hidden="true"/>}
    <section ref={panel} tabIndex={-1} inert={covered} className={`preview-pane${expanded?' expanded':''}`} style={{'--preview-width':`${width}px`} as CSSProperties} role={compact?'dialog':'complementary'} aria-modal={compact?true:undefined} aria-label={title}>
      {!compact&&<div className="preview-resizer" role="separator" tabIndex={0} aria-label="调整预览宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={maxWidth} aria-valuenow={Math.min(width,maxWidth)}
        onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(v=>Math.max(320,Math.min(maxWidth,v+(e.key==='ArrowLeft'?32:-32))));}}}
        onPointerDown={e=>{start.current={x:e.clientX,y:0,width:panel.current?.getBoundingClientRect().width||width};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))setWidth(Math.max(320,Math.min(maxWidth,start.current.width+start.current.x-e.clientX)));}}/>}
      {compact&&<button className="preview-handle" aria-label={expanded?'收起全屏':'展开全屏'} onClick={()=>{if(dragged.current){dragged.current=false;return;}setExpanded(v=>!v);}}
        onPointerDown={e=>{dragged.current=false;start.current={x:0,y:e.clientY,width:0};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerUp={e=>{const delta=e.clientY-start.current.y;if(Math.abs(delta)<35)return;dragged.current=true;if(delta<0)setExpanded(true);else if(expanded)setExpanded(false);else close();}}
      ><span/></button>}
      <header className="preview-header"><div><h2>{title}</h2>{subtitle&&<small title={subtitle}>{subtitle}</small>}</div>
        {compact&&<button onClick={()=>setExpanded(v=>!v)}>{expanded?'收起':'全屏'}</button>}
        <button className="icon-button" aria-label="关闭预览" onClick={close}><Icon name="close"/></button>
      </header>
      <div className="preview-body">{children}</div>
    </section>
  </>;
}
