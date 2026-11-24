import {lazy,Suspense,startTransition,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Client,inviteCode,operationId} from './client';
import {AntigravityPanel} from './antigravity';
import {AntigravitySidebar} from './antigravity-sidebar';
import {ClaudeCodePanel} from './claude-code';
import {ClaudeProjectEditor,GuestProjectForm} from './claude-projects';
import {ChatSearch,HomeHeader,ThreadHeader,useComposerHeight} from './chat-layout';
import {ServiceSwitch, switchRoute} from './service-switch';
import {versionGap,versionGapNotice} from './features';
import {fileOwner,previewOwner as previewOwnerOf,routeConversation,serviceHome,serviceLabel,serviceOf,supportedRoute,withConversation,type Service} from './services';
import {Icon} from './icons';
import {IconButton} from './icon-button';
import {QueuedMessages} from './queued-messages';
import {connectionLost,ConversationStatus,ConversationTurn,PendingMessage} from './conversation';
import {RequestCard} from './content';
import {createFirstTurn} from './new-chat';
import {SessionListLoader} from './session-list-loader';
import {HISTORY_PAGE_SIZE,refreshHistory,prependHistory} from './thread-history';
import {knownSnapshot,restoreSnapshot} from './session-snapshot';
import {applyLiveFrames,keepLiveText,type LiveFrame} from './live';
import {OPTIMISTIC_ACCEPTED_MS,optimisticDelivered,optimisticMessage,type OptimisticMessage} from './optimistic';
import {cachedList,cachedProjects,cachedView,clearCache,flushCache,loadCache,rememberList,rememberProjects,rememberView,type CachedView} from './session-cache';
import {BrowserPreviewPanel,PageViewer,WebViewer,type PreviewSession} from './browser-preview';
import {belongsToThread,defaultPreviewUrl,openThreadPreview,previewUrlKey,previewWidthKey,reachable} from './thread-preview';
import {PreviewPane,useCompactPreview} from './preview-pane';
import {fileReference,isArtifactUrl,previewRoute,samePreviewTarget,type PreviewTarget} from './preview-target';
import {ArtifactPanel} from './artifact-view';
import {rememberPage,type PaneAction} from './artifact-pane';
import {home,initialLocation,rememberLocation,parseLocation,type Route} from './route-state';
import {useComposerAttachments} from './composer-attachments';
import {AddOptions,Composer,useAttachmentPickers} from './composer';
import {MenuItem,SheetPanel} from './sheet';
import {PermissionButton,PermissionPicker,type PermissionOption} from './permission-picker';
import {UpdateBanner} from './update-banner';
import {MAX_TOTAL_IMAGE_BYTES,imageBytes} from '../src/shared/images';
import {MAX_ATTACHMENTS,validateAttachments} from '../src/shared/attachments';
import {uploadAttachments,type UploadProgress} from './file-upload';
import {DraftSave} from './draft-save';
import {relativeTime,ThreadMenu,ThreadRow} from './thread-menu';
import type {MenuPoint} from './popover';
import {ContextIndicator,ThreadStatusPanel,contextSummary} from './thread-status';
import {groupThreads,visibleThreads,rememberThreads,saveThread,type ThreadPreferences,type ThreadPreference} from './thread-preferences';
import {type Json,type Machine,type SessionView,type RequestAction,type TurnView} from '../src/shared/types';
import {submitTurn,editTurn} from './turn-request';
import {modelDisplayName,reasoningLabel,resolveModelSelection} from '../src/shared/models';
import {ModelButton,ModelPicker} from './model-picker';
import {defaultVoiceProvider,loadVoiceChoice,resolveVoiceProvider,voiceEngineKey,voiceProvider,voiceProviderLabel,type VoiceProvider} from '../src/shared/voice';
import {useVoiceInput} from './use-voice-input';
import {useStableEvent} from './use-event';
import {notifyHint,notifyLabel,notifyState,toggleNotify,useTurnNotice,watchWhileHidden,type NotifyState} from './turn-notify';
import {TeamPanel,type TeamUser} from './team';
import './style.css';
import 'react-diff-view/style/index.css';
import './preview.css';
// The model and permission pickers share these styles; imported here so the components stay importable in tests.
import './model-picker.css';
import {SenderRoot,SenderScope} from './senders';
import {traceOpen} from './trace';

const FilePreviewPanel=lazy(()=>import('./file-preview').then(module=>({default:module.FilePreviewPanel})));
const DiffViewer=lazy(()=>import('./diff-viewer').then(module=>({default:module.DiffViewer})));

const load=(key:string,fallback:any)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}};
const save=(key:string,value:any)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const name=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;
const computerName=(machine:Machine)=>machine.name+(machine.guest?'（借用）':'');
const previewTitle=(target:PreviewTarget)=>target.kind==='file'?target.file?.name||name(target.path):target.kind==='diff'?'本轮修改':target.kind==='image'?target.title:target.kind==='artifact'?target.title||'claude.ai 页面':target.kind==='site'?siteName(target.url):'网页预览';
const siteName=(url:string)=>{try{return new URL(url).host;}catch{return '网页预览';}};
/** What the address form says about where a page will be loaded from. */
const ROUTE_HINT={tunnel:'通过电脑打开：先在电脑或局域网里启动网页服务。',direct:'手机直接打开，不经过电脑。',external:'http 的公网地址不能嵌在这里，只能在浏览器里打开。',artifact:'claude.ai 页面，通过电脑打开。'} as const;
// A team invite link (#invite=…) is kept like a Token until the relay exchanges it for this device's own token.
function initialToken(){const params=new URLSearchParams(location.hash.slice(1));const invite=params.get('invite'),token=params.get('token')||(invite?inviteCode('#invite='+invite):null);if(token){save('connection',token);history.replaceState(history.state,'',location.pathname+location.search);}return token||load('connection','');}
// Only the approval policy changes; the sandbox stays as configured on the computer.
const APPROVALS:PermissionOption[]=[
  {id:'on-request',label:'按需审批',description:'需要时请你审批命令和文件修改'},
  {id:'never',label:'不提示审批',description:'不再请求审批；沙箱仍按电脑配置',elevated:true},
];
const approvalName=(policy?:string)=>APPROVALS.find(option=>option.id===policy)?.label||'电脑配置';
const savedLocation=initialLocation();
const listKey=(machine:string,project:string,archived:boolean)=>`${machine}:${project}:${archived?'archived':'recent'}`;
type PreviewTab={id:number;target:PreviewTarget};
type Sheet='home'|'computer'|'projects'|'add'|'file'|'browser'|'voice'|'claude-project'|'team'|null;
/** Sessions another member started; the filter keeps those of `me` and leaves lists without owners as they are. */
const ownedBy=(threads:Json[],me:TeamUser|null,onlyMine:boolean)=>me&&onlyMine?threads.filter(thread=>!('owner' in thread)||thread.owner?.id===me.id):threads;

