import {useLayoutEffect,type KeyboardEvent,type ReactNode,type RefObject} from 'react';
import {Icon} from './icons';
import {IconButton} from './icon-button';

export const workspaceName=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;

export function HomeHeader({project,machineName,connected,relayOnline,back,backDisabled,chooseComputer,more}:{project:string;machineName:string;connected:boolean;relayOnline:boolean;back:()=>void;backDisabled?:boolean;chooseComputer:()=>void;more:()=>void}){
  return <header className="home-header">
    {project?<><IconButton icon="back" label="返回全部项目" className="round" disabled={backDisabled} onClick={back}/><h1>{project}</h1></>:
      <button className="home-identity" aria-label="选择电脑" onClick={chooseComputer}><span className="home-computer"><Icon name="computer" size={19}/></span><strong>Remote</strong><span className="home-machine"><i className={connected?'dot online':'dot'}/><span>{machineName}</span>{!connected&&<small>{relayOnline?'离线':'连接中…'}</small>}</span></button>}
    <IconButton icon="more" label="更多选项" className="round" onClick={more}/>
  </header>;
}

export function ChatSearch({value,change}:{value:string;change:(value:string)=>void}){
  return <label className="search-pill"><Icon name="search"/><input aria-label="搜索聊天" placeholder="搜索聊天…" value={value} maxLength={200} onChange={event=>change(event.target.value)}/>{value&&<IconButton icon="close" label="清除搜索" onClick={()=>change('')}/>}</label>;
}

export function ThreadHeader({title,project,machineName,connected,back,backDisabled,onTitle,children}:{title:string;project:string;machineName:string;connected:boolean;back:()=>void;backDisabled?:boolean;onTitle?:(element:HTMLButtonElement)=>void;children:ReactNode}){
  const heading=<><strong>{title}</strong><span><Icon name="folder" size={13}/><span>{project}</span><span className="mini-machine"><Icon name="computer" size={13}/><i className={connected?'dot online':'dot'}/></span><span>{machineName}</span></span></>;
  return <header className="thread-header">
    <IconButton icon="back" label="返回会话列表" className="round" disabled={backDisabled} onClick={back}/>
    {onTitle?<button className="thread-title" type="button" onClick={event=>onTitle(event.currentTarget)}>{heading}</button>:<div className="thread-title">{heading}</div>}
    <div className="header-actions">{children}</div>
  </header>;
}

function resizeComposer(el:HTMLTextAreaElement){
  el.style.overflowY='hidden';el.style.height='auto';const height=el.scrollHeight;
  el.style.height=`${Math.min(Math.max(height,44),144)}px`;el.style.overflowY=height>145?'auto':'hidden';
}
export function useComposerHeight(input:RefObject<HTMLTextAreaElement|null>,draft:string,mounted:boolean){
  useLayoutEffect(()=>{if(mounted&&input.current)resizeComposer(input.current);},[input,draft,mounted]);
  useLayoutEffect(()=>{
    const el=input.current;if(!mounted||!el)return;
    let width=el.clientWidth;
    const observer=new ResizeObserver(()=>{if(width!==el.clientWidth){width=el.clientWidth;resizeComposer(el);}});
    observer.observe(el);return()=>observer.disconnect();
  },[input,draft,mounted]);
}

export function submitOnDesktop(event:KeyboardEvent<HTMLTextAreaElement>,submit:()=>void){
  if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&window.matchMedia('(pointer: fine)').matches){event.preventDefault();submit();}
}

export function SendMessageButton({sending,disabled,label}:{sending:boolean;disabled:boolean;label:string}){
  return <button className={`black round send${sending?' sending':''}`} aria-label={sending?'正在发送':label} aria-busy={sending} disabled={disabled} onPointerDown={event=>event.preventDefault()}><Icon name={sending?'more':'send'} size={18}/></button>;
}
