// Keep storage off the keystroke path; flush before navigation, sending, or backgrounding.
export class DraftSave {
  private pending:{key:string;value:string}|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private save:(key:string,value:string)=>void,private delay=300){}
  write(key:string,value:string){
    if(this.pending&&this.pending.key!==key)this.flush();
    this.pending={key,value};clearTimeout(this.timer);
    this.timer=setTimeout(()=>this.flush(),this.delay);
  }
  flush(){
    clearTimeout(this.timer);this.timer=undefined;
    const pending=this.pending;this.pending=null;
    if(pending)this.save(pending.key,pending.value);
  }
}
