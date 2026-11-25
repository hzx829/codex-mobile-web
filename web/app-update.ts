// Keeps an open page on the latest web release. The service worker opens the cached page at once and
// fetches a new one in the background (public/sw.js); afterwards it names the files the cached page uses.
// A page built from other files is outdated: it reloads by itself when it was just opened or brought back
// and nobody has touched it yet, and otherwise offers a refresh.

/** How long after opening or returning to the page it may reload without asking. */
export const QUIET_RELOAD_MS=15_000;
/** At most one automatic reload in this period, so a page the worker cannot replace never loops. */
export const RELOAD_GUARD_MS=60_000;

/** The versioned files a page was built from, as the service worker names them. */
export function pageAssets(doc:Pick<Document,'querySelectorAll'>):string[]{
  const paths=Array.from(doc.querySelectorAll('script[src],link[href]'),element=>{
    try{return new URL(element.getAttribute('src')||element.getAttribute('href')||'','https://page.invalid/').pathname;}catch{return '';}
  });
  return [...new Set(paths.filter(path=>path.startsWith('/assets/')))];
}

/** True when the cached page uses files this page was not built from. An unknown or empty list is not news. */
export function outdated(own:string[],current:unknown):boolean{
  return Array.isArray(current)&&current.length>0&&own.some(path=>!current.includes(path));
}

export type UpdateAction='none'|'reload'|'offer';

/** Decides what to do with each answer from the service worker. */
export class UpdateWatch{
  private shown:number;
  private touched=false;
  constructor(private readonly own:string[],private readonly now:()=>number=Date.now){this.shown=now();}
  /** The page was opened or came back to the screen: a quiet reload is allowed again until someone touches it. */
  show(){this.shown=this.now();this.touched=false;}
  /** A tap, key or scroll: from now on, ask before reloading. */
  touch(){this.touched=true;}
  decide(current:unknown,{visible,lastReload,dirty=false}:{visible:boolean;lastReload:number;dirty?:boolean}):UpdateAction{
    if(!outdated(this.own,current))return 'none';
    const now=this.now(),quiet=visible&&!this.touched&&!dirty&&now-this.shown<QUIET_RELOAD_MS&&now-lastReload>=RELOAD_GUARD_MS;
    return quiet?'reload':'offer';
  }
}
