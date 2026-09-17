import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {Client,operationId} from './client';
import {Icon,type IconName} from './icons';
import {SafeMarkdown,RequestCard} from './content';
import {createFirstTurn} from './new-chat';
import type {Json,SessionView,RequestAction} from '../src/shared/types';
import './style.css';

const load=(key:string,fallback:any)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}};
const save=(key:string,value:any)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const name=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;
const statusLabel:Record<string,string>={inProgress:'进行中',completed:'已完成',interrupted:'已停止',failed:'失败'};
const activityLabel:Record<string,string>={commandExecution:'运行命令',fileChange:'修改文件',mcpToolCall:'使用工具',reasoning:'思考摘要',webSearch:'搜索',contextCompaction:'整理上下文',plan:'计划'};
function relativeTime(value:number){if(!value)return '';const elapsed=Math.max(0,Date.now()-(value<1e12?value*1000:value));const minutes=Math.floor(elapsed/60_000);return minutes<1?'刚刚':minutes<60?`${minutes}分钟`:minutes<1440?`${Math.floor(minutes/60)}小时`:`${Math.floor(minutes/1440)}天`;}
function initialToken(){const params=new URLSearchParams(location.hash.slice(1));const token=params.get('token');if(token){save('connection',token);history.replaceState(null,'',location.pathname);}return token||load('connection','');}
type Route={thread:string;project:string;newChat:boolean};
const home:Route={thread:'',project:'',newChat:false};
type Sheet='home'|'thread'|'computer'|'projects'|'model'|'add'|'file'|null;

