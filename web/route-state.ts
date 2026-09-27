export type Route={thread:string;project:string;newChat:boolean};
export const home:Route={thread:'',project:'',newChat:false};
export type SavedLocation={route:Route;machine:string};

export function parseLocation(value:unknown):SavedLocation|null{
  if(!value||typeof value!=='object')return null;
  const state=value as {cmwRoute?:Partial<Route>;cmwMachine?:unknown};
  const route=state.cmwRoute;
  if(!route||typeof route.thread!=='string'||typeof route.project!=='string'||typeof route.newChat!=='boolean'||typeof state.cmwMachine!=='string')return null;
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
