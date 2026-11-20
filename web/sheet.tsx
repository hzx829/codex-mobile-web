import {useEffect,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Icon,type IconName} from './icons';
import {IconButton} from './icon-button';

export function MenuItem({icon,children,onClick,disabled=false}:{icon:IconName;children:ReactNode;onClick:()=>void;disabled?:boolean}){return <button className="menu-item" onClick={onClick} disabled={disabled}><Icon name={icon} size={20}/><span className="menu-copy">{children}</span></button>;}

/** A bottom sheet on phones, a dialog on wider screens. Rendered into the page body, so a panel's own layout cannot clip or shift it. */
export function SheetPanel({title,close,children,className=''}:{title:string;close:()=>void;children:ReactNode;className?:string}){
  const panel=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement;if(!panel.current?.contains(document.activeElement))panel.current?.focus();const key=(e:KeyboardEvent)=>{
    if(e.key==='Escape'){e.preventDefault();close();}
    if(e.key==='Tab'){const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],summary')||[]);const first=nodes[0],last=nodes.at(-1);if(!panel.current?.contains(document.activeElement)){e.preventDefault();(e.shiftKey?last:first)?.focus();}else if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  };document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};},[]);
  return createPortal(<div className="overlay" onClick={close}><section tabIndex={-1} ref={panel} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><div className="sheet-handle"/><header><h2>{title}</h2><IconButton icon="close" label="关闭" onClick={close}/></header><div className="sheet-content">{children}</div></section></div>,document.body);
}