function App(){
  const [token,setToken]=useState(initialToken),[tokenInput,setTokenInput]=useState('');
  const [status,setStatus]=useState('connecting'),[machines,setMachines]=useState<Json[]>([]),[machine,setMachine]=useState('');
  const [route,setRoute]=useState<Route>(home),[sheet,setSheet]=useState<Sheet>(null);
  const {thread:selected,project,newChat}=route,showThread=Boolean(selected||newChat);
  const [info,setInfo]=useState<Json|null>(null),[projects,setProjects]=useState<string[]>([]),[sessions,setSessions]=useState<Json[]>([]);
  const [cursor,setCursor]=useState<string|null>(null),[search,setSearch]=useState(''),[searchQuery,setSearchQuery]=useState(''),[listBusy,setListBusy]=useState(false),[archived,setArchived]=useState(false);
  const [view,setView]=useState<SessionView|null>(null),[limit,setLimit]=useState(20),[loading,setLoading]=useState(false);
  const [draft,setDraft]=useState(''),[images,setImages]=useState<string[]>([]),[model,setModel]=useState(''),[effort,setEffort]=useState(''),[newCwd,setNewCwd]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<Json|null>(null);
  const [preview,setPreview]=useState<Json|null>(null),[filePath,setFilePath]=useState('');
  const client=useRef<Client|null>(null),current=useRef({machine,selected,project,newChat,limit,searchQuery,archived}),sequence=useRef(0),listSequence=useRef(0),infoSequence=useRef(0);
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),refreshing=useRef(false),again=useRef(false),sticky=useRef(true),timeline=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),fileInput=useRef<HTMLInputElement>(null);
  const scrollAnchor=useRef<{height:number;top:number;limit:number;ready:boolean}|null>(null);
  current.current={machine,selected,project,newChat,limit,searchQuery,archived};
  const connected=status==='online'&&machines.some(m=>m.id===machine),machineName=machines.find(m=>m.id===machine)?.name||'电脑';
  const scope=`${machine}:${selected}`,draftKey=`draft:${scope}`,pendingKey=`operation:${scope}`;
  const call=(action:RequestAction,payload:Json={},target=machine)=>client.current!.request(action,payload,target);
  const stillHere=()=>current.current.machine===machine&&current.current.selected===selected;
  function fail(e:any){setError(e?.message||'操作失败，请重试');}
  function navigate(next:Route,replace=false){
    const depth=replace?(history.state?.cmwDepth||0):(history.state?.cmwDepth||0)+1;
    history[replace?'replaceState':'pushState']({cmwRoute:next,cmwMachine:machine,cmwDepth:depth},'',location.pathname);
    setSheet(null);setRoute(next);
  }
  function back(){setSheet(null);if(history.state?.cmwDepth>0)history.back();else navigate({...home,project:showThread?project:''},true);}
  useEffect(()=>{
    history.replaceState({cmwRoute:home,cmwMachine:machine,cmwDepth:0},'',location.pathname);
    const pop=(e:PopStateEvent)=>{setSheet(null);const next=e.state?.cmwMachine===current.current.machine?e.state.cmwRoute:home;setRoute(next||home);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[machine]);
  async function refreshSession(){
    if(refreshing.current){again.current=true;return;}
    const c={...current.current};if(!c.machine||!c.selected||!client.current?.ready)return;
    const seq=sequence.current;refreshing.current=true;
    try{const next=await call('session.read',{threadId:c.selected,limit:c.limit},c.machine);if(seq===sequence.current&&c.machine===current.current.machine&&c.selected===current.current.selected){if(scrollAnchor.current&&c.limit>=scrollAnchor.current.limit)scrollAnchor.current.ready=true;setView(next);setLoading(false);}}
    catch(e){if(seq===sequence.current){fail(e);setLoading(false);}}
    finally{refreshing.current=false;if(again.current){again.current=false;void refreshSession();}}
  }
  function scheduleRefresh(){if(refreshTimer.current)return;refreshTimer.current=setTimeout(()=>{refreshTimer.current=undefined;void refreshSession();},250);}
  async function list(append=false){
    const c={...current.current},seq=++listSequence.current;setListBusy(true);
    try{
      const r=await call('sessions.list',{cwd:c.project||undefined,search:c.searchQuery||undefined,archived:c.archived,cursor:append?cursor:undefined},c.machine);
      if(seq!==listSequence.current||c.machine!==current.current.machine||c.project!==current.current.project||c.searchQuery!==current.current.searchQuery||c.archived!==current.current.archived)return;
      setSessions(old=>append?[...old,...r.data.filter((n:Json)=>!old.some(s=>s.id===n.id))]:r.data);setCursor(r.nextCursor);
      setProjects(old=>[...new Set<string>([...old,...r.data.map((s:Json)=>s.cwd).filter(Boolean)])]);
    }catch(e){if(seq===listSequence.current)fail(e);}finally{if(seq===listSequence.current)setListBusy(false);}
  }
  const effectiveCwd=newChat?newCwd:view?.cwd||project;
  function refreshInfo(){
    if(!connected)return;const seq=++infoSequence.current;
    call('info',{cwd:effectiveCwd||undefined}).then(r=>{if(seq!==infoSequence.current)return;setInfo(r);setProjects(old=>[...new Set<string>([...r.roots,...old])]);setNewCwd(old=>old||r.roots[0]||'');}).catch(e=>{if(seq===infoSequence.current)fail(e);});
  }
  useEffect(refreshInfo,[connected,machine,effectiveCwd]);
  useEffect(()=>{const timer=setTimeout(()=>setSearchQuery(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{if(connected)void list();},[connected,machine,project,searchQuery,archived]);
  useEffect(()=>{
    if(!token)return;
    const c=new Client(token,m=>{
      if(m.type==='ready'||m.type==='machines')setMachines(m.machines||m.data||[]);
      if(m.type==='changed'&&m.machineId===current.current.machine&&(!m.threadId||m.threadId===current.current.selected))scheduleRefresh();
    },setStatus);client.current=c;
    return()=>{c.close();clearTimeout(refreshTimer.current);};
  },[token]);
  useEffect(()=>{if(!machine&&machines[0])setMachine(machines[0].id);},[machines,machine]);
  useEffect(()=>{
    sequence.current++;setView(null);setLoading(Boolean(selected));setLimit(20);setImages([]);setModel('');setEffort('');setError('');setNotice('');sticky.current=true;scrollAnchor.current=null;
    setDraft(load(draftKey,''));setPending(load(pendingKey,null));void refreshSession();
  },[machine,selected]);
  useEffect(()=>{void refreshSession();},[limit,connected]);
  useEffect(()=>{
    const viewport=window.visualViewport;if(!viewport)return;
    const resize=()=>{if(viewport.scale!==1)return;document.documentElement.style.setProperty('--viewport-height',`${viewport.height}px`);document.documentElement.style.setProperty('--viewport-top',`${viewport.offsetTop}px`);};
    resize();viewport.addEventListener('resize',resize);viewport.addEventListener('scroll',resize);
    return()=>{viewport.removeEventListener('resize',resize);viewport.removeEventListener('scroll',resize);};
  },[]);
  useEffect(()=>{const el=timeline.current;if(!el)return;if(scrollAnchor.current?.ready){el.scrollTop=scrollAnchor.current.top+el.scrollHeight-scrollAnchor.current.height;scrollAnchor.current=null;}else if(sticky.current)el.scrollTop=el.scrollHeight;},[view]);
  useEffect(()=>{const el=composer.current;if(el){el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,144)}px`;}},[draft,showThread]);
  useEffect(()=>{
    if(!connected)return;
    const foreground=()=>{if(document.visibilityState!=='visible')return;if(current.current.selected)void refreshSession();else void list();};
    const timer=setInterval(foreground,5000);document.addEventListener('visibilitychange',foreground);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',foreground);};
  },[connected,project,searchQuery,archived]);
  useEffect(()=>{if(connected&&pending&&!busy)void checkPending();},[connected,pending?.opId,busy]);
  useEffect(()=>{if(!notice||pending)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice,pending]);
  function editDraft(value:string){setDraft(value);save(draftKey,value);}
  function setOperation(value:Json|null){save(pendingKey,value);if(stillHere())setPending(value);}
  function accepted(record:Json,result:Json){
    if(record.action==='session.create'&&record.submittedText&&result.threadId){
      save(`draft:${machine}:${result.threadId}`,record.submittedText);save(draftKey,'');
      setOperation(null);if(stillHere()){setDraft('');navigate({...route,thread:result.threadId,newChat:false},true);setNotice(record.imageCount?'会话已建立，文字已保留；附图请重新选择后发送。':'会话已建立，输入已保留，请点击发送。');}return;
    }
    if(record.action==='turn.send'&&load(draftKey,'')===record.submittedText){save(draftKey,'');if(stillHere()){setDraft('');setImages([]);}}
    setOperation(null);if(!stillHere())return;setNotice(result.kind==='stop_requested'?'已请求停止':result.kind==='response_submitted'?'回应已提交':'Codex 已接受');
    scheduleRefresh();void list();
  }
  async function checkPending(){
    const record=load(pendingKey,null);if(!record||!connected)return;
    try{const r=await call('operation.read',{opId:record.opId});if(r.state==='accepted')accepted(record,r);else if(r.state==='failed'){setOperation(null);if(stillHere())setError(r.error?.message||'请求未执行');}else if(stillHere())setNotice('结果待核实，系统不会自动重发。');}catch{}
  }
  async function mutate(action:RequestAction,payload:Json){
    if(busy||pending)return;
    const record={opId:operationId(),action,submittedText:action==='turn.send'?payload.text:undefined};
    setBusy(true);setError('');setNotice('正在提交…');setOperation(record);
    try{
      const result=await call(action,{...payload,opId:record.opId});
      if(result.state==='accepted')accepted(record,result);
      else if(result.state==='failed'){setOperation(null);if(stillHere()){setNotice('');setError(result.error?.message||'请求未执行');}}
      else if(stillHere())setNotice('结果待核实，请查看最新任务状态。');
    }catch(e:any){if(e.uncertain){if(stillHere())setNotice('恢复连接后会查询这次操作的结果。');}else{setOperation(null);if(stillHere()){setNotice('');fail(e);}}}
    finally{setBusy(false);}
  }
  const target=()=>({threadId:view!.id,source:view!.source,generation:view!.generation,expectedTurnId:view!.activeTurnId});
  function startNew(){if(!connected||busy)return;setNewCwd(project||view?.cwd||info?.roots?.[0]||'');navigate({...route,thread:'',newChat:true});}
  async function submit(){
    if(!connected||busy||pending||!draft.trim())return;
    if(!newChat){if(view?.canControl)await mutate('turn.send',{...target(),text:draft,images,...(!view.activeTurnId?{model:model||undefined,effort:effort||undefined}:{})});return;}
    const createId=operationId(),sendId=operationId(),text=draft,creating={opId:createId,action:'session.create',submittedText:text,imageCount:images.length};
    setBusy(true);setError('');setNotice('正在发送…');setOperation(creating);
    const result=await createFirstTurn((action,payload)=>call(action,payload),{cwd:newCwd,text,images,model,effort,createId,sendId},id=>{
      save(`draft:${machine}:${id}`,text);save(`operation:${machine}:${id}`,{opId:sendId,action:'turn.send',submittedText:text});
      save(draftKey,'');setOperation(null);
      if(stillHere()&&current.current.newChat)navigate({...route,thread:id,newChat:false},true);
    });
    const id=result.threadId||'',key=`operation:${machine}:${id}`;
    if(result.result.state==='accepted'){
      save(key,null);save(`draft:${machine}:${id}`,'');
      if(current.current.machine===machine&&current.current.selected===id){setPending(null);setDraft('');setImages([]);setNotice('Codex 已接受');}
    }else if(result.result.state==='failed'){
      save(key,null);if(current.current.machine===machine&&current.current.selected===id){setPending(null);setNotice('');setError((result.result.error?.message||'发送失败，输入已保留')+(images.length&&id?'；附图请重新选择':''));}
    }else if(current.current.machine===machine&&current.current.selected===id)setNotice('结果待核实，系统不会自动重发。');
    setBusy(false);scheduleRefresh();void list();
  }
  async function openFile(path:string){setError('');try{const file=await call('file.read',{threadId:selected,path});if(stillHere()){setPreview(file);setSheet(null);}}catch(e){if(stillHere())fail(e);}}
  async function attach(files:FileList|null){
    if(!files)return;const results:string[]=[];
    for(const file of Array.from(files).slice(0,2)){
      if(file.size>2*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 图片');return;}
      try{results.push(await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(file);}));}catch(e){fail(e);return;}
    }if(stillHere()&&current.current.newChat===newChat){setImages(results);setSheet(null);}
  }
  function changeMachine(id:string){setSheet(null);if(id===machine)return;infoSequence.current++;listSequence.current++;setListBusy(false);setInfo(null);setProjects([]);setSessions([]);setSearch('');setSearchQuery('');setArchived(false);setNewCwd('');setMachine(id);setRoute(home);}
  function logout(){client.current?.close();save('connection','');setToken('');setView(null);setInfo(null);setMachines([]);changeMachine('');}
  const projectName=(path:string)=>info?.projects?.find((p:Json)=>p.path===path)?.name||name(path);
  const selectedModel=model||view?.model||info?.model;
  const availableModels=(info?.models||[]).filter((m:Json)=>(view?.provider||info?.provider)==='openai'||m.model===(view?.model||info?.model));
  const modelInfo=availableModels.find((m:Json)=>m.model===selectedModel),canImage=modelInfo?.inputModalities?.includes('image');
  const canWrite=connected&&!busy&&!pending&&(newChat?Boolean(newCwd):Boolean(view?.canControl));
  const visibleTitle=newChat?'新聊天':view?.title||sessions.find(s=>s.id===selected)?.title||'正在打开…';
  const feedback=<>{error&&<div className="feedback error" role="alert"><span>{error}</span><IconButton icon="close" label="关闭提示" onClick={()=>setError('')}/></div>}{notice&&<div className="feedback" role="status">{notice}</div>}{pending&&!busy&&<div className="pending"><button onClick={()=>void checkPending()}>核实操作结果</button><button onClick={()=>{if(window.confirm('请先查看最新任务，确认这次操作的实际结果。清除提示不会重发旧操作。')){setOperation(null);setNotice('');}}}>我已核实</button></div>}</>;

  if(!token||status==='auth_error')return <main className="connect"><Icon name="computer" size={38}/><h1>连接你的电脑</h1><p>在手机上继续使用 Codex。</p><form onSubmit={e=>{e.preventDefault();save('connection',tokenInput.trim());setToken(tokenInput.trim());}}><label>中继地址<input readOnly value={location.origin}/></label><label>连接 Token<input type="password" autoComplete="off" value={tokenInput} onChange={e=>setTokenInput(e.target.value)} placeholder="粘贴电脑上的连接 Token" required/></label>{status==='auth_error'&&<p className="error">Token 不匹配，请重新输入。</p>}<button className="primary">连接</button></form><small>也可以用手机扫描电脑上的连接二维码。</small></main>;
  return <div className={`shell ${showThread?'has-session':''}`}>
    <aside className="home-panel" inert={Boolean(sheet||preview)}>
      <header className="home-header"><IconButton icon={project?'back':'computer'} label={project?'返回全部项目':'选择电脑'} className="round" disabled={busy} onClick={()=>project?back():setSheet('computer')}/><h1>{project?projectName(project):'Remote'}</h1><IconButton icon="more" label="更多选项" className="round" onClick={()=>setSheet('home')}/></header>
      <button className="machine-row" onClick={()=>setSheet('computer')}><i className={connected?'dot online':'dot'}/><Icon name="computer" size={19}/><span>{machineName}</span>{!connected&&<small>{status==='online'?'离线':'连接中…'}</small>}</button>
      <div className="home-content">
        {!project&&!searchQuery&&<section className="project-section"><h2>项目</h2><button className="project-row" disabled={busy} onClick={startNew}><Icon name="chat"/><span>聊天</span></button>{projects.map(p=><button className="project-row" key={p} disabled={busy} onClick={()=>{setSessions([]);setCursor(null);navigate({...home,project:p});}} title={p}><Icon name="folder"/><span>{projectName(p)}</span></button>)}</section>}
        <section className="recent-section"><h2>{searchQuery?'搜索结果':archived?'归档会话':'最近'}</h2><nav aria-label={archived?'归档会话':'最近会话'}>{sessions.map(s=><button className={`session-row ${s.id===selected?'selected':''}`} key={s.id} disabled={busy} onClick={()=>navigate({...route,thread:s.id,newChat:false})}><span className="session-name">{s.status?.type==='active'&&<i className="dot online"/>}{s.title}</span><time>{relativeTime(s.updatedAt)}</time></button>)}</nav>
          {listBusy&&!sessions.length?<div className="list-skeleton" role="status" aria-label="正在读取会话"><div/><div/><div/></div>:!sessions.length&&<p className="empty-list">{!connected?'连接电脑后，会话会出现在这里。':searchQuery?'没有找到匹配的会话。':'还没有聊天，开始一个新任务吧。'}</p>}
          {cursor&&<button className="more-link" disabled={listBusy} onClick={()=>void list(true)}>{listBusy?'正在加载…':'加载更多'}</button>}
        </section>
      </div>
      <div className="home-bottom">{!showThread&&feedback}<div className="home-dock"><label className="search-pill"><Icon name="search"/><input aria-label="搜索聊天" placeholder="搜索聊天…" value={search} maxLength={200} onChange={e=>setSearch(e.target.value)}/>{search&&<IconButton icon="close" label="清除搜索" onClick={()=>setSearch('')}/>}</label><IconButton icon="compose" label="新聊天" className="round black new-chat" disabled={!connected||busy||Boolean(pending)} onClick={startNew}/></div></div>
    </aside>

    <main className="thread-panel" inert={Boolean(sheet||preview)}>{!showThread?<div className="desktop-welcome"><h1>我们来处理</h1><button className="center-project" onClick={startNew} disabled={!connected}><Icon name="folder"/><span>{projectName(project||info?.roots?.[0]||'选择一个项目')}</span><Icon name="chevron" size={18}/></button></div>:<>
      <header className="thread-header"><IconButton icon="back" label="返回会话列表" className="round" disabled={busy} onClick={back}/><button className="thread-title" onClick={()=>setSheet(newChat?'projects':'thread')}><strong>{visibleTitle}</strong><span><Icon name="folder" size={13}/><span>{projectName(newChat?newCwd:view?.cwd||project)||'项目'}</span><span className="mini-machine"><Icon name="computer" size={13}/><i className={connected?'dot online':'dot'}/></span><span>{machineName}</span></span></button><div className="header-actions"><IconButton icon="computer" label="电脑与连接状态" onClick={()=>setSheet('computer')}/><IconButton icon="more" label="聊天选项" onClick={()=>setSheet('thread')}/></div></header>
      {!connected&&<div className="banner">连接已断开，电脑上的任务会继续。</div>}
      {view?.notice&&!newChat&&<div className="banner">{view.notice}{view.source==='history'&&<button disabled={!connected||busy||Boolean(pending)} onClick={()=>{if(window.confirm('确认原桌面或 CLI 中的任务已经结束？继续后将由本连接器运行。'))void mutate('session.resume',{threadId:selected,confirmIdle:true});}}>在这里继续</button>}</div>}
      <div className={`timeline ${newChat||(!loading&&view&&!view.turns.length)?'is-empty':''}`} ref={timeline} onScroll={()=>{const el=timeline.current!;sticky.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;}}>
        {loading&&!newChat&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
        {view?.hasMore&&!newChat&&<button className="more-link earlier" disabled={limit>=100} onClick={()=>{sticky.current=false;const el=timeline.current;if(el)scrollAnchor.current={height:el.scrollHeight,top:el.scrollTop,limit:Math.min(100,limit+20),ready:false};setLimit(n=>Math.min(100,n+20));}}>查看更早内容{limit>=100?'（最近 100 轮）':''}</button>}
        {newChat||(!loading&&view&&!view.turns.length)?<div className="new-chat-welcome"><h1>我们来处理</h1><button className="center-project" disabled={!newChat||busy} onClick={()=>setSheet('projects')}><Icon name="folder"/><span>{projectName(newChat?newCwd:view?.cwd||'')||'选择项目'}</span>{newChat&&<Icon name="chevron" size={17}/>}</button></div>:view?.turns.map(turn=><section className="turn" key={turn.id}>
          {turn.items.map(item=>item.role==='activity'?<details className="activity" key={item.id}><summary><span>{activityLabel[item.type]||'任务活动'}</span><span className="activity-excerpt">{item.text.split('\n')[0]?.slice(0,90)}</span></summary><pre>{item.text}</pre>{item.files?.map(path=><button className="file-link" key={path} onClick={()=>void openFile(path)}><Icon name="file" size={15}/>{name(path)}</button>)}</details>:<article className={`message ${item.role}`} key={item.id}><SafeMarkdown text={item.text} openFile={openFile}/>{item.images?.map((url,i)=><img className="attachment" key={i} src={url} alt="附图"/>)}</article>)}
          <div className="turn-status">{turn.status!=='completed'&&(statusLabel[turn.status]||turn.status)}{turn.diff&&<button onClick={()=>setPreview({path:'本轮任务差异',text:turn.diff,mime:'text/plain'})}><Icon name="file" size={14}/>查看修改</button>}</div>{turn.error&&<p className="error">{turn.error}</p>}
        </section>)}
      </div>
      <div className="composer-area"><div className="request-stack">{!newChat&&view?.requests.map(req=><RequestCard key={`${view.generation}:${req.id}`} request={req} disabled={!canWrite} respond={response=>void mutate('request.respond',{...target(),requestId:req.id,response})}/>)}</div>{feedback}
        {view?.activeTurnId&&!newChat&&<div className="running-status"><i className="dot online"/>Codex 正在处理 · 可继续补充</div>}
        <form className={`composer ${images.length?'with-images':''}`} onSubmit={e=>{e.preventDefault();void submit();}}>
          {images.length>0&&<div className="image-strip">{images.map((url,i)=><img key={i} src={url} alt="待发送附图"/>)}<IconButton icon="close" label="移除图片" onClick={()=>setImages([])}/></div>}
          <IconButton icon="plus" label="添加与选项" className="composer-add" disabled={busy} onClick={()=>setSheet('add')}/>
          <textarea ref={composer} aria-label="任务输入" placeholder={newChat||!view?.turns.length?'接下来我们该写什么代码？':view?.activeTurnId?'补充当前任务…':`在 ${machineName} 上继续…`} value={draft} disabled={busy} onChange={e=>editDraft(e.target.value)} rows={1}/>
          <div className="composer-actions">{view?.activeTurnId&&!newChat&&<IconButton icon="stop" label="停止当前任务" className="black round stop" disabled={!canWrite} onClick={()=>void mutate('turn.stop',target())}/>}{draft.trim()?<button className="black round send" aria-label={view?.activeTurnId?'补充当前任务':'发送消息'} disabled={!canWrite}><Icon name="send" size={21}/></button>:!view?.activeTurnId&&<IconButton icon="mic" label="使用系统键盘听写" onClick={()=>{composer.current?.focus();setNotice('请使用系统键盘上的麦克风听写。');}}/>}</div>
        </form>
        <input className="hidden" ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e=>{void attach(e.target.files);e.target.value='';}}/>
      </div>
    </>}</main>

    {sheet&&<SheetPanel title={({home:'选项',thread:'聊天选项',computer:'电脑',projects:'选择项目',model:'模型与思考',add:'添加与选项',file:'查看项目文件'} as const)[sheet]} close={()=>setSheet(null)}>
      {sheet==='home'&&<><MenuItem icon="compose" disabled={!connected||busy} onClick={startNew}>新聊天</MenuItem><MenuItem icon="computer" onClick={()=>setSheet('computer')}>切换电脑</MenuItem><MenuItem icon="refresh" disabled={!connected} onClick={()=>{setSheet(null);refreshInfo();void list();}}>刷新项目与会话</MenuItem><MenuItem icon="chat" disabled={!connected||busy} onClick={()=>{setArchived(!archived);setSheet(null);}}>{archived?'查看最近会话':'查看归档会话'}</MenuItem><MenuItem icon="logout" disabled={busy} onClick={logout}>断开连接</MenuItem></>}
      {sheet==='thread'&&<><MenuItem icon="settings" onClick={()=>setSheet('model')}>模型与思考<span className="menu-detail">{selectedModel||'沿用电脑配置'}</span></MenuItem><MenuItem icon="file" disabled={!selected} onClick={()=>setSheet('file')}>查看项目文件</MenuItem><MenuItem icon="refresh" disabled={!selected||!connected} onClick={()=>{setSheet(null);void refreshSession();}}>刷新会话</MenuItem><MenuItem icon="compose" disabled={!connected||busy} onClick={startNew}>新聊天</MenuItem></>}
      {sheet==='computer'&&<><div className="connection-status"><i className={connected?'dot online':'dot'}/>{connected?'已连接':status==='online'?'等待电脑上线':'正在连接中继…'}</div>{machines.map(m=><MenuItem icon="computer" key={m.id} disabled={busy} onClick={()=>changeMachine(m.id)}>{m.name}{m.id===machine&&<Icon name="check" size={18}/>}</MenuItem>)}{!machines.length&&<p className="muted">请在电脑启动连接器。</p>}<p className="muted">{location.origin}</p></>}
      {sheet==='projects'&&<><div className="project-choices">{projects.map(p=><MenuItem icon="folder" key={p} disabled={busy} onClick={()=>{setNewCwd(p);setModel('');setEffort('');setSheet(null);}}><span>{projectName(p)}<small>{p}</small></span>{p===newCwd&&<Icon name="check" size={18}/>}</MenuItem>)}</div><details className="other-project"><summary>其他项目目录</summary><form onSubmit={e=>{e.preventDefault();setSheet(null);}}><label>电脑上的完整项目路径<input value={newCwd} onChange={e=>setNewCwd(e.target.value)} required/></label><button className="primary">使用这个目录</button></form></details></>}
      {sheet==='model'&&<><p className="muted">{view?.activeTurnId?'当前任务沿用正在使用的模型，结束后可以更换。':'默认沿用电脑配置，也可以填写同一提供商的模型 ID。'}</p><label>模型<input list="models" disabled={Boolean(view?.activeTurnId)||busy} value={model} onChange={e=>setModel(e.target.value)} placeholder={selectedModel||'沿用配置'}/></label><datalist id="models">{availableModels.map((m:Json)=><option key={m.id||m.model} value={m.model}>{m.displayName}</option>)}</datalist><label>思考程度<select disabled={Boolean(view?.activeTurnId)||busy} value={effort} onChange={e=>setEffort(e.target.value)}><option value="">沿用电脑设置</option>{modelInfo?.supportedReasoningEfforts?.map((r:Json)=><option key={r.reasoningEffort} value={r.reasoningEffort}>{({none:'关闭',minimal:'最少',low:'较少',medium:'适中',high:'较多',xhigh:'更多',max:'最多'} as Json)[r.reasoningEffort]||r.reasoningEffort}</option>)}</select></label><button className="primary" onClick={()=>setSheet(null)}>完成</button></>}
      {sheet==='add'&&<>{canImage&&<MenuItem icon="image" disabled={busy} onClick={()=>fileInput.current?.click()}>添加图片</MenuItem>}<MenuItem icon="settings" onClick={()=>setSheet('model')}>模型与思考<span className="menu-detail">{selectedModel}</span></MenuItem>{selected&&<MenuItem icon="file" onClick={()=>setSheet('file')}>查看项目文件</MenuItem>}{newChat&&<MenuItem icon="folder" disabled={busy} onClick={()=>setSheet('projects')}>选择项目</MenuItem>}</>}
      {sheet==='file'&&<form onSubmit={e=>{e.preventDefault();void openFile(filePath);}}><label>文件路径<input autoFocus required value={filePath} onChange={e=>setFilePath(e.target.value)} placeholder="例如 README.md 或 src/app.ts"/></label><button className="primary">打开文件</button></form>}
    </SheetPanel>}
    {preview&&<SheetPanel title={preview.path} className="file-preview" close={()=>setPreview(null)}>{preview.data?<img className="preview-image" src={`data:${preview.mime};base64,${preview.data}`} alt={preview.path}/>:<pre className="file-content">{preview.text}</pre>}</SheetPanel>}
  </div>;
}
function IconButton({icon,label,onClick,disabled=false,className=''}:{icon:IconName;label:string;onClick:()=>void;disabled?:boolean;className?:string}){return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon name={icon}/></button>;}
function MenuItem({icon,children,onClick,disabled=false}:{icon:IconName;children:ReactNode;onClick:()=>void;disabled?:boolean}){return <button className="menu-item" onClick={onClick} disabled={disabled}><Icon name={icon} size={21}/><span className="menu-copy">{children}</span></button>;}
function SheetPanel({title,close,children,className=''}:{title:string;close:()=>void;children:ReactNode;className?:string}){
  const panel=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement;if(!panel.current?.contains(document.activeElement))panel.current?.focus();const key=(e:KeyboardEvent)=>{
    if(e.key==='Escape'){e.preventDefault();close();}
    if(e.key==='Tab'){const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],summary')||[]);const first=nodes[0],last=nodes.at(-1);if(!panel.current?.contains(document.activeElement)){e.preventDefault();(e.shiftKey?last:first)?.focus();}else if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  };document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};},[]);
  return <div className="overlay" onClick={close}><section tabIndex={-1} ref={panel} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><div className="sheet-handle"/><header><h2>{title}</h2><IconButton icon="close" label="关闭" onClick={close}/></header><div className="sheet-content">{children}</div></section></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
