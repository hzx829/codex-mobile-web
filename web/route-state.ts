import {SERVICES, SERVICE_IDS, isConversation, remoteFields, routeConversation, serviceHome, serviceOf, type Service} from './services';

export type Route={thread:string;project:string;newChat:boolean;antigravity?:string;claude?:string};
export const home:Route={thread:'',project:'',newChat:false};
export type SavedLocation={route:Route;machine:string};
/** Cold starts (after the browser process was killed) resume an open chat within this window; older ones land on new chat. */
export const COLD_START_STALE_MS=30*60*1000;

export function newChatRoute(service:Service='codex',project=''):Route{
  return {...serviceHome(service,project),project:project||'',newChat:true};
}

export function hasOpenConversation(route:Route):boolean{
  return Boolean(route.thread||routeConversation(route));
}

export function ensureComposerRoute(route:Route):Route{
  return hasOpenConversation(route)||route.newChat?route:newChatRoute(serviceOf(route),route.project);
}

export function parseLocation(value:unknown):SavedLocation|null{
  if(!value||typeof value!=='object')return null;
  const state=value as {cmwRoute?:Partial<Route>&{chat?:unknown};cmwMachine?:unknown};
  const route=state.cmwRoute;
  if(!route||typeof route.thread!=='string'||typeof route.project!=='string'||typeof route.newChat!=='boolean'||typeof state.cmwMachine!=='string')return null;
  const present=remoteFields().filter(field=>route[field]!==undefined);
  if(present.length>1)return null;
  const field=present[0];
  if(field){
    const id=route[field];
    if(typeof id!=='string'||id!==''&&!isConversation(id))return null;
    const service=SERVICE_IDS.find(item=>(SERVICES[item] as {field?:string}).field===field)!;
    const keepsProject=(SERVICES[service] as {keepsProject?:boolean}).keepsProject;
    return {route:{...home,project:keepsProject?route.project:'',newChat:id===''&&route.newChat,[field]:id},machine:state.cmwMachine};
  }
  if(route.chat!==undefined)return {route:home,machine:state.cmwMachine};
  return {route:{thread:route.thread,project:route.project,newChat:route.newChat},machine:state.cmwMachine};
}

function parsePersisted(raw:string|null):{location:SavedLocation;savedAt:number|null}|null{
  if(!raw)return null;
  try{
    const parsed=JSON.parse(raw) as {savedAt?:unknown};
    const location=parseLocation(parsed);
    if(!location)return null;
    const savedAt=typeof parsed?.savedAt==='number'&&Number.isFinite(parsed.savedAt)?parsed.savedAt:null;
    return {location,savedAt};
  }catch{return null;}
}

function resolveColdStart(entry:{location:SavedLocation;savedAt:number|null},now:number):SavedLocation{
  const {route,machine}=entry.location;
  if(hasOpenConversation(route)&&entry.savedAt!==null&&now-entry.savedAt>COLD_START_STALE_MS){
    return {route:newChatRoute(serviceOf(route),route.project),machine};
  }
  return {route:ensureComposerRoute(route),machine};
}

export function initialLocation(now=Date.now()):SavedLocation{
  const fromHistory=parseLocation(history.state);
  if(fromHistory)return fromHistory;
  try{
    const fromSession=parsePersisted(sessionStorage.getItem('cmw-location'));
    if(fromSession)return fromSession.location;
  }catch{}
  try{
    const fromLocal=parsePersisted(localStorage.getItem('cmw-location'));
    if(fromLocal)return resolveColdStart(fromLocal,now);
  }catch{}
  return {route:newChatRoute('codex'),machine:''};
}

export function rememberLocation(route:Route,machine:string,now=Date.now()){
  try{sessionStorage.setItem('cmw-location',JSON.stringify({cmwRoute:route,cmwMachine:machine}));}catch{}
  try{localStorage.setItem('cmw-location',JSON.stringify({cmwRoute:route,cmwMachine:machine,savedAt:now}));}catch{}
}

/** Refreshes the saved timestamp when the page goes to background so the cold-start window counts from when the user left. */
export function touchLocation(now=Date.now()){
  try{
    const current=parsePersisted(localStorage.getItem('cmw-location'));
    if(current){
      localStorage.setItem('cmw-location',JSON.stringify({cmwRoute:current.location.route,cmwMachine:current.location.machine,savedAt:now}));
    }
  }catch{}
}

/** Clears saved location and per-service routes on sign-out so another account starts clean. */
export function clearSavedLocation(){
  for(const storage of [()=>{return sessionStorage;},()=>{return localStorage;}]){
    try{
      const target=storage();
      target.removeItem('cmw-location');
      const keys:string[]=[];
      for(let i=0;i<target.length;i++){
        const k=target.key(i);
        if(k&&k.startsWith('["cmw-service",'))keys.push(k);
      }
      for(const k of keys)target.removeItem(k);
    }catch{}
  }
}
