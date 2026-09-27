import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {projectCatalog,indexedSessions} from '../src/connector/projects.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError} from '../src/shared/types.js';
import {removeTestTemp} from '../scripts/test-temp.js';

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
      if(method==='thread/read')return {thread:{id:'moved',cwd:moved,turns:[]}};
      if(method==='config/read')return {config:{model:'custom-model',model_provider:'custom',secret:'must-stay-local'}};
      if(method==='model/list')return {data:[]};
      throw Error(method);
    }
    close(){}
  }
  class Desktop extends EventEmitter {clientId='';states=new Map();async follow(){throw Error('not active');}close(){}}
  const runtime=new Runtime(),lists:any[]=[],control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any,async()=>[{path:outside,name:'电脑项目'}],()=>null,(options:any)=>{
    lists.push(options);return {data:[{id:'moved',cwd:moved,title:'旧会话'},{id:'other',cwd:outside,title:'其他会话'},{id:'chat',cwd:'',title:'会话'}].map(row=>({...row,model:'',provider:'openai',updatedAt:0})),nextCursor:'page-2'};
  });
  try {
    const list=await control.handle({id:'list',action:'sessions.list',payload:{cursor:'page-1',archived:true}});
    assert.deepEqual(list.data.map((t:any)=>t.id),['moved','other','chat']);assert.equal(list.nextCursor,'page-2');
    assert.deepEqual(lists.at(-1),{cwd:undefined,archived:true,search:undefined,cursor:'page-1'});
    const repaired=await control.handle({id:'repair',action:'sessions.list',payload:{cwd:moved,refresh:true}});
    assert.deepEqual(repaired,list);
    assert.equal((await control.read('moved')).id,'moved');
    await control.handle({id:'filter',action:'sessions.list',payload:{cwd:moved}});assert.equal(lists.at(-1).cwd,moved);
    const info=await control.handle({id:'info',action:'info',payload:{}});assert.deepEqual(info.roots,[outside]);assert.equal(info.projects[0].name,'电脑项目');assert.ok(!JSON.stringify(info).includes('must-stay-local'));
  } finally {control.close();}
});

test('session index lists desktop-owned threads without asking app-server to open them',async()=>{
  const home=await mkdtemp(join(tmpdir(),'cmw-index-')),cwd=resolve('project');
  const db=new DatabaseSync(join(home,'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT,name TEXT,title TEXT,preview TEXT,cwd TEXT,model TEXT,model_provider TEXT,updated_at INTEGER,archived INTEGER)');
  const insert=db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<32;i++)insert.run(`thread-${i}`,null,`会话 ${i}`,`会话 ${i}`,process.platform==='win32'?`\\\\?\\${cwd}`:cwd,'model','openai',1000-i,0);
  insert.run('archived',null,'旧会话','旧会话',cwd,'model','openai',2000,1);
  insert.run('empty',null,null,null,cwd,'model','openai',3000,0);
  db.close();
  try{
    const first=indexedSessions({cwd,archived:false},home);
    assert.equal(first.data.length,30);assert.equal(first.data[0].id,'thread-0');assert.equal(first.nextCursor,'db:30');
    const second=indexedSessions({cwd,archived:false,cursor:first.nextCursor!},home);
    assert.deepEqual(second.data.map(t=>t.id),['thread-30','thread-31']);assert.equal(second.nextCursor,null);
    assert.deepEqual(indexedSessions({cwd,archived:false,search:'会话 7'},home).data.map(t=>t.id),['thread-7']);
    assert.deepEqual(indexedSessions({cwd,archived:true},home).data.map(t=>t.id),['archived']);
    assert.throws(()=>indexedSessions({archived:false,cursor:'wrong'},home),/分页标识/);
  }finally{await removeTestTemp(home);}
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
