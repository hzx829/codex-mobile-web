import {lazy,Suspense,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type ClipboardEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {Client,operationId} from './client';
import {Icon,type IconName} from './icons';
import {SafeMarkdown,RequestCard} from './content';
import {createFirstTurn} from './new-chat';
import {SessionListLoader} from './session-list-loader';
import {BrowserPreviewPanel,WebViewer,type PreviewSession} from './browser-preview';
import {belongsToThread,defaultPreviewUrl,openThreadPreview,previewUrlKey} from './thread-preview';
import {groupItems} from './activity';
import {PreviewPane,useCompactPreview} from './preview-pane';
import {fileReference,samePreviewTarget,type PreviewTarget} from './preview-target';
import {home,initialLocation,rememberLocation,parseLocation,type Route} from './route-state';
import {appendImages,pastedImage,readImageFiles} from './attachments';
import {MAX_IMAGES} from '../src/shared/images';
import {ThreadMenu,ThreadRow} from './thread-menu';
import type {MenuPoint} from './popover';
import {ContextIndicator,ThreadStatusPanel,contextSummary} from './thread-status';
import {groupThreads,visibleThreads,rememberThreads,saveThread,type ThreadPreferences,type ThreadPreference} from './thread-preferences';
import type {Json,SessionView,RequestAction,MessageItem} from '../src/shared/types';
import './style.css';
import 'react-diff-view/style/index.css';
import './preview.css';

const FilePreviewPanel=lazy(()=>import('./file-preview').then(module=>({default:module.FilePreviewPanel})));
const DiffViewer=lazy(()=>import('./diff-viewer').then(module=>({default:module.DiffViewer})));

const load=(key:string,fallback:any)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}};
const save=(key:string,value:any)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const name=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;
const previewTitle=(target:PreviewTarget)=>target.kind==='file'?target.file?.name||name(target.path):target.kind==='diff'?'本轮修改':target.kind==='image'?target.title:'网页预览';
const statusLabel:Record<string,string>={inProgress:'进行中',completed:'已完成',interrupted:'已停止',failed:'失败'};
const activityLabel:Record<string,string>={commandExecution:'运行命令',fileChange:'修改文件',mcpToolCall:'使用工具',reasoning:'思考摘要',webSearch:'搜索',contextCompaction:'整理上下文',plan:'计划'};
function relativeTime(value:number){if(!value)return '';const elapsed=Math.max(0,Date.now()-(value<1e12?value*1000:value));const minutes=Math.floor(elapsed/60_000);return minutes<1?'刚刚':minutes<60?`${minutes}分钟`:minutes<1440?`${Math.floor(minutes/60)}小时`:`${Math.floor(minutes/1440)}天`;}
function initialToken(){const params=new URLSearchParams(location.hash.slice(1));const token=params.get('token');if(token){save('connection',token);history.replaceState(history.state,'',location.pathname+location.search);}return token||load('connection','');}
const savedLocation=initialLocation();
type PreviewTab={id:number;target:PreviewTarget};
type Sheet='home'|'computer'|'projects'|'model'|'approval'|'add'|'file'|'browser'|null;

