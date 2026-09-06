import {removeTestTemp} from '../scripts/test-temp.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/connector/ledger.js';
import {applyPatches} from '../src/connector/desktop.js';
import {normalizeSession} from '../src/connector/normalize.js';
import {approvalResult} from '../src/connector/approvals.js';
import {readProjectFile} from '../src/connector/project.js';
import {BridgeError} from '../src/shared/types.js';
import {AppServer} from '../src/connector/app-server.js';
const op=()=>`${Date.now()}:${randomUUID()}`;

test('approval success waits for native resolution; missing receipt stays uncertain',async()=>{
  const server=new AppServer('unused-test-binary');let written:any;
  server.child={stdin:{destroyed:false,write:(value:string)=>{written=JSON.parse(value);}}} as any;
  server.requests.set('41',{id:41,method:'item/fileChange/requestApproval',params:{}});
  let resolved=false;const response=server.respond('41',{decision:'accept'},200).then(()=>{resolved=true;});
  await new Promise(r=>setTimeout(r,10));assert.equal(resolved,false);assert.equal(written.id,41);
  (server as any).receive({method:'serverRequest/resolved',params:{requestId:41}});await response;assert.equal(resolved,true);assert.equal(server.requests.has('41'),false);
  server.requests.set('42',{id:42,method:'item/fileChange/requestApproval',params:{}});
  await assert.rejects(server.respond('42',{decision:'decline'},10),(e:any)=>e.uncertain===true);
  assert.throws(()=>server.respond('42',{decision:'accept'}),/已提交/);
});

test('concurrent duplicate operations execute once; changed payload is rejected',async()=>{
  const ledger=new Ledger(':memory:');let count=0;
  try{const id=op();const run=()=>ledger.run(id,{text:'task'},async()=>{count++;await new Promise(r=>setTimeout(r,20));return {turnId:'turn-1'};});
    const [a,b]=await Promise.all([run(),run()]);assert.equal(count,1);assert.deepEqual(a,b);assert.equal(a.state,'accepted');
    await assert.rejects(ledger.run(id,{text:'different'},async()=>({})),/内容发生变化/);
    await run();assert.equal(count,1);
  }finally{ledger.close();}
});
test('lost native receipt stays uncertain and is never retried',async()=>{
  const ledger=new Ledger(':memory:');let count=0;const id=op();
  try{const a=await ledger.run(id,{action:'send'},async()=>{count++;throw new BridgeError('timeout','timeout',true);});assert.equal(a.state,'uncertain');
    await ledger.run(id,{action:'send'},async()=>{count++;return {};});assert.equal(count,1);
    const old=`${Date.now()-8*86400_000}:${randomUUID()}`;await assert.rejects(ledger.run(old,{},async()=>({})),/过期/);
  }finally{ledger.close();}
});
test('restart turns pending operations uncertain without storing prompt text',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-ledger-'));const file=join(dir,'ops.sqlite');
  let ledger=new Ledger(file);const id=op();
  ledger.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?)').run(id,'digest','pending',null,Date.now());ledger.close();ledger=new Ledger(file);
  assert.equal(ledger.read(id).state,'uncertain');ledger.close();await removeTestTemp(dir);
});
test('desktop patches preserve ordering and reject a missing or unsafe baseline',()=>{
  const original={items:[{id:'a',text:''},{id:'b'}]};
  assert.deepEqual(applyPatches(original,[{op:'add',path:['items',1],value:{id:'c'}},{op:'replace',path:['items',0,'text'],value:'hello'},{op:'remove',path:['items',2]}]),{items:[{id:'a',text:'hello'},{id:'c'}]});
  assert.equal(original.items[0].text,'');
  assert.throws(()=>applyPatches(original,[{op:'remove',path:['items',2]}]));
  assert.throws(()=>applyPatches(original,[{op:'add',path:['__proto__','polluted'],value:true}]));
  assert.throws(()=>applyPatches(original,[{op:'add',path:['missing','field'],value:true}]));
});
test('current Windows canonical history exposes the real active turn and pending requests',()=>{
  const raw={id:'s',cwd:'x',latestModel:'deepseek-test',modelProvider:'local-test',turns:[],turnHistory:{kind:'canonical',history:{entitiesByKey:{b:{turnId:'t2',status:'inProgress',params:{input:[{type:'text',text:'hello'}]},items:[{id:'answer',type:'agentMessage',text:'working'}]},a:{turnId:'t1',status:'completed',items:[]}},islands:[{entries:[{value:'a'},{value:'b'}]}]}},threadRuntimeStatus:{type:'active'}};
  const v=normalizeSession(raw,'desktop',[{id:42,method:'item/tool/requestUserInput',params:{}},{id:43,completed:true}],1);
  assert.equal(v.activeTurnId,'t2');assert.equal(v.canControl,true);assert.equal(v.hasMore,true);assert.equal(v.turns[0].items[0].role,'user');assert.equal(v.requests.length,1);assert.equal(v.model,'deepseek-test');
  assert.equal(normalizeSession({id:'s',status:{type:'active'},turns:[]},'connector',[]).canControl,false);
});
test('approval responders preserve native IDs, decisions and permission scope',()=>{
  const amended={acceptWithExecpolicyAmendment:{execpolicy_amendment:['git','status']}};
  assert.deepEqual(approvalResult({method:'item/commandExecution/requestApproval',params:{availableDecisions:['decline',amended]}},{decision:amended}).result,{decision:amended});
  assert.throws(()=>approvalResult({method:'item/commandExecution/requestApproval',params:{availableDecisions:['decline']}},{decision:'accept'}));
  const granted={network:{enabled:true}};
  const p=approvalResult({method:'item/permissions/requestApproval',params:{permissions:granted}},{allow:true,scope:'turn'});
  assert.equal(p.method,'thread-follower-permissions-request-approval-response');assert.deepEqual(p.result,{permissions:granted,scope:'turn'});
  assert.throws(()=>approvalResult({method:'unknown',params:{}},{}),/电脑端/);
  assert.throws(()=>approvalResult({method:'item/tool/requestUserInput',params:{questions:[{id:'q'}]}},{answers:{}}));
});
test('file preview rejects traversal, junction escape and large files; HTML is inert text',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-files-')),root=join(dir,'project'),outside=join(dir,'outside');await mkdir(root);await mkdir(outside);
  try{await writeFile(join(root,'index.html'),'<script>active()</script>');await writeFile(join(outside,'secret.txt'),'private');
    assert.equal((await readProjectFile([root],root,'index.html')).mime,'text/plain');
    await assert.rejects(readProjectFile([root],root,'../outside/secret.txt'),/不在/);
    await symlink(outside,join(root,'link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(readProjectFile([root],root,'link/secret.txt'),/不在/);
    await writeFile(join(root,'large.txt'),Buffer.alloc(2*1024*1024+1));await assert.rejects(readProjectFile([root],root,'large.txt'),/2 MiB/);
  }finally{await removeTestTemp(dir);}
});
