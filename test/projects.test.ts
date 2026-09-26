import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {projectCatalog} from '../src/connector/projects.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError} from '../src/shared/types.js';

test('native projects keep desktop names and order, including empty or moved projects',()=>{
  const a=resolve('missing-project-a'),b=resolve('missing-project-b'),c=resolve('cli-only-project');
  const state={'local-projects':{first:{name:'旧名称',rootPaths:[a]},second:{name:'我的项目',rootPaths:[b]}},'project-order':['second','first'],'electron-saved-workspace-roots':[resolve('stale-legacy-path')]};
  const projects=projectCatalog(state,{projects:{[a]:{},[c]:{trust_level:'trusted'}}});
  assert.deepEqual(projects,[{path:b,name:'我的项目'},{path:a,name:'旧名称'},{path:c,name:'cli-only-project'}]);
  assert.deepEqual(projectCatalog({'electron-saved-workspace-roots':[a],'electron-workspace-root-labels':{[a]:'自定义名称'}},{}),[{path:a,name:'自定义名称'}]);
});

test('session listing and reading do not require an allowed or existing directory',async()=>{
  const moved=resolve('directory-no-longer-exists'),outside=process.platform==='win32'?'Z:\\other-project':'/other-project';
  class Runtime extends EventEmitter {
    calls:any[]=[];requests=new Map();
    async rpc(method:string,params:any) {
      this.calls.push({method,params});
      if(method==='thread/list')return params.useStateDbOnly?{data:[{id:'moved',cwd:moved,name:'旧会话'},{id:'other',cwd:outside},{id:'chat',cwd:''}],nextCursor:'page-2'}:{data:[],nextCursor:'scan-cursor'};
      if(method==='thread/read')return {thread:{id:'moved',cwd:moved,turns:[]}};
      if(method==='config/read')return {config:{model:'custom-model',model_provider:'custom',secret:'must-stay-local'}};
      if(method==='model/list')return {data:[]};
      throw Error(method);
    }
    close(){}
  }
  class Desktop extends EventEmitter {clientId='';async follow(){throw Error('not active');}close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any,async()=>[{path:outside,name:'电脑项目'}]);
  try {
    const list=await control.handle({id:'list',action:'sessions.list',payload:{cursor:'page-1',archived:true}});
    assert.deepEqual(list.data.map((t:any)=>t.id),['moved','other','chat']);assert.equal(list.nextCursor,'page-2');
    const params=runtime.calls.at(-1).params;assert.equal(params.cwd,undefined);assert.deepEqual(params.modelProviders,[]);assert.equal(params.archived,true);assert.equal(params.cursor,'page-1');assert.ok(params.sourceKinds.includes('subAgent'));
    assert.equal(params.useStateDbOnly,true);
    const repaired=await control.handle({id:'repair',action:'sessions.list',payload:{cwd:moved,refresh:true}});
    assert.deepEqual(runtime.calls.slice(-2).map(c=>c.params.useStateDbOnly),[false,true]);assert.deepEqual(repaired,list);
    assert.equal((await control.read('moved')).id,'moved');
    await control.handle({id:'filter',action:'sessions.list',payload:{cwd:moved}});assert.equal(runtime.calls.at(-1).params.cwd,moved);
    const info=await control.handle({id:'info',action:'info',payload:{}});assert.deepEqual(info.roots,[outside]);assert.equal(info.projects[0].name,'电脑项目');assert.ok(!JSON.stringify(info).includes('must-stay-local'));
  } finally {control.close();}
});

test('paginated history uses the turns endpoint when thread/read cannot include turns',async()=>{
  const cwd=resolve('paged-project');
  class Runtime extends EventEmitter {
    calls:any[]=[];requests=new Map();
    async rpc(method:string,params:any) {
      this.calls.push({method,params});
      if(method==='thread/read'&&params.includeTurns)throw new BridgeError('runtime_error','paginated threads do not support thread/read(includeTurns=true)');
      if(method==='thread/read')return {thread:{id:'paged',cwd,name:'分页会话',turns:[]}};
      if(method==='thread/turns/list')return {data:[{id:'new',status:'completed',items:[{id:'reply',type:'agentMessage',text:'完整回复'}]},{id:'old',status:'completed',items:[]}],nextCursor:'older'};
      throw Error(method);
    }
    close(){}
  }
  class Desktop extends EventEmitter {clientId='';async follow(){throw Error('not active');}close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any);
  try {
    const view=await control.read('paged',5);
    assert.equal(view.source,'history');assert.equal(view.hasMore,true);assert.deepEqual(view.turns.map(t=>t.id),['old','new']);
    assert.equal(view.turns[1].items[0].text,'完整回复');
    assert.deepEqual(runtime.calls.at(-1),{method:'thread/turns/list',params:{threadId:'paged',limit:5,sortDirection:'desc',itemsView:'full'}});
  } finally {control.close();}
});

test('paginated history uses the local index when turn listing is unavailable',async()=>{
  const cwd=resolve('paged-project');
  class Runtime extends EventEmitter {
    requests=new Map();
    async rpc(method:string,params:any) {
      if(method==='thread/read'&&params.includeTurns)throw new BridgeError('runtime_error','list_turns is not supported yet');
      if(method==='thread/read')return {thread:{id:'paged',cwd,name:'分页会话'}};
      if(method==='thread/turns/list')throw Error('unsupported endpoint should not be called');
      throw Error(method);
    }
    close(){}
  }
  class Desktop extends EventEmitter {clientId='';async follow(){throw Error('not active');}close(){}}
  const history=()=>({turns:[{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:'本地记录'}]}],hasMore:true});
  const control=new Control(new Ledger(':memory:'),new Runtime() as any,new Desktop() as any,async()=>[],history);
  try {
    const view=await control.read('paged',5);
    assert.equal(view.source,'history');assert.equal(view.hasMore,true);
    assert.equal(view.resumeUnavailable,true);
    assert.equal(view.turns[0].items[0].text,'本地记录');
    const resume=await control.handle({id:'resume',action:'session.resume',payload:{threadId:'paged',confirmIdle:true,opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(resume.state,'failed');assert.equal(resume.error.code,'unsupported');
  } finally {control.close();}
});