function App(){
  const [token,setToken]=useState(initialToken),[tokenInput,setTokenInput]=useState('');
  // The signed-in member once the relay has a team; null with the shared Token.
  const [me,setMe]=useState<TeamUser|null>(null),[onlyMine,setOnlyMine]=useState(()=>load('only-mine',false)===true),teamDevice=useRef('');
  const [status,setStatus]=useState('connecting'),[machines,setMachines]=useState<Machine[]>([]),[machine,setMachine]=useState(savedLocation.machine);
  const [route,setRoute]=useState<Route>(savedLocation.route),[sheet,setSheet]=useState<Sheet>(null);
  const [remoteListRevision,refreshRemoteList]=useState(0);
  const [claudeNewCwd,setClaudeNewCwd]=useState<string|null>(null);
  const service=serviceOf(route),codexActive=service==='codex';
  useEffect(()=>setClaudeNewCwd(null),[machine,service]);
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
  const [draft,setDraft]=useState(''),[model,setModel]=useState(''),[effort,setEffort]=useState(''),[approval,setApproval]=useState(''),[newCwd,setNewCwd]=useState('');
  const [optimistic,setOptimistic]=useState<OptimisticMessage|null>(null),optimisticRef=useRef(optimistic);optimisticRef.current=optimistic;
  const everOnline=useRef(false);if(status==='online')everOnline.current=true;
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null);
  const draftSave=useRef(new DraftSave(save));
  const [serviceTier,setServiceTier]=useState<string|null|undefined>(undefined);
  // Each app (Codex, Claude Code, Antigravity) keeps its own voice engine, defaulting to its native service.
  const [voiceChoices,setVoiceChoices]=useState<Record<Service,VoiceProvider>>(()=>({
    codex:loadVoiceChoice('codex',key=>load(key,'')),
    claude:loadVoiceChoice('claude',key=>load(key,'')),
    antigravity:loadVoiceChoice('antigravity',key=>load(key,'')),
  }));
  const voiceChoice=voiceChoices[service];
  const [threadMenu,setThreadMenu]=useState<{thread:Json;point:MenuPoint;machine:string;archived:boolean;compact?:boolean}|null>(null);
  const [modelPoint,setModelPoint]=useState<MenuPoint|null>(null),modelButton=useRef<HTMLButtonElement>(null);
  const [permissionPoint,setPermissionPoint]=useState<MenuPoint|null>(null),permissionButton=useRef<HTMLButtonElement>(null);
  const [statusPanel,setStatusPanel]=useState<{machine:string;thread:string;point:MenuPoint}|null>(null);
  const [preferenceState,setPreferences]=useState<{machine:string;values:ThreadPreferences}>({machine:'',values:{}});
  const preferences=preferenceState.machine===machine?preferenceState.values:{};
  const [notify,setNotify]=useState<NotifyState>(notifyState),[notifyMessage,setNotifyMessage]=useState('');
  useEffect(()=>{if(sheet!=='home')setNotifyMessage('');else setNotify(notifyState());},[sheet]);
  const notifyItem=<><MenuItem icon="bell" disabled={notify==='unsupported'} onClick={()=>void toggleNotify().then(next=>{setNotify(next);setNotifyMessage(notifyHint[next]);})}>完成通知<span className="menu-detail">{notifyLabel[notify]}</span></MenuItem>{notifyMessage&&<p className="muted" role="status">{notifyMessage}</p>}</>;
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<Json|null>(null);
  const [previewState,setPreviewState]=useState<{tabs:PreviewTab[];activeId:number|null}>({tabs:[],activeId:null}),[filePath,setFilePath]=useState('');
  const preview=previewState.tabs.find(tab=>tab.id===previewState.activeId)?.target||null;
  const previewIds=useRef(0);
  const compactPreview=useCompactPreview();
  const fileSequence=useRef(0),browserSequence=useRef(0);
  const [browserUrl,setBrowserUrl]=useState(defaultPreviewUrl),[browserRequest,setBrowserRequest]=useState<number|null>(null),[browserState,setBrowserSession]=useState<PreviewSession|null>(null),[unreachable,setUnreachable]=useState('');
  const browserRoute=previewRoute(browserUrl,location.protocol==='https:');
  const browserBusy=browserRequest!==null,browserSession=!browserState?.filePath&&belongsToThread(browserState,machine,previewThread)?browserState:null;
  const activeMachine=machines.find(m=>m.id===machine),guest=Boolean(activeMachine?.guest);
  const available=activeMachine?.services;
  // Fall back to another available service when the connected computer does not offer the chosen provider.
  const voiceMode=resolveVoiceProvider(voiceChoice,available);
  const connected=status==='online'&&Boolean(activeMachine)&&(!available||available.includes(service));
  const client=useRef<Client|null>(null),current=useRef({machine,selected,project,newChat,searchQuery,archived,service,connected}),sequence=useRef(0),listLoader=useRef(new SessionListLoader()),infoSequence=useRef(0);
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),refreshing=useRef(false),again=useRef(false),sticky=useRef(true),timeline=useRef<HTMLDivElement>(null),timelineContent=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),submitting=useRef(false);
  const scrollAnchor=useRef<{element:HTMLElement;top:number}|null>(null),lastScrollTop=useRef(0),olderRequest=useRef<object|null>(null);
  const liveFrames=useRef<LiveFrame[]>([]),liveFrame=useRef(0);
  current.current={machine,selected,project,newChat,searchQuery,archived,service,connected};
  const machineName=activeMachine?computerName(activeMachine):'电脑';
  const scope=`${machine}:${selected}`,draftKey=`draft:${scope}`,pendingKey=`operation:${scope}`;
  const call=(action:RequestAction,payload:Json={},target=machine)=>client.current!.request(action,payload,target);
  const stillHere=()=>current.current.service==='codex'&&current.current.machine===machine&&current.current.selected===selected;
  // The claude.ai page a Claude Code conversation has open is remembered with it, as is closing the pane.
  const notePage=(url:string)=>{if(service==='claude'&&remoteConversation)rememberPage(machine,remoteConversation,url);};
  // Pages Claude opens come up beside the chat; on a phone the sheet would cover the reply, so the turn's card stays the way in.
  const showPage=useStableEvent((page:PaneAction)=>{
    const tab=previewState.tabs.find(item=>item.target.kind==='artifact'&&item.target.url===page.url);
    if(!tab){if(page.open&&!compactPreview)showPreview({kind:'artifact',machineId:machine,url:page.url,title:page.title||undefined,fresh:page.fresh});return;}
    setPreviewState(old=>({tabs:old.tabs.map(item=>item.id===tab.id&&item.target.kind==='artifact'?{...item,target:{...item.target,fresh:page.fresh??item.target.fresh}}:item),activeId:page.open&&!compactPreview?tab.id:old.activeId}));
    if(page.open&&!compactPreview)notePage(page.url);
  });
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
    if(next.kind==='artifact')notePage(next.url);
    setSheet(null);
  }
  function closePreviewTab(id:number){browserSequence.current++;const target=previewState.tabs.find(tab=>tab.id===id)?.target;if(target?.kind==='artifact'){const left=previewState.tabs.filter(tab=>tab.id!==id).map(tab=>tab.target).filter(item=>item.kind==='artifact').at(-1);notePage(left?.url||'');}if(target?.kind==='file'&&target.file?.path&&target.file.path===browserState?.filePath)closeBrowser();setPreviewState(old=>{const index=old.tabs.findIndex(tab=>tab.id===id);if(index<0)return old;const tabs=old.tabs.filter(tab=>tab.id!==id);return {tabs,activeId:old.activeId===id?tabs[Math.min(index,tabs.length-1)]?.id??null:old.activeId};});}
  function fail(e:any){setError(e?.message||'操作失败，请重试');}
  function navigate(next:Route,replace=false){
    history[replace?'replaceState':'pushState']({cmwRoute:next,cmwMachine:machine},'',location.pathname);
    rememberLocation(next,machine);setSheet(null);setThreadMenu(null);setStatusPanel(null);setModelPoint(null);setPermissionPoint(null);setRoute(next);
  }
  function backToProjects(){navigate(home);}
  function backToSessions(){navigate({...home,project});}
  useEffect(()=>{
    const pop=(e:PopStateEvent)=>{setSheet(null);setThreadMenu(null);setStatusPanel(null);setModelPoint(null);setPermissionPoint(null);const location=parseLocation(e.state);const next=location?.machine===current.current.machine?location.route:home;rememberLocation(next,current.current.machine);setRoute(next);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=>{history.replaceState({cmwRoute:route,cmwMachine:machine},'',location.pathname);rememberLocation(route,machine);},[machine]);
  async function refreshSession(){
    if(refreshing.current){again.current=true;return;}
    const c={...current.current};if(!c.connected||c.service!=='codex'||!c.machine||!c.selected||!client.current?.ready)return;
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
  function scheduleRefresh(){if(refreshTimer.current||document.visibilityState!=='visible'&&!watchWhileHidden(viewRef.current?.running))return;refreshTimer.current=setTimeout(()=>{refreshTimer.current=undefined;void refreshSession();},16);}
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
    request:(action,payload)=>call(action,payload),
    draft:()=>draft,setDraft:editDraft,
    error:fail,
  });
  const voiceBusy=voice.state!=='idle',voiceLabel=voiceProviderLabel(voiceMode);
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
      if(m.type==='ready'){setMe(m.user||null);teamDevice.current=m.device?.id||'';}
      if(m.type==='team.user')setMe(m.user||null);
      if(m.type==='changed'&&m.machineId===current.current.machine&&(!m.threadId||m.threadId===current.current.selected))scheduleRefresh();
      if(m.type==='live'&&current.current.service==='codex'&&m.machineId===current.current.machine&&m.threadId===current.current.selected)receiveLive(m as LiveFrame);
    },setStatus,next=>save('connection',next));client.current=c;
    return()=>{c.close();clearTimeout(refreshTimer.current);cancelAnimationFrame(liveFrame.current);liveFrame.current=0;liveFrames.current=[];};
  },[token]);
  useEffect(()=>client.current?.onPreview(message=>{
    if(message.type==='preview.disconnected'||message.type==='preview.ended'&&message.sessionId===browserState?.sessionId){setBrowserSession(null);setPreviewState(old=>{const tabs=old.tabs.filter(tab=>tab.target.kind!=='web');return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});}
  }),[token,browserState?.sessionId]);
  useEffect(()=>{
    if(!machine&&machines[0]){changeMachine(machines[0].id);return;}
    const next=supportedRoute(route,available);
    if(next!==route)navigate(next,true);
  },[machines,machine,route,available]);
  useEffect(()=>{client.current?.watch(codexActive&&machine&&selected?{machineId:machine,threadId:selected}:null);},[token,machine,selected,codexActive]);
  useEffect(()=>{setPreferences({machine,values:load(`thread-preferences:${machine}`,{})});setThreadMenu(null);},[machine]);
  useEffect(()=>{
    draftSave.current.flush();
    setStatusPanel(null);setModelPoint(null);setPermissionPoint(null);
    attachments.reset();setUploadProgress(null);
    setBrowserRequest(null);setBrowserUrl(load(previewUrlKey(machine,selected),defaultPreviewUrl));
    // Show the last known content at once; it stays marked as cached until the read below lands.
    const cached=selected?cachedView(`${machine}:${selected}`):null;
    if(selected)traceOpen('codex',`${machine}:${selected}`,'start');
    sequence.current++;setView(cached);setLoading(Boolean(selected)&&!cached);olderRequest.current=null;setLoadingOlder(false);setHistoryError('');setModel('');setEffort('');setApproval('');setError('');setNotice('');sticky.current=true;scrollAnchor.current=null;lastScrollTop.current=0;
    setServiceTier(undefined);
    // A message that is still being sent keeps its place when a new chat turns into its thread.
    const sending=optimisticRef.current?.key===scope;setOptimistic(old=>old?.key===scope?old:null);
    setDraft(sending?'':load(draftKey,''));setPending(load(pendingKey,null));void refreshSession();
  },[machine,selected,newChat]);
  useEffect(()=>{
    if(!view||view.id!==selected)return;
    const cachedShown=Boolean((view as CachedView).cached);
    traceOpen('codex',`${machine}:${selected}`,cachedShown?'cached':'fresh');
    if(!cachedShown)rememberView(`${machine}:${selected}`,view);
  },[view]);
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
  useEffect(()=>{
    if(!connected||!codexActive)return;
    // A safety net for missed notices: the open thread also renews its live watch here.
    let ticks=0;
    const foreground=()=>{if(document.visibilityState!=='visible'&&!(current.current.selected&&watchWhileHidden(viewRef.current?.running)))return;if(current.current.selected)void refreshSession();else void list();};
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
  function startNew(){if(!connected||busy)return;const cwd=project||view?.cwd||info?.roots?.[0]||'';setNewCwd(cwd);navigate({...route,thread:'',newChat:true});if(guest&&!cwd)setSheet('projects');}
  function selectProject(path:string){setNewCwd(path);setModel('');setEffort('');setApproval('');setSheet(null);}
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
    if(owner.service==='antigravity'||owner.service==='claude')return call(`${owner.service}.file.${action}`,{conversationId:owner.id,...payload},ownerMachine);
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
  // An address goes by its own shape: claude.ai pages and the computer's side of the network through the computer, other pages straight from this device.
  async function openBrowser(address:string|{filePath:string}=browserUrl,fileTarget?:Extract<PreviewTarget,{kind:'file'}>,unchecked=false){
    const thread=fileTarget?.threadId||previewThread,owner=fileTarget?.machineId||machine;
    if(!thread)return;
    let direct=false;
    if(typeof address==='string'){
      address=address.trim();setBrowserUrl(address);setUnreachable('');
      const way=previewRoute(address,location.protocol==='https:');
      if(!way){setError('网页地址无效，需要以 http:// 或 https:// 开头');return;}
      if(way==='external'){window.open(address,'_blank','noopener,noreferrer');return;}
      if(way==='artifact'){if(!connected)return;const url=address,old=previewState.tabs.map(tab=>tab.target).find(target=>target.kind==='artifact'&&target.url===url);showPreview(old?.kind==='artifact'?old:{kind:'artifact',machineId:owner,url});return;}
      direct=way==='direct';
    }
    if(!direct&&!connected)return;
    const request=++browserSequence.current;
    const here=()=>previewOwner.current.machine===owner&&previewOwner.current.thread===previewThread&&request===browserSequence.current;
    setBrowserRequest(request);setError('');
    if(direct){
      const url=address as string,found=unchecked||await reachable(url);
      if(here()){if(found){save(previewUrlKey(owner,thread),url);showPreview({kind:'site',machineId:owner,threadId:thread,url});}else setUnreachable(url);}
      setBrowserRequest(old=>old===request?null:old);return;
    }
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
  function changeMachine(id:string){setSheet(null);if(id===machine)return;closeBrowser();closePreview();infoSequence.current++;listLoader.current.invalidate();setListBusy(false);setInfo(null);setProjects([]);setSessions([]);setSearch('');setSearchQuery('');setArchived(false);setNewCwd('');const next=id?supportedRoute(serviceHome(service),machines.find(item=>item.id===id)?.services):home;history.replaceState({cmwRoute:next,cmwMachine:id},'',location.pathname);rememberLocation(next,id);setMachine(id);setRoute(next);}
  function logout(){
    // A member signing out also removes this device, so its token stops working everywhere.
    if(me&&teamDevice.current&&client.current?.ready)void client.current.team('team.devices.revoke',{deviceId:teamDevice.current}).catch(()=>{});
    client.current?.close();save('connection','');setMe(null);teamDevice.current='';setToken('');setView(null);setInfo(null);setMachines([]);setOptimistic(null);void clearCache();changeMachine('');}
  async function copyText(text:string){
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
      else {
        const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();
        try{if(!document.execCommand('copy'))throw Error('copy failed');}finally{input.remove();}
      }
  }
  const markdownOpenFile=useStableEvent(openFile),markdownOpenPreview=useStableEvent((url:string)=>{if(isArtifactUrl(url)){const old=previewState.tabs.map(tab=>tab.target).find(target=>target.kind==='artifact'&&target.url===url);showPreview(old?.kind==='artifact'?old:{kind:'artifact',machineId:machine,url});}else void openBrowser(url);}),markdownFollowup=useStableEvent(insertFollowup);
  const notifyView=codexActive&&!newChat&&view?.id===selected?view:null;
  useTurnNotice(`codex:${machine}:${selected}`,notifyView?Boolean(notifyView.running):undefined,notifyView?.requests.length||0,()=>{
    const turn=view?.turns.at(-1);
    return {service:'Codex',title:view?.title,status:turn?.status,reply:turn?.items.filter(item=>item.role==='assistant').at(-1)?.text,error:turn?.error};
  });
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
  const attachments=useComposerAttachments({disabled:busy,imagesBlocked:canImage?undefined:'当前模型未确认图片能力',notify:setError,added:()=>setSheet(null)});
  const {images,files,setImages,setFiles}=attachments,imageLoading=attachments.loading;
  const pick=useAttachmentPickers(chosen=>void attachments.add(chosen));
  useEffect(()=>{setPreviewState(old=>{let changed=false;const tabs=old.tabs.flatMap(tab=>{if(tab.target.kind!=='image')return [tab];const index=images.indexOf(tab.target.url);if(index<0){changed=true;return [];}const title=`待发送图片 ${index+1}/${images.length}`;if(title!==tab.target.title){changed=true;return [{...tab,target:{...tab.target,title}}];}return [tab];});if(!changed)return old;return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});},[images]);
  const modelLabel=modelDisplayName(modelInfo,selection.id)||'选择模型';
  const inheritedApproval=newChat?info?.approvalPolicy:view?.approvalPolicy;
  // A cached view is only shown; its turn and generation may be outdated.
  const cachedShown=Boolean((view as CachedView|null)?.cached);
  const canWrite=connected&&!busy&&!pending&&!imageLoading&&!voiceBusy&&(newChat?Boolean(newCwd):!cachedShown&&Boolean(view?.canControl||queueNext&&view&&view.source!=='history'));
  const canOperate=connected&&!busy&&!pending&&!cachedShown&&Boolean(view?.canControl);
  // Hidden in the same render that shows the delivered message, so the two never appear together.
  const pendingShown=optimistic&&optimistic.key===scope&&!optimisticDelivered(optimistic,view)?optimistic:null;
  const attachmentCount=images.length+files.length,selectedImageBytes=images.reduce((sum,url)=>sum+imageBytes(url),0);
  const effortLabel=reasoningLabel(selection.effort),sending=busy&&(Boolean(uploadProgress)||pending?.action==='turn.send'||pending?.action==='session.create');
  const listedThreads=useMemo(()=>ownedBy(visibleThreads(sessions,preferences,project,archived,searchQuery),me,onlyMine),[sessions,preferences,project,archived,searchQuery,me,onlyMine]);
  const visibleTitle=newChat?'新聊天':view?.title||sessions.find(s=>s.id===selected)?.title||'正在打开…';
  const conversationCopy=useStableEvent((text:string)=>void copyText(text).then(()=>setNotice('已复制文字')).catch(()=>setError('复制失败，请长按选择文字')));
  const conversationEdit=useStableEvent((turnId:string,itemId:string,text:string)=>editTurn(mutate,target(),{turnId,itemId,text},{model,effort,approvalPolicy:approval,serviceTier}));
  const conversationFork=useStableEvent(fork),conversationDiff=useStableEvent((turn:TurnView)=>showPreview({kind:'diff',threadId:selected,turnId:turn.id,text:turn.diff!}));
  const conversation=useMemo(()=>view?.turns.map(turn=><ConversationTurn key={turn.id} turn={turn} running={Boolean(view.running)} source={view.source} latestUser={turn.id===latestUserTurn} disabled={!connected||busy||Boolean(pending)} openFile={markdownOpenFile} openPreview={markdownOpenPreview} onFollowup={markdownFollowup} onCopy={conversationCopy} onEdit={conversationEdit} onFork={conversationFork} onDiff={conversationDiff} onBlocked={setNotice}/>),[view?.turns,view?.running,view?.source,latestUserTurn,connected,busy,Boolean(pending),markdownOpenFile,markdownOpenPreview,markdownFollowup,conversationCopy,conversationEdit,conversationFork,conversationDiff]);
  const feedback=<>{error&&<div className="feedback error" role="alert"><span>{error}</span><IconButton icon="close" label="关闭提示" onClick={()=>setError('')}/></div>}{notice&&<div className="feedback" role="status">{notice}</div>}{pending&&!busy&&<div className="pending"><button onClick={()=>void checkPending()}>核实操作结果</button><button onClick={()=>{if(window.confirm('请先查看最新任务，确认这次操作的实际结果。清除提示不会重发旧操作。')){setOperation(null);setNotice('');setOptimistic(old=>old?.key===scope?null:old);}}}>我已核实</button></div>}</>;

  if(!token||status==='auth_error')return <main className="connect"><Icon name="computer" size={38}/><h1>连接你的电脑</h1><p>通过自部署中继继续电脑上的对话。</p><form onSubmit={e=>{e.preventDefault();const value=inviteCode(tokenInput)||tokenInput.trim();save('connection',value);setToken(value);}}><label>中继地址<input readOnly value={location.origin}/></label><label>邀请链接或连接 Token<input type="password" autoComplete="off" value={tokenInput} onChange={e=>setTokenInput(e.target.value)} placeholder="粘贴团队邀请链接，或电脑上的连接 Token" required/></label>{status==='auth_error'&&<p className="error">登录信息无效或已失效。请重新输入，团队成员请向管理员要新的邀请链接。</p>}<button className="primary">连接</button></form><small>也可以用手机扫描电脑上的连接二维码。</small></main>;
  const selectService=(next:Service)=>navigate(switchRoute(machine,route,next));
  const switcher=<ServiceSwitch active={service} available={available} disabled={busy||voiceBusy||imageLoading} select={selectService}/>;
  const previewPane=preview&&<PreviewPane title={previewTitle(preview)} subtitle={preview.kind==='file'?preview.file?.path||preview.path:preview.kind==='web'?preview.session.url:preview.kind==='site'?`${preview.url} · 手机直接访问`:preview.kind==='artifact'?'经电脑中转，手机不直接访问 claude.ai':undefined}
       tabs={previewState.tabs.map(tab=>({id:tab.id,title:previewTitle(tab.target)}))} activeTab={previewState.activeId}
       selectTab={id=>{const target=previewState.tabs.find(tab=>tab.id===id)?.target;if(target?.kind==='artifact')notePage(target.url);setPreviewState(old=>({...old,activeId:id}));}} closeTab={closePreviewTab}
       compact={compactPreview} covered={Boolean(sheet||threadMenu||statusPanel||modelPoint||permissionPoint)} close={()=>{if(previewState.tabs.some(tab=>tab.target.kind==='artifact'))notePage('');closePreview();}}>
       {previewState.tabs.map(({id,target})=><div key={id} id={`preview-panel-${id}`} aria-labelledby={`preview-tab-${id}`} className="preview-tab-panel" role="tabpanel" hidden={id!==previewState.activeId}>
         {target.kind==='file'&&(target.file?<Suspense fallback={<p className="preview-notice" role="status">正在加载查看器…</p>}><FilePreviewPanel allowFileUrls={fileOwner(target.threadId).service!=='codex'} key={target.request} file={target.file} connected={connected} line={target.line} openFile={path=>void openFile(path,target.machineId,target.threadId)}
           htmlPreview={browserState?.filePath===target.file.path&&belongsToThread(browserState,target.machineId,target.threadId)?<WebViewer session={browserState} onEnd={closeBrowser}/>:browserBusy?<p role="status">正在打开网页…</p>:null}
           htmlError={target.error} openHtml={()=>void openBrowser({filePath:target.file!.path},target)}
           readFile={path=>fileRequest('read',target.machineId,target.threadId,{path})}
           read={offset=>fileRequest('download',target.machineId,target.threadId,{path:target.file!.path,revision:target.file!.revision,offset})}/></Suspense>:<div className="preview-empty" role={target.error?'alert':'status'}><p>{target.error||'正在读取文件…'}</p>{target.error&&<button disabled={!connected} onClick={()=>void openFile(target.path+(target.line?`:${target.line}`:''),target.machineId,target.threadId)}>重试</button>}</div>)}
         {target.kind==='diff'&&<Suspense fallback={<p className="preview-notice">正在加载差异…</p>}><DiffViewer text={target.text} compact={compactPreview}/></Suspense>}
         {target.kind==='web'&&<WebViewer session={target.session} onEnd={closeBrowser}/>}
         {target.kind==='site'&&<PageViewer src={target.url} address={target.url} widthKey={previewWidthKey(target.machineId,target.threadId)} onEnd={()=>closePreviewTab(id)} endLabel="关闭"/>}
         {target.kind==='artifact'&&<ArtifactPanel url={target.url} fresh={target.fresh} connected={connected&&target.machineId===machine} call={(action,payload)=>call(action,payload,target.machineId)}
           onTitle={title=>setPreviewState(old=>({...old,tabs:old.tabs.map(tab=>tab.id===id&&tab.target.kind==='artifact'?{...tab,target:{...tab.target,title}}:tab)}))}/>}
         {target.kind==='image'&&<div className="image-viewer"><img className="preview-image" src={target.url} alt={target.title}/></div>}
       </div>)}
     </PreviewPane>;
  const computerOptions=<><div className="connection-status"><i className={connected?'dot online':'dot'}/>{connected?'已连接':status==='online'?'等待电脑上线':'正在连接中继…'}</div>{machines.map(m=>{const gap=versionGap(m);return <MenuItem icon="computer" key={m.id} disabled={busy} onClick={()=>changeMachine(m.id)}>{computerName(m)}{gap&&<span className="menu-detail">{gap==='page'?'请刷新网页':'需更新'}</span>}{m.id===machine&&<Icon name="check" size={18}/>}</MenuItem>;})}{!machines.length&&<p className="muted">请在电脑启动连接器。</p>}{activeMachine&&versionGap(activeMachine)&&<p className="muted">{versionGapNotice[versionGap(activeMachine)!]}</p>}<p className="muted">{location.origin}</p></>;
  // Each app keeps its own voice input setting in this browser; the active sheet edits the current app's choice.
  const nativeVoice=defaultVoiceProvider(service);
  const voiceOptionLabel=(provider:VoiceProvider)=>`${voiceProviderLabel(provider)}${provider===nativeVoice?'（推荐）':''}`;
  const voiceOptions=<>
    <label>识别方式<select value={voiceChoice} onChange={e=>{const mode=voiceProvider(e.target.value,nativeVoice);setVoiceChoices(old=>({...old,[service]:mode}));save(voiceEngineKey(service),mode);}}>
      <option value="claude">{voiceOptionLabel('claude')}</option>
      <option value="antigravity">{voiceOptionLabel('antigravity')}</option>
      <option value="codex">{voiceOptionLabel('codex')}</option>
      <option value="keyboard">{voiceOptionLabel('keyboard')}</option>
    </select></label>
    <p className="muted">{
      voiceChoice==='claude'?'点麦克风开始说话，文字边说边出现，说完点 ✓，最后会再校对一遍。用电脑上 Claude Code 的 claude.ai 登录，与 Claude Code 自带的语音输入是同一个服务；需要 HTTPS。声音经中继、电脑实时发送到语音服务。'
      :voiceChoice==='antigravity'?'点麦克风开始说话，文字边说边出现，说完点 ✓。使用电脑上 Antigravity 桌面的语音服务，无需额外登录；需要 HTTPS。声音经中继、电脑实时发送到本机 Antigravity。'
      :voiceChoice==='codex'?'点麦克风开始录音，说完点 ✓，整段识别后填入输入框。需要 HTTPS 和电脑上 Codex 的 ChatGPT 登录。录音经中继、电脑发送到语音服务。'
      :'点麦克风打开输入框，再使用手机键盘上的听写。'
    }</p>
    {voiceMode!==voiceChoice&&<p className="muted">这台电脑暂不支持 {voiceProviderLabel(voiceChoice)}，当前改用 {voiceProviderLabel(voiceMode)}。</p>}
    <p className="muted">此设置仅用于 {serviceLabel(service)}，保存在当前浏览器；不同应用可分别选择。</p>
    <button className="primary" onClick={()=>setSheet(null)}>完成</button>
  </>;
  const teamItems=me&&<><MenuItem icon="team" onClick={()=>setSheet('team')}>团队<span className="menu-detail">{me.name}</span></MenuItem>
    <MenuItem icon="chat" onClick={()=>{setOnlyMine(!onlyMine);save('only-mine',!onlyMine);setSheet(null);}}>只看我的会话{onlyMine&&<Icon name="check" size={18}/>}</MenuItem></>;
  const teamPanel=me&&<TeamPanel me={me} team={(action,payload)=>client.current?client.current.team(action,payload):Promise.reject({message:'尚未连接中继'})} logout={logout} copy={copyText}
    machines={new Map(machines.map(item=>[item.id,computerName(item)]))}/>;
  const fileOptions=<form onSubmit={e=>{e.preventDefault();void openFile(filePath);}}><label>文件路径<input autoFocus required value={filePath} onChange={e=>setFilePath(e.target.value)} placeholder="例如 README.md 或 docs/deck.pptx"/></label>{error&&<p className="error" role="alert">{error}</p>}<button className="primary">打开文件</button></form>;
  if(service==='antigravity'||service==='claude'){
    const id=remoteConversation,inert=Boolean(sheet||compactPreview&&preview);
    const open=(next:string)=>{setClaudeNewCwd(null);if(next!==id){navigate(withConversation(route,next));if(!next)refreshRemoteList(value=>value+1);}};
    const creatingClaude=service==='claude'&&!id&&claudeNewCwd!==null,creatingAntigravity=service==='antigravity'&&!id&&claudeNewCwd!==null;
    const created=(next:string)=>{setClaudeNewCwd(null);refreshRemoteList(value=>value+1);navigate(withConversation(route,next),true);};
    const forked=(next:string)=>{refreshRemoteList(value=>value+1);open(next);};
    async function claudeChange(action:RequestAction,payload:Json){
      const result=await call(action,{...payload,opId:operationId()});
      if(result.state!=='accepted')throw new Error(result.error?.message||'结果待核实，请刷新列表查看。');
      return result;
    }
    const claudeActions=(thread:Json)=>({
      rename:async(title:string)=>{await claudeChange('claude.rename',{conversationId:thread.id,title});},
      archive:async()=>{await claudeChange('claude.archive',{conversationId:thread.id});if(thread.id===id)open('');},
      duplicate:async()=>{forked((await claudeChange('claude.fork',{conversationId:thread.id})).conversationId);},
    });
    return <SenderRoot me={me?.id}><div className={`shell ${id||creatingClaude||creatingAntigravity?'has-session':''}`}>
      <AntigravitySidebar key={`${service}:${machine}`} inert={inert} selected={id} project={route.project} machine={machine} machineName={machineName}
        copyText={copyText} threadActions={service==='claude'?claudeActions:undefined} connected={connected} relayOnline={status==='online'}
        revision={remoteListRevision} switcher={switcher} call={call} open={open} chooseProject={project=>navigate(serviceHome(service,project))}
        listAction={`${service}.list`} appName={serviceLabel(service)} filter={threads=>ownedBy(threads,me,onlyMine)} action={service==='claude'&&route.project?
          <div className="claude-project-actions"><button type="button" disabled={!connected} onClick={()=>setSheet('claude-project')}>项目设置</button></div>:undefined}
        onNew={project=>{setClaudeNewCwd(project);if(id)navigate(withConversation(route,''));}}
        chooseComputer={()=>setSheet('computer')} more={()=>setSheet('home')}/>
      {(id||creatingClaude)&&service==='claude'?<ClaudeCodePanel key={JSON.stringify([machine,service,id])} inert={inert} openFile={markdownOpenFile} openPreview={markdownOpenPreview} showPage={showPage} previewError={error}
        machine={machine} guest={guest} newCwd={id?null:claudeNewCwd} created={created} forked={forked}
        showDiff={turn=>{if(turn.diff)showPreview({kind:'diff',threadId:`claude:${id}`,turnId:turn.id,text:turn.diff});}} voiceMode={voiceMode} chooseVoice={()=>setSheet('voice')} actions={claudeActions}
        showImage={(url,title)=>showPreview({kind:'image',url,title})}
        machineName={machineName} connected={connected} conversationId={id} call={call} go={open}
        showFiles={()=>{setFilePath('');setSheet('file');}} copyText={copyText} clearPreviewError={()=>setError('')}/>:
        id||creatingAntigravity?<AntigravityPanel key={JSON.stringify([machine,service,id])} inert={inert} openFile={markdownOpenFile} openPreview={markdownOpenPreview} previewError={error}
        machine={machine} machineName={machineName} connected={connected} conversationId={id} call={call} go={open} newProject={id?null:claudeNewCwd} created={created} voiceMode={voiceMode} chooseVoice={()=>setSheet('voice')}
        showImage={(url,title)=>showPreview({kind:'image',url,title})}
        showFiles={()=>{setFilePath('');setSheet('file');}} copyText={copyText} clearPreviewError={()=>setError('')}/>:
        <main className="thread-panel" inert={inert}><div className="desktop-welcome"><h1>选择一个聊天</h1></div></main>}
      {sheet==='home'&&<SheetPanel title="选项" close={()=>setSheet(null)}>
        <MenuItem icon="computer" onClick={()=>setSheet('computer')}>切换电脑</MenuItem>
        {teamItems}
        <MenuItem icon="refresh" disabled={!connected} onClick={()=>{setSheet(null);refreshRemoteList(value=>value+1);}}>刷新项目与会话</MenuItem>
        <MenuItem icon="mic" onClick={()=>setSheet('voice')}>语音输入<span className="menu-detail">{voiceLabel}</span></MenuItem>
        {notifyItem}
        <MenuItem icon="logout" onClick={logout}>{me?'退出登录':'断开连接'}</MenuItem>
      </SheetPanel>}
      {sheet==='voice'&&<SheetPanel title={`语音输入 · ${serviceLabel(service)}`} close={()=>setSheet(null)}>{voiceOptions}</SheetPanel>}
      {sheet==='team'&&teamPanel&&<SheetPanel title="团队" close={()=>setSheet(null)}>{teamPanel}</SheetPanel>}
      {sheet==='computer'&&<SheetPanel title="电脑" close={()=>setSheet(null)}>{computerOptions}</SheetPanel>}
      {sheet==='file'&&<SheetPanel title="查看项目文件" close={()=>setSheet(null)}>{fileOptions}</SheetPanel>}
      {sheet==='claude-project'&&route.project&&<SheetPanel title="项目设置" close={()=>setSheet(null)}>
        <ClaudeProjectEditor key={route.project} folder={route.project} connected={connected} call={call} done={()=>setSheet(null)}/></SheetPanel>}
      {previewPane}
    </div></SenderRoot>;
  }
  return <SenderRoot me={me?.id}><div className={`shell ${showThread?'has-session':''}`}>
    <aside className="home-panel" inert={Boolean(sheet||threadMenu||statusPanel||modelPoint||permissionPoint||compactPreview&&preview)}>
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

    <main className="thread-panel" inert={Boolean(sheet||threadMenu||statusPanel||modelPoint||permissionPoint||compactPreview&&preview)}>{!showThread?<div className="desktop-welcome"><h1>我们来处理</h1><button className="center-project" onClick={startNew} disabled={!connected}><Icon name="folder"/><span>{projectName(project||info?.roots?.[0]||'选择一个项目')}</span><Icon name="chevron" size={18}/></button></div>:<>
      <ThreadHeader title={visibleTitle} project={projectName(newChat?newCwd:view?.cwd||project)||'项目'} machineName={machineName} connected={connected} back={backToSessions} backDisabled={busy} onTitle={element=>newChat?setSheet('projects'):openStatus(element)}>
        <button type="button" className="icon-button" aria-haspopup="dialog" aria-label={`会话状态：${contextSummary(view?.contextUsage)}`} title="上下文与额度限制" disabled={!selected} onClick={e=>openStatus(e.currentTarget)}><ContextIndicator usage={view?.contextUsage}/></button><button type="button" className="icon-button" aria-haspopup="dialog" aria-label="会话操作" disabled={!selected||busy} onClick={e=>openThreadMenu(e.currentTarget)}><Icon name="more"/></button>
      </ThreadHeader>
       {browserSession&&<BrowserPreviewPanel session={browserSession} onOpen={()=>showPreview({kind:'web',session:browserSession})} onClose={closeBrowser}/>}
      {view?.notice&&!newChat&&<div className="banner">{view.notice}{!guest&&view.source==='history'&&!view.resumeUnavailable&&<button disabled={!connected||busy||Boolean(pending)} onClick={()=>{if(window.confirm('确认原桌面或 CLI 中的任务已经结束？继续后将由本连接器运行。'))void mutate('session.resume',{threadId:selected,confirmIdle:true});}}>在这里继续</button>}</div>}
      <div className={`timeline ${newChat||(!loading&&view&&!view.turns.length)?'is-empty':''}`} ref={timeline} onScroll={()=>{const el=timeline.current!,up=el.scrollTop<lastScrollTop.current,distance=el.scrollHeight-el.scrollTop-el.clientHeight;lastScrollTop.current=el.scrollTop;
          // Content that shrinks at the bottom moves the position up without the user; still at the bottom means still following.
          sticky.current=distance<24&&(!up||distance<2);if(up&&el.scrollTop<160&&!historyError)void loadOlder();}}>
        <div className="timeline-content" ref={timelineContent}>
        {loading&&!newChat&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
        {view?.hasMore&&!newChat&&<button className="more-link earlier" disabled={!connected||loadingOlder} onClick={()=>void loadOlder()}>{loadingOlder?'正在加载…':historyError?`${historyError} · 重试`:'加载更早内容'}</button>}
        {pendingShown&&(newChat||!view?.turns.length)?null:newChat||(!loading&&view&&!view.turns.length)?<div className="new-chat-welcome"><h1>我们来处理</h1><button className="center-project" disabled={!newChat||busy} onClick={()=>setSheet('projects')}><Icon name="folder"/><span>{projectName(newChat?newCwd:view?.cwd||'')||'选择项目'}</span>{newChat&&<Icon name="chevron" size={17}/>}</button></div>:<SenderScope senders={view?.turns.flatMap(turn=>turn.items.map(item=>item.sender))||[]}>{conversation}</SenderScope>}
        {pendingShown&&<PendingMessage message={pendingShown} openFile={markdownOpenFile} openPreview={markdownOpenPreview} onFollowup={markdownFollowup}/>}
        {!newChat&&view?.retry&&<ConversationStatus>{view.retry}</ConversationStatus>}
        {!connected?<ConversationStatus>{!everOnline.current?'正在连接电脑…':cachedShown?'与电脑的连接中断，以下是上次打开时的内容。':connectionLost}</ConversationStatus>:cachedShown&&<ConversationStatus>正在同步最新内容…</ConversationStatus>}
        </div>
      </div>
      <div className="composer-area"><div className="request-stack">{!newChat&&view?.requests.map(req=><RequestCard key={`${view.generation}:${req.id}`} request={req} disabled={!canOperate} respond={response=>void mutate('request.respond',{...target(),requestId:req.id,response})}/>)}</div>{feedback}
        {connected&&view?.running&&!newChat&&!view.retry&&view.turns.at(-1)?.items.at(-1)?.type!=='retry'&&<div className="running-status"><i className="dot online"/>Codex 正在处理</div>}
        {!newChat&&view?.queuedMessages&&<QueuedMessages messages={view.queuedMessages} disabled={!connected||busy||Boolean(pending)} canSteer={canOperate&&Boolean(view.activeTurnId)} withdrawBlocked={imageLoading||voiceBusy}
          attachmentsFull={message=>attachmentCount+message.imageCount+(message.fileNames?.length||0)>MAX_ATTACHMENTS||selectedImageBytes+(message.imageBytes||0)>MAX_TOTAL_IMAGE_BYTES}
          onSteer={queuedId=>void mutate('turn.steerQueued',{...target(),queuedId})} onWithdraw={queuedId=>void mutate('turn.withdrawQueued',{threadId:selected,queuedId})} onCancel={queuedId=>void mutate('turn.cancelQueued',{threadId:selected,queuedId})}/>}
        <Composer attachments={attachments} input={composer} draft={draft} edit={editDraft} readOnly={busy} submit={()=>void submit()}
          placeholder={queueNext?'当前任务完成后发送…':newChat||!view?.turns.length?'接下来我们该写什么代码？':`在 ${machineName} 上继续…`}
          locked={busy} showImage={(url,title)=>showPreview({kind:'image',url,title})} uploadProgress={uploadProgress}
          voice={voice} voiceMode={voiceMode} voiceDisabled={busy} onVoiceStart={()=>{setError('');setNotice('');}} connected={connected}
          add={()=>setSheet('add')} addDisabled={busy||imageLoading}
          permission={<PermissionButton ref={permissionButton} options={APPROVALS} value={approval} current={{id:inheritedApproval||'',label:approvalName(inheritedApproval)}} expanded={Boolean(permissionPoint)} disabled={busy} open={setPermissionPoint}/>}
          model={<ModelButton ref={modelButton} label={modelLabel} details={[effortLabel,isFast?'极速':''].filter(Boolean)} expanded={Boolean(modelPoint)} disabled={busy} open={setModelPoint}/>}
          running={view?.activeTurnId&&!newChat?{stop:()=>void mutate('turn.stop',target()),disabled:!canOperate,queue:true}:undefined}
          send={{label:queueNext?'完成后发送':'发送消息',sending,disabled:!canWrite||!draft.trim()&&!attachmentCount}}/>
        {pick.inputs}
      </div>
    </>}</main>

     {threadMenu&&threadMenu.machine===machine&&<ThreadMenu key={`${machine}:${threadMenu.thread.id}`} thread={threadMenu.thread} point={threadMenu.point} preference={preferences[threadMenu.thread.id]||{}} sections={[...new Set(Object.values(preferences).map(p=>p.section).filter((s):s is string=>Boolean(s)))]} archived={threadMenu.archived} compact={threadMenu.compact} connected={connected} close={()=>setThreadMenu(current=>current===threadMenu?null:current)} change={patch=>changePreference(threadMenu.thread.id,patch,threadMenu.thread)} copy={()=>copyText(threadMenu.thread.id)} rename={name=>changeThread('session.rename',threadMenu.thread,{name})} archive={()=>changeThread(threadMenu.archived?'session.unarchive':'session.archive',threadMenu.thread)} openPreview={threadMenu.compact?()=>setSheet('browser'):undefined}/>}
     {statusPanel&&statusPanel.machine===machine&&statusPanel.thread===selected&&<ThreadStatusPanel key={`${machine}:${selected}`} point={statusPanel.point} view={view} threadId={selected} cwd={view?.cwd||project} connected={connected} close={()=>setStatusPanel(current=>current===statusPanel?null:current)} copy={()=>copyText(selected)} read={()=>call('session.status',{threadId:selected})}/>}
     {permissionPoint&&<PermissionPicker anchor={permissionButton.current} point={permissionPoint} options={APPROVALS} value={approval} current={{id:inheritedApproval||'',label:approvalName(inheritedApproval)}} title="许可" disabled={busy} onChange={setApproval} close={()=>setPermissionPoint(null)}/>}
     {modelPoint&&<ModelPicker anchor={modelButton.current} point={modelPoint} models={availableModels} value={{model,effort,serviceTier}} current={currentModel} disabled={busy} onChange={value=>{setModel(value.model);setEffort(value.effort);setServiceTier(value.serviceTier);}} close={()=>setModelPoint(null)}/>}
     {sheet&&<SheetPanel title={sheet==='voice'?`语音输入 · ${serviceLabel(service)}`:({home:'选项',computer:'电脑',projects:'选择项目',add:'添加与选项',file:'查看项目文件',browser:'打开网页','claude-project':'项目',team:'团队'} as const)[sheet]} close={()=>{if(sheet==='browser'){browserSequence.current++;setBrowserRequest(null);setUnreachable('');}setSheet(null);}}>
       {sheet==='home'&&<><MenuItem icon="compose" disabled={!connected||busy} onClick={startNew}>新聊天</MenuItem><MenuItem icon="computer" onClick={()=>setSheet('computer')}>切换电脑</MenuItem>{teamItems}<MenuItem icon="refresh" disabled={!connected||listBusy} onClick={()=>{setSheet(null);refreshInfo();void list(false,true);}}>刷新项目与会话</MenuItem><MenuItem icon="chat" disabled={!connected||busy} onClick={()=>{setArchived(!archived);setSheet(null);}}>{archived?'查看最近会话':'查看归档会话'}</MenuItem><MenuItem icon="mic" onClick={()=>setSheet('voice')}>语音输入<span className="menu-detail">{voiceLabel}</span></MenuItem>{notifyItem}<MenuItem icon="logout" disabled={busy} onClick={logout}>{me?'退出登录':'断开连接'}</MenuItem></>}
      {sheet==='computer'&&computerOptions}
       {sheet==='projects'&&<><div className="project-choices">{projects.map(p=><MenuItem icon="folder" key={p} disabled={busy} onClick={()=>selectProject(p)}><span>{projectName(p)}<small>{p}</small></span>{p===newCwd&&<Icon name="check" size={18}/>}</MenuItem>)}</div>
         {guest?<GuestProjectForm connected={connected&&!busy} call={call} select={path=>{setProjects(old=>[...new Set([...old,path])]);selectProject(path);}}/>:
         <details className="other-project"><summary>其他项目目录</summary><form onSubmit={e=>{e.preventDefault();setSheet(null);}}><label>电脑上的完整项目路径<input value={newCwd} onChange={e=>setNewCwd(e.target.value)} required/></label><button className="primary">使用这个目录</button></form></details>}</>}
       {sheet==='voice'&&voiceOptions}
       {sheet==='team'&&teamPanel}
       {sheet==='add'&&<AddOptions attachments={attachments} pick={pick} disabled={busy} connected={connected} error={error} imagesBlocked={canImage?undefined:'当前模型未确认图片能力'}
         voiceLabel={voiceLabel} chooseVoice={()=>setSheet('voice')} browse={selected?()=>setSheet('browser'):undefined}
         projectFiles={selected?()=>setSheet('file'):undefined} refresh={selected?()=>{setSheet(null);void refreshSession();}:undefined} chooseProject={newChat?()=>setSheet('projects'):undefined}/>}
       {sheet==='file'&&fileOptions}
       {sheet==='browser'&&selected&&<form onSubmit={e=>{e.preventDefault();void openBrowser();}}><label>网页地址<input autoFocus required type="url" value={browserUrl} onChange={e=>{setBrowserUrl(e.target.value);setUnreachable('');save(previewUrlKey(machine,selected),e.target.value);}} placeholder="http://127.0.0.1:5173"/></label><p className="muted">{browserRoute?ROUTE_HINT[browserRoute]:'本机和局域网地址通过电脑打开，其他 https 地址由手机直接打开。'}地址仅用于当前聊天。</p>{error&&<p className="error" role="alert">{error}</p>}
         {unreachable&&unreachable===browserUrl.trim()&&<><p className="error" role="alert">手机没有连上这个地址，也可能是它不允许被探测。</p><div className="site-issue"><button type="button" onClick={()=>void openBrowser(unreachable,undefined,true)}>仍然打开</button><button type="button" onClick={()=>window.open(unreachable,'_blank','noopener,noreferrer')}>在浏览器打开 ↗</button></div></>}
         <button className="primary" disabled={browserBusy||browserRoute!=='direct'&&browserRoute!=='external'&&!connected}>{browserBusy?'正在打开…':browserRoute==='external'?'在浏览器打开 ↗':'打开预览'}</button></form>}
     </SheetPanel>}
     {previewPane}
  </div></SenderRoot>;
}
// The app shell is cached by a service worker for instant reopening; see public/sw.js.
// UpdateBanner moves an open page to a new release once the worker has it.
if(import.meta.env.PROD&&'serviceWorker' in navigator)window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').catch(()=>{});});
// The stored cache is read first (bounded by a short timeout) so the first paint can show it.
void loadCache().finally(()=>createRoot(document.getElementById('root')!).render(<><App/><UpdateBanner/></>));
