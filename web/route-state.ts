import {SERVICES, SERVICE_IDS, isConversation, remoteFields} from './services';

export type Route={thread:string;project:string;newChat:boolean;antigravity?:string;claude?:string};
export const home:Route={thread:'',project:'',newChat:false};
export type SavedLocation={route:Route;machine:string};

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
    return {route:{...home,project:keepsProject?route.project:'',[field]:id},machine:state.cmwMachine};
  }
  if(route.chat!==undefined)return {route:home,machine:state.cmwMachine};
  return {route:{thread:route.thread,project:route.project,newChat:route.newChat},machine:state.cmwMachine};
}

export function initialLocation():SavedLocation{
  const fromHistory=parseLocation(history.state);
  if(fromHistory)return fromHistory;
  try{const saved=sessionStorage.getItem('cmw-location');if(saved){const location=parseLocation(JSON.parse(saved));if(location)return location;}}catch{}
  return {route:home,machine:''};
}

export function rememberLocation(route:Route,machine:string){
  try{sessionStorage.setItem('cmw-location',JSON.stringify({cmwRoute:route,cmwMachine:machine}));}catch{}
}
