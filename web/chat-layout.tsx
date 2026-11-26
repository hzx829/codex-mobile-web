import {useLayoutEffect,useState,type KeyboardEvent,type ReactNode,type RefObject} from 'react';
import {Icon} from './icons';
import {IconButton} from './icon-button';
import {OwnerBadge,type TeamMemberRef} from './team';

export const workspaceName=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;

export function HomeHeader({project,machineName,connected,relayOnline,back,backDisabled,chooseComputer,mobileSettings,onRefresh,refreshDisabled=false}:{project?:string;machineName:string;connected:boolean;relayOnline:boolean;back?:()=>void;backDisabled?:boolean;chooseComputer:()=>void;mobileSettings?:ReactNode;onRefresh?:()=>void;refreshDisabled?:boolean}){
  return <header className="home-header">
    {project&&back?<><IconButton icon="back" label="返回全部项目" className="round" disabled={backDisabled} onClick={back}/><h1>{project}</h1></>:
      <button className="home-identity" aria-label="选择电脑" onClick={chooseComputer}><span className="home-computer"><Icon name="computer" size={19}/></span><strong>Remote</strong><span className="home-machine"><i className={connected?'dot online':'dot'}/><span>{machineName}</span>{!connected&&<small>{relayOnline?'离线':'连接中…'}</small>}<Icon name="chevron" size={13}/></span></button>}
    {(onRefresh||mobileSettings)&&<div className="home-header-actions">
      {onRefresh&&<IconButton icon="refresh" label="刷新项目与会话" className="round home-refresh" disabled={!connected||refreshDisabled} onClick={onRefresh}/>}
      {mobileSettings&&<span className="mobile-only-actions">{mobileSettings}</span>}
    </div>}
  </header>;
}

export function ChatSearch({value,change}:{value:string;change:(value:string)=>void}){
  return <label className="search-pill"><Icon name="search"/><input aria-label="搜索聊天" placeholder="搜索聊天…" value={value} maxLength={200} onChange={event=>change(event.target.value)}/>{value&&<IconButton icon="close" label="清除搜索" onClick={()=>change('')}/>}</label>;
}

/** Desktop shows New and Search as sidebar rows; phones keep the floating search pill and round new-chat button. */
export function SidebarActions({search,setSearch,onNew,newDisabled=false}:{search:string;setSearch:(value:string)=>void;onNew?:()=>void;newDisabled?:boolean}){
  const [searching,setSearching]=useState(false);
  const open=searching||Boolean(search);
  const close=()=>{setSearch('');setSearching(false);};
  return <div className="home-bottom">
    <nav className="sidebar-nav" aria-label="侧边栏操作">
      {onNew&&<button type="button" className="sidebar-nav-row" disabled={newDisabled} onClick={onNew}><Icon name="plus" size={17}/><span>新建</span></button>}
      {open?<label className="sidebar-nav-row sidebar-search"><Icon name="search" size={17}/>
        <input autoFocus aria-label="搜索聊天" placeholder="搜索聊天…" value={search} maxLength={200}
          onChange={event=>setSearch(event.target.value)}
          onBlur={()=>{if(!search)setSearching(false);}}
          onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();close();}}}/>
        <button type="button" className="icon-button" aria-label="关闭搜索" title="关闭搜索" onPointerDown={event=>event.preventDefault()} onClick={close}><Icon name="close"/></button>
      </label>:<button type="button" className="sidebar-nav-row" onClick={()=>setSearching(true)}><Icon name="search" size={17}/><span>搜索</span></button>}
    </nav>
    <div className="home-dock"><ChatSearch value={search} change={setSearch}/>{onNew&&<IconButton icon="compose" label="新聊天" className="round black new-chat" disabled={newDisabled} onClick={onNew}/>}</div>
  </div>;
}

/** A sidebar group title that folds its list away; search results pass no toggle and stay open. */
export function GroupHeading({label,collapsed=false,onToggle,action}:{label:string;collapsed?:boolean;onToggle?:()=>void;action?:ReactNode}){
  const title=onToggle?<h2 className="section-heading"><button type="button" className="section-toggle" aria-expanded={!collapsed} title={collapsed?`展开${label}`:`收起${label}`} onClick={onToggle}>
    <span>{label}</span><Icon name="chevron" size={13}/></button></h2>:<h2>{label}</h2>;
  return action?<div className="section-head">{title}{action}</div>:title;
}

