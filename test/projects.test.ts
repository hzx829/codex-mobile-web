import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {projectCatalog} from '../src/connector/projects.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';

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
