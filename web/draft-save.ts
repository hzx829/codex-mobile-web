// Keep storage off the keystroke path; flush before navigation, sending, reload, or backgrounding.
const pendingInstances=new Set<DraftSave>();

/** Flushes every DraftSave with an unsaved change immediately (e.g. before a hot-deploy reload). */
export function flushAllDrafts(){
  for(const instance of [...pendingInstances])instance.flush();
}

/** True when any composer has typed text waiting for its debounce timer to persist. */
export function hasPendingDrafts():boolean{
  return pendingInstances.size>0;
}

export class DraftSave {
  private pending:{key:string;value:string}|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private save:(key:string,value:string)=>void,private delay=300){}
  write(key:string,value:string){
    if(this.pending&&this.pending.key!==key)this.flush();
    this.pending={key,value};
    pendingInstances.add(this);
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>this.flush(),this.delay);
  }
  flush(){
    clearTimeout(this.timer);this.timer=undefined;
    pendingInstances.delete(this);
    const pending=this.pending;this.pending=null;
    if(pending)this.save(pending.key,pending.value);
  }
}
