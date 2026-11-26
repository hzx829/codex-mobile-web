import {lazy,Suspense,startTransition,useEffect,useLayoutEffect,useMemo,useRef,useState,type TouchEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {Client,hashCredential,inviteCode,operationId} from './client';
import {AntigravityPanel} from './antigravity';
import {AntigravitySidebar,type LiveThreadStatus} from './antigravity-sidebar';
import {ClaudeCodePanel} from './claude-code';
import {ClaudeProjectEditor,GuestProjectForm} from './claude-projects';
import {ProjectCreateSheet} from './project-create';
import {loadExpandedProjects,ProjectEditSheet,ProjectTree,saveExpandedProjects,type ProjectItem,type ProjectThreadsState} from './project-tree';
import {MobileSettingsTrigger,SettingsSheet,SidebarFooter,type SidebarFooterProps} from './settings-menu';
import {GroupHeading,HomeHeader,SidebarActions,ThreadHeader,useBottomAnchor,useComposerHeight} from './chat-layout';
import {ServiceSwitch, switchRoute} from './service-switch';
import {connectorHas,versionGap,versionGapNotice} from './features';
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
import {mergeProjectPaths,projectPathKey} from '../src/shared/project-paths';
import {BrowserPreviewPanel,PageViewer,WebViewer,type PreviewSession} from './browser-preview';
import {belongsToThread,defaultPreviewUrl,openThreadPreview,previewUrlKey,previewWidthKey,reachable} from './thread-preview';
import {PreviewPane,useCompactPreview} from './preview-pane';
import {fileReference,isArtifactUrl,previewRoute,samePreviewTarget,type PreviewTarget} from './preview-target';
import {ArtifactPanel} from './artifact-view';
import {rememberPage,type PaneAction} from './artifact-pane';
import {clearSavedLocation,ensureComposerRoute,home,initialLocation,newChatRoute,parseLocation,rememberLocation,touchLocation,type Route} from './route-state';
import {clearDraftAttachments,flushDraftAttachments,loadDraftAttachments,useComposerAttachments} from './composer-attachments';
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
import {type BridgeService,type FilePreview,type Json,type Machine,type ProjectCreateResult,type SessionView,type RequestAction,type TurnView} from '../src/shared/types';
import {submitTurn,editTurn} from './turn-request';
import {modelDisplayName,reasoningLabel,resolveModelSelection} from '../src/shared/models';
import {ModelButton,ModelPicker} from './model-picker';
import {defaultVoiceProvider,loadVoiceChoice,resolveVoiceProvider,voiceEngineKey,voiceProvider,voiceProviderLabel,type VoiceProvider} from '../src/shared/voice';
import {useVoiceInput} from './use-voice-input';
import {useStableEvent} from './use-event';
import {notifyState,useTurnNotice,watchWhileHidden,type NotifyState} from './turn-notify';
import {filterThreadsByOwner,isTeamAdmin,mergeMembers,otherOwnerHint,OwnerFilterControl,ownerFilterLabel,parseOwnerFilter,TeamPanel,type OpenActivityThread,type OwnerFilter,type TeamMemberRef,type TeamUser} from './team';
import './style.css';
import 'react-diff-view/style/index.css';
import './preview.css';
// The model and permission pickers share these styles; imported here so the components stay importable in tests.
import './model-picker.css';
import {SenderRoot,SenderScope} from './senders';
import {traceOpen} from './trace';
import type {SyncLink} from './sync/engine';
import {seedOf,storedView,useSyncedPanel,useThreadSync} from './use-thread-sync';
import {clearThreadStore,flushThreadStore,loadThreadStore} from './sync/idb-store';
import {blobSession,blobUrl,setBlobUploadTarget} from './blob';
import {BlobImage,withUploadedImages} from './blob-image';
import type {FileStreamSource} from './file-preview';

const FilePreviewPanel=lazy(()=>import('./file-preview').then(module=>({default:module.FilePreviewPanel})));
const DiffViewer=lazy(()=>import('./diff-viewer').then(module=>({default:module.DiffViewer})));

const load=(key:string,fallback:any)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}};
const save=(key:string,value:any)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const name=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)||path;
const computerName=(machine:Machine)=>machine.name+(machine.guest?'（借用）':'');
const previewTitle=(target:PreviewTarget)=>target.kind==='file'?target.file?.name||name(target.path):target.kind==='diff'?'本轮修改':target.kind==='image'?target.title:target.kind==='artifact'?target.title||'claude.ai 页面':target.kind==='site'?siteName(target.url):target.kind==='tasks'?'后台任务':'网页预览';
const siteName=(url:string)=>{try{return new URL(url).host;}catch{return '网页预览';}};
/** What the address form says about where a page will be loaded from. */
const ROUTE_HINT={tunnel:'通过电脑打开：先在电脑或局域网里启动网页服务。',direct:'手机直接打开，不经过电脑。',external:'http 的公网地址不能嵌在这里，只能在浏览器里打开。',artifact:'claude.ai 页面，通过电脑打开。'} as const;
// A team invite link (#invite=…) is kept like a Token until the relay exchanges it for this device's own token.
function consumeHashCredential(){const credential=hashCredential(location.hash);if(!credential)return null;save('connection',credential);history.replaceState(history.state,'',location.pathname+location.search);return credential;}
function initialToken(){return consumeHashCredential()||load('connection','');}
// Only the approval policy changes; the sandbox stays as configured on the computer.
const APPROVALS:PermissionOption[]=[
  {id:'on-request',label:'按需审批',description:'需要时请你审批命令和文件修改'},
  {id:'never',label:'不提示审批',description:'不再请求审批；沙箱仍按电脑配置',elevated:true},
];
const approvalName=(policy?:string)=>APPROVALS.find(option=>option.id===policy)?.label||'电脑配置';
const savedLocation=initialLocation();
const initialRoute=ensureComposerRoute(savedLocation.route);
const codexCwdKey=(m:string)=>`codex:${m}:new-cwd`;
const codexModelKey=(m:string)=>`codex:${m}:model`;
const codexEffortKey=(m:string)=>`codex:${m}:effort`;
const codexApprovalKey=(m:string)=>`codex:${m}:approval`;
const codexTierKey=(m:string)=>`codex:${m}:service-tier`;
const loadCodexTier=(m:string):string|null|undefined=>{const value=load(codexTierKey(m),'__inherit');return value==='__inherit'?undefined:value;};
const listKey=(machine:string,project:string,archived:boolean)=>`${machine}:${project}:${archived?'archived':'recent'}`;
type PreviewTab={id:number;target:PreviewTarget};
type Sheet='settings'|'computer'|'projects'|'create-project'|'edit-project'|'add'|'file'|'browser'|'voice'|'claude-project'|'team'|null;
function App(){
  const [token,setToken]=useState(initialToken),[tokenInput,setTokenInput]=useState('');
  // The signed-in member once the relay has a team; null with the shared Token.
  const [me,setMe]=useState<TeamUser|null>(null),[roster,setRoster]=useState<TeamMemberRef[]>([]),[ownerFilter,setOwnerFilterState]=useState<OwnerFilter>(()=>parseOwnerFilter(load('owner-filter',null),load('only-mine',false)===true)),teamDevice=useRef('');
  const setOwnerFilter=(next:OwnerFilter)=>{setOwnerFilterState(next);save('owner-filter',next);save('only-mine',next==='mine');};
  const [projectsCollapsed,setProjectsCollapsed]=useState<boolean>(()=>load('sidebar-projects-collapsed',false)===true);
  const toggleProjects=()=>setProjectsCollapsed(old=>{const next=!old;save('sidebar-projects-collapsed',next);return next;});
  const [collapsedGroups,setCollapsedGroups]=useState<string[]>(()=>{const saved=load('sidebar-groups-collapsed',[]);return Array.isArray(saved)?saved.filter(item=>typeof item==='string'):[];});
  const toggleGroup=(key:string)=>setCollapsedGroups(old=>{const next=old.includes(key)?old.filter(item=>item!==key):[...old,key];save('sidebar-groups-collapsed',next);return next;});
  const [status,setStatus]=useState('connecting'),[machines,setMachines]=useState<Machine[]>([]),[machine,setMachine]=useState(savedLocation.machine);
  const [route,setRoute]=useState<Route>(initialRoute),[sheet,setSheet]=useState<Sheet>(null);
  const [drawerOpen,setDrawerOpen]=useState(false);
  const [isMobile,setIsMobile]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(max-width: 760px)').matches);
  const [remoteListRevision,refreshRemoteList]=useState(0);
  const [remoteLiveStatus,setRemoteLiveStatus]=useState<{service:Service;machine:string;status:LiveThreadStatus}|null>(null);
  const service=serviceOf(route),codexActive=service==='codex';
  const lastCodex=useRef({machine,route:newChatRoute('codex')});
  if(codexActive)lastCodex.current={machine,route};
  const codexRoute=codexActive?route:lastCodex.current.machine===machine?lastCodex.current.route:newChatRoute('codex');
  const selected=codexRoute.thread,project=codexRoute.project,newChat=!selected,showThread=true;
  const remoteConversation=routeConversation(route),previewThread=previewOwnerOf(route,selected);
  const previewOwner=useRef({machine,thread:previewThread});previewOwner.current={machine,thread:previewThread};
  const threadMounted=codexActive&&showThread&&Boolean(token)&&status!=='auth_error';
  const [info,setInfo]=useState<Json|null>(null),[projects,setProjects]=useState<string[]>([]),[sessions,setSessions]=useState<Json[]>([]);
  const infoRef=useRef(info);infoRef.current=info;
  const createOrigin=useRef<'sidebar'|'new-chat'>('sidebar');
  const projectRefreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [cursor,setCursor]=useState<string|null>(null),[search,setSearch]=useState(''),[searchQuery,setSearchQuery]=useState(''),[listBusy,setListBusy]=useState(false),[archived,setArchived]=useState(false);
  const [view,setView]=useState<SessionView|null>(null),[loading,setLoading]=useState(false),[loadingOlder,setLoadingOlder]=useState(false),[historyError,setHistoryError]=useState('');
  const viewRef=useRef(view);useLayoutEffect(()=>{viewRef.current=view;},[view]);
  const [draft,setDraft]=useState<string>(()=>String(load(`draft:${savedLocation.machine}:${initialRoute.thread}`,'')||'')),[model,setModel]=useState(()=>initialRoute.newChat&&savedLocation.machine?String(load(codexModelKey(savedLocation.machine),'')||''):''),[effort,setEffort]=useState(()=>initialRoute.newChat&&savedLocation.machine?String(load(codexEffortKey(savedLocation.machine),'')||''):''),[approval,setApproval]=useState(()=>initialRoute.newChat&&savedLocation.machine?String(load(codexApprovalKey(savedLocation.machine),'')||''):''),[newCwd,setNewCwd]=useState<string>(()=>initialRoute.project||(savedLocation.machine?String(load(codexCwdKey(savedLocation.machine),'')||''):''));
  const [optimistic,setOptimistic]=useState<OptimisticMessage|null>(null),optimisticRef=useRef(optimistic);optimisticRef.current=optimistic;
  const everOnline=useRef(false);if(status==='online')everOnline.current=true;
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null);
  const draftSave=useRef(new DraftSave(save));
  const [serviceTier,setServiceTier]=useState<string|null|undefined>(()=>initialRoute.newChat&&savedLocation.machine?loadCodexTier(savedLocation.machine):undefined);
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
  useEffect(()=>{if(sheet!=='settings')setNotifyMessage('');else setNotify(notifyState());},[sheet]);
  const [editingProject,setEditingProject]=useState<{service:BridgeService;project:ProjectItem}|null>(null);
  const [claudeSettingsFolder,setClaudeSettingsFolder]=useState('');
  const [autoExpandKey,setAutoExpandKey]=useState('');
  const [codexExpandedState,setCodexExpandedState]=useState<{machine:string;keys:string[]|null}>(()=>({machine:savedLocation.machine,keys:savedLocation.machine?loadExpandedProjects('codex',savedLocation.machine):null}));
  const [codexProjectPages,setCodexProjectPages]=useState<Record<string,{items:Json[];nextCursor:string|null;loading:boolean;error:string}>>({});
  const codexProjectReqSeq=useRef<Record<string,number>>({});
  const codexProjectPagesRef=useRef(codexProjectPages);codexProjectPagesRef.current=codexProjectPages;
  const codexExpandedRef=useRef<Set<string>>(new Set());
  const codexLoadedExpanded=useRef(new Set<string>());
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<Json|null>(null);
  const [previewState,setPreviewState]=useState<{tabs:PreviewTab[];activeId:number|null}>({tabs:[],activeId:null}),[filePath,setFilePath]=useState('');
  const preview=previewState.tabs.find(tab=>tab.id===previewState.activeId)?.target||null;
  // Where an Antigravity conversation shows its background tasks while their tab is open.
  const [tasksSlot,setTasksSlot]=useState<HTMLElement|null>(null);
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
  const client=useRef<Client|null>(null),current=useRef({machine,selected,project,newChat,searchQuery,archived,service,connected,synced:false}),sequence=useRef(0),listLoader=useRef(new SessionListLoader()),infoSequence=useRef(0);
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),refreshing=useRef(false),again=useRef(false),sticky=useRef(true),timeline=useRef<HTMLDivElement>(null),timelineContent=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),submitting=useRef(false);
  const scrollAnchor=useRef<{element:HTMLElement;top:number}|null>(null),lastScrollTop=useRef(0),olderRequest=useRef<object|null>(null);
  const liveFrames=useRef<LiveFrame[]>([]),liveFrame=useRef(0);
  const codexSynced=codexActive&&Boolean(selected)&&!newChat&&connectorHas(activeMachine,'sync.codex');
  current.current={machine,selected,project,newChat,searchQuery,archived,service,connected,synced:codexSynced};
  const machineName=activeMachine?computerName(activeMachine):'电脑';
  const scope=`${machine}:${selected}`,draftKey=`draft:${scope}`,pendingKey=`operation:${scope}`;
  // Images to send go up through the data channel first when the computer takes them (web/blob-image.tsx).
  const call=async(action:RequestAction,payload:Json={},target=machine)=>client.current!.request(action,await withUploadedImages(action,payload,target),target);
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
  function navigate(next:Route,replace=false,keepDrawer=false){
    const resolved=ensureComposerRoute(next);
    history[replace?'replaceState':'pushState']({cmwRoute:resolved,cmwMachine:machine},'',location.pathname);
    rememberLocation(resolved,machine);setSheet(null);setThreadMenu(null);setStatusPanel(null);setModelPoint(null);setPermissionPoint(null);if(!keepDrawer)setDrawerOpen(false);setRoute(resolved);
  }
  useEffect(()=>{
    const mq=window.matchMedia('(max-width: 760px)');
    const sync=()=>{setIsMobile(mq.matches);if(!mq.matches)setDrawerOpen(false);};
    sync();
    mq.addEventListener('change',sync);
    return()=>mq.removeEventListener('change',sync);
  },[]);
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      if((e.ctrlKey||e.metaKey)&&!e.altKey&&e.key===','){
        e.preventDefault();
        setSheet(old=>old==='settings'?null:'settings');
      }else if(e.key==='Escape'&&drawerOpen&&!sheet&&!threadMenu&&!statusPanel&&!modelPoint&&!permissionPoint){
        setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[drawerOpen,sheet,threadMenu,statusPanel,modelPoint,permissionPoint]);
  useEffect(()=>{
    const pop=(e:PopStateEvent)=>{setSheet(null);setThreadMenu(null);setStatusPanel(null);setModelPoint(null);setPermissionPoint(null);setDrawerOpen(false);const location=parseLocation(e.state);const next=ensureComposerRoute(location?.machine===current.current.machine?location.route:newChatRoute('codex'));rememberLocation(next,current.current.machine);setRoute(next);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=>{history.replaceState({cmwRoute:route,cmwMachine:machine},'',location.pathname);rememberLocation(route,machine);},[machine]);
  async function refreshSession(){
    // A synced thread asks for what changed; the engine merges calls that overlap.
    if(codexSync.engine.current&&current.current.synced){await codexSync.engine.current.open();return;}
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
      const engine=codexSync.engine.current;
      if(engine&&c.synced){
        const element=timeline.current?.querySelector<HTMLElement>('.turn');
        if(element)scrollAnchor.current={element,top:element.getBoundingClientRect().top};
        await engine.page(HISTORY_PAGE_SIZE);return;
      }
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
  const codexProjectMeta=(path:string)=>{
    if(!path)return undefined;
    const key=projectPathKey(path);
    return (infoRef.current?.projects as Json[]|undefined)?.find(item=>projectPathKey(item.path)===key);
  };
  async function list(append=false,refresh=false,showError=true){
    const c={...current.current};
    const key=(value:typeof c)=>JSON.stringify([value.service,value.machine,value.searchQuery,value.archived]);
    const here=()=>key(c)===key(current.current);
    await listLoader.current.load(key(c),()=>call('sessions.list',{search:c.searchQuery||undefined,archived:c.archived,cursor:append?cursor:undefined,refresh},c.machine),{
      start:()=>setListBusy(true),
      result:r=>{
        if(!here())return;
        startTransition(()=>{setSessions(old=>append?[...old,...r.data.filter((n:Json)=>!old.some(s=>s.id===n.id))]:r.data);setCursor(r.nextCursor);});
        if(!append&&!c.searchQuery)rememberList(listKey(c.machine,'',c.archived),r.data);
        setPreferences(old=>{if(old.machine!==c.machine)return old;const values=rememberThreads(old.values,r.data,c.archived);if(values===old.values)return old;save(`thread-preferences:${c.machine}`,values);return {...old,values};});
        if(!infoRef.current?.projectApi)setProjects(old=>mergeProjectPaths([...old,...r.data.map((s:Json)=>s.cwd)]));
      },
      error:e=>{if(here()&&showError)fail(e);},
      finish:()=>setListBusy(false),
    });
  }
  const loadCodexProject=useStableEvent((proj:ProjectItem,append=false)=>{
    const c={...current.current};
    if(!c.connected||c.service!=='codex'||!c.machine)return;
    const prev=codexProjectPagesRef.current[proj.key];
    const nextCursor=append?prev?.nextCursor||undefined:undefined;
    const seq=(codexProjectReqSeq.current[proj.key]||0)+1;
    codexProjectReqSeq.current[proj.key]=seq;
    const cache=listKey(c.machine,proj.path,c.archived);
    setCodexProjectPages(old=>{
      const existing=old[proj.key];
      const seed=existing?.items?.length?existing.items:(cachedList(cache)||[]);
      return {...old,[proj.key]:{items:seed,nextCursor:existing?.nextCursor||null,loading:true,error:''}};
    });
    void call('sessions.list',{cwd:proj.path,projectId:proj.id||undefined,roots:proj.roots||undefined,archived:c.archived,cursor:nextCursor},c.machine).then(r=>{
      if(codexProjectReqSeq.current[proj.key]!==seq||current.current.machine!==c.machine||current.current.archived!==c.archived)return;
      if(!append)rememberList(cache,r.data);
      setPreferences(old=>{if(old.machine!==c.machine)return old;const values=rememberThreads(old.values,r.data,c.archived);if(values===old.values)return old;save(`thread-preferences:${c.machine}`,values);return {...old,values};});
      setCodexProjectPages(old=>{
        const prior=append?old[proj.key]?.items||[]:[];
        const merged=append?[...prior,...r.data.filter((n:Json)=>!prior.some(s=>s.id===n.id))]:r.data;
        return {...old,[proj.key]:{items:merged,nextCursor:r.nextCursor||null,loading:false,error:''}};
      });
    }).catch((e:any)=>{
      if(codexProjectReqSeq.current[proj.key]!==seq)return;
      setCodexProjectPages(old=>{
        const existing=old[proj.key];
        return {...old,[proj.key]:{items:existing?.items||[],nextCursor:existing?.nextCursor||null,loading:false,error:e?.message||'读取项目会话失败'}};
      });
    });
  });
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
    call('info',{cwd:effectiveCwd||undefined}).then(r=>{if(seq!==infoSequence.current)return;setInfo(r);setProjects(old=>r.projectApi?mergeProjectPaths(r.roots):mergeProjectPaths([...r.roots,...old]));setNewCwd(old=>old||r.roots[0]||'');}).catch(e=>{if(seq===infoSequence.current)fail(e);});
  }
  useEffect(refreshInfo,[connected,machine,effectiveCwd,codexActive]);
  useEffect(()=>{const timer=setTimeout(()=>setSearchQuery(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{if(searchQuery)return;const cached=cachedList(listKey(machine,'',archived));if(cached)setSessions(cached);},[machine,searchQuery,archived]);
  useEffect(()=>{if(connected&&codexActive)void list();},[connected,machine,searchQuery,archived,codexActive]);
  useEffect(()=>{codexLoadedExpanded.current.clear();setCodexProjectPages({});if(machine)setCodexExpandedState({machine,keys:loadExpandedProjects('codex',machine)});},[machine,archived]);
  useEffect(()=>{if(machine)setProjects(old=>old.length?old:mergeProjectPaths(cachedProjects(machine)));},[machine]);
  useEffect(()=>{if(projects.length)rememberProjects(machine,projects);},[projects]);
  const onProjectListChanged=useStableEvent(()=>{
    if(projectRefreshTimer.current)return;
    projectRefreshTimer.current=setTimeout(()=>{
      projectRefreshTimer.current=undefined;
      if(!current.current.connected)return;
      if(current.current.service==='codex'){refreshInfo();refreshExpandedCodex();}
      else refreshRemoteList(value=>value+1);
    },300);
  });
  useEffect(()=>{
    if(!token)return;
    const c=new Client(token,m=>{
      if(m.type==='ready'||m.type==='machines')setMachines(m.machines||m.data||[]);
      if(m.type==='ready'){setMe(m.user||null);teamDevice.current=m.device?.id||'';}
      if(m.type==='team.user')setMe(m.user||null);
      // A synced thread gets its changes as frames; notices about it would only ask again.
      if(m.type==='changed'&&m.machineId===current.current.machine){
        if(!m.threadId)onProjectListChanged();
        if(!m.threadId||m.threadId===current.current.selected&&!current.current.synced)scheduleRefresh();
      }
      if(m.type==='live'&&current.current.service==='codex'&&m.machineId===current.current.machine&&m.threadId===current.current.selected)receiveLive(m as LiveFrame);
    },setStatus,next=>save('connection',next));client.current=c;
    const stopSync=c.onSync(frame=>{for(const listener of syncBus.current.frames)listener(frame);});
    const stopStatus=c.onStatus(online=>{for(const listener of syncBus.current.status)listener(online);});
    return()=>{stopSync();stopStatus();c.close();clearTimeout(refreshTimer.current);clearTimeout(projectRefreshTimer.current);projectRefreshTimer.current=undefined;cancelAnimationFrame(liveFrame.current);liveFrame.current=0;liveFrames.current=[];};
  },[token]);
  useEffect(()=>{
    const onHash=()=>{
      const next=consumeHashCredential();
      if(!next)return;
      setTokenInput('');
      setToken(next);
    };
    window.addEventListener('hashchange',onHash);
    return()=>window.removeEventListener('hashchange',onHash);
  },[]);
  const teamSheetOpen=sheet==='team';
  useEffect(()=>{
    if(!me||status!=='online'||!client.current||teamSheetOpen)return;
    let alive=true;
    client.current.team('team.roster').then(result=>{if(alive&&Array.isArray(result?.members))setRoster(result.members);}).catch(()=>{});
    return()=>{alive=false;};
  },[me?.id,status,teamSheetOpen]);
  useEffect(()=>client.current?.onPreview(message=>{
    if(message.type==='preview.disconnected'||message.type==='preview.ended'&&message.sessionId===browserState?.sessionId){setBrowserSession(null);setPreviewState(old=>{const tabs=old.tabs.filter(tab=>tab.target.kind!=='web');return {tabs,activeId:tabs.some(tab=>tab.id===old.activeId)?old.activeId:tabs.at(-1)?.id??null};});}
  }),[token,browserState?.sessionId]);
  useEffect(()=>{
    if(!machine&&machines[0]){changeMachine(machines[0].id);return;}
    const next=ensureComposerRoute(supportedRoute(route,available));
    if(JSON.stringify(next)!==JSON.stringify(route))navigate(next,true,drawerOpen);
  },[machines,machine,route,available]);
  // Other apps' threads set their own watch when they open (web/sync/engine.ts); leaving Codex does not clear it here,
  // because their effects run before this one.
  // A synced thread sets its own watch (web/sync/engine.ts); this one is for the reads and live frames of older connectors.
  useEffect(()=>{if(codexActive&&!codexSynced)client.current?.watch(machine&&selected?{machineId:machine,threadId:selected}:null);},[token,machine,selected,codexActive,codexSynced]);
  // Synced threads (web/sync/engine.ts) reach the client through this bus, which outlives clients, so a panel can start
  // following before the client below exists.
  const syncBus=useRef({frames:new Set<(frame:Json)=>void>(),status:new Set<(online:boolean)=>void>()});
  const syncLink=useMemo<SyncLink|undefined>(()=>machine?{
    online:()=>Boolean(client.current?.ready),
    request:(action,payload)=>client.current?client.current.request(action,payload,machine):Promise.reject({code:'offline',message:'尚未连接中继'}),
    onFrame:listener=>{
      const forward=(frame:Json)=>{if(frame.machineId===machine)listener(frame);};
      syncBus.current.frames.add(forward);return()=>{syncBus.current.frames.delete(forward);};
    },
    onStatus:listener=>{syncBus.current.status.add(listener);return()=>{syncBus.current.status.delete(listener);};},
    watch:(target,owner)=>{
      const link=client.current;if(!link)return;
      const now=link.watched;
      if(owner&&(now?.machineId!==machine||now?.threadId!==owner.threadId||now?.service!==owner.service))return;
      link.watch(target?{machineId:machine,...target}:null);
    },
  }:undefined,[machine]);
  // Codex threads follow their frames when the connector pushes them (sync.codex); reads and live frames otherwise.
  const codexSync=useThreadSync(codexSynced?syncLink:undefined,'codex',codexSynced?selected:'',()=>seedOf(cachedView<Json>(`${machine}:${selected}`),'turns'),machine);
  useSyncedPanel(codexSync.view,'turns',next=>{
    if(next.id!==current.current.selected)return;
    startTransition(()=>{setView({...next,nextCursor:next.truncated&&next.turns.length?{before:next.turns[0].id}:null,hasMore:Boolean(next.truncated)} as unknown as SessionView);setLoading(false);});
  },update=>setError(update),'请更新这台电脑上的连接器。');
  useEffect(()=>{setPreferences({machine,values:load(`thread-preferences:${machine}`,{})});setThreadMenu(null);},[machine]);
  useEffect(()=>{
    draftSave.current.flush();
    setStatusPanel(null);setModelPoint(null);setPermissionPoint(null);
    setUploadProgress(null);
    setBrowserRequest(null);setBrowserUrl(load(previewUrlKey(machine,selected),defaultPreviewUrl));
    // Show the last known content at once; it stays marked as cached until the read below lands.
    const stored=selected&&codexSynced?storedView('codex',machine,selected,'turns'):null;
    const cached=stored?{...stored,hasMore:Boolean(stored.truncated),nextCursor:stored.truncated&&stored.turns.length?{before:stored.turns[0].id}:null} as unknown as CachedView:selected?cachedView(`${machine}:${selected}`):null;
    if(selected)traceOpen('codex',`${machine}:${selected}`,'start');
    sequence.current++;setView(cached);setLoading(Boolean(selected)&&!cached);olderRequest.current=null;setLoadingOlder(false);setHistoryError('');
    setModel(newChat&&machine?String(load(codexModelKey(machine),'')||''):'');
    setEffort(newChat&&machine?String(load(codexEffortKey(machine),'')||''):'');
    setApproval(newChat&&machine?String(load(codexApprovalKey(machine),'')||''):'');
    setServiceTier(newChat&&machine?loadCodexTier(machine):undefined);
    setError('');setNotice('');sticky.current=true;scrollAnchor.current=null;lastScrollTop.current=0;
    // A message that is still being sent keeps its place when a new chat turns into its thread.
    const sending=optimisticRef.current?.key===scope;setOptimistic(old=>old?.key===scope?old:null);
    setDraft(sending?'':load(draftKey,''));setPending(load(pendingKey,null));if(!codexSynced)void refreshSession();
  },[machine,selected,newChat]);
  useEffect(()=>{
    if(!view||view.id!==selected)return;
    const cachedShown=Boolean((view as CachedView).cached);
    traceOpen('codex',`${machine}:${selected}`,cachedShown?'cached':'fresh');
    // A followed thread is kept by its engine (web/sync/idb-store.ts).
    if(!cachedShown&&!current.current.synced)rememberView(`${machine}:${selected}`,view);
  },[view]);
  useEffect(()=>{
    if(!optimistic?.acceptedAt)return;
    if(optimistic.key===scope&&optimisticDelivered(optimistic,view)){setOptimistic(null);return;}
    const timer=setTimeout(()=>setOptimistic(old=>old===optimistic?null:old),Math.max(0,optimistic.acceptedAt+OPTIMISTIC_ACCEPTED_MS-Date.now()));
    return()=>clearTimeout(timer);
  },[optimistic,view,scope]);
  useEffect(()=>{
    const flush=()=>{draftSave.current.flush();touchLocation();void flushDraftAttachments();void flushCache();void flushThreadStore();},hidden=()=>{if(document.visibilityState==='hidden')flush();};
    window.addEventListener('beforeunload',flush);window.addEventListener('pagehide',flush);document.addEventListener('visibilitychange',hidden);
    return()=>{flush();window.removeEventListener('beforeunload',flush);window.removeEventListener('pagehide',flush);document.removeEventListener('visibilitychange',hidden);};
  },[]);
  useEffect(()=>{if(!codexSynced)void refreshSession();},[connected,codexActive,codexSynced]);
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
  useLayoutEffect(()=>{const el=timeline.current;if(!el)return;const anchor=scrollAnchor.current;scrollAnchor.current=null;if(anchor?.element.isConnected)el.scrollTop+=anchor.element.getBoundingClientRect().top-anchor.top;else if(sticky.current)el.scrollTop=el.scrollHeight;lastScrollTop.current=el.scrollTop;},[view?.turns,loadingOlder,optimistic?.at]);
  useEffect(()=>{
    const el=timeline.current,content=timelineContent.current;if(!el||!content)return;
    let frame=0;
    const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(sticky.current&&!scrollAnchor.current){el.scrollTop=el.scrollHeight;lastScrollTop.current=el.scrollTop;}});});
    observer.observe(el);observer.observe(content);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[threadMounted]);
  useComposerHeight(composer,draft,threadMounted);
  useBottomAnchor(timeline,threadMounted);
  useEffect(()=>{
    if(!connected||!codexActive)return;
    // A safety net for missed notices: the open thread also renews its live watch here.
    let ticks=0;
    const foreground=(event?:Event)=>{
      const visible=document.visibilityState==='visible';
      if(visible)void list(false,false,false);
      if(!current.current.synced&&current.current.selected&&(visible||watchWhileHidden(viewRef.current?.running))&&(event||++ticks%2===0))void refreshSession();
    };
    const timer=setInterval(foreground,5000);document.addEventListener('visibilitychange',foreground);
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
    void refreshSession();void list(false,false,false);
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
  function startNew(targetPath?:string){
    if(busy)return;
    const savedCwd=machine?String(load(codexCwdKey(machine),'')||''):'';
    const cwd=targetPath||savedCwd||project||view?.cwd||info?.roots?.[0]||'';
    setNewCwd(cwd);
    if(targetPath&&machine)save(codexCwdKey(machine),targetPath);
    navigate(newChatRoute('codex',cwd));
    if(guest&&!cwd)setSheet('projects');
  }
  function selectProject(path:string){
    setNewCwd(path);
    if(machine)save(codexCwdKey(machine),path);
    setSheet(null);
  }
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
    const result=await createFirstTurn((action,payload)=>call(action,payload),{cwd:newCwd,projectId:codexProjectMeta(newCwd)?.id,text,images,files,model,effort,approvalPolicy:approval,serviceTier,createId,sendId},id=>{
      createdThread=id;
      save(`draft:${machine}:${id}`,text);save(`operation:${machine}:${id}`,{opId:sendId,action:'turn.send',submittedText:text});
      save(draftKey,'');clearDraftAttachments(`codex:${scope}`);setOperation(null);
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
    setBusy(false);setUploadProgress(null);void refreshSession();void list(false,false,false);refreshExpandedCodex();
  }
  /** The action and payload that read a thread's file: Codex's `file.*`, or the app's own with its conversation. */
  function fileAction(action:'read'|'download',threadId:string,payload:Json):{action:RequestAction;payload:Json}|null{
    const owner=fileOwner(threadId);
    if(owner.service==='antigravity'||owner.service==='claude')return {action:`${owner.service}.file.${action}`,payload:{conversationId:owner.id,...payload}};
    if(owner.service!=='codex')return null;
    return {action:`file.${action}`,payload:{threadId,...payload}};
  }
  function fileRequest(action:'read'|'download',ownerMachine:string,threadId:string,payload:Json){
    const request=fileAction(action,threadId,payload);
    return request?call(request.action,request.payload,ownerMachine):Promise.reject(new Error('这个应用暂不支持读取文件'));
  }
  // Uploads to the open computer go through the data channel when the relay and its connector both take them.
  useEffect(()=>{
    const link=client.current;
    setBlobUploadTarget(link&&status==='online'&&link.relayFeatures.includes('blob')&&connectorHas(activeMachine,'blob.upload')
      ?{machine,token:link.signInToken,images:link.relayFeatures.includes('blob.image')&&connectorHas(activeMachine,'blob.image')}:null);
  },[status,machine,activeMachine]);
  /** A file through the relay's data channel, when both the relay and that computer's connector have it (web/blob.ts). */
  function fileStream(ownerMachine:string,threadId:string,file:FilePreview):FileStreamSource|undefined{
    const link=client.current,request=fileAction('download',threadId,{path:file.path,revision:file.revision});
    if(!link||!request||!link.relayFeatures.includes('blob')||!connectorHas(machines.find(item=>item.id===ownerMachine),'blob'))return undefined;
    return {url:download=>blobUrl(ownerMachine,request.action,request.payload,download),ready:()=>blobSession(link.signInToken)};
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
  function changeMachine(id:string){setSheet(null);setDrawerOpen(false);if(id===machine)return;closeBrowser();closePreview();infoSequence.current++;listLoader.current.invalidate();setListBusy(false);setInfo(null);setProjects([]);setSessions([]);setSearch('');setSearchQuery('');setArchived(false);const savedCwd=id?String(load(codexCwdKey(id),'')||''):'';setNewCwd(savedCwd);const next=id?ensureComposerRoute(supportedRoute(newChatRoute(service,service==='codex'?savedCwd:''),machines.find(item=>item.id===id)?.services)):newChatRoute('codex');history.replaceState({cmwRoute:next,cmwMachine:id},'',location.pathname);rememberLocation(next,id);setMachine(id);setRoute(next);}
  function logout(){
    // A member signing out also removes this device, so its token stops working everywhere.
    if(me&&teamDevice.current&&client.current?.ready)void client.current.team('team.devices.revoke',{deviceId:teamDevice.current}).catch(()=>{});
    client.current?.close();save('connection','');clearSavedLocation();setMe(null);setRoster([]);teamDevice.current='';setToken('');setView(null);setInfo(null);setMachines([]);setOptimistic(null);clearDraftAttachments();void clearCache();void clearThreadStore();changeMachine('');}
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
    const thread={...row,id:selected,title:view?.title||row?.title||'会话',cwd:view?.cwd||row?.cwd||project,owner:view?.owner??row?.owner??null,status:view?.running?{type:'active'}:row?.status};
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
    else{setSessions(old=>old.filter(s=>s.id!==thread.id));if(current.current.selected===thread.id)navigate(newChatRoute('codex'));}
    listLoader.current.invalidate();void list();refreshExpandedCodex();
  }
  const projectName=(path:string)=>{
    const key=projectPathKey(path);
    return info?.projects?.find((p:Json)=>projectPathKey(p.path)===key)?.name||name(path);
  };
  const codexProjectItems=useMemo<ProjectItem[]>(()=>projects.map(p=>{
    const key=projectPathKey(p);
    const meta=(info?.projects as Json[]|undefined)?.find(item=>projectPathKey(item.path)===key);
    return {key,id:meta?.id,path:p,name:meta?.name||name(p),roots:meta?.roots,owner:meta?.owner};
  }),[projects,info?.projects]);
  const codexExpandedKeys=useMemo(()=>{
    const saved=codexExpandedState.machine===machine?codexExpandedState.keys:(machine?loadExpandedProjects('codex',machine):null);
    if(saved!==null)return new Set(saved);
    return codexProjectItems[0]?new Set([codexProjectItems[0].key]):new Set<string>();
  },[codexExpandedState,machine,codexProjectItems]);
  codexExpandedRef.current=codexExpandedKeys;
  const refreshExpandedCodex=useStableEvent(()=>{
    if(!current.current.connected||current.current.service!=='codex')return;
    for(const item of codexProjectItems){
      if(codexExpandedRef.current.has(item.key))loadCodexProject(item,false);
    }
  });
  useEffect(()=>{
    if(!connected||!codexActive)return;
    for(const item of codexProjectItems){
      if(codexExpandedKeys.has(item.key)&&!codexLoadedExpanded.current.has(item.key)){
        codexLoadedExpanded.current.add(item.key);
        loadCodexProject(item,false);
      }
    }
  },[connected,codexActive,codexProjectItems,codexExpandedKeys,loadCodexProject]);
  function toggleCodexProject(proj:ProjectItem){
    const opening=!codexExpandedKeys.has(proj.key);
    setCodexExpandedState(old=>{
      const base=(old.machine===machine?old.keys:loadExpandedProjects('codex',machine))??[...codexExpandedKeys];
      const next=opening?[...new Set([...base,proj.key])]:base.filter(k=>k!==proj.key);
      saveExpandedProjects('codex',machine,next);
      return {machine,keys:next};
    });
    if(opening&&connected){
      codexLoadedExpanded.current.add(proj.key);
      loadCodexProject(proj,false);
    }
  }
  function markCodexProjectRead(threadIds:string[]){
    let changed=false;
    const next={...preferences};
    for(const id of threadIds){
      if(next[id]?.unread){next[id]={...next[id],unread:false};changed=true;}
    }
    if(changed){save(`thread-preferences:${machine}`,next);setPreferences({machine,values:next});}
  }
  const codexProjectThreadsMap=useMemo<Record<string,ProjectThreadsState>>(()=>{
    const map:Record<string,ProjectThreadsState>={};
    for(const item of codexProjectItems){
      if(!codexExpandedKeys.has(item.key))continue;
      const entry=codexProjectPages[item.key];
      const cache=listKey(machine,item.path,archived);
      const rawItems=entry?.items?.length?entry.items
        :(cachedList(cache)||sessions.filter(s=>s.cwd&&projectPathKey(s.cwd)===item.key));
      const shown=filterThreadsByOwner(visibleThreads(rawItems,preferences,item.path,archived,''),me,ownerFilter);
      map[item.key]={
        items:shown,
        loading:Boolean(entry?.loading),
        hasMore:Boolean(entry?.nextCursor),
        error:entry?.error||'',
      };
    }
    return map;
  },[codexProjectItems,codexExpandedKeys,codexProjectPages,machine,archived,sessions,preferences,me,ownerFilter]);
  const allCodexThreads=useMemo(()=>[...sessions,...Object.values(codexProjectPages).flatMap(entry=>entry.items)],[sessions,codexProjectPages]);
  const queueNext=!newChat&&Boolean(view?.running||view?.queuedMessages?.length);
  const availableModels=(info?.models||[]).filter((m:Json)=>(view?.provider||info?.provider)==='openai'||m.model===(view?.model||info?.model));
  const currentModel={model:view?.model||info?.model,effort:view?.effort||(newChat?info?.effort:''),serviceTier:view?.serviceTier!==undefined?view.serviceTier:info?.serviceTier};
  const selection=resolveModelSelection(availableModels,{model,effort,serviceTier},currentModel);
  const modelInfo=selection.model,canImage=modelInfo?.inputModalities?.includes('image'),isFast=selection.isFast;
  const attachments=useComposerAttachments({draftKey:`codex:${scope}`,disabled:busy,imagesBlocked:canImage?undefined:'当前模型未确认图片能力',notify:setError,added:()=>setSheet(null)});
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
  const codexMembers=useMemo(()=>mergeMembers(roster,allCodexThreads),[roster,allCodexThreads]);
  const listedThreads=useMemo(()=>filterThreadsByOwner(visibleThreads(sessions,preferences,'',archived,searchQuery),me,ownerFilter),[sessions,preferences,archived,searchQuery,me,ownerFilter]);
  const visibleTitle=newChat?'新聊天':view?.title||sessions.find(s=>s.id===selected)?.title||'正在打开…';
  const conversationCopy=useStableEvent((text:string)=>void copyText(text).then(()=>setNotice('已复制文字')).catch(()=>setError('复制失败，请长按选择文字')));
  const conversationEdit=useStableEvent((turnId:string,itemId:string,text:string)=>editTurn(mutate,target(),{turnId,itemId,text},{model,effort,approvalPolicy:approval,serviceTier}));
  const conversationFork=useStableEvent(fork),conversationDiff=useStableEvent((turn:TurnView)=>showPreview({kind:'diff',threadId:selected,turnId:turn.id,text:turn.diff!}));
  const conversation=useMemo(()=>view?.turns.map(turn=><ConversationTurn key={turn.id} turn={turn} running={Boolean(view.running)} source={view.source} latestUser={turn.id===latestUserTurn} disabled={!connected||busy||Boolean(pending)} openFile={markdownOpenFile} openPreview={markdownOpenPreview} onFollowup={markdownFollowup} onCopy={conversationCopy} onEdit={conversationEdit} onFork={conversationFork} onDiff={conversationDiff} onBlocked={setNotice}/>),[view?.turns,view?.running,view?.source,latestUserTurn,connected,busy,Boolean(pending),markdownOpenFile,markdownOpenPreview,markdownFollowup,conversationCopy,conversationEdit,conversationFork,conversationDiff]);
  const feedback=<>{error&&<div className="feedback error" role="alert"><span>{error}</span><IconButton icon="close" label="关闭提示" onClick={()=>setError('')}/></div>}{notice&&<div className="feedback" role="status">{notice}</div>}{pending&&!busy&&<div className="pending"><button onClick={()=>void checkPending()}>核实操作结果</button><button onClick={()=>{if(window.confirm('请先查看最新任务，确认这次操作的实际结果。清除提示不会重发旧操作。')){setOperation(null);setNotice('');setOptimistic(old=>old?.key===scope?null:old);}}}>我已核实</button></div>}</>;

  const swipe=useRef<{x:number;y:number;mode:'open'|'close'}|null>(null);
  const onShellTouchStart=(e:TouchEvent<HTMLDivElement>)=>{
    if(!isMobile||e.touches.length!==1||sheet||threadMenu||statusPanel||modelPoint||permissionPoint||preview)return;
    const t=e.touches[0];
    if(drawerOpen)swipe.current={x:t.clientX,y:t.clientY,mode:'close'};
    else if(t.clientX<28)swipe.current={x:t.clientX,y:t.clientY,mode:'open'};
  };
  const onShellTouchEnd=(e:TouchEvent<HTMLDivElement>)=>{
    const start=swipe.current;swipe.current=null;
    if(!start||!e.changedTouches.length)return;
    const t=e.changedTouches[0],dx=t.clientX-start.x,dy=t.clientY-start.y;
    if(Math.abs(dx)<56||Math.abs(dx)<Math.abs(dy)*1.4)return;
    if(start.mode==='open'&&dx>0)setDrawerOpen(true);
    else if(start.mode==='close'&&dx<0)setDrawerOpen(false);
  };

  if(!token||status==='auth_error')return <main className="connect"><Icon name="computer" size={38}/><h1>连接你的电脑</h1><p>通过自部署中继继续电脑上的对话。</p><form onSubmit={e=>{e.preventDefault();const value=inviteCode(tokenInput)||tokenInput.trim();save('connection',value);setToken(value);}}><label>中继地址<input readOnly value={location.origin}/></label><label>邀请链接或连接 Token<input type="password" autoComplete="off" value={tokenInput} onChange={e=>setTokenInput(e.target.value)} placeholder="粘贴团队邀请链接，或电脑上的连接 Token" required/></label>{status==='auth_error'&&<p className="error">登录信息无效或已失效。请重新输入，团队成员请向管理员要新的邀请链接。</p>}<button className="primary">连接</button></form><small>也可以用手机扫描电脑上的连接二维码。</small></main>;
  const selectService=(next:Service,keepDrawer=false)=>navigate(switchRoute(machine,route,next),false,keepDrawer);
  const switcher=<ServiceSwitch active={service} available={available} disabled={busy||voiceBusy||imageLoading} select={next=>selectService(next,true)}/>;
  const mobileHeaderCenter=!available||available.length>1
    ?<ServiceSwitch className="header-service-switch" active={service} available={available} disabled={busy||voiceBusy||imageLoading} select={next=>selectService(next,false)}/>
    :<button type="button" className="header-machine-pill" onClick={()=>setSheet('computer')}><i className={connected?'dot online':'dot'}/><span>{machineName}</span></button>;
  const welcomeMeta=<button type="button" className="welcome-machine" onClick={()=>setSheet('computer')}>
    <i className={connected?'dot online':'dot'}/>
    <span>{machineName}</span>
    {!connected&&<small>{status==='online'?'离线':'连接中…'}</small>}
  </button>;
  const previewPane=preview&&<PreviewPane title={previewTitle(preview)} subtitle={preview.kind==='file'?preview.file?.path||preview.path:preview.kind==='web'?preview.session.url:preview.kind==='site'?`${preview.url} · 手机直接访问`:undefined}
       tabs={previewState.tabs.map(tab=>({id:tab.id,title:previewTitle(tab.target)}))} activeTab={previewState.activeId}
       selectTab={id=>{const target=previewState.tabs.find(tab=>tab.id===id)?.target;if(target?.kind==='artifact')notePage(target.url);setPreviewState(old=>({...old,activeId:id}));}} closeTab={closePreviewTab}
       compact={compactPreview} covered={Boolean(sheet||threadMenu||statusPanel||modelPoint||permissionPoint)} close={()=>{if(previewState.tabs.some(tab=>tab.target.kind==='artifact'))notePage('');closePreview();}}>
       {previewState.tabs.map(({id,target})=><div key={id} id={`preview-panel-${id}`} aria-labelledby={previewState.tabs.length>1?`preview-tab-${id}`:undefined} className="preview-tab-panel" role={previewState.tabs.length>1?'tabpanel':undefined} hidden={id!==previewState.activeId}>
         {target.kind==='file'&&(target.file?<Suspense fallback={<p className="preview-notice" role="status">正在加载查看器…</p>}><FilePreviewPanel allowFileUrls={fileOwner(target.threadId).service!=='codex'} key={target.request} file={target.file} connected={connected} line={target.line} openFile={path=>void openFile(path,target.machineId,target.threadId)}
           htmlPreview={browserState?.filePath===target.file.path&&belongsToThread(browserState,target.machineId,target.threadId)?<WebViewer session={browserState} onEnd={closeBrowser}/>:browserBusy?<p role="status">正在打开网页…</p>:null}
           htmlError={target.error} openHtml={()=>void openBrowser({filePath:target.file!.path},target)}
           readFile={path=>fileRequest('read',target.machineId,target.threadId,{path})}
           stream={fileStream(target.machineId,target.threadId,target.file)}
           read={offset=>fileRequest('download',target.machineId,target.threadId,{path:target.file!.path,revision:target.file!.revision,offset})}/></Suspense>:<div className="preview-empty" role={target.error?'alert':'status'}><p>{target.error||'正在读取文件…'}</p>{target.error&&<button disabled={!connected} onClick={()=>void openFile(target.path+(target.line?`:${target.line}`:''),target.machineId,target.threadId)}>重试</button>}</div>)}
         {target.kind==='diff'&&<Suspense fallback={<p className="preview-notice">正在加载差异…</p>}><DiffViewer text={target.text} compact={compactPreview}/></Suspense>}
         {target.kind==='web'&&<WebViewer session={target.session} onEnd={closeBrowser}/>}
         {target.kind==='site'&&<PageViewer src={target.url} address={target.url} widthKey={previewWidthKey(target.machineId,target.threadId)} onEnd={()=>closePreviewTab(id)} endLabel="关闭"/>}
         {target.kind==='artifact'&&<ArtifactPanel url={target.url} fresh={target.fresh} active={id===previewState.activeId} connected={connected&&target.machineId===machine} call={(action,payload)=>call(action,payload,target.machineId)}
           onTitle={title=>setPreviewState(old=>({...old,tabs:old.tabs.map(tab=>tab.id===id&&tab.target.kind==='artifact'?{...tab,target:{...tab.target,title}}:tab)}))}/>}
         {target.kind==='tasks'&&<div className="bg-tasks-pane" ref={setTasksSlot}/>}
         {target.kind==='image'&&<div className="image-viewer"><BlobImage className="preview-image" src={target.url} alt={target.title}/></div>}
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
  const openActivityThread:OpenActivityThread=target=>{
    setSheet(null);
    const next:Route=target.service==='codex'?{...home,thread:target.threadId}:withConversation(serviceHome(target.service),target.threadId);
    if(target.machineId!==machine){
      closeBrowser();closePreview();infoSequence.current++;listLoader.current.invalidate();setListBusy(false);setInfo(null);setProjects([]);setSessions([]);setSearch('');setSearchQuery('');setArchived(false);setNewCwd('');
      history.pushState({cmwRoute:next,cmwMachine:target.machineId},'',location.pathname);rememberLocation(next,target.machineId);setMachine(target.machineId);setRoute(next);
    }else navigate(next);
  };
  async function claimOwner(targetMachine:string,targetService:Service,threadId:string,userId:string|null){
    if(!client.current)throw new Error('尚未连接中继');
    await client.current.team('team.threads.claim',{machineId:targetMachine,service:targetService,threadId,userId});
    const nextOwner=userId?codexMembers.find(item=>item.id===userId)||roster.find(item=>item.id===userId)||null:null;
    if(targetService==='codex'&&targetMachine===machine){
      setSessions(old=>old.map(item=>item.id===threadId?{...item,owner:nextOwner}:item));
      setView(old=>old&&old.id===threadId?{...old,owner:nextOwner}:old);
      listLoader.current.invalidate();void list();refreshExpandedCodex();
    }else refreshRemoteList(value=>value+1);
  }
  const teamPanel=me&&<TeamPanel me={me} team={(action,payload)=>client.current?client.current.team(action,payload):Promise.reject({message:'尚未连接中继'})} logout={logout} copy={copyText}
    machines={new Map(machines.map(item=>[item.id,computerName(item)]))} onOpenThread={openActivityThread}/>;
  const fileOptions=<form onSubmit={e=>{e.preventDefault();void openFile(filePath);}}><label>文件路径<input autoFocus required value={filePath} onChange={e=>setFilePath(e.target.value)} placeholder="例如 README.md 或 docs/deck.pptx"/></label>{error&&<p className="error" role="alert">{error}</p>}<button className="primary">打开文件</button></form>;
  const canCreateProject=connectorHas(activeMachine,'projects.create');
  const canManageProjects=!guest&&connectorHas(activeMachine,'projects.manage');
  const openCreateProject=(origin:'sidebar'|'new-chat')=>{createOrigin.current=origin;setSheet('create-project');};
  const openEditProject=(targetService:BridgeService,targetProject:ProjectItem)=>{setEditingProject({service:targetService,project:targetProject});setSheet('edit-project');};
  const openClaudeProjectSettings=(folder:string)=>{setClaudeSettingsFolder(folder);setSheet('claude-project');};
  async function removeProject(targetService:BridgeService,targetProject:ProjectItem){
    const result=await call('projects.remove',{
      service:targetService,
      ...(targetProject.id?{id:targetProject.id}:{}),
      ...(targetProject.projectId?{projectId:targetProject.projectId}:{}),
      path:targetProject.path,
      opId:operationId(),
    });
    if(result?.state==='failed'||result?.state==='uncertain')throw new Error(result.error?.message||'移除项目失败，请重试');
    if(result?.notice)setNotice(result.notice);
    if(targetService==='codex'){
      setProjects(old=>old.filter(p=>projectPathKey(p)!==targetProject.key));
      setCodexExpandedState(old=>{
        const base=old.keys??[...codexExpandedKeys];
        const next=base.filter(k=>k!==targetProject.key);
        saveExpandedProjects('codex',machine,next);
        return {machine,keys:next};
      });
      refreshInfo();
    }else{
      refreshRemoteList(value=>value+1);
    }
  }
  function handleProjectEdited(updated:{name:string;notice?:string}){
    const targetService=editingProject?.service||service;
    setEditingProject(null);setSheet(null);
    if(updated.notice)setNotice(updated.notice);
    if(targetService==='codex')refreshInfo();
    else refreshRemoteList(value=>value+1);
  }
  function handleProjectCreated(result:ProjectCreateResult,selectedServices:BridgeService[]){
    setSheet(null);
    if(result.results.codex?.ok){
      setProjects(old=>mergeProjectPaths([result.path,...old]));
      if(codexActive)refreshInfo();
    }
    refreshRemoteList(value=>value+1);
    const preferred:Service=result.results[service]?.ok?service:(selectedServices.find(item=>result.results[item]?.ok)||service);
    const notes=[result.results[preferred]?.notice,result.gitNotice].filter(Boolean).join('；');
    if(notes)setNotice(notes);
    if(preferred==='codex'){
      const codexPath=result.results.codex?.project?.path||result.path;
      const key=projectPathKey(codexPath);
      if(createOrigin.current==='new-chat'||newChat)selectProject(codexPath);
      else{
        setCodexExpandedState(old=>{
          const base=(old.machine===machine?old.keys:loadExpandedProjects('codex',machine))??[...codexExpandedKeys];
          const next=[...new Set([...base,key])];
          saveExpandedProjects('codex',machine,next);
          return {machine,keys:next};
        });
        if(service!=='codex')navigate(newChatRoute('codex'),false,true);
      }
    }else if(preferred==='claude'){
      const claudeId=result.results.claude?.project?.id||result.path;
      if(createOrigin.current==='new-chat'||route.newChat)navigate(newChatRoute('claude',claudeId),true);
      else{setAutoExpandKey(projectPathKey(result.path)||claudeId);if(service!=='claude')navigate(newChatRoute('claude'),false,true);}
    }else if(preferred==='antigravity'){
      const agId=result.results.antigravity?.project?.id||result.path;
      if(createOrigin.current==='new-chat'||route.newChat)navigate(newChatRoute('antigravity',agId),true);
      else{setAutoExpandKey(projectPathKey(result.path)||agId);if(service!=='antigravity')navigate(newChatRoute('antigravity'),false,true);}
    }
  }
  const projectCreateSheet=<ProjectCreateSheet key={`${machine}:${service}`} connected={connected} machineServices={available} currentService={service} guest={guest} call={call} onCreated={handleProjectCreated} close={()=>setSheet(null)}/>;
  const projectEditSheet=editingProject&&<ProjectEditSheet
    key={`${editingProject.service}:${editingProject.project.key}`}
    service={editingProject.service}
    project={editingProject.project}
    connected={connected}
    call={call}
    onSaved={handleProjectEdited}
    onOpenClaudeSettings={editingProject.service==='claude'?()=>{const folder=editingProject.project.path;setEditingProject(null);openClaudeProjectSettings(folder);}:undefined}
    close={()=>{setEditingProject(null);setSheet(null);}}
  />;
  const handleVoiceChange=(mode:VoiceProvider)=>{setVoiceChoices(old=>({...old,[service]:mode}));save(voiceEngineKey(service),mode);};
  const refreshSidebar=()=>service==='codex'?(refreshInfo(),void list(false,true),refreshExpandedCodex()):refreshRemoteList(value=>value+1);
  const footerProps:SidebarFooterProps={
    me,machineName,machinesCount:machines.length,connected,relayOnline:status==='online',busy,
    archived:service==='codex'?archived:undefined,
    onToggleArchived:service==='codex'?()=>setArchived(old=>!old):undefined,
    onOpenSettings:()=>setSheet('settings'),
    onOpenComputer:()=>setSheet('computer'),
    onOpenTeam:me?()=>setSheet('team'):undefined,
    onLogout:logout,
  };
  const sidebarFooter=<SidebarFooter {...footerProps}/>;
  const mobileSettings=<MobileSettingsTrigger {...footerProps}/>;
  const settingsSheet=<SettingsSheet
    service={service} me={me} machineName={machineName} connected={connected} relayOnline={status==='online'}
    voiceChoice={voiceChoice} voiceMode={voiceMode} onVoiceChange={handleVoiceChange}
    notify={notify} notifyMessage={notifyMessage} onNotifyChange={(next,msg)=>{setNotify(next);setNotifyMessage(msg);}}
    ownerFilter={ownerFilter} onOwnerFilterChange={me?setOwnerFilter:undefined}
    archived={service==='codex'?archived:undefined}
    onToggleArchived={service==='codex'?()=>setArchived(old=>!old):undefined}
    onOpenComputer={()=>setSheet('computer')}
    onOpenTeam={me?()=>setSheet('team'):undefined}
    onLogout={logout}
    busy={busy}
  />;
  if(service==='antigravity'||service==='claude'){
    const id=remoteConversation,overlayInert=Boolean(sheet||compactPreview&&preview);
    const sidebarInert=overlayInert||Boolean(isMobile&&!drawerOpen);
    const mainInert=overlayInert||Boolean(isMobile&&drawerOpen);
    const open=(next:string)=>{
      if(!next){navigate(newChatRoute(service,route.project));refreshRemoteList(value=>value+1);return;}
      if(next!==id||route.newChat)navigate(withConversation(route,next));
      else setDrawerOpen(false);
    };
    const creatingClaude=service==='claude'&&!id,creatingAntigravity=service==='antigravity'&&!id;
    const created=(next:string)=>{refreshRemoteList(value=>value+1);navigate(withConversation(route,next),true);};
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
    const liveThread=remoteLiveStatus&&remoteLiveStatus.service===service&&remoteLiveStatus.machine===machine&&remoteLiveStatus.status.id===id?remoteLiveStatus.status:null;
    const reportLiveStatus=(status:LiveThreadStatus|null)=>{
      setRemoteLiveStatus(old=>{
        if(!status)return old&&old.service===service&&old.machine===machine?null:old;
        if(old&&old.service===service&&old.machine===machine&&old.status.id===status.id&&old.status.running===status.running&&old.status.background===status.background)return old;
        return {service,machine,status};
      });
    };
    return <SenderRoot me={me?.id}><div className={`shell has-session${drawerOpen?' drawer-open':''}`} onTouchStart={onShellTouchStart} onTouchEnd={onShellTouchEnd}>
      <AntigravitySidebar key={`${service}:${machine}`} service={service} inert={sidebarInert} selected={id} machine={machine} machineName={machineName}
        copyText={copyText} threadActions={service==='claude'?claudeActions:undefined} connected={connected} relayOnline={status==='online'}
        liveThread={liveThread}
        footer={sidebarFooter} mobileSettings={mobileSettings}
        projectsCollapsed={projectsCollapsed} onToggleProjects={toggleProjects} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} me={me} roster={roster} ownerFilter={ownerFilter} onOwnerFilterChange={setOwnerFilter}
        claimOwner={isTeamAdmin(me)?(threadId,userId)=>claimOwner(machine,service,threadId,userId):undefined}
        revision={remoteListRevision} switcher={switcher} call={call} open={open}
        listAction={`${service}.list`} appName={serviceLabel(service)} filter={threads=>filterThreadsByOwner(threads,me,ownerFilter)}
        onNew={targetProject=>navigate(newChatRoute(service,targetProject))}
        onCreateProject={canCreateProject?()=>openCreateProject('sidebar'):undefined}
        onEditProject={canManageProjects?proj=>openEditProject(service,proj):undefined}
        onClaudeSettings={service==='claude'?proj=>openClaudeProjectSettings(proj.path):undefined}
        onRemoveProject={canManageProjects?proj=>removeProject(service,proj):undefined}
        canManageProjects={canManageProjects}
        autoExpandKey={autoExpandKey}
        chooseComputer={()=>setSheet('computer')}/>
      {drawerOpen&&<div className="drawer-backdrop" aria-hidden="true" onClick={()=>setDrawerOpen(false)}/>}
      {(id||creatingClaude)&&service==='claude'?<ClaudeCodePanel key={JSON.stringify([machine,service,id])} inert={mainInert} openFile={markdownOpenFile} openPreview={markdownOpenPreview} showPage={showPage} previewError={error}
        machine={machine} guest={guest} newCwd={creatingClaude?route.project:null} created={created} forked={forked}
        onCreateProject={canCreateProject?()=>openCreateProject('new-chat'):undefined} projectsRevision={remoteListRevision}
        showDiff={turn=>{if(turn.diff)showPreview({kind:'diff',threadId:`claude:${id}`,turnId:turn.id,text:turn.diff});}} voiceMode={voiceMode} chooseVoice={()=>setSheet('voice')} actions={claudeActions}
        claim={isTeamAdmin(me)&&id?{members:roster,assign:userId=>claimOwner(machine,'claude',id,userId)}:undefined}
        showImage={(url,title)=>showPreview({kind:'image',url,title})}
        openSidebar={()=>setDrawerOpen(true)} onNewChat={()=>navigate(newChatRoute('claude'))}
        mobileHeaderCenter={mobileHeaderCenter} mobileHeaderRight={mobileSettings} welcomeMeta={welcomeMeta}
        machineName={machineName} connected={connected} conversationId={id} call={call} go={open} sync={connectorHas(activeMachine,'sync.claude')?syncLink:undefined}
        onLiveStatus={reportLiveStatus}
        showFiles={()=>{setFilePath('');setSheet('file');}} copyText={copyText} clearPreviewError={()=>setError('')}/>:
        <AntigravityPanel key={JSON.stringify([machine,service,id])} inert={mainInert} openFile={markdownOpenFile} openPreview={markdownOpenPreview} previewError={error}
        machine={machine} machineName={machineName} connected={connected} conversationId={id} call={call} go={open} newProject={creatingAntigravity?route.project:null} created={created} voiceMode={voiceMode} chooseVoice={()=>setSheet('voice')}
        onCreateProject={canCreateProject?()=>openCreateProject('new-chat'):undefined} projectsRevision={remoteListRevision}
        sync={connectorHas(activeMachine,'sync.antigravity')?syncLink:undefined}
        showTasks={()=>{if(id)showPreview({kind:'tasks',conversationId:id});}} tasksSlot={tasksSlot}
        claim={isTeamAdmin(me)&&id?{members:roster,assign:userId=>claimOwner(machine,'antigravity',id,userId)}:undefined}
        showImage={(url,title)=>showPreview({kind:'image',url,title})}
        openSidebar={()=>setDrawerOpen(true)} onNewChat={()=>navigate(newChatRoute('antigravity'))}
        mobileHeaderCenter={mobileHeaderCenter} mobileHeaderRight={mobileSettings} welcomeMeta={welcomeMeta}
        onLiveStatus={reportLiveStatus}
        showFiles={()=>{setFilePath('');setSheet('file');}} copyText={copyText} clearPreviewError={()=>setError('')}/>}
      {sheet==='settings'&&<SheetPanel title="设置" close={()=>setSheet(null)}>{settingsSheet}</SheetPanel>}
      {sheet==='voice'&&<SheetPanel title={`语音输入 · ${serviceLabel(service)}`} close={()=>setSheet(null)}>{voiceOptions}</SheetPanel>}
      {sheet==='team'&&teamPanel&&<SheetPanel title="团队" close={()=>setSheet(null)}>{teamPanel}</SheetPanel>}
      {sheet==='computer'&&<SheetPanel title="电脑" close={()=>setSheet(null)}>{computerOptions}</SheetPanel>}
      {sheet==='file'&&<SheetPanel title="查看项目文件" close={()=>setSheet(null)}>{fileOptions}</SheetPanel>}
      {sheet==='claude-project'&&claudeSettingsFolder&&<SheetPanel title="项目设置" close={()=>setSheet(null)}>
        <ClaudeProjectEditor key={claudeSettingsFolder} folder={claudeSettingsFolder} connected={connected} call={call} done={()=>setSheet(null)}/></SheetPanel>}
      {sheet==='create-project'&&<SheetPanel title="新建项目" close={()=>setSheet(null)}>{projectCreateSheet}</SheetPanel>}
      {sheet==='edit-project'&&projectEditSheet&&<SheetPanel title="编辑项目" close={()=>{setEditingProject(null);setSheet(null);}}>{projectEditSheet}</SheetPanel>}
      {previewPane}
    </div></SenderRoot>;
  }
  const codexShowProjectsTree=!searchQuery&&!archived&&(codexProjectItems.length>0||canCreateProject);
  const codexHeading=searchQuery?'搜索结果':archived?'归档会话':'最近';
  const codexGroups=groupThreads(listedThreads,preferences,codexHeading);
  // Folding only applies to the normal list: search results and the archive always show everything.
  const codexFoldable=!searchQuery&&!archived,codexRecentCollapsed=codexFoldable&&collapsedGroups.includes('recent');
  const codexFilterControl=me?<OwnerFilterControl me={me} value={ownerFilter} members={codexMembers} change={setOwnerFilter}/>:null;
  const codexCanManage=canManageProjects&&Boolean(info?.projectApi);
  // Unknown (null) while offline, so a stale list neither shows a run nor marks one finished.
  const isCodexActive=(s:Json)=>!connected?null:(view&&s.id===selected&&view.id===s.id&&!cachedShown?Boolean(view.running):s.status?.type==='active');
  const codexOverlayInert=Boolean(sheet||threadMenu||statusPanel||modelPoint||permissionPoint||compactPreview&&preview);
  const codexSidebarInert=codexOverlayInert||Boolean(isMobile&&!drawerOpen);
  const codexMainInert=codexOverlayInert||Boolean(isMobile&&drawerOpen);
  const openCodexThread=(s:Json)=>{changePreference(s.id,{unread:false});if(s.id===selected&&!newChat)setDrawerOpen(false);else navigate({...home,thread:s.id,newChat:false});};
  return <SenderRoot me={me?.id}><div className={`shell has-session${drawerOpen?' drawer-open':''}`} onTouchStart={onShellTouchStart} onTouchEnd={onShellTouchEnd}>
    <aside className="home-panel" inert={codexSidebarInert}>
      <HomeHeader machineName={machineName} connected={connected} relayOnline={status==='online'} chooseComputer={()=>setSheet('computer')} mobileSettings={mobileSettings} onRefresh={refreshSidebar} refreshDisabled={listBusy}/>
      {!archived&&!searchQuery&&switcher}
      <SidebarActions search={search} setSearch={setSearch} onNew={()=>startNew()} newDisabled={busy||Boolean(pending)}/>
      <div className="home-content">
        {codexShowProjectsTree&&<ProjectTree
          service="codex"
          machine={machine}
          projects={codexProjectItems}
          expandedKeys={codexExpandedKeys}
          onToggleExpand={toggleCodexProject}
          projectThreads={codexProjectThreadsMap}
          onLoadMore={proj=>loadCodexProject(proj,true)}
          selectedThread={selected}
          threadPreferences={preferences}
          isThreadActive={isCodexActive}
          onOpenThread={openCodexThread}
          onThreadMenu={(s,point)=>setThreadMenu({thread:s,point,machine,archived})}
          onNewChat={proj=>startNew(proj.path)}
          onCreateProject={canCreateProject?()=>openCreateProject('sidebar'):undefined}
          onEditProject={codexCanManage?proj=>openEditProject('codex',proj):undefined}
          onRemoveProject={codexCanManage?proj=>removeProject('codex',proj):undefined}
          onMarkAllRead={(_proj,ids)=>markCodexProjectRead(ids)}
          onCopyPath={copyText}
          projectsCollapsed={projectsCollapsed}
          onToggleProjects={toggleProjects}
          connected={connected}
          busy={busy}
          canManageProjects={codexCanManage}
          ownerFiltered={Boolean(me&&ownerFilter!=='all')}
        />}
        <section className="recent-section">
          {archived&&<div className="section-head"><h2>归档会话</h2><button type="button" className="text-button" onClick={()=>setArchived(false)}>返回最近</button></div>}
          {!archived&&!codexGroups.length&&<GroupHeading label={codexHeading} collapsed={codexFoldable&&codexRecentCollapsed} onToggle={codexFoldable?()=>toggleGroup('recent'):undefined} action={codexFilterControl}/>}
          {codexGroups.map((group,index)=>{const folded=codexFoldable&&collapsedGroups.includes(group.key);return <div className="thread-group" key={group.key}>{!archived&&<GroupHeading label={group.label} collapsed={folded} onToggle={codexFoldable?()=>toggleGroup(group.key):undefined} action={index===0?codexFilterControl:undefined}/>}{!folded&&<nav aria-label={group.label}>{group.threads.map(s=><ThreadRow key={s.id} thread={s} selected={s.id===selected} disabled={busy} preference={preferences[s.id]}
            time={relativeTime(s.updatedAt)} active={isCodexActive(s)}
            open={()=>openCodexThread(s)} menu={point=>setThreadMenu({thread:s,point,machine,archived})}/>)}</nav>}</div>;})}
          {codexRecentCollapsed?null:listBusy&&!listedThreads.length?<div className="list-skeleton" role="status" aria-label="正在读取会话"><div/><div/><div/></div>:!listedThreads.length&&<p className="empty-list">{!connected?'连接电脑后，会话会出现在这里。':me&&ownerFilter!=='all'?<>当前仅显示「{ownerFilterLabel(ownerFilter,me,codexMembers)}」的会话，已加载列表中没有匹配项。<button type="button" className="empty-list-action" onClick={()=>setOwnerFilter('all')}>显示全部</button></>:searchQuery?'没有找到匹配的会话。':archived?'还没有归档会话。':'还没有聊天，开始一个新任务吧。'}</p>}
          {cursor&&!codexRecentCollapsed&&<button className="more-link" disabled={listBusy} onClick={()=>void list(true)}>{listBusy?'正在加载…':'加载更多'}</button>}
        </section>
      </div>
      {sidebarFooter}
    </aside>
    {drawerOpen&&<div className="drawer-backdrop" aria-hidden="true" onClick={()=>setDrawerOpen(false)}/>}

    <main className="thread-panel" inert={codexMainInert}>
      <ThreadHeader title={visibleTitle} project={projectName(newChat?newCwd:view?.cwd||project)||'项目'} machineName={machineName} connected={connected} menu={()=>setDrawerOpen(true)} backDisabled={busy} onTitle={element=>newChat?setSheet('projects'):openStatus(element)}
        mobileCenter={newChat?mobileHeaderCenter:undefined} mobileRight={newChat?mobileSettings:undefined}
        onNewChat={!newChat?()=>startNew():undefined} newChatDisabled={busy||Boolean(pending)}
        owner={newChat?null:view?.owner} lastSender={newChat?null:view?.lastSender} meId={me?.id}>
        {!newChat&&<><button type="button" className="icon-button" aria-haspopup="dialog" aria-label={`会话状态：${contextSummary(view?.contextUsage)}`} title="上下文与额度限制" disabled={!selected} onClick={e=>openStatus(e.currentTarget)}><ContextIndicator usage={view?.contextUsage}/></button><button type="button" className="icon-button" aria-haspopup="dialog" aria-label="会话操作" disabled={!selected||busy} onClick={e=>openThreadMenu(e.currentTarget)}><Icon name="more"/></button></>}
      </ThreadHeader>
       {browserSession&&<BrowserPreviewPanel session={browserSession} onOpen={()=>showPreview({kind:'web',session:browserSession})} onClose={closeBrowser}/>}
      {view?.notice&&!newChat&&<div className="banner">{view.notice}{!guest&&view.source==='history'&&!view.running&&!view.resumeUnavailable&&<button disabled={!connected||busy||Boolean(pending)} onClick={()=>{if(window.confirm('确认原桌面或 CLI 中的任务已经结束？继续后将由本连接器运行。'))void mutate('session.resume',{threadId:selected,confirmIdle:true});}}>在这里继续</button>}</div>}
      <div className={`timeline ${newChat||(!loading&&view&&!view.turns.length)?'is-empty':''}`} ref={timeline} onScroll={()=>{const el=timeline.current!,up=el.scrollTop<lastScrollTop.current,distance=el.scrollHeight-el.scrollTop-el.clientHeight;lastScrollTop.current=el.scrollTop;
          // Content that shrinks at the bottom moves the position up without the user; still at the bottom means still following.
          sticky.current=distance<24&&(!up||distance<2);if(up&&el.scrollTop<160&&!historyError)void loadOlder();}}>
        <div className="timeline-content" ref={timelineContent}>
        {loading&&!newChat&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
        {view?.hasMore&&!newChat&&<button className="more-link earlier" disabled={!connected||loadingOlder} onClick={()=>void loadOlder()}>{loadingOlder?'正在加载…':historyError?`${historyError} · 重试`:'加载更早内容'}</button>}
        {pendingShown&&(newChat||!view?.turns.length)?null:newChat||(!loading&&view&&!view.turns.length)?<div className="new-chat-welcome"><h1>我们来处理</h1>{newChat&&welcomeMeta}<button className="center-project" disabled={!newChat||busy} onClick={()=>setSheet('projects')}><Icon name="folder"/><span>{projectName(newChat?newCwd:view?.cwd||'')||'选择项目'}</span>{newChat&&<Icon name="chevron" size={17}/>}</button></div>:<SenderScope senders={view?.turns.flatMap(turn=>turn.items.map(item=>item.sender))||[]}>{conversation}</SenderScope>}
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
          placeholder={newChat?'接下来我们该写什么代码？':otherOwnerHint(view?.owner,me?.id,queueNext?'当前任务完成后发送…':!view?.turns.length?'接下来我们该写什么代码？':`在 ${machineName} 上继续…`)}
          locked={busy} showImage={(url,title)=>showPreview({kind:'image',url,title})} uploadProgress={uploadProgress}
          voice={voice} voiceMode={voiceMode} voiceDisabled={busy} onVoiceStart={()=>{setError('');setNotice('');}} connected={connected}
          add={()=>setSheet('add')} addDisabled={busy||imageLoading}
          permission={<PermissionButton ref={permissionButton} options={APPROVALS} value={approval} current={{id:inheritedApproval||'',label:approvalName(inheritedApproval)}} expanded={Boolean(permissionPoint)} disabled={busy} open={setPermissionPoint}/>}
          model={<ModelButton ref={modelButton} label={modelLabel} details={[effortLabel,isFast?'极速':''].filter(Boolean)} expanded={Boolean(modelPoint)} disabled={busy} open={setModelPoint}/>}
          running={view?.activeTurnId&&view.source!=='history'&&!newChat?{stop:()=>void mutate('turn.stop',target()),disabled:!canOperate,queue:true}:undefined}
          send={{label:queueNext?'完成后发送':'发送消息',sending,disabled:!canWrite||!draft.trim()&&!attachmentCount}}/>
        {pick.inputs}
      </div>
    </main>

     {threadMenu&&threadMenu.machine===machine&&<ThreadMenu key={`${machine}:${threadMenu.thread.id}`} thread={threadMenu.thread} point={threadMenu.point} preference={preferences[threadMenu.thread.id]||{}} sections={[...new Set(Object.values(preferences).map(p=>p.section).filter((s):s is string=>Boolean(s)))]} archived={threadMenu.archived} compact={threadMenu.compact} connected={connected}
       teamMode={Boolean(me)} claim={isTeamAdmin(me)?{members:codexMembers,assign:userId=>claimOwner(machine,'codex',threadMenu.thread.id,userId)}:undefined}
       close={()=>setThreadMenu(current=>current===threadMenu?null:current)} change={patch=>changePreference(threadMenu.thread.id,patch,threadMenu.thread)} copy={()=>copyText(threadMenu.thread.id)} rename={name=>changeThread('session.rename',threadMenu.thread,{name})} archive={()=>changeThread(threadMenu.archived?'session.unarchive':'session.archive',threadMenu.thread)} openPreview={threadMenu.compact?()=>setSheet('browser'):undefined}/>}
     {statusPanel&&statusPanel.machine===machine&&statusPanel.thread===selected&&<ThreadStatusPanel key={`${machine}:${selected}`} point={statusPanel.point} view={view} threadId={selected} cwd={view?.cwd||project} connected={connected} close={()=>setStatusPanel(current=>current===statusPanel?null:current)} copy={()=>copyText(selected)} read={()=>call('session.status',{threadId:selected})}/>}
     {permissionPoint&&<PermissionPicker anchor={permissionButton.current} point={permissionPoint} options={APPROVALS} value={approval} current={{id:inheritedApproval||'',label:approvalName(inheritedApproval)}} title="许可" disabled={busy} onChange={next=>{setApproval(next);if(newChat&&machine)save(codexApprovalKey(machine),next);}} close={()=>setPermissionPoint(null)}/>}
     {modelPoint&&<ModelPicker anchor={modelButton.current} point={modelPoint} models={availableModels} value={{model,effort,serviceTier}} current={currentModel} disabled={busy} onChange={value=>{setModel(value.model);setEffort(value.effort);setServiceTier(value.serviceTier);if(newChat&&machine){save(codexModelKey(machine),value.model);save(codexEffortKey(machine),value.effort);save(codexTierKey(machine),value.serviceTier===undefined?'__inherit':value.serviceTier);}}} close={()=>setModelPoint(null)}/>}
     {sheet&&<SheetPanel title={sheet==='voice'?`语音输入 · ${serviceLabel(service)}`:({settings:'设置',computer:'电脑',projects:'选择项目','create-project':'新建项目','edit-project':'编辑项目',add:'添加与选项',file:'查看项目文件',browser:'打开网页','claude-project':'项目设置',team:'团队'} as const)[sheet]} close={()=>{if(sheet==='browser'){browserSequence.current++;setBrowserRequest(null);setUnreachable('');}if(sheet==='edit-project')setEditingProject(null);setSheet(null);}}>
       {sheet==='settings'&&settingsSheet}
      {sheet==='computer'&&computerOptions}
       {sheet==='projects'&&<><div className="project-choices">{projects.map(p=><MenuItem icon="folder" key={p} disabled={busy} onClick={()=>selectProject(p)}><span>{projectName(p)}<small>{p}</small></span>{projectPathKey(p)===projectPathKey(newCwd)&&<Icon name="check" size={18}/>}</MenuItem>)}</div>
         {canCreateProject?<MenuItem icon="plus" disabled={!connected||busy} onClick={()=>openCreateProject('new-chat')}>新建或关联项目</MenuItem>
         :guest?<GuestProjectForm connected={connected&&!busy} call={call} select={path=>{setProjects(old=>mergeProjectPaths([...old,path]));selectProject(path);}}/>:
         <details className="other-project"><summary>其他项目目录</summary><form onSubmit={e=>{e.preventDefault();setSheet(null);}}><label>电脑上的完整项目路径<input value={newCwd} onChange={e=>setNewCwd(e.target.value)} required/></label><button className="primary">使用这个目录</button></form></details>}</>}
       {sheet==='create-project'&&projectCreateSheet}
       {sheet==='edit-project'&&projectEditSheet}
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
// Ask the browser not to evict drafts and cached threads under storage pressure when supported.
try{void navigator.storage?.persist?.().catch(()=>{});}catch{}
// The stored cache is read first (bounded by a short timeout) so the first paint can show it.
void Promise.all([loadCache(),loadThreadStore(),loadDraftAttachments()]).finally(()=>createRoot(document.getElementById('root')!).render(<><App/><UpdateBanner/></>));
