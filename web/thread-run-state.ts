import {useEffect,useState} from 'react';

/**
 * The sidebar dot for a conversation's run: a blinking green dot while it runs, a steady green dot
 * once a run this browser saw has ended and the conversation hasn't been opened since. Kept in this
 * browser so a run that ends while the drawer is closed, or the page is reloaded, still shows as done.
 */
export type RunMark='running'|'done'|'';
type Stored='running'|'done';
const KEY='thread-run-state';
let memory:Record<string,Stored>|null=null;
const listeners=new Set<()=>void>();
function load(){
  if(!memory){try{const value=JSON.parse(localStorage.getItem(KEY)||'{}');memory=value&&typeof value==='object'?value:{};}catch{memory={};}}
  return memory!;
}
function store(id:string,value:Stored|undefined){
  const values=load();if(values[id]===value)return;
  if(value)values[id]=value;else delete values[id];
  try{localStorage.setItem(KEY,JSON.stringify(values));}catch{}
  listeners.forEach(listener=>listener());
}

/** What to remember after seeing a row; `active` null means unknown (the computer is offline), so nothing changes. */
export function nextRunState(prev:Stored|undefined,active:boolean|null,selected:boolean):Stored|undefined{
  if(active===null)return prev;
  if(active)return 'running';
  if(selected)return undefined;
  return prev?'done':undefined;
}
/** What the row shows: an open conversation's finished run counts as seen. */
export function runMark(prev:Stored|undefined,active:boolean|null,selected:boolean):RunMark{
  if(active)return 'running';
  if(selected)return '';
  const next=nextRunState(prev,active,selected);
  return next==='done'?'done':'';
}

export function clearRunDone(id:string){if(load()[id]==='done')store(id,undefined);}

export function useRunMark(id:string,active:boolean|null,selected:boolean):RunMark{
  const [,refresh]=useState(0);
  useEffect(()=>{const listener=()=>refresh(n=>n+1);listeners.add(listener);return()=>{listeners.delete(listener);};},[]);
  useEffect(()=>{store(id,nextRunState(load()[id],active,selected));},[id,active,selected]);
  return runMark(load()[id],active,selected);
}