function App(){
  const [token,setToken]=useState(initialToken),[tokenInput,setTokenInput]=useState('');
  const [status,setStatus]=useState('connecting'),[machines,setMachines]=useState<Json[]>([]),[machine,setMachine]=useState(savedLocation.machine);
  const [route,setRoute]=useState<Route>(savedLocation.route),[sheet,setSheet]=useState<Sheet>(null);
  const {thread:selected,project,newChat}=route,showThread=Boolean(selected||newChat);
  const [info,setInfo]=useState<Json|null>(null),[projects,setProjects]=useState<string[]>([]),[sessions,setSessions]=useState<Json[]>([]);
  const [cursor,setCursor]=useState<string|null>(null),[search,setSearch]=useState(''),[searchQuery,setSearchQuery]=useState(''),[listBusy,setListBusy]=useState(false),[archived,setArchived]=useState(false);
  const [view,setView]=useState<SessionView|null>(null),[limit,setLimit]=useState(20),[loading,setLoading]=useState(false);
  const [draft,setDraft]=useState(''),[images,setImages]=useState<string[]>([]),[model,setModel]=useState(''),[effort,setEffort]=useState(''),[approval,setApproval]=useState(''),[newCwd,setNewCwd]=useState('');
  const [imageLoading,setImageLoading]=useState(false),imageLoad=useRef<number|null>(null),imageSequence=useRef(0),imagesRef=useRef(images);imagesRef.current=images;
  const [threadMenu,setThreadMenu]=useState<{thread:Json;point:MenuPoint;machine:string;archived:boolean;compact?:boolean}|null>(null);
  const [statusPanel,setStatusPanel]=useState<{machine:string;thread:string;point:MenuPoint}|null>(null);
  const [preferenceState,setPreferences]=useState<{machine:string;values:ThreadPreferences}>({machine:'',values:{}});
  const preferences=preferenceState.machine===machine?preferenceState.values:{};
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<Json|null>(null);
  const [previewState,setPreviewState]=useState<{tabs:PreviewTab[];activeId:number|null}>({tabs:[],activeId:null}),[filePath,setFilePath]=useState('');
  const preview=previewState.tabs.find(tab=>tab.id===previewState.activeId)?.target||null;
  const previewIds=useRef(0);
  const compactPreview=useCompactPreview();
  const fileSequence=useRef(0),browserSequence=useRef(0);
  const [browserUrl,setBrowserUrl]=useState(defaultPreviewUrl),[browserRequest,setBrowserRequest]=useState<number|null>(null),[browserState,setBrowserSession]=useState<PreviewSession|null>(null);
  const browserBusy=browserRequest!==null,browserSession=belongsToThread(browserState,machine,selected)?browserState:null;
  const client=useRef<Client|null>(null),current=useRef({machine,selected,project,newChat,limit,searchQuery,archived}),sequence=useRef(0),listLoader=useRef(new SessionListLoader()),infoSequence=useRef(0);
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),refreshing=useRef(false),again=useRef(false),sticky=useRef(true),timeline=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),fileInput=useRef<HTMLInputElement>(null);
  const scrollAnchor=useRef<{height:number;top:number;limit:number;ready:boolean}|null>(null);
  current.current={machine,selected,project,newChat,limit,searchQuery,archived};
  const connected=status==='online'&&machines.some(m=>m.id===machine),machineName=machines.find(m=>m.id===machine)?.name||'电脑';
  const scope=`${machine}:${selected}`,draftKey=`draft:${scope}`,pendingKey=`operation:${scope}`;
  const call=(action:RequestAction,payload:Json={},target=machine)=>client.current!.request(action,payload,target);
  const stillHere=()=>current.current.machine===machine&&current.current.selected===selected;
  function closePreview(){browserSequence.current++;setPreviewState({tabs:[],activeId:null});}
  function showPreview(next:PreviewTarget){
    const id=++previewIds.current;
    setPreviewState(old=>{const tabs=next.kind==='web'?old.tabs.filter(tab=>tab.target.kind!=='web'||tab.target.session.sessionId===next.session.sessionId):old.tabs;
      const existing=tabs.find(tab=>samePreviewTarget(tab.target,next));return existing
      ?{tabs:tabs.map(tab=>tab.id===existing.id?{...tab,target:next}:tab),activeId:existing.id}
      :{tabs:[...tabs,{id,target:next}],activeId:id};});
    setSheet(null);
  }
  function closePreviewTab(id:number){setPreviewState(old=>{const index=old.tabs.findIndex(tab=>tab.id===id);if(index<0)return old;const tabs=old.tabs.filter(tab=>tab.id!==id);return {tabs,activeId:old.activeId===id?tabs[Math.min(index,tabs.length-1)]?.id??null:old.activeId};});}
  function fail(e:any){setError(e?.message||'操作失败，请重试');}
  function navigate(next:Route,replace=false){
    history[replace?'replaceState':'pushState']({cmwRoute:next,cmwMachine:machine},'',location.pathname);
    rememberLocation(next,machine);setSheet(null);setThreadMenu(null);setStatusPanel(null);setRoute(next);
  }
  function backToProjects(){navigate(home);}
  function backToSessions(){navigate({...home,project});}
  useEffect(()=>{
    const pop=(e:PopStateEvent)=>{setSheet(null);setThreadMenu(null);setStatusPanel(null);const location=parseLocation(e.state);const next=location?.machine===current.current.machine?location.route:home;rememberLocation(next,current.current.machine);setRoute(next);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=>{history.replaceState({cmwRoute:route,cmwMachine:machine},'',location.pathname);rememberLocation(route,machine);},[machine]);
  async function refreshSession(){
    if(refreshing.current){again.current=true;return;}
    const c={...current.current};if(!c.machine||!c.selected||!client.current?.ready)return;
    const seq=sequence.current;refreshing.current=true;
    try{const next=await call('session.read',{threadId:c.selected,limit:c.limit},c.machine);if(seq===sequence.current&&c.machine===current.current.machine&&c.selected===current.current.selected){if(scrollAnchor.current&&c.limit>=scrollAnchor.current.limit)scrollAnchor.current.ready=true;setView(next);setLoading(false);}}
    catch(e){if(seq===sequence.current){fail(e);setLoading(false);}}
    finally{refreshing.current=false;if(again.current){again.current=false;void refreshSession();}}
  }
  function scheduleRefresh(){if(refreshTimer.current)return;refreshTimer.current=setTimeout(()=>{refreshTimer.current=undefined;void refreshSession();},250);}
  async function list(append=false,refresh=false){
    const c={...current.current};
    const key=(value:typeof c)=>JSON.stringify([value.machine,value.project,value.searchQuery,value.archived]);
    const here=()=>key(c)===key(current.current);
    await listLoader.current.load(key(c),()=>call('sessions.list',{cwd:c.project||undefined,search:c.searchQuery||undefined,archived:c.archived,cursor:append?cursor:undefined,refresh},c.machine),{
      start:()=>setListBusy(true),
      result:r=>{
        if(!here())return;
        setSessions(old=>append?[...old,...r.data.filter((n:Json)=>!old.some(s=>s.id===n.id))]:r.data);setCursor(r.nextCursor);
        setPreferences(old=>{if(old.machine!==c.machine)return old;const values=rememberThreads(old.values,r.data,c.archived);if(values===old.values)return old;save(`thread-preferences:${c.machine}`,values);return {...old,values};});
        setProjects(old=>[...new Set<string>([...old,...r.data.map((s:Json)=>s.cwd).filter(Boolean)])]);
      },
      error:e=>{if(here())fail(e);},
      finish:()=>setListBusy(false),
    });
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
  useEffect(()=>client.current?.onPreview(message=>{
    if(message.type==='preview.disconnected'||message.type==='preview.ended'&&message.sessionId===browserState?.sessionId){setBrowserSession(null);setPreviewState(old=>{const tabs=old.tabs.filter(tab=>tab.target.kind!=='web');return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});}
  }),[token,browserState?.sessionId]);
  useEffect(()=>{if(!machine&&machines[0])setMachine(machines[0].id);},[machines,machine]);
  useEffect(()=>{setPreferences({machine,values:load(`thread-preferences:${machine}`,{})});setThreadMenu(null);},[machine]);
  useEffect(()=>{
    setStatusPanel(null);
    imageSequence.current++;imageLoad.current=null;setImageLoading(false);
    setBrowserRequest(null);setBrowserUrl(load(previewUrlKey(machine,selected),defaultPreviewUrl));
    sequence.current++;setView(null);setLoading(Boolean(selected));setLimit(20);setImages([]);setModel('');setEffort('');setApproval('');setError('');setNotice('');sticky.current=true;scrollAnchor.current=null;
    setDraft(load(draftKey,''));setPending(load(pendingKey,null));void refreshSession();
  },[machine,selected,newChat]);
  useEffect(()=>{void refreshSession();},[limit,connected]);
  useEffect(()=>{
    const viewport=window.visualViewport;if(!viewport)return;
    const resize=()=>{if(viewport.scale!==1)return;document.documentElement.style.setProperty('--viewport-height',`${viewport.height}px`);document.documentElement.style.setProperty('--viewport-top',`${viewport.offsetTop}px`);};
    resize();viewport.addEventListener('resize',resize);viewport.addEventListener('scroll',resize);
    return()=>{viewport.removeEventListener('resize',resize);viewport.removeEventListener('scroll',resize);};
  },[]);
  useEffect(()=>{const el=timeline.current;if(!el)return;if(scrollAnchor.current?.ready){el.scrollTop=scrollAnchor.current.top+el.scrollHeight-scrollAnchor.current.height;scrollAnchor.current=null;}else if(sticky.current)el.scrollTop=el.scrollHeight;},[view]);
  function resizeComposer(){const el=composer.current;if(!el)return;el.style.overflowY='hidden';el.style.height='auto';const height=el.scrollHeight;el.style.height=`${Math.min(Math.max(height,44),144)}px`;el.style.overflowY=height>145?'auto':'hidden';}
  useLayoutEffect(resizeComposer,[draft,showThread]);
  useEffect(()=>{const el=composer.current;if(!el)return;let width=el.clientWidth;const observer=new ResizeObserver(()=>{if(width!==el.clientWidth){width=el.clientWidth;resizeComposer();}});observer.observe(el);return()=>observer.disconnect();},[showThread]);
  useEffect(()=>{setPreviewState(old=>{let changed=false;const tabs=old.tabs.flatMap(tab=>{if(tab.target.kind!=='image')return [tab];const index=images.indexOf(tab.target.url);if(index<0){changed=true;return [];}const title=`待发送图片 ${index+1}/${images.length}`;if(title!==tab.target.title){changed=true;return [{...tab,target:{...tab.target,title}}];}return [tab];});if(!changed)return old;return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});},[images]);
  useEffect(()=>{
    if(!connected)return;
    const foreground=()=>{if(document.visibilityState!=='visible')return;if(current.current.selected)void refreshSession();else void list();};
    const timer=setInterval(foreground,5000);document.addEventListener('visibilitychange',foreground);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',foreground);};
  },[connected,project,searchQuery,archived]);
  useEffect(()=>{if(connected&&pending&&!busy)void checkPending();},[connected,pending?.opId,busy]);
  useEffect(()=>{if(!notice||pending)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice,pending]);
  function editDraft(value:string){setDraft(value);save(draftKey,value);}
  function insertFollowup(prompt:string){if(!draft.trimEnd().endsWith(prompt))editDraft(draft.trim()?`${draft.trimEnd()}\n\n${prompt}`:prompt);setNotice('已填入输入框，确认后发送。');composer.current?.focus();}
  function setOperation(value:Json|null){save(pendingKey,value);if(stillHere())setPending(value);}
  function accepted(record:Json,result:Json){
    if(record.action==='session.create'&&record.submittedText!==undefined&&result.threadId){
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
    if(!connected||busy||pending||imageLoading||!draft.trim()&&!images.length)return;
    if(images.length&&!canImage){setError('当前模型未确认图片能力，请更换模型或移除图片');return;}
    if(!newChat){if(view?.canControl)await mutate('turn.send',{...target(),text:draft,images,...(!view.activeTurnId?{model:model||undefined,effort:effort||undefined,approvalPolicy:approval||undefined}:{})});return;}
    const createId=operationId(),sendId=operationId(),text=draft,creating={opId:createId,action:'session.create',submittedText:text,imageCount:images.length};
    setBusy(true);setError('');setNotice('正在发送…');setOperation(creating);
    const result=await createFirstTurn((action,payload)=>call(action,payload),{cwd:newCwd,text,images,model,effort,approvalPolicy:approval,createId,sendId},id=>{
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
  async function openFile(reference:string,ownerMachine=machine,ownerThread=selected){
    const {path,line}=fileReference(reference),request=++fileSequence.current;
    const next:PreviewTarget={kind:'file',machineId:ownerMachine,threadId:ownerThread,path,line,request};
    setError('');showPreview(next);
    try{const file=await call('file.read',{threadId:ownerThread,path},ownerMachine);setPreviewState(old=>({...old,tabs:old.tabs.map(tab=>tab.target.kind==='file'&&samePreviewTarget(tab.target,next)&&tab.target.request===request?{...tab,target:{...next,file}}:tab)}));}
    catch(e){setPreviewState(old=>({...old,tabs:old.tabs.map(tab=>tab.target.kind==='file'&&samePreviewTarget(tab.target,next)&&tab.target.request===request?{...tab,target:{...next,error:(e as Error)?.message||'文件读取失败'}}:tab)}));}
  }
  async function openBrowser(url=browserUrl){
    if(!connected||browserBusy||!selected)return;
    const owner=machine,request=++browserSequence.current;
    const address=url.trim();setBrowserUrl(address);
    setBrowserRequest(request);setError('');
    try{
      const result=await openThreadPreview(call,owner,selected,address,()=>stillHere()&&request===browserSequence.current);
      if(!result)return;
      save(previewUrlKey(owner,selected),address);setBrowserSession(result);showPreview({kind:'web',session:result});
    }catch(e){if(stillHere()&&request===browserSequence.current)fail(e);}finally{setBrowserRequest(old=>old===request?null:old);}
  }
  function closeBrowser(){const session=browserState;browserSequence.current++;setBrowserSession(null);setPreviewState(old=>{const tabs=old.tabs.filter(tab=>tab.target.kind!=='web');return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});if(session)void call('preview.stop',{sessionId:session.sessionId,threadId:session.threadId},session.machineId).catch(()=>{});}
  async function attach(files:File[],data?:string){
    if(busy||!files.length&&!data)return;
    if(!canImage){setError('当前模型未确认图片能力');return;}
    if(imageLoad.current!==null){setError('图片正在读取，请稍候');return;}
    const request=++imageSequence.current;imageLoad.current=request;setImageLoading(true);setError('');
    try{
      const incoming=data?[data]:await readImageFiles(files);
      if(request!==imageSequence.current||!stillHere()||current.current.newChat!==newChat)return;
      const next=appendImages(imagesRef.current,incoming);imagesRef.current=next;setImages(next);setSheet(null);
    }catch(e){if(request===imageSequence.current&&stillHere())fail(e);}
    finally{if(imageLoad.current===request){imageLoad.current=null;setImageLoading(false);}}
  }
  function paste(e:ClipboardEvent<HTMLTextAreaElement>){
    const files=Array.from(e.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file));
    if(files.length){e.preventDefault();void attach(files);return;}
    try{const data=pastedImage(e.clipboardData.getData('text/plain'));if(data){e.preventDefault();void attach([],data);}}
    catch(error){e.preventDefault();fail(error);}
  }
  function changeMachine(id:string){setSheet(null);if(id===machine)return;closeBrowser();closePreview();infoSequence.current++;listLoader.current.invalidate();setListBusy(false);setInfo(null);setProjects([]);setSessions([]);setSearch('');setSearchQuery('');setArchived(false);setNewCwd('');history.replaceState({cmwRoute:home,cmwMachine:id},'',location.pathname);rememberLocation(home,id);setMachine(id);setRoute(home);}
  function logout(){client.current?.close();save('connection','');setToken('');setView(null);setInfo(null);setMachines([]);changeMachine('');}
  async function copyId(id:string){
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(id);
      else {
        const input=document.createElement('textarea');input.value=id;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();
        try{if(!document.execCommand('copy'))throw Error('copy failed');}finally{input.remove();}
      }
  }
  function headerPoint(element:HTMLElement):MenuPoint{const rect=element.getBoundingClientRect();return {x:rect.right,y:rect.bottom+8,align:'end'};}
  function openStatus(element:HTMLElement){if(selected)setStatusPanel({machine,thread:selected,point:headerPoint(element)});}
  function openThreadMenu(element:HTMLElement){
    if(!selected)return;
    const row:Json|undefined=sessions.find(s=>s.id===selected)||preferences[selected]?.thread;
    const thread={...row,id:selected,title:view?.title||row?.title||'会话',cwd:view?.cwd||row?.cwd||project,status:view?.running?{type:'active'}:row?.status};
    setThreadMenu({thread,point:headerPoint(element),machine,archived,compact:true});
  }
  function changePreference(id:string,patch:ThreadPreference,thread?:Json){
    const preference={...preferences[id],...patch};
    if(thread&&(preference.pinned||preference.section))preference.thread=saveThread(thread,archived);
    if(!preference.pinned&&!preference.section)delete preference.thread;
    const values={...preferences,[id]:preference};save(`thread-preferences:${machine}`,values);setPreferences({machine,values});
  }
  async function changeThread(action:'session.rename'|'session.archive'|'session.unarchive',thread:Json,payload:Json={}){
    const owner=machine,result=await call(action,{threadId:thread.id,...payload,opId:operationId()},owner);
    if(result.state!=='accepted')throw Error(result.state==='uncertain'?'结果待核实，请刷新会话列表查看。':result.error?.message||'操作未完成');
    if(current.current.machine!==owner)return;
    const updated=action==='session.rename'?{...thread,title:payload.name}:thread;
    setPreferences(old=>{if(old.machine!==owner)return old;const values=rememberThreads(old.values,[updated],action==='session.rename'?archived:action==='session.archive');save(`thread-preferences:${owner}`,values);return {...old,values};});
    if(action==='session.rename'){setSessions(old=>old.map(s=>s.id===thread.id?updated:s));setView(old=>old&&old.id===thread.id?{...old,title:payload.name}:old);}
    else{setSessions(old=>old.filter(s=>s.id!==thread.id));if(current.current.selected===thread.id)navigate({...home,project:thread.cwd||''});}
    listLoader.current.invalidate();void list();
  }
  const projectName=(path:string)=>info?.projects?.find((p:Json)=>p.path===path)?.name||name(path);
  const selectedModel=view?.activeTurnId?view.model:model||view?.model||info?.model;
  const availableModels=(info?.models||[]).filter((m:Json)=>(view?.provider||info?.provider)==='openai'||m.model===(view?.model||info?.model));
  const customModel=Boolean(model)&&!availableModels.some((m:Json)=>m.model===model);
  const modelInfo=availableModels.find((m:Json)=>m.model===selectedModel),canImage=modelInfo?.inputModalities?.includes('image');
  const inheritedApproval=newChat?info?.approvalPolicy:view?.approvalPolicy;
  const approvalLabel=inheritedApproval==='never'?'不提示':inheritedApproval==='on-request'?'按需审批':'电脑配置';
  const canWrite=connected&&!busy&&!pending&&!imageLoading&&(newChat?Boolean(newCwd):Boolean(view?.canControl));
  const effortLabel=({none:'关闭',minimal:'最少',low:'较少',medium:'适中',high:'较多',xhigh:'极高',max:'最高'} as Json)[effort||(newChat?info?.effort:'')||''];
  const activeApproval=approval||inheritedApproval;
  const listedThreads=visibleThreads(sessions,preferences,project,archived,searchQuery);
  const visibleTitle=newChat?'新聊天':view?.title||sessions.find(s=>s.id===selected)?.title||'正在打开…';
  const feedback=<>{error&&<div className="feedback error" role="alert"><span>{error}</span><IconButton icon="close" label="关闭提示" onClick={()=>setError('')}/></div>}{notice&&<div className="feedback" role="status">{notice}</div>}{pending&&!busy&&<div className="pending"><button onClick={()=>void checkPending()}>核实操作结果</button><button onClick={()=>{if(window.confirm('请先查看最新任务，确认这次操作的实际结果。清除提示不会重发旧操作。')){setOperation(null);setNotice('');}}}>我已核实</button></div>}</>;

  if(!token||status==='auth_error')return <main className="connect"><Icon name="computer" size={38}/><h1>连接你的电脑</h1><p>在手机上继续使用 Codex。</p><form onSubmit={e=>{e.preventDefault();save('connection',tokenInput.trim());setToken(tokenInput.trim());}}><label>中继地址<input readOnly value={location.origin}/></label><label>连接 Token<input type="password" autoComplete="off" value={tokenInput} onChange={e=>setTokenInput(e.target.value)} placeholder="粘贴电脑上的连接 Token" required/></label>{status==='auth_error'&&<p className="error">Token 不匹配，请重新输入。</p>}<button className="primary">连接</button></form><small>也可以用手机扫描电脑上的连接二维码。</small></main>;
  return <div className={`shell ${showThread?'has-session':''}`}>
    <aside className="home-panel" inert={Boolean(sheet||threadMenu||statusPanel||compactPreview&&preview)}>
       <header className="home-header">{project?<><IconButton icon="back" label="返回全部项目" className="round" disabled={busy} onClick={backToProjects}/><h1>{projectName(project)}</h1></>:<button className="home-identity" aria-label="选择电脑" onClick={()=>setSheet('computer')}><span className="home-computer"><Icon name="computer" size={22}/></span><strong>Remote</strong><span className="home-machine"><i className={connected?'dot online':'dot'}/><span>{machineName}</span>{!connected&&<small>{status==='online'?'离线':'连接中…'}</small>}</span></button>}<IconButton icon="more" label="更多选项" className="round" onClick={()=>setSheet('home')}/></header>
      <div className="home-content">
        {!project&&!searchQuery&&<section className="project-section"><h2>项目</h2><button className="project-row" disabled={busy} onClick={startNew}><Icon name="chat"/><span>聊天</span></button>{projects.map(p=><button className="project-row" key={p} disabled={busy} onClick={()=>{setSessions([]);setCursor(null);navigate({...home,project:p});}} title={p}><Icon name="folder"/><span>{projectName(p)}</span></button>)}</section>}
        <section className="recent-section">{!listedThreads.length&&<h2>{searchQuery?'搜索结果':archived?'归档会话':'最近'}</h2>}{groupThreads(listedThreads,preferences,searchQuery?'搜索结果':archived?'归档会话':'最近').map(group=><div className="thread-group" key={group.key}><h2>{group.label}</h2><nav aria-label={group.label}>{group.threads.map(s=><ThreadRow key={s.id} thread={s} selected={s.id===selected} disabled={busy} preference={preferences[s.id]} time={relativeTime(s.updatedAt)} open={()=>{changePreference(s.id,{unread:false});navigate({...route,thread:s.id,newChat:false});}} menu={point=>setThreadMenu({thread:s,point,machine,archived})}/>)}</nav></div>)}
          {listBusy&&!listedThreads.length?<div className="list-skeleton" role="status" aria-label="正在读取会话"><div/><div/><div/></div>:!listedThreads.length&&<p className="empty-list">{!connected?'连接电脑后，会话会出现在这里。':searchQuery?'没有找到匹配的会话。':'还没有聊天，开始一个新任务吧。'}</p>}
          {cursor&&<button className="more-link" disabled={listBusy} onClick={()=>void list(true)}>{listBusy?'正在加载…':'加载更多'}</button>}
        </section>
      </div>
      <div className="home-bottom">{!showThread&&feedback}<div className="home-dock"><label className="search-pill"><Icon name="search"/><input aria-label="搜索聊天" placeholder="搜索聊天…" value={search} maxLength={200} onChange={e=>setSearch(e.target.value)}/>{search&&<IconButton icon="close" label="清除搜索" onClick={()=>setSearch('')}/>}</label><IconButton icon="compose" label="新聊天" className="round black new-chat" disabled={!connected||busy||Boolean(pending)} onClick={startNew}/></div></div>
    </aside>

    <main className="thread-panel" inert={Boolean(sheet||threadMenu||statusPanel||compactPreview&&preview)}>{!showThread?<div className="desktop-welcome"><h1>我们来处理</h1><button className="center-project" onClick={startNew} disabled={!connected}><Icon name="folder"/><span>{projectName(project||info?.roots?.[0]||'选择一个项目')}</span><Icon name="chevron" size={18}/></button></div>:<>
       <header className="thread-header"><IconButton icon="back" label="返回会话列表" className="round" disabled={busy} onClick={backToSessions}/><button className="thread-title" onClick={e=>newChat?setSheet('projects'):openStatus(e.currentTarget)}><strong>{visibleTitle}</strong><span><Icon name="folder" size={13}/><span>{projectName(newChat?newCwd:view?.cwd||project)||'项目'}</span><span className="mini-machine"><Icon name="computer" size={13}/><i className={connected?'dot online':'dot'}/></span><span>{machineName}</span></span></button><div className="header-actions"><button type="button" className="icon-button" aria-haspopup="dialog" aria-label={`会话状态：${contextSummary(view?.contextUsage)}`} title="上下文与额度限制" disabled={!selected} onClick={e=>openStatus(e.currentTarget)}><ContextIndicator usage={view?.contextUsage}/></button><button type="button" className="icon-button" aria-haspopup="dialog" aria-label="会话操作" disabled={!selected||busy} onClick={e=>openThreadMenu(e.currentTarget)}><Icon name="more"/></button></div></header>
       {browserSession&&<BrowserPreviewPanel session={browserSession} onOpen={()=>showPreview({kind:'web',session:browserSession})} onClose={closeBrowser}/>}
      {!connected&&<div className="banner">连接已断开，电脑上的任务会继续。</div>}
      {view?.notice&&!newChat&&<div className="banner">{view.notice}{view.source==='history'&&!view.resumeUnavailable&&<button disabled={!connected||busy||Boolean(pending)} onClick={()=>{if(window.confirm('确认原桌面或 CLI 中的任务已经结束？继续后将由本连接器运行。'))void mutate('session.resume',{threadId:selected,confirmIdle:true});}}>在这里继续</button>}</div>}
      <div className={`timeline ${newChat||(!loading&&view&&!view.turns.length)?'is-empty':''}`} ref={timeline} onScroll={()=>{const el=timeline.current!;sticky.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;}}>
        {loading&&!newChat&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
        {view?.hasMore&&!newChat&&<button className="more-link earlier" disabled={limit>=100} onClick={()=>{sticky.current=false;const el=timeline.current;if(el)scrollAnchor.current={height:el.scrollHeight,top:el.scrollTop,limit:Math.min(100,limit+20),ready:false};setLimit(n=>Math.min(100,n+20));}}>查看更早内容{limit>=100?'（最近 100 轮）':''}</button>}
        {newChat||(!loading&&view&&!view.turns.length)?<div className="new-chat-welcome"><h1>我们来处理</h1><button className="center-project" disabled={!newChat||busy} onClick={()=>setSheet('projects')}><Icon name="folder"/><span>{projectName(newChat?newCwd:view?.cwd||'')||'选择项目'}</span>{newChat&&<Icon name="chevron" size={17}/>}</button></div>:view?.turns.map(turn=><section className="turn" key={turn.id}>
          {groupItems(turn.items).map((group,index)=>group[0].role==='activity'?<details className="activity-group" key={`activity-${index}`}><summary>{turn.status==='inProgress'?'正在处理':'运行记录'} · {group.length} 项<span className="activity-excerpt">{activityLabel[group.at(-1)!.type]||'任务活动'}</span></summary><div className="activity-list">{group.map(item=><details className="activity" key={item.id}><summary><span>{activityLabel[item.type]||'任务活动'}</span><span className="activity-excerpt">{item.text.split('\n')[0]?.slice(0,90)}</span></summary><pre>{item.text}</pre>{item.files?.map(path=><button className="file-link" key={path} onClick={()=>void openFile(path)}><Icon name="file" size={15}/>{name(path)}</button>)}</details>)}</div></details>:group.map((item:MessageItem)=><article className={`message ${item.role}`} key={item.id}><SafeMarkdown text={item.text} openFile={openFile} openPreview={url=>void openBrowser(url)} onFollowup={insertFollowup}/>{item.images?.map((url,i)=><img className="attachment" key={i} src={url} alt="附图"/>)}</article>))}
          <div className="turn-status">{turn.status!=='completed'&&(statusLabel[turn.status]||turn.status)}{turn.diff&&<button onClick={()=>showPreview({kind:'diff',threadId:selected,turnId:turn.id,text:turn.diff!})}><Icon name="file" size={14}/>查看修改</button>}</div>{turn.error&&<p className="error">{turn.error}</p>}
        </section>)}
      </div>
      <div className="composer-area"><div className="request-stack">{!newChat&&view?.requests.map(req=><RequestCard key={`${view.generation}:${req.id}`} request={req} disabled={!canWrite} respond={response=>void mutate('request.respond',{...target(),requestId:req.id,response})}/>)}</div>{feedback}
        {view?.activeTurnId&&!newChat&&<div className="running-status"><i className="dot online"/>Codex 正在处理 · 可继续补充</div>}
        <form className={`composer ${images.length?'with-images':''}`} onSubmit={e=>{e.preventDefault();void submit();}}>
          {images.length>0&&<div className="image-strip"><span className="attachment-count" role="status">图片 {images.length}/{MAX_IMAGES}</span><div className="attachment-thumbnails">{images.map((url,i)=><div className="attachment-thumb" key={url}><button type="button" aria-label={`查看第 ${i+1} 张图片，共 ${images.length} 张`} onClick={()=>showPreview({kind:'image',url,title:`待发送图片 ${i+1}/${images.length}`})}><img src={url} alt={`待发送图片 ${i+1}`}/></button><button className="attachment-remove" type="button" disabled={busy} aria-label={`移除第 ${i+1} 张图片`} onClick={()=>setImages(old=>old.filter(value=>value!==url))}><Icon name="close" size={14}/></button></div>)}</div></div>}
          {imageLoading&&<span className="attachment-count" role="status">正在读取图片…</span>}
          <textarea ref={composer} aria-label="任务输入" placeholder={newChat||!view?.turns.length?'接下来我们该写什么代码？':view?.activeTurnId?'补充当前任务…':`在 ${machineName} 上继续…`} value={draft} disabled={busy} onChange={e=>editDraft(e.target.value)} onPaste={paste} rows={1}/>
          <div className="composer-toolbar">
            <IconButton icon="plus" label="添加与选项" className="composer-add" disabled={busy||imageLoading} onClick={()=>setSheet('add')}/>
            <IconButton icon="shield" label={`许可：${activeApproval==='never'?'不提示':activeApproval==='on-request'?'按需审批':'电脑配置'}`} className={`composer-permission${activeApproval==='never'?' unrestricted':''}`} disabled={busy} onClick={()=>setSheet('approval')}/>
            <button className="composer-model" type="button" onClick={()=>setSheet('model')} disabled={busy} title={`${selectedModel||'选择模型'}${effortLabel?' · '+effortLabel:''}`}><span>{modelInfo?.displayName||selectedModel||'选择模型'}</span>{effortLabel&&<small>{effortLabel}</small>}<Icon name="chevron" size={13}/></button>
            <div className="composer-actions">{view?.activeTurnId&&!newChat&&<IconButton icon="stop" label="停止当前任务" className="black round stop" disabled={!canWrite} onClick={()=>void mutate('turn.stop',target())}/>}{draft.trim()||images.length?<button className="black round send" aria-label={view?.activeTurnId?'补充当前任务':'发送消息'} disabled={!canWrite}><Icon name="send" size={21}/></button>:!view?.activeTurnId&&<IconButton icon="mic" label="使用系统键盘听写" onClick={()=>{composer.current?.focus();setNotice('请使用系统键盘上的麦克风听写。');}}/>}</div>
          </div>
         </form>
         <input className="hidden" ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e=>{void attach(Array.from(e.target.files||[]));e.target.value='';}}/>
      </div>
    </>}</main>

     {threadMenu&&threadMenu.machine===machine&&<ThreadMenu key={`${machine}:${threadMenu.thread.id}`} thread={threadMenu.thread} point={threadMenu.point} preference={preferences[threadMenu.thread.id]||{}} sections={[...new Set(Object.values(preferences).map(p=>p.section).filter((s):s is string=>Boolean(s)))]} archived={threadMenu.archived} compact={threadMenu.compact} connected={connected} close={()=>setThreadMenu(current=>current===threadMenu?null:current)} change={patch=>changePreference(threadMenu.thread.id,patch,threadMenu.thread)} copy={()=>copyId(threadMenu.thread.id)} rename={name=>changeThread('session.rename',threadMenu.thread,{name})} archive={()=>changeThread(threadMenu.archived?'session.unarchive':'session.archive',threadMenu.thread)} openPreview={threadMenu.compact?()=>setSheet('browser'):undefined}/>}
     {statusPanel&&statusPanel.machine===machine&&statusPanel.thread===selected&&<ThreadStatusPanel key={`${machine}:${selected}`} point={statusPanel.point} view={view} threadId={selected} cwd={view?.cwd||project} connected={connected} close={()=>setStatusPanel(current=>current===statusPanel?null:current)} copy={()=>copyId(selected)} read={()=>call('session.status',{threadId:selected})}/>}
     {sheet&&<SheetPanel title={({home:'选项',computer:'电脑',projects:'选择项目',model:'模型与思考程度',approval:'许可',add:'添加与选项',file:'查看项目文件',browser:'打开本机网页'} as const)[sheet]} close={()=>{if(sheet==='browser'){browserSequence.current++;setBrowserRequest(null);}setSheet(null);}}>
       {sheet==='home'&&<><MenuItem icon="compose" disabled={!connected||busy} onClick={startNew}>新聊天</MenuItem><MenuItem icon="computer" onClick={()=>setSheet('computer')}>切换电脑</MenuItem><MenuItem icon="refresh" disabled={!connected||listBusy} onClick={()=>{setSheet(null);refreshInfo();void list(false,true);}}>刷新项目与会话</MenuItem><MenuItem icon="chat" disabled={!connected||busy} onClick={()=>{setArchived(!archived);setSheet(null);}}>{archived?'查看最近会话':'查看归档会话'}</MenuItem><MenuItem icon="logout" disabled={busy} onClick={logout}>断开连接</MenuItem></>}
      {sheet==='computer'&&<><div className="connection-status"><i className={connected?'dot online':'dot'}/>{connected?'已连接':status==='online'?'等待电脑上线':'正在连接中继…'}</div>{machines.map(m=><MenuItem icon="computer" key={m.id} disabled={busy} onClick={()=>changeMachine(m.id)}>{m.name}{m.id===machine&&<Icon name="check" size={18}/>}</MenuItem>)}{!machines.length&&<p className="muted">请在电脑启动连接器。</p>}<p className="muted">{location.origin}</p></>}
       {sheet==='projects'&&<><div className="project-choices">{projects.map(p=><MenuItem icon="folder" key={p} disabled={busy} onClick={()=>{setNewCwd(p);setModel('');setEffort('');setApproval('');setSheet(null);}}><span>{projectName(p)}<small>{p}</small></span>{p===newCwd&&<Icon name="check" size={18}/>}</MenuItem>)}</div><details className="other-project"><summary>其他项目目录</summary><form onSubmit={e=>{e.preventDefault();setSheet(null);}}><label>电脑上的完整项目路径<input value={newCwd} onChange={e=>setNewCwd(e.target.value)} required/></label><button className="primary">使用这个目录</button></form></details></>}
       {sheet==='model'&&<>
         <p className="muted">{view?.activeTurnId?'当前任务沿用正在使用的设置，结束后可以更换。':'下次发送时使用所选模型与思考程度。'}</p>
         <label>模型<select disabled={Boolean(view?.activeTurnId)||busy||!availableModels.length} value={model} onChange={e=>{setModel(e.target.value);setEffort('');}}>
           <option value="">沿用当前设置{selectedModel?` · ${view?.model||info?.model}`:''}</option>
           {availableModels.map((m:Json)=><option key={m.id||m.model} value={m.model}>{m.displayName||m.model}</option>)}
           {customModel&&<option value={model}>{model}</option>}
         </select></label>
         <details className="other-project"><summary>输入其他模型 ID</summary><label>同一提供商的模型 ID<input disabled={Boolean(view?.activeTurnId)||busy} value={model} onChange={e=>{setModel(e.target.value);setEffort('');}} placeholder="例如自定义模型 ID"/></label></details>
         <label>思考程度<select disabled={Boolean(view?.activeTurnId)||busy||!modelInfo} value={effort} onChange={e=>setEffort(e.target.value)}><option value="">沿用当前设置</option>{modelInfo?.supportedReasoningEfforts?.map((r:Json)=><option key={r.reasoningEffort} value={r.reasoningEffort}>{({none:'关闭',minimal:'最少',low:'较少',medium:'适中',high:'较多',xhigh:'更多',max:'最多'} as Json)[r.reasoningEffort]||r.reasoningEffort}</option>)}</select></label>
         <button className="primary" onClick={()=>setSheet(null)}>完成</button>
       </>}
       {sheet==='approval'&&<><p className="muted">{view?.activeTurnId?'当前任务沿用正在使用的许可，结束后可以更换。':'下次发送时使用所选许可。'}</p><label>审批策略<select disabled={Boolean(view?.activeTurnId)||busy} value={approval} onChange={e=>setApproval(e.target.value)}><option value="">沿用当前设置 · {approvalLabel}</option><option value="on-request">按需审批</option><option value="never">不提示审批</option></select></label><button className="primary" onClick={()=>setSheet(null)}>完成</button></>}
       {sheet==='add'&&<>{selected&&<MenuItem icon="browser" disabled={!connected} onClick={()=>setSheet('browser')}>打开本机网页</MenuItem>}<MenuItem icon="image" disabled={busy||imageLoading||!canImage||images.length>=MAX_IMAGES} onClick={()=>fileInput.current?.click()}>添加图片<span className="menu-detail">{images.length}/{MAX_IMAGES}</span></MenuItem>{!canImage&&<p className="muted">当前模型未确认图片能力。</p>}{error&&<p className="error" role="alert">{error}</p>}{selected&&<><MenuItem icon="file" onClick={()=>setSheet('file')}>查看项目文件</MenuItem><MenuItem icon="refresh" disabled={!connected} onClick={()=>{setSheet(null);void refreshSession();}}>刷新会话</MenuItem></>}{newChat&&<MenuItem icon="folder" disabled={busy} onClick={()=>setSheet('projects')}>选择项目</MenuItem>}</>}
       {sheet==='file'&&<form onSubmit={e=>{e.preventDefault();void openFile(filePath);}}><label>文件路径<input autoFocus required value={filePath} onChange={e=>setFilePath(e.target.value)} placeholder="例如 README.md 或 docs/deck.pptx"/></label>{error&&<p className="error" role="alert">{error}</p>}<button className="primary">打开文件</button></form>}
       {sheet==='browser'&&selected&&<form onSubmit={e=>{e.preventDefault();void openBrowser();}}><label>电脑上的网页地址<input autoFocus required type="url" value={browserUrl} onChange={e=>{setBrowserUrl(e.target.value);save(previewUrlKey(machine,selected),e.target.value);}} placeholder="http://127.0.0.1:5173"/></label><p className="muted">地址仅用于当前聊天。先在电脑启动网页服务，再打开预览。</p>{error&&<p className="error" role="alert">{error}</p>}<button className="primary" disabled={browserBusy||!connected}>{browserBusy?'正在打开…':'打开预览'}</button></form>}
     </SheetPanel>}
     {preview&&<PreviewPane title={previewTitle(preview)} subtitle={preview.kind==='file'?preview.file?.path||preview.path:preview.kind==='web'?preview.session.url:undefined}
       tabs={previewState.tabs.map(tab=>({id:tab.id,title:previewTitle(tab.target)}))} activeTab={previewState.activeId}
       selectTab={id=>setPreviewState(old=>({...old,activeId:id}))} closeTab={closePreviewTab}
       compact={compactPreview} covered={Boolean(sheet||threadMenu||statusPanel)} close={closePreview}>
       {previewState.tabs.map(({id,target})=><div key={id} id={`preview-panel-${id}`} aria-labelledby={`preview-tab-${id}`} className="preview-tab-panel" role="tabpanel" hidden={id!==previewState.activeId}>
         {target.kind==='file'&&(target.file?<Suspense fallback={<p className="preview-notice" role="status">正在加载查看器…</p>}><FilePreviewPanel key={target.request} file={target.file} connected={connected} line={target.line} openFile={path=>void openFile(path,target.machineId,target.threadId)}
           readFile={path=>call('file.read',{threadId:target.threadId,path},target.machineId)}
           read={offset=>call('file.download',{threadId:target.threadId,path:target.file!.path,revision:target.file!.revision,offset},target.machineId)}/></Suspense>:<div className="preview-empty" role={target.error?'alert':'status'}><p>{target.error||'正在读取文件…'}</p>{target.error&&<button disabled={!connected} onClick={()=>void openFile(target.path+(target.line?`:${target.line}`:''),target.machineId,target.threadId)}>重试</button>}</div>)}
         {target.kind==='diff'&&<Suspense fallback={<p className="preview-notice">正在加载差异…</p>}><DiffViewer text={target.text} compact={compactPreview}/></Suspense>}
         {target.kind==='web'&&<WebViewer session={target.session} onEnd={closeBrowser}/>}
         {target.kind==='image'&&<div className="image-viewer"><img className="preview-image" src={target.url} alt={target.title}/></div>}
       </div>)}
     </PreviewPane>}
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
