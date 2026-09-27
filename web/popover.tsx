import {useEffect,useLayoutEffect,useRef,type ReactNode} from 'react';
import {Icon} from './icons';

export type MenuPoint={x:number;y:number;align?:'end'};
export function Popover({point,title,label,close,children,className='',focusSelector}:{point:MenuPoint;title:string;label:string;close:()=>void;children:ReactNode;className?:string;focusSelector?:string}){
  const panel=useRef<HTMLElement>(null),closeRef=useRef(close),opener=useRef<HTMLElement|null>(null);closeRef.current=close;
  useLayoutEffect(()=>{opener.current=document.activeElement as HTMLElement;},[]);
  useLayoutEffect(()=>{
    const el=panel.current;if(!el)return;
    const viewport=window.visualViewport;
    const position=()=>{
      const {width,height}=el.getBoundingClientRect(),top=viewport?.offsetTop||0;
      el.style.left=`${Math.max(12,Math.min(point.x-(point.align==='end'?width:0),window.innerWidth-width-12))}px`;
      el.style.top=`${Math.max(top+12,Math.min(point.y,top+(viewport?.height||window.innerHeight)-height-12))}px`;
    };
    position();const observer=new ResizeObserver(position);observer.observe(el);
    window.addEventListener('resize',position);viewport?.addEventListener('resize',position);viewport?.addEventListener('scroll',position);
    return()=>{observer.disconnect();window.removeEventListener('resize',position);viewport?.removeEventListener('resize',position);viewport?.removeEventListener('scroll',position);};
  },[point.x,point.y,point.align]);
  useLayoutEffect(()=>{const el=panel.current;(focusSelector?el?.querySelector<HTMLElement>(focusSelector)||el:el)?.focus({preventScroll:true});},[focusSelector]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();closeRef.current();}
      const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')||[]),index=nodes.indexOf(document.activeElement as HTMLElement);
      if(e.key==='Tab'){e.preventDefault();const next=index<0?(e.shiftKey?nodes.length-1:0):(index+(e.shiftKey?-1:1)+nodes.length)%nodes.length;nodes[next]?.focus();}
      if((e.key==='ArrowDown'||e.key==='ArrowUp')&&document.activeElement?.tagName==='BUTTON'){e.preventDefault();nodes[(index+(e.key==='ArrowUp'?-1:1)+nodes.length)%nodes.length]?.focus();}
    };
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);if(opener.current?.isConnected)opener.current.focus({preventScroll:true});};
  },[]);
  return <div className="thread-menu-overlay" onPointerDown={e=>{if(e.target===e.currentTarget)close();}} onContextMenu={e=>e.preventDefault()}>
    <section className={`thread-menu ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={panel}>
      <header><span>{title}</span><button type="button" aria-label="关闭弹出面板" onClick={close}><Icon name="close" size={18}/></button></header>
      {children}
    </section>
  </div>;
}
