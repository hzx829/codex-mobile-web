import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {resolveCodex} from '../src/connector/app-server.js';
import {removeTestTemp} from '../scripts/test-temp.js';

async function fixture(){
  const cwd=await mkdtemp(join(tmpdir(),'cmw-reload-'));
  class Runtime extends EventEmitter{
    bin='old-codex.exe';version='old';requests=new Map();calls:string[]=[];running=false;failNew=false;waitRead:Promise<void>|undefined;
    async rpc(method:string){
      this.calls.push(method);
      if(method==='thread/start'||method==='thread/resume')return {thread:{id:'s'},model:'selected',modelProvider:'openai',approvalPolicy:'never'};
      if(method==='thread/read'){await this.waitRead;return {thread:{id:'s',cwd,turns:[{id:'t',status:this.running?'inProgress':'completed',items:[]}]}};}
      throw Error(method);
    }
    async stop(){this.calls.push('stop');this.emit('offline');}
    async start(){this.calls.push('start');if(this.failNew&&this.bin!=='old-codex.exe')throw Error('incompatible');this.version=this.bin==='old-codex.exe'?'old':'new';}
    close(){}
  }
  class Desktop extends EventEmitter{clientId='';states=new Map();close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any);
  await control.handle({id:'create',action:'session.create',payload:{cwd,opId:`${Date.now()}:${randomUUID()}`}});
  const reload=()=>control.handle({id:'reload',action:'runtime.reload',payload:{generation:control.generation,expectedBin:resolveCodex()}});
  return {runtime,control,reload,cleanup:async()=>{control.close();await removeTestTemp(cwd);}};
}
test('reload refuses active turns and pending approvals without stopping the runtime',async()=>{
  const f=await fixture();try{
    f.runtime.running=true;await assert.rejects(f.reload(),/仍在运行/);assert(!f.runtime.calls.includes('stop'));
    f.runtime.running=false;f.runtime.requests.set('approval',{});await assert.rejects(f.reload(),/尚未结束/);assert(!f.runtime.calls.includes('stop'));
  }finally{await f.cleanup();}
});
test('reload blocks new operations during its idle check and restores every loaded thread',async()=>{
  const f=await fixture();try{
    let release!:()=>void;f.runtime.waitRead=new Promise(resolve=>{release=resolve;});
    const pending=f.reload();
    await assert.rejects(f.control.handle({id:'new',action:'session.create',payload:{cwd:'.',opId:`${Date.now()}:${randomUUID()}`}}),/正在适配/);
    release();const result=await pending;assert.equal(result.restored,1);assert.equal(f.runtime.bin,resolveCodex());
    assert.equal((await f.control.read('s')).source,'connector');
  }finally{await f.cleanup();}
});
test('a failed runtime switch restores the previous binary and its loaded threads',async()=>{
  const f=await fixture();try{
    f.runtime.failNew=true;await assert.rejects(f.reload(),/已恢复原运行端/);
    assert.equal(f.runtime.bin,'old-codex.exe');assert.equal((await f.control.read('s')).source,'connector');
  }finally{await f.cleanup();}
});

test('preparing a connector deployment holds the idle guard and returns the complete loaded set',async()=>{
  const f=await fixture();try{
    const result=await f.control.handle({id:'prepare',action:'runtime.reload',payload:{generation:f.control.generation,expectedBin:resolveCodex(),prepareOnly:true}});
    assert.deepEqual(result.threadIds,['s']);assert.equal(result.prepared,true);assert.equal(result.leaseMs,60000);
    assert(!f.runtime.calls.includes('stop'));
    await assert.rejects(f.control.handle({id:'new',action:'session.create',payload:{cwd:'.'}}),/正在适配/);
  }finally{await f.cleanup();}
});
