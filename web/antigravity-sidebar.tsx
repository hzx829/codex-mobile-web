import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ChatSearch,HomeHeader,workspaceName} from './chat-layout';
import {Icon} from './icons';
import {IconButton} from './icon-button';
import {relativeTime,ThreadMenu,ThreadRow} from './thread-menu';
import {groupThreads,rememberThreads,visibleThreads,type ThreadPreference,type ThreadPreferences} from './thread-preferences';
import type {MenuPoint} from './popover';
import {SessionListLoader} from './session-list-loader';
import {useStableEvent} from './use-event';
import type {Json,RequestAction} from '../src/shared/types';

type Project={id:string;path:string;name?:string};
type Thread={id:string;title:string;updatedAt:number;running:boolean;cwd?:string};
/** Session actions an app supports beyond pinning and copying the ID, which every app gets. */
export type ThreadActions={rename?:(name:string)=>Promise<void>;archive?:()=>Promise<void>;duplicate?:()=>Promise<void>};
function loadPreferences(key:string):ThreadPreferences{try{return JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{return {};}}
function savePreferences(key:string,values:ThreadPreferences){try{localStorage.setItem(key,JSON.stringify(values));}catch{}}
type Page={data:Thread[];hasMore:boolean;projects?:Project[];notice?:string};
type Props={
  /** List action and wording of the app this sidebar shows; defaults to Antigravity. */
  listAction?:RequestAction;appName?:string;
  /** Starts a new conversation in the shown project (its list id); omitted for apps that cannot create one. */
  onNew?:(project:string)=>void;
  selected:string;project:string;machine:string;machineName:string;connected:boolean;relayOnline:boolean;inert:boolean;revision:number;switcher:ReactNode;action?:ReactNode;
  copyText:(text:string)=>Promise<void>;threadActions?:(thread:Json)=>ThreadActions;
  call:(action:RequestAction,payload?:Json)=>Promise<any>;open:(id:string)=>void;chooseProject:(id:string)=>void;chooseComputer:()=>void;more:()=>void;
};
export function AntigravitySidebar({listAction='antigravity.list',appName='Antigravity',onNew,selected,project,machine,machineName,connected,relayOnline,inert,revision,switcher,action,copyText,threadActions,call,open,chooseProject,chooseComputer,more}:Props){
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[projects,setProjects]=useState<Project[]>([]);
  const [page,setPage]=useState<{key:string;items:Thread[];offset:number;hasMore:boolean}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const loader=useRef(new SessionListLoader());
  // Pins live in this browser, per app and computer, as Codex's do.
  const storage=`${listAction.split('.')[0]}-preferences:${machine}`;
  const [preferenceState,setPreferences]=useState(()=>({key:storage,values:loadPreferences(storage)}));
  const preferences=preferenceState.key===storage?preferenceState.values:loadPreferences(storage);
  const [menu,setMenu]=useState<{thread:Json;point:MenuPoint}|null>(null);
  function changePreference(id:string,patch:ThreadPreference,thread:Json){
    const values=rememberThreads({...preferences,[id]:{...preferences[id],...patch}},[thread],false);
    savePreferences(storage,values);setPreferences({key:storage,values});
  }
  const key=JSON.stringify([project,query]),current=page?.key===key?page:null;
  const items=current?.items||[];
  const matching=query?items.filter(item=>item.title.toLowerCase().includes(query.toLowerCase())):items;
  const visible=visibleThreads(matching,preferences,project,false,query) as Thread[];
  const load=useStableEvent((more=false)=>{
    if(!connected)return;
    const offset=more?current?.offset||0:0;
    void loader.current.load(key,():Promise<Page>=>call(listAction,{project,search:query,offset}),{
      start:()=>{setBusy(true);setError('');setNotice('');},
      result:result=>{
        if(result.projects)setProjects(result.projects);
        setPreferences(old=>{const base=old.key===storage?old.values:loadPreferences(storage),values=rememberThreads(base,result.data,false);if(values!==base)savePreferences(storage,values);return {key:storage,values};});
        setNotice(result.notice||'');
        setPage({key,items:offset?[...new Map([...items,...result.data].map(item=>[item.id,item])).values()]:result.data,
          offset:offset+result.data.length,hasMore:result.hasMore});
      },
      error:failure=>setError((failure as {message?:string})?.message||'读取会话失败'),
      finish:()=>setBusy(false),
    });
  });
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    if(connected)load();else setBusy(false);
    const activeLoader=loader.current;
    return()=>activeLoader.invalidate();
  },[connected,key,revision,load]);
  const heading=query?'搜索结果':project?'聊天':'最近';
  const currentProject=projects.find(item=>item.id===project);
  const projectLabel=currentProject?.path;
  return <aside className="home-panel" inert={inert}>
    <HomeHeader project={project?currentProject?.name||(projectLabel?workspaceName(projectLabel):'项目'):''} machineName={machineName} connected={connected} relayOnline={relayOnline}
      back={()=>{setSearch('');setQuery('');chooseProject('');}} chooseComputer={chooseComputer} more={more}/>
    {!project&&!query&&switcher}
    <div className="home-content">
      {action}
      {!project&&!query&&projects.length>0&&<section className="project-section"><h2>项目</h2>{projects.map(item=>
        <button className="project-row" key={item.id} title={item.path} onClick={()=>chooseProject(item.id)}><Icon name="folder"/><span>{item.name||workspaceName(item.path)}</span></button>)}</section>}
      <section className="recent-section">{!visible.length&&<h2>{heading}</h2>}
        {groupThreads(visible,preferences,heading).map(group=><div className="thread-group" key={group.key}><h2>{group.label}</h2><nav aria-label={group.label}>{group.threads.map(item=>{
          const thread={...item,status:item.running?{type:'active'}:undefined};
          return <ThreadRow key={item.id} thread={thread} selected={selected===item.id} preference={preferences[item.id]}
            time={relativeTime(item.updatedAt)} open={()=>open(item.id)} menu={point=>setMenu({thread,point})}/>;})}</nav></div>)}
        {busy&&!visible.length?<div className="list-skeleton" role="status" aria-label="正在读取会话"><div/><div/><div/></div>:
          !visible.length&&!error&&<p className="empty-list">{!connected?'连接电脑后，会话会出现在这里。':query?'没有找到匹配的会话。':`还没有 ${appName} 会话。`}</p>}
        {error&&<p className="error" role="alert">{error} {connected&&<button type="button" onClick={()=>load()}>重试</button>}</p>}
        {notice&&<p className="muted">{notice}</p>}
        {current?.hasMore&&<button className="more-link" disabled={!connected||busy} onClick={()=>load(true)}>{busy?'正在加载…':'加载更多'}</button>}
      </section>
    </div>
    {menu&&<ThreadMenu key={menu.thread.id} thread={menu.thread} point={menu.point} preference={preferences[menu.thread.id]||{}} sections={[]} archived={false} compact connected={connected}
      close={()=>setMenu(null)} change={patch=>changePreference(menu.thread.id,patch,menu.thread)} copy={()=>copyText(menu.thread.id)}
      {...afterEach(threadActions?.(menu.thread)||{},()=>load())}/>}
    <div className="home-bottom"><div className="home-dock"><ChatSearch value={search} change={setSearch}/>{onNew&&<IconButton icon="compose" label="新聊天" className="round black new-chat" disabled={!connected} onClick={()=>onNew(project)}/>}</div></div>
  </aside>;
}

/** Refreshes the list after each action that changes a session. */
function afterEach(actions:ThreadActions,refresh:()=>void):ThreadActions{
  const wrap=<A extends unknown[]>(run?:(...args:A)=>Promise<void>)=>run&&(async(...args:A)=>{try{await run(...args);}finally{refresh();}});
  return {rename:wrap(actions.rename),archive:wrap(actions.archive),duplicate:wrap(actions.duplicate)};
}
