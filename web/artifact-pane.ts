import type {TurnView} from '../src/shared/types';

/**
 * Which claude.ai page the preview pane shows for a Claude Code conversation, the way Claude's own app does it:
 * a publish or an `open` call brings the page up, the pane stays with the conversation until it is closed,
 * and the copy on screen is renewed when the page changes.
 */
export type PaneAction={url:string;title:string;fresh?:string;open:boolean};
type Page=NonNullable<TurnView['pages']>[number];

const CLOSED='closed';
const key=(machine:string,conversation:string)=>`claude:${machine}:${conversation}:page`;
/** The page left open in this conversation, `''` when the pane was closed, `null` when nothing was recorded. */
export function savedPage(machine:string,conversation:string):string|null {
  try{const value=localStorage.getItem(key(machine,conversation));return value===null?null:value===CLOSED?'':value;}catch{return null;}
}
export function rememberPage(machine:string,conversation:string,url:string){
  try{localStorage.setItem(key(machine,conversation),url||CLOSED);}catch{}
}

const own=(turn:TurnView):Page[]=>(turn.pages||[]).filter(page=>!page.earlier);
/** While a turn runs only a call that shows the page renews the copy; once it ends, its last change does. */
const freshKey=(turn:TurnView,page:Page)=>turn.status==='inProgress'?page.shown:page.changed||page.shown;

/** The page to bring back when a conversation is opened. */
export function pageToRestore(turns:TurnView[],saved:string|null):PaneAction|null {
  if(saved==='')return null;
  const pages=turns.flatMap(turn=>turn.pages||[]);
  const latest=turns.flatMap(own).at(-1);
  const page=saved?pages.find(item=>item.url===saved)||null:latest;
  return page?{url:page.url,title:page.title,open:true}:null;
}

/**
 * What changed since `seen` was last updated: pages newly shown to the user (`open`) and pages whose copy is out of date.
 * `seen` is updated in place; pass a fresh map with `quiet` to take a conversation's history as already seen.
 */
export function paneActions(turns:TurnView[],seen:Map<string,string>,quiet=false):PaneAction[] {
  // A page several turns touched is judged by the newest of them.
  const latest=new Map<string,{turn:TurnView;page:Page}>();
  for(const turn of turns)for(const page of own(turn))latest.set(page.url,{turn,page});
  const actions:PaneAction[]=[];
  for(const {turn,page} of latest.values()){
    const shown=page.shown,fresh=freshKey(turn,page);
    const opened=Boolean(shown)&&seen.get(`shown:${page.url}`)!==shown,renewed=Boolean(fresh)&&seen.get(`fresh:${page.url}`)!==fresh;
    if(shown)seen.set(`shown:${page.url}`,shown);
    if(fresh)seen.set(`fresh:${page.url}`,fresh);
    if(opened||renewed)actions.push({url:page.url,title:page.title,fresh,open:opened});
  }
  return quiet?[]:actions;
}
