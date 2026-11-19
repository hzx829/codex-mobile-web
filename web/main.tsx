import {lazy,Suspense,startTransition,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type ClipboardEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {Client,operationId} from './client';
import {AntigravityPanel} from './antigravity';
import {AntigravitySidebar} from './antigravity-sidebar';
import {CoworkOpenAction,CoworkPanel} from './cowork';
import {ChatSearch,HomeHeader,SendMessageButton,ThreadHeader,submitOnDesktop,useComposerHeight} from './chat-layout';
import {ServiceSwitch, switchRoute} from './service-switch';
import {fileOwner,previewOwner as previewOwnerOf,routeConversation,serviceHome,serviceLabel,serviceOf,withConversation,type Service} from './services';
import {Icon,type IconName} from './icons';
import {IconButton} from './icon-button';
import {connectionLost,ConversationStatus,ConversationTurn,PendingMessage} from './conversation';
import {RequestCard} from './content';
import {createFirstTurn} from './new-chat';
import {SessionListLoader} from './session-list-loader';
import {HISTORY_PAGE_SIZE,refreshHistory,prependHistory} from './thread-history';
import {knownSnapshot,restoreSnapshot} from './session-snapshot';
import {applyLiveFrames,keepLiveText,type LiveFrame} from './live';
import {OPTIMISTIC_ACCEPTED_MS,optimisticDelivered,optimisticMessage,type OptimisticMessage} from './optimistic';
import {cachedList,cachedProjects,cachedView,clearCache,flushCache,loadCache,rememberList,rememberProjects,rememberView,type CachedView} from './session-cache';
import {BrowserPreviewPanel,WebViewer,type PreviewSession} from './browser-preview';
import {belongsToThread,defaultPreviewUrl,openThreadPreview,previewUrlKey} from './thread-preview';
import {PreviewPane,useCompactPreview} from './preview-pane';
import {fileReference,samePreviewTarget,type PreviewTarget} from './preview-target';
import {home,initialLocation,rememberLocation,parseLocation,type Route} from './route-state';
import {pastedImage,readAttachmentFiles,clipboardFiles,imageFile,isImageFile,type DraftFileAttachment} from './attachments';
import {MAX_IMAGES,MAX_TOTAL_IMAGE_BYTES,imageBytes} from '../src/shared/images';
import {MAX_ATTACHMENTS,validateAttachments} from '../src/shared/attachments';
import {uploadAttachments,type UploadProgress} from './file-upload';
import {DraftSave} from './draft-save';
import {relativeTime,ThreadMenu,ThreadRow} from './thread-menu';
import type {MenuPoint} from './popover';
import {ContextIndicator,ThreadStatusPanel,contextSummary} from './thread-status';
import {groupThreads,visibleThreads,rememberThreads,saveThread,type ThreadPreferences,type ThreadPreference} from './thread-preferences';
import {type Json,type SessionView,type RequestAction,type TurnView} from '../src/shared/types';
import {submitTurn,editTurn} from './turn-request';
import {modelDisplayName,reasoningLabel,resolveModelSelection} from '../src/shared/models';
import {ModelPicker} from './model-picker';
import {voiceProvider} from '../src/shared/voice';
import {useVoiceInput} from './use-voice-input';
import {useStableEvent} from './use-event';
import './style.css';
import 'react-diff-view/style/index.css';
import './preview.css';

const FilePreviewPanel=lazy(()=>import('./file-preview').then(module=>({default:module.FilePreviewPanel})));
const DiffViewer=lazy(()=>import('./diff-viewer').then(module=>({default:module.DiffViewer})));

const load=(key:string,fallback:any)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}};
const save=(key:string,value:any)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const name=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;
const previewTitle=(target:PreviewTarget)=>target.kind==='file'?target.file?.name||name(target.path):target.kind==='diff'?'本轮修改':target.kind==='image'?target.title:'网页预览';
function initialToken(){const params=new URLSearchParams(location.hash.slice(1));const token=params.get('token');if(token){save('connection',token);history.replaceState(history.state,'',location.pathname+location.search);}return token||load('connection','');}
const savedLocation=initialLocation();
const listKey=(machine:string,project:string,archived:boolean)=>`${machine}:${project}:${archived?'archived':'recent'}`;
type PreviewTab={id:number;target:PreviewTarget};
type Sheet='home'|'computer'|'projects'|'approval'|'add'|'file'|'browser'|'voice'|null;

