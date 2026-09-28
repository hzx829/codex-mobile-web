import {useEffect,useRef,useState} from 'react';
import {Icon,type IconName} from './icons';
import type {Json} from '../src/shared/types';
import type {ThreadPreference} from './thread-preferences';
import {Popover,type MenuPoint} from './popover';

export function ThreadRow({thread,selected,disabled,preference={},time,open,menu}:{thread:Json;selected:boolean;disabled:boolean;preference?:ThreadPreference;time:string;open:()=>void;menu:(point:MenuPoint)=>void}){
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),start=useRef<MenuPoint|null>(null),held=useRef(false);
  const cancel=()=>{clearTimeout(timer.current);start.current=null;};
  useEffect(()=>cancel,[]);
  return <button className={`session-row${selected?' selected':''}${preference.unread?' unread':''}`} disabled={disabled} aria-haspopup="dialog" onClick={()=>{if(!held.current)open();}}
    onContextMenu={e=>{e.preventDefault();cancel();if(!held.current){held.current=true;menu({x:e.clientX,y:e.clientY});}}}
    onPointerDown={e=>{held.current=false;cancel();if(e.pointerType==='mouse'||!e.isPrimary)return;const point={x:e.clientX,y:e.clientY};start.current=point;timer.current=setTimeout(()=>{held.current=true;menu(point);},500);}}
    onPointerMove={e=>{if(start.current&&Math.hypot(e.clientX-start.current.x,e.clientY-start.current.y)>10)cancel();}}
    onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')held.current=false;if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey){e.preventDefault();const rect=e.currentTarget.getBoundingClientRect();menu({x:rect.left+16,y:rect.bottom});}}}>
    <span className="session-name">{thread.status?.type==='active'&&<i className="dot online"/>}{preference.unread&&<i className="dot unread-dot"/>}{thread.title}</span>
    <span className="session-meta">{preference.pinned&&<Icon name="pin" size={14}/>}<time>{time}</time></span>
  </button>;
}

export function ThreadMenu({thread,point,preference,sections,archived,connected,close,change,copy,rename,archive,openPreview,compact=false}:{thread:Json;point:MenuPoint;preference:ThreadPreference;sections:string[];archived:boolean;connected:boolean;close:()=>void;change:(patch:ThreadPreference)=>void;copy:()=>Promise<void>;rename:(name:string)=>Promise<void>;archive:()=>Promise<void>;openPreview?:()=>void;compact?:boolean}){
  const [mode,setMode]=useState<'menu'|'rename'|'sections'>('menu'),[name,setName]=useState(thread.title),[section,setSection]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await action();close();}catch(e){setError((e as Error).message||'操作失败，请刷新后重试');}finally{setBusy(false);}}
  function choose(patch:ThreadPreference){change(patch);close();}
  const item=(icon:IconName,label:string,action:()=>void,disabled=false,danger=false)=><button type="button" className={`menu-item${danger?' danger':''}`} disabled={busy||disabled} onClick={action}><Icon name={icon} size={22}/><span className="menu-copy">{label}</span></button>;
  return <Popover point={point} title={thread.title} label="会话操作" close={close} className={compact?'thread-menu-compact':''} focusSelector={mode==='menu'?'.menu-item:not(:disabled)':'input'}>
      {error&&<p role="alert" className="error">{error}</p>}
      {mode==='menu'?<>
        {compact&&openPreview&&item('browser','打开本机网页',()=>{close();openPreview();},!connected)}
        {item('pin',preference.pinned?'取消置顶':'置顶',()=>choose({pinned:!preference.pinned}))}
        {!compact&&item('folder','移至分区',()=>setMode('sections'))}
        {!compact&&item('unread',preference.unread?'标为已读':'标为未读',()=>choose({unread:!preference.unread}))}
        {item('copy','复制会话 ID',()=>void run(copy))}
        {item('compose','重命名',()=>setMode('rename'),!connected)}
        {item('archive',archived?'取消归档':'归档',()=>void run(archive),!connected||(!archived&&thread.status?.type==='active'),!archived)}
      </>:mode==='rename'?<form onSubmit={e=>{e.preventDefault();void run(()=>rename(name.trim()));}}><label>会话名称<input value={name} onChange={e=>setName(e.target.value)} maxLength={200} required disabled={busy}/></label><button className="primary" disabled={busy||!name.trim()}>{busy?'正在保存…':'保存'}</button></form>:<>
        <p className="muted">分区保存在此浏览器中。</p>
        {item('chat','最近',()=>choose({section:''}))}
        {sections.map(value=><div key={value}>{item('folder',value,()=>choose({section:value}))}</div>)}
        <form onSubmit={e=>{e.preventDefault();if(section.trim())choose({section:section.trim()});}}><label>新建分区<input value={section} maxLength={40} onChange={e=>setSection(e.target.value)} placeholder="分区名称"/></label><button className="primary" disabled={!section.trim()}>移入新分区</button></form>
      </>}
      {mode!=='menu'&&<button type="button" className="more-link" disabled={busy} onClick={()=>{setMode('menu');setError('');}}>返回</button>}
  </Popover>;
}