export function ProjectsSection({collapsed,onToggle,action,children}:{collapsed:boolean;onToggle:()=>void;action?:ReactNode;children:ReactNode}){
  return <section className={`project-section${collapsed?' collapsed':''}`}>
    <div className="project-section-head">
      <h2 className="section-heading">
        <button type="button" className="section-toggle" aria-expanded={!collapsed} title={collapsed?'展开项目':'收起项目'} onClick={onToggle}>
          <span>项目</span><Icon name="chevron" size={13}/>
        </button>
      </h2>
      {action}
    </div>
    {!collapsed&&children}
  </section>;
}

export function ThreadHeader({title,project,machineName,connected,back,menu,backDisabled,onTitle,owner,lastSender,meId,mobileCenter,mobileRight,onNewChat,newChatDisabled,children}:{title:string;project:string;machineName:string;connected:boolean;back?:()=>void;menu?:()=>void;backDisabled?:boolean;onTitle?:(element:HTMLButtonElement)=>void;owner?:TeamMemberRef|null;lastSender?:TeamMemberRef|null;meId?:string|null;mobileCenter?:ReactNode;mobileRight?:ReactNode;onNewChat?:()=>void;newChatDisabled?:boolean;children?:ReactNode}){
  const isOther=Boolean(owner&&meId&&owner.id!==meId);
  const ownerTip=[owner&&`由 ${owner.name} 创建`,lastSender&&lastSender.id!==owner?.id&&`${lastSender.name} 最后发送`].filter(Boolean).join(' · ');
  const heading=<><strong>{title}</strong><span><Icon name="folder" size={13}/><span>{project}</span><span className="mini-machine"><Icon name="computer" size={13}/><i className={connected?'dot online':'dot'}/></span><span>{machineName}</span>{owner&&<span className={`thread-owner-tag${isOther?' other':''}`} title={ownerTip}><OwnerBadge owner={owner} title={ownerTip}/><span>{owner.id===meId?'我':owner.name}</span></span>}</span></>;
  const titleClass=`thread-title${mobileCenter?' desktop-only-title':''}`;
  const hasActions=Boolean(children||onNewChat);
  return <header className={`thread-header${mobileCenter?' has-mobile-center':''}`}>
    {menu?<IconButton icon="sidebar" label="打开侧边栏" className="round mobile-drawer-trigger" disabled={backDisabled} onClick={menu}/>
      :back?<IconButton icon="back" label="返回会话列表" className="round" disabled={backDisabled} onClick={back}/>:null}
    {onTitle?<button className={titleClass} type="button" onClick={event=>onTitle(event.currentTarget)}>{heading}</button>:<div className={titleClass}>{heading}</div>}
    {mobileCenter&&<div className="thread-header-mobile-center">{mobileCenter}</div>}
    {mobileRight&&<div className="thread-header-mobile-right">{mobileRight}</div>}
    {hasActions&&<div className={`header-actions${mobileRight?' desktop-only-actions':''}`}>
      {onNewChat&&<IconButton icon="compose" label="新聊天" className="mobile-new-chat-btn" disabled={newChatDisabled} onClick={onNewChat}/>}
      {children}
    </div>}
  </header>;
}

function resizeComposer(el:HTMLTextAreaElement){
  // Measuring collapses the field to one row. The form keeps its height meanwhile, or the messages above would
  // grow for a moment and a list scrolled to its end would be pushed back by the height of the collapsed lines.
  const form=el.form;if(form)form.style.height=`${form.getBoundingClientRect().height}px`;
  el.style.overflowY='hidden';el.style.height='auto';const height=el.scrollHeight;
  el.style.height=`${Math.min(Math.max(height,44),144)}px`;el.style.overflowY=height>145?'auto':'hidden';
  if(form)form.style.height='';
}
/**
 * Keeps the messages still against the composer when the list changes height (a new line in the draft,
 * an attachment, the keyboard): the list resizes from its lower edge, so that edge keeps showing the same content.
 */
export function useBottomAnchor(scroll:RefObject<HTMLElement|null>,mounted:boolean){
  useLayoutEffect(()=>{
    const el=scroll.current;if(!mounted||!el)return;
    let height=el.clientHeight,edge=el.scrollTop+height;
    const track=()=>{edge=el.scrollTop+el.clientHeight;};
    const observer=new ResizeObserver(()=>{
      const next=el.clientHeight;if(next===height)return;
      height=next;
      // Already at the end (the browser clamped it, or new content was just scrolled to): nothing to restore.
      if(el.scrollHeight-el.scrollTop-next>=1)el.scrollTop=edge-next;
      track();
    });
    observer.observe(el);el.addEventListener('scroll',track,{passive:true});
    return()=>{observer.disconnect();el.removeEventListener('scroll',track);};
  },[scroll,mounted]);
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
