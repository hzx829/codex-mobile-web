// A polling tick must not supersede an unfinished read for the same project.
export class SessionListLoader {
  private active:{key:string}|null=null;
  invalidate(){this.active=null;}
  async load<T>(key:string,read:()=>Promise<T>,handlers:{start:()=>void;result:(value:T)=>void;error:(error:unknown)=>void;finish:()=>void}) {
    if(this.active?.key===key)return;
    const request={key};this.active=request;handlers.start();
    try {const result=await read();if(this.active===request)handlers.result(result);}
    catch(error){if(this.active===request)handlers.error(error);}
    finally {if(this.active===request){this.active=null;handlers.finish();}}
  }
}
