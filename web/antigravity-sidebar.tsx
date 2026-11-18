import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ChatSearch,HomeHeader,workspaceName} from './chat-layout';
import {Icon} from './icons';
import {relativeTime,ThreadRow} from './thread-menu';
import {SessionListLoader} from './session-list-loader';
import {useStableEvent} from './use-event';
import type {Json,RequestAction} from '../src/shared/types';

type Project={id:string;path:string};
type Thread={id:string;title:string;updatedAt:number;running:boolean};
type Page={data:Thread[];hasMore:boolean;projects?:Project[]};
type Props={
  selected:string;project:string;machineName:string;connected:boolean;relayOnline:boolean;inert:boolean;revision:number;switcher:ReactNode;
  call:(action:RequestAction,payload?:Json)=>Promise<any>;open:(id:string)=>void;chooseProject:(id:string)=>void;chooseComputer:()=>void;more:()=>void;
};
export function AntigravitySidebar({selected,project,machineName,connected,relayOnline,inert,revision,switcher,call,open,chooseProject,chooseComputer,more}:Props){
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[projects,setProjects]=useState<Project[]>([]);
  const [page,setPage]=useState<{key:string;items:Thread[];offset:number;hasMore:boolean}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const loader=useRef(new SessionListLoader());
  const key=JSON.stringify([project,query]),current=page?.key===key?page:null;
  const items=current?.items||[];
  const visible=query?items.filter(item=>item.title.toLowerCase().includes(query.toLowerCase())):items;
  const load=useStableEvent((more=false)=>{
    if(!connected)return;
    const offset=more?current?.offset||0:0;
    void loader.current.load(key,():Promise<Page>=>call('antigravity.list',{project,search:query,offset}),{
      start:()=>{setBusy(true);setError('');},
      result:result=>{
        if(result.projects)setProjects(result.projects);
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
  const projectLabel=projects.find(item=>item.id===project)?.path;
  return <aside className="home-panel" inert={inert}>
    <HomeHeader project={project?projectLabel?workspaceName(projectLabel):'项目':''} machineName={machineName} connected={connected} relayOnline={relayOnline}
      back={()=>{setSearch('');setQuery('');chooseProject('');}} chooseComputer={chooseComputer} more={more}/>
    {!project&&!query&&switcher}
    <div className="home-content">
      {!project&&!query&&projects.length>0&&<section className="project-section"><h2>项目</h2>{projects.map(item=>
        <button className="project-row" key={item.id} title={item.path} onClick={()=>chooseProject(item.id)}><Icon name="folder"/><span>{workspaceName(item.path)}</span></button>)}</section>}
      <section className="recent-section"><h2>{heading}</h2>
        <nav aria-label={heading}>{visible.map(item=><ThreadRow key={item.id} thread={{...item,status:item.running?{type:'active'}:undefined}} selected={selected===item.id}
          time={relativeTime(item.updatedAt)} open={()=>open(item.id)}/>)}</nav>
        {busy&&!visible.length?<div className="list-skeleton" role="status" aria-label="正在读取会话"><div/><div/><div/></div>:
          !visible.length&&!error&&<p className="empty-list">{!connected?'连接电脑后，会话会出现在这里。':query?'没有找到匹配的会话。':'还没有 Antigravity 会话。'}</p>}
        {error&&<p className="error" role="alert">{error} {connected&&<button type="button" onClick={()=>load()}>重试</button>}</p>}
        {current?.hasMore&&<button className="more-link" disabled={!connected||busy} onClick={()=>load(true)}>{busy?'正在加载…':'加载更多'}</button>}
      </section>
    </div>
    <div className="home-bottom"><div className="home-dock"><ChatSearch value={search} change={setSearch}/></div></div>
  </aside>;
}
