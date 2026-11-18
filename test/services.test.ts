import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ServiceRouter} from '../src/connector/services.js';
import {Control} from '../src/connector/control.js';
import {AppServer} from '../src/connector/app-server.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError} from '../src/shared/types.js';
import {home} from '../web/route-state.js';
import {SERVICE_IDS,fileOwner,previewOwner,routeConversation,serviceHome,serviceOf,withConversation} from '../web/services.js';

const id='12345678-1234-1234-1234-123456789abc';

test('connector routes app actions by prefix and keeps Codex as the fallback', async () => {
  const seen:string[]=[];let updating=false,prepared=0;
  const router=new ServiceRouter([
    {prefix:'chatgpt',handle:async action=>{seen.push(action);return {ok:action};},mutations:['chatgpt.send'],prepareReload:()=>{prepared++;}},
    {prefix:'antigravity',handle:async (action,payload)=>{seen.push(`${action}:${JSON.stringify(payload)}`);return {};}},
  ],async request=>{seen.push(`codex:${request.action}`);return {};},()=>updating);
  await router.handle({id:'1',action:'chatgpt.read',payload:{}});
  await router.handle({id:'2',action:'antigravity.list',payload:undefined as any});
  await router.handle({id:'3',action:'session.read',payload:{}});
  await router.handle({id:'4',action:'runtime.reload',payload:{}});
  assert.deepEqual(seen,['chatgpt.read','antigravity.list:{}','codex:session.read','codex:runtime.reload']);
  assert.equal(prepared,1);
  updating=true;
  await assert.rejects(router.handle({id:'5',action:'chatgpt.send',payload:{}}),(error:BridgeError)=>error.code==='maintenance');
  await router.handle({id:'6',action:'chatgpt.read',payload:{}});
  assert.throws(()=>new ServiceRouter([{prefix:'a',handle:async()=>({})},{prefix:'a',handle:async()=>({})}],async()=>({})));
});

test('phone app routes come from one registry', () => {
  assert.deepEqual(SERVICE_IDS,['codex','chatgpt','antigravity','claude']);
  // Changing computers keeps the current app instead of falling back to Codex.
  assert.deepEqual(serviceHome('chatgpt'),{...home,chat:''});
  assert.deepEqual(serviceHome('antigravity','file:///c%3A/work'),{...home,project:'file:///c%3A/work',antigravity:''});
  assert.deepEqual(serviceHome('chatgpt','C:/work'),{...home,chat:''});
  const ag=withConversation(serviceHome('antigravity'),id);
  assert.equal(serviceOf(ag),'antigravity');assert.equal(routeConversation(ag),id);
  assert.equal(previewOwner(ag,'codex-thread'),'antigravity:'+id);
  assert.equal(previewOwner(serviceHome('chatgpt'),'codex-thread'),'');
  assert.equal(previewOwner(home,'codex-thread'),'codex-thread');
  assert.deepEqual(fileOwner('antigravity:'+id),{service:'antigravity',id});
  assert.deepEqual(fileOwner('codex-thread'),{service:'codex',id:'codex-thread'});
});

test('a missing Codex does not stop the connector, and a crashed runtime restarts', async () => {
  const missing=new AppServer('',{...process.env,CODEX_BIN:'codex.cmd'});
  await assert.rejects(missing.start(),(error:BridgeError)=>error.code==='codex_missing');

  class Runtime extends EventEmitter{
    child:object|null=null;starts=0;fail=true;requests=new Map();
    async start(){this.starts++;if(this.fail)throw new BridgeError('codex_missing','missing');this.child={};}
    close(){}
  }
  class Desktop extends EventEmitter{async connect(){}close(){}}
  // Restart timers are unref'd in production; keep the test process alive while waiting for them.
  const keepAlive=setInterval(()=>{},50);
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any);
  try{
    await assert.rejects(control.start());
    assert.equal(runtime.starts,1);
    runtime.fail=false;
    const changed=new Promise(resolve=>control.once('change',resolve));
    await changed;
    assert.equal(runtime.starts,2);assert.ok(runtime.child);
    // A runtime that exits later is brought back without restarting the connector.
    runtime.child=null;const again=new Promise(resolve=>control.once('change',()=>control.once('change',resolve)));
    runtime.emit('offline');await again;
    assert.equal(runtime.starts,3);
  }finally{control.close();clearInterval(keepAlive);}
});