function App(){
  const [token,setToken]=useState(initialToken),[tokenInput,setTokenInput]=useState('');
  const [status,setStatus]=useState('connecting'),[machines,setMachines]=useState<Json[]>([]),[machine,setMachine]=useState(savedLocation.machine);
  const [route,setRoute]=useState<Route>(savedLocation.route),[sheet,setSheet]=useState<Sheet>(null);
  const [remoteListRevision,refreshRemoteList]=useState(0);
  const service=serviceOf(route),codexActive=service==='codex';
  const lastCodex=useRef({machine,route:home});
  if(codexActive)lastCodex.current={machine,route};
  const codexRoute=codexActive?route:lastCodex.current.machine===machine?lastCodex.current.route:home;
  const {thread:selected,project,newChat}=codexRoute,showThread=Boolean(selected||newChat);
  const remoteConversation=routeConversation(route),previewThread=previewOwnerOf(route,selected);
  const previewOwner=useRef({machine,thread:previewThread});previewOwner.current={machine,thread:previewThread};
  const threadMounted=codexActive&&showThread&&Boolean(token)&&status!=='auth_error';
  const [info,setInfo]=useState<Json|null>(null),[projects,setProjects]=useState<string[]>([]),[sessions,setSessions]=useState<Json[]>([]);
  const [cursor,setCursor]=useState<string|null>(null),[search,setSearch]=useState(''),[searchQuery,setSearchQuery]=useState(''),[listBusy,setListBusy]=useState(false),[archived,setArchived]=useState(false);
  const [view,setView]=useState<SessionView|null>(null),[loading,setLoading]=useState(false),[loadingOlder,setLoadingOlder]=useState(false),[historyError,setHistoryError]=useState('');
  const viewRef=useRef(view);useLayoutEffect(()=>{viewRef.current=view;},[view]);
  const [draft,setDraft]=useState(''),[images,setImages]=useState<string[]>([]),[model,setModel]=useState(''),[effort,setEffort]=useState(''),[approval,setApproval]=useState(''),[newCwd,setNewCwd]=useState('');
  const [files,setFiles]=useState<DraftFileAttachment[]>([]),filesRef=useRef(files);filesRef.current=files;
  const [optimistic,setOptimistic]=useState<OptimisticMessage|null>(null),optimisticRef=useRef(optimistic);optimisticRef.current=optimistic;
  const everOnline=useRef(false);if(status==='online')everOnline.current=true;
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null);
  const documentInput=useRef<HTMLInputElement>(null);
  const draftSave=useRef(new DraftSave(save));
  const [serviceTier,setServiceTier]=useState<string|null|undefined>(undefined);
  const [voiceMode,setVoiceMode]=useState(()=>voiceProvider(load('voice-provider','codex')));
  const [imageLoading,setImageLoading]=useState(false),imageLoad=useRef<number|null>(null),imageSequence=useRef(0),imagesRef=useRef(images);imagesRef.current=images;
  const [threadMenu,setThreadMenu]=useState<{thread:Json;point:MenuPoint;machine:string;archived:boolean;compact?:boolean}|null>(null);
  const [modelPoint,setModelPoint]=useState<MenuPoint|null>(null),modelButton=useRef<HTMLButtonElement>(null);
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
  const browserBusy=browserRequest!==null,browserSession=!browserState?.filePath&&belongsToThread(browserState,machine,previewThread)?browserState:null;
  const client=useRef<Client|null>(null),current=useRef({machine,selected,project,newChat,searchQuery,archived,service}),sequence=useRef(0),listLoader=useRef(new SessionListLoader()),infoSequence=useRef(0);
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),refreshing=useRef(false),again=useRef(false),sticky=useRef(true),timeline=useRef<HTMLDivElement>(null),timelineContent=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),fileInput=useRef<HTMLInputElement>(null),submitting=useRef(false);
  const scrollAnchor=useRef<{element:HTMLElement;top:number}|null>(null),lastScrollTop=useRef(0),olderRequest=useRef<object|null>(null);
  const liveFrames=useRef<LiveFrame[]>([]),liveFrame=useRef(0);
  current.current={machine,selected,project,newChat,searchQuery,archived,service};
  const connected=status==='online'&&machines.some(m=>m.id===machine),machineName=machines.find(m=>m.id===machine)?.name||'电脑';
  const scope=`${machine}:${selected}`,draftKey=`draft:${scope}`,pendingKey=`operation:${scope}`;
  const call=(action:RequestAction,payload:Json={},target=machine)=>client.current!.request(action,payload,target);
  const stillHere=()=>current.current.service==='codex'&&current.current.machine===machine&&current.current.selected===selected;
  function closePreview(){browserSequence.current++;if(browserState?.filePath)closeBrowser();setPreviewState({tabs:[],activeId:null});}
  const leavePreview=useStableEvent(()=>{if(browserState)closeBrowser();});
  useLayoutEffect(()=>{
    setPreviewState({tabs:[],activeId:null});setBrowserRequest(null);setBrowserSession(null);setError('');
    return ()=>{browserSequence.current++;fileSequence.current++;leavePreview();};
  },[machine,service,remoteConversation]);
  function showPreview(next:PreviewTarget){
    const id=++previewIds.current;
    setPreviewState(old=>{const tabs=next.kind==='web'?old.tabs.filter(tab=>tab.target.kind!=='web'||tab.target.session.sessionId===next.session.sessionId):old.tabs;
      const existing=tabs.find(tab=>samePreviewTarget(tab.target,next));return existing
      ?{tabs:tabs.map(tab=>tab.id===existing.id?{...tab,target:next}:tab),activeId:existing.id}
      :{tabs:[...tabs,{id,target:next}],activeId:id};});
    setSheet(null);
  }
  function closePreviewTab(id:number){browserSequence.current++;const target=previewState.tabs.find(tab=>tab.id===id)?.target;if(target?.kind==='file'&&target.file?.path&&target.file.path===browserState?.filePath)closeBrowser();setPreviewState(old=>{const index=old.tabs.findIndex(tab=>tab.id===id);if(index<0)return old;const tabs=old.tabs.filter(tab=>tab.id!==id);return {tabs,activeId:old.activeId===id?tabs[Math.min(index,tabs.length-1)]?.id??null:old.activeId};});}
  function fail(e:any){setError(e?.message||'操作失败，请重试');}
  function navigate(next:Route,replace=false){
    history[replace?'replaceState':'pushState']({cmwRoute:next,cmwMachine:machine},'',location.pathname);
    rememberLocation(next,machine);setSheet(null);setThreadMenu(null);setStatusPanel(null);setModelPoint(null);setRoute(next);
  }
  function backToProjects(){navigate(home);}
  function backToSessions(){navigate({...home,project});}
  useEffect(()=>{
    const pop=(e:PopStateEvent)=>{setSheet(null);setThreadMenu(null);setStatusPanel(null);setModelPoint(null);const location=parseLocation(e.state);const next=location?.machine===current.current.machine?location.route:home;rememberLocation(next,current.current.machine);setRoute(next);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=>{history.replaceState({cmwRoute:route,cmwMachine:machine},'',location.pathname);rememberLocation(route,machine);},[machine]);
  async function refreshSession(){
    if(refreshing.current){again.current=true;return;}
    const c={...current.current};if(c.service!=='codex'||!c.machine||!c.selected||!client.current?.ready)return;
    const seq=sequence.current,previous=viewRef.current;refreshing.current=true;
    try{const snapshot=await call('session.read',{threadId:c.selected,limit:HISTORY_PAGE_SIZE,known:previous?.id===c.selected?knownSnapshot(previous):undefined,watch:true},c.machine);if(seq===sequence.current&&c.machine===current.current.machine&&c.selected===current.current.selected){const next=restoreSnapshot(previous,snapshot);startTransition(()=>{setView(old=>refreshHistory(old,keepLiveText(old,next)));setLoading(false);});}}
    catch(e){if(seq===sequence.current){fail(e);setLoading(false);}}
    finally{refreshing.current=false;if(again.current){again.current=false;void refreshSession();}}
  }
  async function loadOlder(){
    const cursor=view?.nextCursor;if(!connected||loading||olderRequest.current||!view?.hasMore||!cursor)return;
    const c={...current.current},seq=sequence.current,request={};olderRequest.current=request;
    setLoadingOlder(true);setHistoryError('');sticky.current=false;
    const here=()=>seq===sequence.current&&c.machine===current.current.machine&&c.selected===current.current.selected;
    try{
      const page=await call('session.read',{threadId:c.selected,limit:HISTORY_PAGE_SIZE,cursor},c.machine);
      if(!here())return;
      const element=timeline.current?.querySelector<HTMLElement>('.turn');
      if(element)scrollAnchor.current={element,top:element.getBoundingClientRect().top};
      setView(old=>prependHistory(old,page,cursor));
    }catch(e:any){if(here())setHistoryError(e?.message||'加载失败，请重试');}
    finally{if(olderRequest.current===request){olderRequest.current=null;setLoadingOlder(false);}}
  }
  // Change notices arrive already batched by the connector; only merge ones that land together.
  function scheduleRefresh(){if(refreshTimer.current||document.visibilityState!=='visible')return;refreshTimer.current=setTimeout(()=>{refreshTimer.current=undefined;void refreshSession();},16);}
  function receiveLive(frame:LiveFrame){
    // Hidden pages do not paint; the foreground refresh brings them up to date.
    if(document.visibilityState!=='visible'){liveFrames.current=[];return;}
    liveFrames.current.push(frame);if(liveFrame.current)return;
    liveFrame.current=requestAnimationFrame(()=>{
      liveFrame.current=0;const frames=liveFrames.current;liveFrames.current=[];
      setView(old=>{const result=applyLiveFrames(old,frames);if(result.resync)scheduleRefresh();return result.view;});
    });
  }
  async function list(append=false,refresh=false){
    const c={...current.current};
    const key=(value:typeof c)=>JSON.stringify([value.service,value.machine,value.project,value.searchQuery,value.archived]);
    const here=()=>key(c)===key(current.current);
    await listLoader.current.load(key(c),()=>call('sessions.list',{cwd:c.project||undefined,search:c.searchQuery||undefined,archived:c.archived,cursor:append?cursor:undefined,refresh},c.machine),{
      start:()=>setListBusy(true),
      result:r=>{
        if(!here())return;
        setSessions(old=>append?[...old,...r.data.filter((n:Json)=>!old.some(s=>s.id===n.id))]:r.data);setCursor(r.nextCursor);
        if(!append&&!c.searchQuery)rememberList(listKey(c.machine,c.project,c.archived),r.data);
        setPreferences(old=>{if(old.machine!==c.machine)return old;const values=rememberThreads(old.values,r.data,c.archived);if(values===old.values)return old;save(`thread-preferences:${c.machine}`,values);return {...old,values};});
        setProjects(old=>[...new Set<string>([...old,...r.data.map((s:Json)=>s.cwd).filter(Boolean)])]);
      },
      error:e=>{if(here())fail(e);},
      finish:()=>setListBusy(false),
    });
  }
  const effectiveCwd=newChat?newCwd:view?.cwd||project;
  const voice=useVoiceInput(voiceMode,JSON.stringify([machine,selected,newChat,newChat?newCwd:'']),connected,{
    keyboard:()=>{composer.current?.focus();setNotice('请使用系统键盘上的麦克风听写。');},
    transcribe:recording=>call('voice.transcribe',recording),
    text:text=>{editDraft(draft.trim()?`${draft.trimEnd()}\n${text}`:text);setNotice('已填入输入框，确认后发送。');},
    error:fail,
  });
  const voiceBusy=voice.state!=='idle',voiceLabel=voiceMode==='codex'?'Codex 识别':'系统键盘';
  function refreshInfo(){
    const seq=++infoSequence.current;if(!connected||!codexActive)return;
    call('info',{cwd:effectiveCwd||undefined}).then(r=>{if(seq!==infoSequence.current)return;setInfo(r);setProjects(old=>[...new Set<string>([...r.roots,...old])]);setNewCwd(old=>old||r.roots[0]||'');}).catch(e=>{if(seq===infoSequence.current)fail(e);});
  }
  useEffect(refreshInfo,[connected,machine,effectiveCwd,codexActive]);
  useEffect(()=>{const timer=setTimeout(()=>setSearchQuery(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{if(searchQuery)return;const cached=cachedList(listKey(machine,project,archived));if(cached)setSessions(cached);},[machine,project,searchQuery,archived]);
  useEffect(()=>{if(connected&&codexActive)void list();},[connected,machine,project,searchQuery,archived,codexActive]);
  useEffect(()=>{if(machine)setProjects(old=>old.length?old:cachedProjects(machine));},[machine]);
  useEffect(()=>{if(projects.length)rememberProjects(machine,projects);},[projects]);
  useEffect(()=>{
    if(!token)return;
    const c=new Client(token,m=>{
      if(m.type==='ready'||m.type==='machines')setMachines(m.machines||m.data||[]);
      if(m.type==='changed'&&m.machineId===current.current.machine&&(!m.threadId||m.threadId===current.current.selected))scheduleRefresh();
      if(m.type==='live'&&current.current.service==='codex'&&m.machineId===current.current.machine&&m.threadId===current.current.selected)receiveLive(m as LiveFrame);
    },setStatus);client.current=c;
    return()=>{c.close();clearTimeout(refreshTimer.current);cancelAnimationFrame(liveFrame.current);liveFrame.current=0;liveFrames.current=[];};
  },[token]);
  useEffect(()=>client.current?.onPreview(message=>{
    if(message.type==='preview.disconnected'||message.type==='preview.ended'&&message.sessionId===browserState?.sessionId){setBrowserSession(null);setPreviewState(old=>{const tabs=old.tabs.filter(tab=>tab.target.kind!=='web');return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});}
  }),[token,browserState?.sessionId]);
  useEffect(()=>{if(!machine&&machines[0])setMachine(machines[0].id);},[machines,machine]);
  useEffect(()=>{client.current?.watch(codexActive&&machine&&selected?{machineId:machine,threadId:selected}:null);},[token,machine,selected,codexActive]);
  useEffect(()=>{setPreferences({machine,values:load(`thread-preferences:${machine}`,{})});setThreadMenu(null);},[machine]);
  useEffect(()=>{
    draftSave.current.flush();
    setStatusPanel(null);setModelPoint(null);
    imageSequence.current++;imageLoad.current=null;setImageLoading(false);
    setFiles([]);setUploadProgress(null);
    setBrowserRequest(null);setBrowserUrl(load(previewUrlKey(machine,selected),defaultPreviewUrl));
    // Show the last known content at once; it stays marked as cached until the read below lands.
    const cached=selected?cachedView(`${machine}:${selected}`):null;
    sequence.current++;setView(cached);setLoading(Boolean(selected)&&!cached);olderRequest.current=null;setLoadingOlder(false);setHistoryError('');setImages([]);setModel('');setEffort('');setApproval('');setError('');setNotice('');sticky.current=true;scrollAnchor.current=null;lastScrollTop.current=0;
    setServiceTier(undefined);
    // A message that is still being sent keeps its place when a new chat turns into its thread.
    const sending=optimisticRef.current?.key===scope;setOptimistic(old=>old?.key===scope?old:null);
    setDraft(sending?'':load(draftKey,''));setPending(load(pendingKey,null));void refreshSession();
  },[machine,selected,newChat]);
  useEffect(()=>{if(view&&view.id===selected&&!(view as CachedView).cached)rememberView(`${machine}:${selected}`,view);},[view]);
  useEffect(()=>{
    if(!optimistic?.acceptedAt)return;
    if(optimistic.key===scope&&optimisticDelivered(optimistic,view)){setOptimistic(null);return;}
    const timer=setTimeout(()=>setOptimistic(old=>old===optimistic?null:old),Math.max(0,optimistic.acceptedAt+OPTIMISTIC_ACCEPTED_MS-Date.now()));
    return()=>clearTimeout(timer);
  },[optimistic,view,scope]);
  useEffect(()=>{
    const flush=()=>{draftSave.current.flush();void flushCache();},hidden=()=>{if(document.visibilityState==='hidden')flush();};
    window.addEventListener('pagehide',flush);document.addEventListener('visibilitychange',hidden);
    return()=>{flush();window.removeEventListener('pagehide',flush);document.removeEventListener('visibilitychange',hidden);};
  },[]);
  useEffect(()=>{void refreshSession();},[connected,codexActive]);
  useEffect(()=>{
    const viewport=window.visualViewport;if(!viewport)return;
    // Keyboard animations fire these events continuously. Write once per frame, and only
    // when a value changed, so the whole page is not laid out again for nothing.
    let frame=0,height='',top='';
    const apply=()=>{
      frame=0;if(viewport.scale!==1)return;
      const nextHeight=`${viewport.height}px`,nextTop=`${viewport.offsetTop}px`,style=document.documentElement.style;
      if(nextHeight!==height){height=nextHeight;style.setProperty('--viewport-height',nextHeight);}
      if(nextTop!==top){top=nextTop;style.setProperty('--viewport-top',nextTop);}
    };
    const resize=()=>{if(!frame)frame=requestAnimationFrame(apply);};
    apply();viewport.addEventListener('resize',resize);viewport.addEventListener('scroll',resize);
    return()=>{cancelAnimationFrame(frame);viewport.removeEventListener('resize',resize);viewport.removeEventListener('scroll',resize);};
  },[]);
  useLayoutEffect(()=>{const el=timeline.current;if(!el)return;const anchor=scrollAnchor.current;scrollAnchor.current=null;if(anchor?.element.isConnected)el.scrollTop+=anchor.element.getBoundingClientRect().top-anchor.top;else if(sticky.current)el.scrollTop=el.scrollHeight;lastScrollTop.current=el.scrollTop;},[view?.turns,loadingOlder]);
  useEffect(()=>{
    const el=timeline.current,content=timelineContent.current;if(!el||!content)return;
    let frame=0;
    const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(sticky.current&&!scrollAnchor.current){el.scrollTop=el.scrollHeight;lastScrollTop.current=el.scrollTop;}});});
    observer.observe(el);observer.observe(content);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[threadMounted]);
  useComposerHeight(composer,draft,threadMounted);
  useEffect(()=>{setPreviewState(old=>{let changed=false;const tabs=old.tabs.flatMap(tab=>{if(tab.target.kind!=='image')return [tab];const index=images.indexOf(tab.target.url);if(index<0){changed=true;return [];}const title=`待发送图片 ${index+1}/${images.length}`;if(title!==tab.target.title){changed=true;return [{...tab,target:{...tab.target,title}}];}return [tab];});if(!changed)return old;return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});},[images]);
  useEffect(()=>{
    if(!connected||!codexActive)return;
    // A safety net for missed notices: the open thread also renews its live watch here.
    let ticks=0;
    const foreground=()=>{if(document.visibilityState!=='visible')return;if(current.current.selected)void refreshSession();else void list();};
    const timer=setInterval(()=>{if(current.current.selected&&++ticks%2)return;foreground();},5000);document.addEventListener('visibilitychange',foreground);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',foreground);};
  },[connected,project,searchQuery,archived,codexActive]);
  useEffect(()=>{if(codexActive&&connected&&pending&&!busy)void checkPending();},[connected,pending?.opId,busy,codexActive]);
  useEffect(()=>{if(!notice||pending)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice,pending]);
  function editDraft(value:string){setDraft(value);draftSave.current.write(draftKey,value);}
  function insertFollowup(prompt:string){if(!draft.trimEnd().endsWith(prompt))editDraft(draft.trim()?`${draft.trimEnd()}\n\n${prompt}`:prompt);setNotice('已填入输入框，确认后发送。');composer.current?.focus();}
  function setOperation(value:Json|null){save(pendingKey,value);if(stillHere())setPending(value);}
  function accepted(record:Json,result:Json){
    draftSave.current.flush();
    if(record.action==='session.fork'&&result.threadId){
      setOperation(null);
      if(stillHere()){
        setSearch('');setSearchQuery('');setArchived(false);
        navigate({...home,project:result.cwd||view?.cwd||project,thread:result.threadId,newChat:false});
      }
      listLoader.current.invalidate();void list(false,true);return;
    }
    if(record.action==='session.create'&&record.submittedText!==undefined&&result.threadId){
      save(`draft:${machine}:${result.threadId}`,record.submittedText);save(draftKey,'');
      setOperation(null);if(stillHere()){setDraft('');navigate({...route,thread:result.threadId,newChat:false},true);setNotice(record.imageCount||record.fileCount?'会话已建立，文字已保留；附件请重新选择后发送。':'会话已建立，输入已保留，请点击发送。');}return;
    }
    if(record.action==='turn.send'&&load(draftKey,'')===record.submittedText){save(draftKey,'');if(stillHere()){setDraft('');setImages([]);setFiles([]);}}
    if(record.action==='turn.send')setOptimistic(old=>old?.key===scope?{...old,state:'sending',acceptedAt:old.acceptedAt||Date.now()}:old);
    if(result.kind==='queue_withdrawn'&&result.message){
      const message=result.message,text=[load(draftKey,''),message.text].filter(Boolean).join('\n\n');
      save(draftKey,text);
      if(stillHere()){
        setDraft(text);setImages(old=>[...old,...(message.images||[])]);setFiles(old=>[...old,...(message.files||[])]);
        setModel(message.model||'');setEffort(message.effort||'');setApproval(message.approvalPolicy||'');setServiceTier(message.serviceTier);
        requestAnimationFrame(()=>composer.current?.focus());
      }
    }
    setOperation(null);if(!stillHere())return;
    if(result.queuedId)setView(old=>old?{...old,queuedMessages:old.queuedMessages?.filter(message=>message.id!==result.queuedId)}:old);
    setNotice(result.kind==='queued'?'已加入队列，当前任务结束后发送':result.kind==='queue_withdrawn'?'已撤回到输入框':result.kind==='queue_cancelled'?'已删除排队消息':result.kind==='steer_accepted'?'已追加到当前任务':result.kind==='stop_requested'?'已请求停止':result.kind==='response_submitted'?'回应已提交':result.kind==='edited'?'已重新发送':'');
    void refreshSession();void list();
  }
  async function checkPending(){
    const record=load(pendingKey,null);if(!record||!connected)return;
    try{const r=await call('operation.read',{opId:record.opId});if(r.state==='accepted')accepted(record,r);else if(r.state==='failed'){setOperation(null);if(stillHere()){setError(r.error?.message||'请求未执行');if(record.action==='turn.send')restoreOptimistic();}}else if(stillHere())setNotice('结果待核实，系统不会自动重发。');}catch{}
  }
  async function mutate(action:RequestAction,payload:Json):Promise<'accepted'|'failed'|'uncertain'|undefined>{
    if(busy||pending)return;
    draftSave.current.flush();
    const record={opId:operationId(),action,submittedText:action==='turn.send'||action==='turn.edit'?payload.text:undefined};
    setBusy(true);setError('');setNotice(action==='turn.send'?'':'正在提交…');setOperation(record);
    try{
      const result=await call(action,{...payload,opId:record.opId});
      if(result.state==='accepted'){accepted(record,result);return 'accepted';}
      else if(result.state==='failed'){setOperation(null);if(stillHere()){setNotice('');setError(result.error?.message||'请求未执行');}return 'failed';}
      else if(stillHere())setNotice('结果待核实，请查看最新任务状态。');
      return 'uncertain';
    }catch(e:any){if(e.uncertain){if(stillHere())setNotice('恢复连接后会查询这次操作的结果。');return 'uncertain';}else{setOperation(null);if(stillHere()){setNotice('');fail(e);}return 'failed';}}
    finally{setBusy(false);}
  }
  const target=()=>({threadId:view!.id,source:view!.source,generation:view!.generation,expectedTurnId:view!.activeTurnId});
  function startNew(){if(!connected||busy)return;setNewCwd(project||view?.cwd||info?.roots?.[0]||'');navigate({...route,thread:'',newChat:true});}
  function restoreOptimistic(){
    setOptimistic(old=>old?.key===scope?null:old);
    // The stored draft keeps the text until the send is accepted.
    setDraft(old=>old.trim()?old:load(draftKey,''));
  }
  function settleOptimistic(message:OptimisticMessage,outcome:'accepted'|'failed'|'uncertain'|undefined){
    if(outcome==='accepted')setOptimistic(old=>old?.at===message.at?{...old,state:'sending',acceptedAt:old.acceptedAt||Date.now()}:old);
    else if(outcome==='uncertain')setOptimistic(old=>old?.at===message.at?{...old,state:'uncertain'}:old);
    else if(optimisticRef.current?.at===message.at&&stillHere())restoreOptimistic();
    else setOptimistic(old=>old?.at===message.at?null:old);
  }
  async function submit(){
    if(submitting.current||!connected||busy||pending||imageLoading||voiceBusy||!draft.trim()&&!images.length&&!files.length)return;
    if(images.length&&!canImage){setError('当前模型未确认图片能力，请更换模型或移除图片');return;}
    try{validateAttachments(images,files);}catch(error){fail(error);return;}
    submitting.current=true;sticky.current=true;
    if(timeline.current){timeline.current.scrollTop=timeline.current.scrollHeight;lastScrollTop.current=timeline.current.scrollTop;}
    try{await sendDraft();}finally{submitting.current=false;}
  }
  async function sendDraft(){
    draftSave.current.flush();
    if(!newChat){
      if(!canWrite)return;
      // Queued messages appear in the queue; everything else appears in the conversation now.
      const message=queueNext?null:optimisticMessage(scope,view,draft,images,files.map(file=>file.name));
      if(message){setOptimistic(message);setDraft('');}
      setBusy(true);setError('');
      let outcome:'accepted'|'failed'|'uncertain'|undefined;
      try{
        const uploaded=await uploadAttachments(call,selected,files,value=>{if(stillHere())setUploadProgress(value);});
        if(stillHere())outcome=await submitTurn(mutate,target(),draft,images,{model,effort,approvalPolicy:approval,serviceTier},queueNext?'queue':'steer',uploaded);
      }catch(error){if(stillHere())fail(error);outcome='failed';}
      finally{setBusy(false);setUploadProgress(null);}
      if(message)settleOptimistic(message,outcome);
      return;
    }
    const createId=operationId(),sendId=operationId(),text=draft,creating={opId:createId,action:'session.create',submittedText:text,imageCount:images.length,fileCount:files.length};
    let createdThread='';
    const message=optimisticMessage(scope,null,text,images,files.map(file=>file.name));
    setOptimistic(message);setDraft('');
    setBusy(true);setError('');setNotice('');setOperation(creating);
    const result=await createFirstTurn((action,payload)=>call(action,payload),{cwd:newCwd,text,images,files,model,effort,approvalPolicy:approval,serviceTier,createId,sendId},id=>{
      createdThread=id;
      save(`draft:${machine}:${id}`,text);save(`operation:${machine}:${id}`,{opId:sendId,action:'turn.send',submittedText:text});
      save(draftKey,'');setOperation(null);
      setOptimistic(old=>old?.at===message.at?{...old,key:`${machine}:${id}`}:old);
      if(stillHere()&&current.current.newChat)navigate({...route,thread:id,newChat:false},true);
    },value=>{if(current.current.machine===machine&&current.current.selected===createdThread)setUploadProgress(value);},opId=>{
      const record={opId,action:'turn.send',submittedText:text};save(`operation:${machine}:${createdThread}`,record);
      if(current.current.machine===machine&&current.current.selected===createdThread)setPending(record);
    });
    const id=result.threadId||'',key=`operation:${machine}:${id}`,here=current.current.machine===machine&&current.current.selected===id;
    if(result.result.state==='accepted'){
      save(key,null);save(`draft:${machine}:${id}`,'');
      if(here){setPending(null);setDraft('');setImages([]);setFiles([]);setNotice('');}
      setOptimistic(old=>old?.at===message.at?{...old,acceptedAt:Date.now()}:old);
    }else if(result.result.state==='failed'){
      save(key,null);if(here){setPending(null);setNotice('');setImages(images);setFiles(files);setDraft(old=>old.trim()?old:text);setError(result.result.error?.message||'发送失败，输入和附件已保留，请重试');}
      setOptimistic(old=>old?.at===message.at?null:old);
    }else{
      if(here)setNotice('结果待核实，系统不会自动重发。');
      setOptimistic(old=>old?.at===message.at?{...old,state:'uncertain'}:old);
    }
    setBusy(false);setUploadProgress(null);void refreshSession();void list();
  }
  function fileRequest(action:'read'|'download',ownerMachine:string,threadId:string,payload:Json){
    const owner=fileOwner(threadId);
    if(owner.service==='antigravity')return call(`antigravity.file.${action}`,{conversationId:owner.id,...payload},ownerMachine);
    if(owner.service!=='codex')return Promise.reject(new Error('这个应用暂不支持读取文件'));
    return call(`file.${action}`,{threadId,...payload},ownerMachine);
  }
  async function openFile(reference:string,ownerMachine=machine,ownerThread=previewThread){
    const {path,line}=fileReference(reference),request=++fileSequence.current;
    const browserGeneration=browserSequence.current;
    const next:PreviewTarget={kind:'file',machineId:ownerMachine,threadId:ownerThread,path,line,request};
    setError('');showPreview(next);
    try{const file=await fileRequest('read',ownerMachine,ownerThread,{path});setPreviewState(old=>({...old,tabs:old.tabs.map(tab=>tab.target.kind==='file'&&samePreviewTarget(tab.target,next)&&tab.target.request===request?{...tab,target:{...next,file}}:tab)}));
      if(/\.html?$/i.test(file.name)&&fileSequence.current===request&&browserSequence.current===browserGeneration)void openBrowser({filePath:file.path},next);
    }
    catch(e){setPreviewState(old=>({...old,tabs:old.tabs.map(tab=>tab.target.kind==='file'&&samePreviewTarget(tab.target,next)&&tab.target.request===request?{...tab,target:{...next,error:(e as Error)?.message||'文件读取失败'}}:tab)}));}
  }
  async function openBrowser(address:string|{filePath:string}=browserUrl,fileTarget?:Extract<PreviewTarget,{kind:'file'}>){
    const thread=fileTarget?.threadId||previewThread,owner=fileTarget?.machineId||machine;
    if(!connected||!thread)return;
    const request=++browserSequence.current;
    if(typeof address==='string'){address=address.trim();setBrowserUrl(address);}
    const here=()=>previewOwner.current.machine===owner&&previewOwner.current.thread===previewThread&&request===browserSequence.current;
    setBrowserRequest(request);setError('');
    try{
      const result=await openThreadPreview(call,owner,thread,address,here);
      if(!result)return;
      if(typeof address==='string'){
        save(previewUrlKey(owner,thread),address);setBrowserSession(result);showPreview({kind:'web',session:result});
      }else setBrowserSession({...result,filePath:address.filePath});
    }catch(e){if(here()){
      if(fileTarget)setPreviewState(old=>({...old,tabs:old.tabs.map(tab=>tab.target.kind==='file'&&samePreviewTarget(tab.target,fileTarget)?{...tab,target:{...tab.target,error:(e as Error).message}}:tab)}));
      else fail(e);
    }}finally{setBrowserRequest(old=>old===request?null:old);}
  }
  function closeBrowser(){const session=browserState;browserSequence.current++;setBrowserSession(null);setPreviewState(old=>{const tabs=old.tabs.filter(tab=>tab.target.kind!=='web');return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});if(session)void call('preview.stop',{sessionId:session.sessionId,threadId:session.threadId},session.machineId).catch(()=>{});}
  async function attach(files:File[],data?:string){
    if(busy||!files.length&&!data)return;
    const selection=data?[imageFile(data)]:files;
    if(selection.some(isImageFile)&&!canImage){setError('当前模型未确认图片能力');return;}
    if(imageLoad.current!==null){setError('附件正在读取，请稍候');return;}
    const request=++imageSequence.current;imageLoad.current=request;setImageLoading(true);setError('');
    try{
      const next=await readAttachmentFiles(selection,imagesRef.current,filesRef.current,()=>request!==imageSequence.current);
      if(!next||request!==imageSequence.current||!stillHere()||current.current.newChat!==newChat)return;
      imagesRef.current=next.images;filesRef.current=next.files;setImages(next.images);setFiles(next.files);setSheet(null);
    }catch(e){if(request===imageSequence.current&&stillHere())fail(e);}
    finally{if(imageLoad.current===request){imageLoad.current=null;setImageLoading(false);}}
  }
  function paste(e:ClipboardEvent<HTMLTextAreaElement>){
    const files=clipboardFiles(e.clipboardData);
    if(files.length){e.preventDefault();void attach(files);return;}
    try{const data=pastedImage(e.clipboardData.getData('text/plain'));if(data){e.preventDefault();void attach([],data);}}
    catch(error){e.preventDefault();fail(error);}
  }
  function changeMachine(id:string){setSheet(null);if(id===machine)return;closeBrowser();closePreview();infoSequence.current++;listLoader.current.invalidate();setListBusy(false);setInfo(null);setProjects([]);setSessions([]);setSearch('');setSearchQuery('');setArchived(false);setNewCwd('');const next=id?serviceHome(service):home;history.replaceState({cmwRoute:next,cmwMachine:id},'',location.pathname);rememberLocation(next,id);setMachine(id);setRoute(next);}
  function logout(){client.current?.close();save('connection','');setToken('');setView(null);setInfo(null);setMachines([]);setOptimistic(null);void clearCache();changeMachine('');}
  async function copyText(text:string){
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
      else {
        const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();
        try{if(!document.execCommand('copy'))throw Error('copy failed');}finally{input.remove();}
      }
  }
  const markdownOpenFile=useStableEvent(openFile),markdownOpenPreview=useStableEvent((url:string)=>void openBrowser(url)),markdownFollowup=useStableEvent(insertFollowup);
  const latestUserTurn=useMemo(()=>view?.turns.filter(turn=>turn.items.some(item=>item.role==='user')).at(-1)?.id,[view?.turns]);
  function fork(turn:TurnView){
    if(turn.status==='inProgress'){setNotice('请等这一轮结束后再分叉');return;}
    if(!turn.canFork){setNotice('此轮状态尚未同步，请刷新后重试');return;}
    void mutate('session.fork',{threadId:selected,lastTurnId:turn.id});
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
  const queueNext=!newChat&&Boolean(view?.running||view?.queuedMessages?.length);
  const availableModels=(info?.models||[]).filter((m:Json)=>(view?.provider||info?.provider)==='openai'||m.model===(view?.model||info?.model));
  const currentModel={model:view?.model||info?.model,effort:view?.effort||(newChat?info?.effort:''),serviceTier:view?.serviceTier!==undefined?view.serviceTier:info?.serviceTier};
  const selection=resolveModelSelection(availableModels,{model,effort,serviceTier},currentModel);
  const modelInfo=selection.model,canImage=modelInfo?.inputModalities?.includes('image'),isFast=selection.isFast;
  const modelLabel=modelDisplayName(modelInfo,selection.id)||'选择模型';
  const inheritedApproval=newChat?info?.approvalPolicy:view?.approvalPolicy;
  const approvalLabel=inheritedApproval==='never'?'不提示':inheritedApproval==='on-request'?'按需审批':'电脑配置';
  // A cached view is only shown; its turn and generation may be outdated.
  const cachedShown=Boolean((view as CachedView|null)?.cached);
  const canWrite=connected&&!busy&&!pending&&!imageLoading&&!voiceBusy&&(newChat?Boolean(newCwd):!cachedShown&&Boolean(view?.canControl||queueNext&&view&&view.source!=='history'));
  const canOperate=connected&&!busy&&!pending&&!cachedShown&&Boolean(view?.canControl);
  // Hidden in the same render that shows the delivered message, so the two never appear together.
  const pendingShown=optimistic&&optimistic.key===scope&&!optimisticDelivered(optimistic,view)?optimistic:null;
  const attachmentCount=images.length+files.length,selectedImageBytes=images.reduce((sum,url)=>sum+imageBytes(url),0);
  const effortLabel=reasoningLabel(selection.effort),sending=busy&&(Boolean(uploadProgress)||pending?.action==='turn.send'||pending?.action==='session.create');
  const activeApproval=approval||inheritedApproval;
  const listedThreads=useMemo(()=>visibleThreads(sessions,preferences,project,archived,searchQuery),[sessions,preferences,project,archived,searchQuery]);
  const visibleTitle=newChat?'新聊天':view?.title||sessions.find(s=>s.id===selected)?.title||'正在打开…';
  const conversationCopy=useStableEvent((text:string)=>void copyText(text).then(()=>setNotice('已复制文字')).catch(()=>setError('复制失败，请长按选择文字')));
  const conversationEdit=useStableEvent((turnId:string,itemId:string,text:string)=>editTurn(mutate,target(),{turnId,itemId,text},{model,effort,approvalPolicy:approval,serviceTier}));
  const conversationFork=useStableEvent(fork),conversationDiff=useStableEvent((turn:TurnView)=>showPreview({kind:'diff',threadId:selected,turnId:turn.id,text:turn.diff!}));
  const conversation=useMemo(()=>view?.turns.map(turn=><ConversationTurn key={turn.id} turn={turn} running={Boolean(view.running)} source={view.source} latestUser={turn.id===latestUserTurn} disabled={!connected||busy||Boolean(pending)} openFile={markdownOpenFile} openPreview={markdownOpenPreview} onFollowup={markdownFollowup} onCopy={conversationCopy} onEdit={conversationEdit} onFork={conversationFork} onDiff={conversationDiff} onBlocked={setNotice}/>),[view?.turns,view?.running,view?.source,latestUserTurn,connected,busy,Boolean(pending),markdownOpenFile,markdownOpenPreview,markdownFollowup,conversationCopy,conversationEdit,conversationFork,conversationDiff]);
  const feedback=<>{error&&<div className="feedback error" role="alert"><span>{error}</span><IconButton icon="close" label="关闭提示" onClick={()=>setError('')}/></div>}{notice&&<div className="feedback" role="status">{notice}</div>}{pending&&!busy&&<div className="pending"><button onClick={()=>void checkPending()}>核实操作结果</button><button onClick={()=>{if(window.confirm('请先查看最新任务，确认这次操作的实际结果。清除提示不会重发旧操作。')){setOperation(null);setNotice('');setOptimistic(old=>old?.key===scope?null:old);}}}>我已核实</button></div>}</>;

  if(!token||status==='auth_error')return <main className="connect"><Icon name="computer" size={38}/><h1>连接你的电脑</h1><p>通过自部署中继继续电脑上的对话。</p><form onSubmit={e=>{e.preventDefault();save('connection',tokenInput.trim());setToken(tokenInput.trim());}}><label>中继地址<input readOnly value={location.origin}/></label><label>连接 Token<input type="password" autoComplete="off" value={tokenInput} onChange={e=>setTokenInput(e.target.value)} placeholder="粘贴电脑上的连接 Token" required/></label>{status==='auth_error'&&<p className="error">Token 不匹配，请重新输入。</p>}<button className="primary">连接</button></form><small>也可以用手机扫描电脑上的连接二维码。</small></main>;
  const selectService=(next:Service)=>navigate(switchRoute(machine,route,next));
  const switcher=<ServiceSwitch active={service} disabled={busy||voiceBusy||imageLoading} select={selectService}/>;
  const previewPane=preview&&<PreviewPane title={previewTitle(preview)} subtitle={preview.kind==='file'?preview.file?.path||preview.path:preview.kind==='web'?preview.session.url:undefined}
       tabs={previewState.tabs.map(tab=>({id:tab.id,title:previewTitle(tab.target)}))} activeTab={previewState.activeId}
       selectTab={id=>setPreviewState(old=>({...old,activeId:id}))} closeTab={closePreviewTab}
       compact={compactPreview} covered={Boolean(sheet||threadMenu||statusPanel||modelPoint)} close={closePreview}>
       {previewState.tabs.map(({id,target})=><div key={id} id={`preview-panel-${id}`} aria-labelledby={`preview-tab-${id}`} className="preview-tab-panel" role="tabpanel" hidden={id!==previewState.activeId}>
         {target.kind==='file'&&(target.file?<Suspense fallback={<p className="preview-notice" role="status">正在加载查看器…</p>}><FilePreviewPanel allowFileUrls={fileOwner(target.threadId).service!=='codex'} key={target.request} file={target.file} connected={connected} line={target.line} openFile={path=>void openFile(path,target.machineId,target.threadId)}
           htmlPreview={browserState?.filePath===target.file.path&&belongsToThread(browserState,target.machineId,target.threadId)?<WebViewer session={browserState} onEnd={closeBrowser}/>:browserBusy?<p role="status">正在打开网页…</p>:null}
           htmlError={target.error} openHtml={()=>void openBrowser({filePath:target.file!.path},target)}
           readFile={path=>fileRequest('read',target.machineId,target.threadId,{path})}
           read={offset=>fileRequest('download',target.machineId,target.threadId,{path:target.file!.path,revision:target.file!.revision,offset})}/></Suspense>:<div className="preview-empty" role={target.error?'alert':'status'}><p>{target.error||'正在读取文件…'}</p>{target.error&&<button disabled={!connected} onClick={()=>void openFile(target.path+(target.line?`:${target.line}`:''),target.machineId,target.threadId)}>重试</button>}</div>)}
         {target.kind==='diff'&&<Suspense fallback={<p className="preview-notice">正在加载差异…</p>}><DiffViewer text={target.text} compact={compactPreview}/></Suspense>}
         {target.kind==='web'&&<WebViewer session={target.session} onEnd={closeBrowser}/>}
         {target.kind==='image'&&<div className="image-viewer"><img className="preview-image" src={target.url} alt={target.title}/></div>}
       </div>)}
     </PreviewPane>;
  const computerOptions=<><div className="connection-status"><i className={connected?'dot online':'dot'}/>{connected?'已连接':status==='online'?'等待电脑上线':'正在连接中继…'}</div>{machines.map(m=><MenuItem icon="computer" key={m.id} disabled={busy} onClick={()=>changeMachine(m.id)}>{m.name}{m.id===machine&&<Icon name="check" size={18}/>}</MenuItem>)}{!machines.length&&<p className="muted">请在电脑启动连接器。</p>}<p className="muted">{location.origin}</p></>;
  const fileOptions=<form onSubmit={e=>{e.preventDefault();void openFile(filePath);}}><label>文件路径<input autoFocus required value={filePath} onChange={e=>setFilePath(e.target.value)} placeholder="例如 README.md 或 docs/deck.pptx"/></label>{error&&<p className="error" role="alert">{error}</p>}<button className="primary">打开文件</button></form>;
  if(service==='antigravity'||service==='cowork'){
    const id=remoteConversation,inert=Boolean(sheet||compactPreview&&preview);
    const open=(next:string)=>{if(next!==id){navigate(withConversation(route,next));if(!next)refreshRemoteList(value=>value+1);}};
    return <div className={`shell ${id?'has-session':''}`}>
      <AntigravitySidebar key={`${service}:${machine}`} inert={inert} selected={id} project={route.project} machineName={machineName} connected={connected} relayOnline={status==='online'}
        revision={remoteListRevision} switcher={switcher} call={call} open={open} chooseProject={project=>navigate(serviceHome(service,project))}
        listAction={`${service}.list`} appName={serviceLabel(service)} action={service==='cowork'?<CoworkOpenAction project={route.project}/>:undefined}
        chooseComputer={()=>setSheet('computer')} more={()=>setSheet('home')}/>
      {id&&service==='cowork'?<CoworkPanel key={JSON.stringify([machine,id])} id={id} inert={inert} machineName={machineName} connected={connected} back={()=>open('')} call={call}/>:
        id?<AntigravityPanel key={JSON.stringify([machine,service,id])} inert={inert} openFile={markdownOpenFile} openPreview={markdownOpenPreview} previewError={error}
        machine={machine} machineName={machineName} connected={connected} conversationId={id} call={call} go={open}
        showFiles={()=>{setFilePath('');setSheet('file');}} copyText={copyText} clearPreviewError={()=>setError('')}/>:
        <main className="thread-panel" inert={inert}><div className="desktop-welcome"><h1>选择一个聊天</h1></div></main>}
      {sheet==='home'&&<SheetPanel title="选项" close={()=>setSheet(null)}>
        <MenuItem icon="computer" onClick={()=>setSheet('computer')}>切换电脑</MenuItem>
        <MenuItem icon="refresh" disabled={!connected} onClick={()=>{setSheet(null);refreshRemoteList(value=>value+1);}}>刷新项目与会话</MenuItem>
        <MenuItem icon="logout" onClick={logout}>断开连接</MenuItem>
      </SheetPanel>}
      {sheet==='computer'&&<SheetPanel title="电脑" close={()=>setSheet(null)}>{computerOptions}</SheetPanel>}
      {sheet==='file'&&<SheetPanel title="查看项目文件" close={()=>setSheet(null)}>{fileOptions}</SheetPanel>}
      {previewPane}
    </div>;
  }
  return <div className={`shell ${showThread?'has-session':''}`}>
    <aside className="home-panel" inert={Boolean(sheet||threadMenu||statusPanel||modelPoint||compactPreview&&preview)}>
      <HomeHeader project={projectName(project)} machineName={machineName} connected={connected} relayOnline={status==='online'} back={backToProjects} backDisabled={busy} chooseComputer={()=>setSheet('computer')} more={()=>setSheet('home')}/>
      {!project&&!archived&&!searchQuery&&switcher}
      <div className="home-content">
        {!project&&!searchQuery&&<section className="project-section"><h2>项目</h2><button className="project-row" disabled={busy} onClick={startNew}><Icon name="chat"/><span>聊天</span></button>{projects.map(p=><button className="project-row" key={p} disabled={busy} onClick={()=>{setSessions([]);setCursor(null);navigate({...home,project:p});}} title={p}><Icon name="folder"/><span>{projectName(p)}</span></button>)}</section>}
        <section className="recent-section">{!listedThreads.length&&<h2>{searchQuery?'搜索结果':archived?'归档会话':'最近'}</h2>}{groupThreads(listedThreads,preferences,searchQuery?'搜索结果':archived?'归档会话':'最近').map(group=><div className="thread-group" key={group.key}><h2>{group.label}</h2><nav aria-label={group.label}>{group.threads.map(s=><ThreadRow key={s.id} thread={s} selected={s.id===selected} disabled={busy} preference={preferences[s.id]} time={relativeTime(s.updatedAt)} open={()=>{changePreference(s.id,{unread:false});navigate({...route,thread:s.id,newChat:false});}} menu={point=>setThreadMenu({thread:s,point,machine,archived})}/>)}</nav></div>)}
          {listBusy&&!listedThreads.length?<div className="list-skeleton" role="status" aria-label="正在读取会话"><div/><div/><div/></div>:!listedThreads.length&&<p className="empty-list">{!connected?'连接电脑后，会话会出现在这里。':searchQuery?'没有找到匹配的会话。':'还没有聊天，开始一个新任务吧。'}</p>}
          {cursor&&<button className="more-link" disabled={listBusy} onClick={()=>void list(true)}>{listBusy?'正在加载…':'加载更多'}</button>}
        </section>
      </div>
      <div className="home-bottom">{!showThread&&feedback}<div className="home-dock"><ChatSearch value={search} change={setSearch}/><IconButton icon="compose" label="新聊天" className="round black new-chat" disabled={!connected||busy||Boolean(pending)} onClick={startNew}/></div></div>
    </aside>

    <main className="thread-panel" inert={Boolean(sheet||threadMenu||statusPanel||modelPoint||compactPreview&&preview)}>{!showThread?<div className="desktop-welcome"><h1>我们来处理</h1><button className="center-project" onClick={startNew} disabled={!connected}><Icon name="folder"/><span>{projectName(project||info?.roots?.[0]||'选择一个项目')}</span><Icon name="chevron" size={18}/></button></div>:<>
      <ThreadHeader title={visibleTitle} project={projectName(newChat?newCwd:view?.cwd||project)||'项目'} machineName={machineName} connected={connected} back={backToSessions} backDisabled={busy} onTitle={element=>newChat?setSheet('projects'):openStatus(element)}>
        <button type="button" className="icon-button" aria-haspopup="dialog" aria-label={`会话状态：${contextSummary(view?.contextUsage)}`} title="上下文与额度限制" disabled={!selected} onClick={e=>openStatus(e.currentTarget)}><ContextIndicator usage={view?.contextUsage}/></button><button type="button" className="icon-button" aria-haspopup="dialog" aria-label="会话操作" disabled={!selected||busy} onClick={e=>openThreadMenu(e.currentTarget)}><Icon name="more"/></button>
      </ThreadHeader>
       {browserSession&&<BrowserPreviewPanel session={browserSession} onOpen={()=>showPreview({kind:'web',session:browserSession})} onClose={closeBrowser}/>}
      {view?.notice&&!newChat&&<div className="banner">{view.notice}{view.source==='history'&&!view.resumeUnavailable&&<button disabled={!connected||busy||Boolean(pending)} onClick={()=>{if(window.confirm('确认原桌面或 CLI 中的任务已经结束？继续后将由本连接器运行。'))void mutate('session.resume',{threadId:selected,confirmIdle:true});}}>在这里继续</button>}</div>}
      <div className={`timeline ${newChat||(!loading&&view&&!view.turns.length)?'is-empty':''}`} ref={timeline} onScroll={()=>{const el=timeline.current!,up=el.scrollTop<lastScrollTop.current,distance=el.scrollHeight-el.scrollTop-el.clientHeight;lastScrollTop.current=el.scrollTop;
          // Content that shrinks at the bottom moves the position up without the user; still at the bottom means still following.
          sticky.current=distance<24&&(!up||distance<2);if(up&&el.scrollTop<160&&!historyError)void loadOlder();}}>
        <div className="timeline-content" ref={timelineContent}>
        {loading&&!newChat&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
        {view?.hasMore&&!newChat&&<button className="more-link earlier" disabled={!connected||loadingOlder} onClick={()=>void loadOlder()}>{loadingOlder?'正在加载…':historyError?`${historyError} · 重试`:'加载更早内容'}</button>}
        {pendingShown&&(newChat||!view?.turns.length)?null:newChat||(!loading&&view&&!view.turns.length)?<div className="new-chat-welcome"><h1>我们来处理</h1><button className="center-project" disabled={!newChat||busy} onClick={()=>setSheet('projects')}><Icon name="folder"/><span>{projectName(newChat?newCwd:view?.cwd||'')||'选择项目'}</span>{newChat&&<Icon name="chevron" size={17}/>}</button></div>:conversation}
        {pendingShown&&<PendingMessage message={pendingShown} openFile={markdownOpenFile} openPreview={markdownOpenPreview} onFollowup={markdownFollowup}/>}
        {!newChat&&view?.retry&&<ConversationStatus>{view.retry}</ConversationStatus>}
        {!connected?<ConversationStatus>{!everOnline.current?'正在连接电脑…':cachedShown?'与电脑的连接中断，以下是上次打开时的内容。':connectionLost}</ConversationStatus>:cachedShown&&<ConversationStatus>正在同步最新内容…</ConversationStatus>}
        </div>
      </div>
      <div className="composer-area"><div className="request-stack">{!newChat&&view?.requests.map(req=><RequestCard key={`${view.generation}:${req.id}`} request={req} disabled={!canOperate} respond={response=>void mutate('request.respond',{...target(),requestId:req.id,response})}/>)}</div>{feedback}
        {connected&&view?.running&&!newChat&&!view.retry&&view.turns.at(-1)?.items.at(-1)?.type!=='retry'&&<div className="running-status"><i className="dot online"/>Codex 正在处理</div>}
        {!newChat&&Boolean(view?.queuedMessages?.length)&&<div className="queued-messages" aria-label="待发送消息">
          <div className="queue-heading">完成后发送 <span>{view?.queuedMessages?.length}</span></div>
          {view?.queuedMessages?.map((message,index)=>{
            const disabled=!connected||busy||Boolean(pending)||message.state==='sending';
            const attachmentsFull=attachmentCount+message.imageCount+(message.fileNames?.length||0)>MAX_ATTACHMENTS||selectedImageBytes+(message.imageBytes||0)>MAX_TOTAL_IMAGE_BYTES;
            const confirmUncertain=()=>message.state!=='uncertain'||window.confirm('请先核实这条消息是否已经发送。移出后，后续排队消息会继续发送。');
            return <div className="queued-message" key={message.id}>
              <div className="queued-content"><small>{message.state==='queued'?`排队 ${index+1}`:message.state==='sending'?'正在发送':message.state==='uncertain'?'结果待核实':'发送失败'}{message.imageCount>0?` · ${message.imageCount} 张图片`:''}{message.fileNames?.length?` · ${message.fileNames.length} 个文件`:''}</small><p title={[message.text,...message.fileNames||[]].join('\n')}>{message.text||message.fileNames?.join('、')||'图片消息'}</p>{message.error&&<small className="error">{message.error}；后续消息已暂停，请核实后移出。</small>}</div>
              <div className="queued-actions">
                <IconButton icon="steer" label="立即追加到当前任务（Steer，沿用当前任务设置）" disabled={disabled||!canOperate||!view?.activeTurnId||message.state!=='queued'} onClick={()=>void mutate('turn.steerQueued',{...target(),queuedId:message.id})}/>
                <IconButton icon="undo" label={attachmentsFull?'输入框附件已满，请先处理草稿':'撤回到输入框'} disabled={disabled||imageLoading||voiceBusy||attachmentsFull} onClick={()=>{if(confirmUncertain())void mutate('turn.withdrawQueued',{threadId:selected,queuedId:message.id});}}/>
                <IconButton icon="trash" label="删除排队消息" disabled={disabled} onClick={()=>{if(confirmUncertain())void mutate('turn.cancelQueued',{threadId:selected,queuedId:message.id});}}/>
              </div>
            </div>;
          })}
        </div>}
        <form className={`composer ${attachmentCount?'with-images':''}`} onSubmit={e=>{e.preventDefault();void submit();}}>
          {images.length>0&&<div className="image-strip"><span className="attachment-count" role="status">图片 {images.length}/{MAX_IMAGES}</span><div className="attachment-thumbnails">{images.map((url,i)=><div className="attachment-thumb" key={i}><button type="button" aria-label={`查看第 ${i+1} 张图片，共 ${images.length} 张`} onClick={()=>showPreview({kind:'image',url,title:`待发送图片 ${i+1}/${images.length}`})}><img src={url} alt={`待发送图片 ${i+1}`} decoding="async"/></button><button className="attachment-remove" type="button" disabled={busy||imageLoading} aria-label={`移除第 ${i+1} 张图片`} onClick={()=>setImages(old=>old.filter(value=>value!==url))}><Icon name="close" size={14}/></button></div>)}</div></div>}
          {files.length>0&&<div className="file-attachments">{files.map((file,i)=><div className="file-attachment" key={i}><Icon name="file" size={18}/><span title={file.name}>{file.name}<small>{file.size>=1024*1024?`${(file.size/1024/1024).toFixed(1)} MiB`:`${Math.max(1,Math.ceil(file.size/1024))} KiB`}</small></span><IconButton icon="close" label={`移除 ${file.name}`} disabled={busy||imageLoading} onClick={()=>setFiles(old=>old.filter((_,index)=>index!==i))}/></div>)}</div>}
          {imageLoading&&<span className="attachment-count" role="status">正在处理附件，大图会自动压缩…</span>}
          {uploadProgress&&<div className="upload-progress" role="status"><span>正在上传 {uploadProgress.index}/{uploadProgress.count} · {Math.floor(uploadProgress.loaded/uploadProgress.size*100)}% · {uploadProgress.name}</span><progress value={uploadProgress.loaded} max={uploadProgress.size} aria-label={`正在上传 ${uploadProgress.name}`}/></div>}
          {voiceBusy&&<div className="voice-status" role="status"><span>{voice.state==='starting'?'正在请求麦克风…':voice.state==='recording'?'录音中 · 最长 2 分钟':'正在识别…'}</span><button type="button" onClick={voice.cancel}>取消</button></div>}
          <textarea ref={composer} aria-label="任务输入" placeholder={queueNext?'当前任务完成后发送…':newChat||!view?.turns.length?'接下来我们该写什么代码？':`在 ${machineName} 上继续…`} value={draft} readOnly={busy} onChange={e=>editDraft(e.target.value)} onPaste={paste} rows={1} onKeyDown={e=>submitOnDesktop(e,()=>void submit())}/>
          <div className="composer-toolbar">
            <IconButton icon="plus" label="添加与选项" className="composer-add" disabled={busy||imageLoading} onClick={()=>setSheet('add')}/>
            <IconButton icon="shield" label={`许可：${activeApproval==='never'?'不提示':activeApproval==='on-request'?'按需审批':'电脑配置'}`} className={`composer-permission${activeApproval==='never'?' unrestricted':''}`} disabled={busy} onClick={()=>setSheet('approval')}/>
            <button className="composer-model" ref={modelButton} type="button" aria-haspopup="dialog" aria-expanded={Boolean(modelPoint)} onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();setModelPoint({x:rect.right,y:rect.top,align:'end'});}} disabled={busy} title={`${modelLabel}${effortLabel?' · '+effortLabel:''}${isFast?' · 极速':''}`}><span>{modelLabel}</span>{effortLabel&&<small>{effortLabel}</small>}{isFast&&<small>极速</small>}<Icon name="chevron" size={13}/></button>
            <div className="composer-actions">
              {view?.activeTurnId&&!newChat&&Boolean(draft.trim()||attachmentCount||busy)&&<IconButton icon="stop" label="停止当前任务" className="black round stop" disabled={!canOperate} onClick={()=>void mutate('turn.stop',target())}/>}
              <IconButton icon={voice.state==='recording'?'stop':'mic'} label={voice.state==='recording'?'结束录音并识别':voice.state==='transcribing'?'正在识别':voice.state==='starting'?'正在请求麦克风':`语音输入：${voiceLabel}`} className={voice.state==='recording'?'recording round':''} disabled={busy||voice.state==='starting'||voice.state==='transcribing'||voiceMode==='codex'&&!connected} onClick={()=>{if(voice.state==='recording')voice.stop();else{setError('');setNotice('');voice.start();}}}/>
              {view?.activeTurnId&&!newChat&&!draft.trim()&&!attachmentCount&&!busy?<IconButton icon="stop" label="停止当前任务" className="black round stop" disabled={!canOperate} onClick={()=>void mutate('turn.stop',target())}/>:<SendMessageButton sending={sending} label={queueNext?'完成后发送':'发送消息'} disabled={!canWrite||!draft.trim()&&!attachmentCount}/>}
            </div>
          </div>
         </form>
         <input className="hidden" ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e=>{void attach(Array.from(e.target.files||[]));e.target.value='';}}/>
         {/* Give mobile browsers document types so this entry does not offer media capture sources. */}
         <input className="hidden" ref={documentInput} type="file" accept="application/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.xml,.zip" multiple onChange={e=>{void attach(Array.from(e.target.files||[]));e.target.value='';}}/>
      </div>
    </>}</main>

     {threadMenu&&threadMenu.machine===machine&&<ThreadMenu key={`${machine}:${threadMenu.thread.id}`} thread={threadMenu.thread} point={threadMenu.point} preference={preferences[threadMenu.thread.id]||{}} sections={[...new Set(Object.values(preferences).map(p=>p.section).filter((s):s is string=>Boolean(s)))]} archived={threadMenu.archived} compact={threadMenu.compact} connected={connected} close={()=>setThreadMenu(current=>current===threadMenu?null:current)} change={patch=>changePreference(threadMenu.thread.id,patch,threadMenu.thread)} copy={()=>copyText(threadMenu.thread.id)} rename={name=>changeThread('session.rename',threadMenu.thread,{name})} archive={()=>changeThread(threadMenu.archived?'session.unarchive':'session.archive',threadMenu.thread)} openPreview={threadMenu.compact?()=>setSheet('browser'):undefined}/>}
     {statusPanel&&statusPanel.machine===machine&&statusPanel.thread===selected&&<ThreadStatusPanel key={`${machine}:${selected}`} point={statusPanel.point} view={view} threadId={selected} cwd={view?.cwd||project} connected={connected} close={()=>setStatusPanel(current=>current===statusPanel?null:current)} copy={()=>copyText(selected)} read={()=>call('session.status',{threadId:selected})}/>}
     {modelPoint&&<ModelPicker anchor={modelButton.current} point={modelPoint} models={availableModels} value={{model,effort,serviceTier}} current={currentModel} disabled={busy} onChange={value=>{setModel(value.model);setEffort(value.effort);setServiceTier(value.serviceTier);}} close={()=>setModelPoint(null)}/>}
     {sheet&&<SheetPanel title={({home:'选项',computer:'电脑',projects:'选择项目',approval:'许可',add:'添加与选项',file:'查看项目文件',browser:'打开本机网页',voice:'语音输入'} as const)[sheet]} close={()=>{if(sheet==='browser'){browserSequence.current++;setBrowserRequest(null);}setSheet(null);}}>
       {sheet==='home'&&<><MenuItem icon="compose" disabled={!connected||busy} onClick={startNew}>新聊天</MenuItem><MenuItem icon="computer" onClick={()=>setSheet('computer')}>切换电脑</MenuItem><MenuItem icon="refresh" disabled={!connected||listBusy} onClick={()=>{setSheet(null);refreshInfo();void list(false,true);}}>刷新项目与会话</MenuItem><MenuItem icon="chat" disabled={!connected||busy} onClick={()=>{setArchived(!archived);setSheet(null);}}>{archived?'查看最近会话':'查看归档会话'}</MenuItem><MenuItem icon="mic" onClick={()=>setSheet('voice')}>语音输入<span className="menu-detail">{voiceLabel}</span></MenuItem><MenuItem icon="logout" disabled={busy} onClick={logout}>断开连接</MenuItem></>}
      {sheet==='computer'&&computerOptions}
       {sheet==='projects'&&<><div className="project-choices">{projects.map(p=><MenuItem icon="folder" key={p} disabled={busy} onClick={()=>{setNewCwd(p);setModel('');setEffort('');setApproval('');setSheet(null);}}><span>{projectName(p)}<small>{p}</small></span>{p===newCwd&&<Icon name="check" size={18}/>}</MenuItem>)}</div><details className="other-project"><summary>其他项目目录</summary><form onSubmit={e=>{e.preventDefault();setSheet(null);}}><label>电脑上的完整项目路径<input value={newCwd} onChange={e=>setNewCwd(e.target.value)} required/></label><button className="primary">使用这个目录</button></form></details></>}
       {sheet==='approval'&&<><p className="muted">下次发送时使用所选许可。</p><label>审批策略<select disabled={busy} value={approval} onChange={e=>setApproval(e.target.value)}><option value="">沿用当前设置 · {approvalLabel}</option><option value="on-request">按需审批</option><option value="never">不提示审批</option></select></label><button className="primary" onClick={()=>setSheet(null)}>完成</button></>}
       {sheet==='voice'&&<><label>识别方式<select value={voiceMode} onChange={e=>{const mode=voiceProvider(e.target.value);setVoiceMode(mode);save('voice-provider',mode);}}><option value="codex">Codex 识别</option><option value="keyboard">系统键盘</option></select></label><p className="muted">{voiceMode==='codex'?'点麦克风开始录音，再点结束，文字填入输入框。需要 HTTPS 和电脑上的 ChatGPT 登录；录音经中继、电脑发送到语音服务。':'点麦克风打开输入框，再使用手机键盘上的听写。'}</p><p className="muted">选择保存在当前浏览器。</p><button className="primary" onClick={()=>setSheet(null)}>完成</button></>}
       {sheet==='add'&&<><MenuItem icon="mic" onClick={()=>setSheet('voice')}>语音输入<span className="menu-detail">{voiceLabel}</span></MenuItem>{selected&&<MenuItem icon="browser" disabled={!connected} onClick={()=>setSheet('browser')}>打开本机网页</MenuItem>}<MenuItem icon="image" disabled={busy||imageLoading||!canImage||attachmentCount>=MAX_ATTACHMENTS} onClick={()=>fileInput.current?.click()}>添加图片<span className="menu-detail">大图自动压缩</span></MenuItem><MenuItem icon="file" disabled={busy||imageLoading||attachmentCount>=MAX_ATTACHMENTS} onClick={()=>documentInput.current?.click()}>添加文件<span className="menu-detail">PDF、Word 等</span></MenuItem><p className="muted">附件 {attachmentCount}/{MAX_ATTACHMENTS} · 文件每个最多 100 MiB</p>{!canImage&&<p className="muted">当前模型未确认图片能力。</p>}{error&&<p className="error" role="alert">{error}</p>}{selected&&<><MenuItem icon="file" onClick={()=>setSheet('file')}>查看项目文件</MenuItem><MenuItem icon="refresh" disabled={!connected} onClick={()=>{setSheet(null);void refreshSession();}}>刷新会话</MenuItem></>}{newChat&&<MenuItem icon="folder" disabled={busy} onClick={()=>setSheet('projects')}>选择项目</MenuItem>}</>}
       {sheet==='file'&&fileOptions}
       {sheet==='browser'&&selected&&<form onSubmit={e=>{e.preventDefault();void openBrowser();}}><label>电脑上的网页地址<input autoFocus required type="url" value={browserUrl} onChange={e=>{setBrowserUrl(e.target.value);save(previewUrlKey(machine,selected),e.target.value);}} placeholder="http://127.0.0.1:5173"/></label><p className="muted">地址仅用于当前聊天。先在电脑启动网页服务，再打开预览。</p>{error&&<p className="error" role="alert">{error}</p>}<button className="primary" disabled={browserBusy||!connected}>{browserBusy?'正在打开…':'打开预览'}</button></form>}
     </SheetPanel>}
     {previewPane}
  </div>;
}
function MenuItem({icon,children,onClick,disabled=false}:{icon:IconName;children:ReactNode;onClick:()=>void;disabled?:boolean}){return <button className="menu-item" onClick={onClick} disabled={disabled}><Icon name={icon} size={21}/><span className="menu-copy">{children}</span></button>;}
function SheetPanel({title,close,children,className=''}:{title:string;close:()=>void;children:ReactNode;className?:string}){
  const panel=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement;if(!panel.current?.contains(document.activeElement))panel.current?.focus();const key=(e:KeyboardEvent)=>{
    if(e.key==='Escape'){e.preventDefault();close();}
    if(e.key==='Tab'){const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],summary')||[]);const first=nodes[0],last=nodes.at(-1);if(!panel.current?.contains(document.activeElement)){e.preventDefault();(e.shiftKey?last:first)?.focus();}else if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  };document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};},[]);
  return <div className="overlay" onClick={close}><section tabIndex={-1} ref={panel} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><div className="sheet-handle"/><header><h2>{title}</h2><IconButton icon="close" label="关闭" onClick={close}/></header><div className="sheet-content">{children}</div></section></div>;
}
// The app shell is cached by a service worker for instant reopening; see public/sw.js.
if(import.meta.env.PROD&&'serviceWorker' in navigator)window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').catch(()=>{});});
// The stored cache is read first (bounded by a short timeout) so the first paint can show it.
void loadCache().finally(()=>createRoot(document.getElementById('root')!).render(<App/>));
