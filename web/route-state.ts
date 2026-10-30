export type Route={thread:string;project:string;newChat:boolean;chat?:string};
export const home:Route={thread:'',project:'',newChat:false};
export type SavedLocation={route:Route;machine:string};

export function parseLocation(value:unknown):SavedLocation|null{
  if(!value||typeof value!=='object')return null;
  const state=value as {cmwRoute?:Partial<Route>;cmwMachine?:unknown};
  const route=state.cmwRoute;
  if(!route||typeof route.thread!=='string'||typeof route.project!=='string'||typeof route.newChat!=='boolean'||typeof state.cmwMachine!=='string')return null;
  if(route.chat!==undefined){
    if(typeof route.chat!=='string'||route.chat!==''&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(route.chat))return null;
    return {route:{...home,chat:route.chat},machine:state.cmwMachine};
  }
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
