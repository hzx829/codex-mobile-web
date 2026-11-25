import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COLD_START_STALE_MS,clearSavedLocation,home,initialLocation,newChatRoute,parseLocation,rememberLocation,touchLocation} from '../web/route-state.js';
import {switchRoute} from '../web/service-switch.js';
import {serviceHome, supportedRoute} from '../web/services.js';

function memoryStorage(){
  const map=new Map<string,string>();
  return {
    get length(){return map.size;},
    key:(i:number)=>[...map.keys()][i]??null,
    getItem:(k:string)=>map.get(k)??null,
    setItem:(k:string,v:string)=>{map.set(k,v);},
    removeItem:(k:string)=>{map.delete(k);},
    clear:()=>{map.clear();},
  };
}

test('borrowed computers fall back to an available app', () => {
  const route = serviceHome('antigravity', 'project');
  assert.equal(supportedRoute(route), route);
  assert.deepEqual(supportedRoute(route, ['claude']), serviceHome('claude'));
  assert.deepEqual(supportedRoute(route, ['codex', 'claude']), home);
  const claude = serviceHome('claude', 'demo');
  assert.equal(supportedRoute(claude, ['codex', 'claude']), claude);
});

test('a reload restores the current machine, project and thread from history or sessionStorage',()=>{
  const route={project:'C:/work',thread:'thread-2',newChat:false};
  const session=memoryStorage(),local=memoryStorage();
  const oldHistory=globalThis.history,oldSession=globalThis.sessionStorage,oldLocal=globalThis.localStorage;
  Object.assign(globalThis,{history:{state:{cmwRoute:route,cmwMachine:'pc-2'}},sessionStorage:session,localStorage:local});
  try{
    rememberLocation(home,'pc-1');
    assert.deepEqual(initialLocation(),{route,machine:'pc-2'});
    Object.assign(globalThis,{history:{state:null}});
    rememberLocation(route,'pc-2');
    assert.deepEqual(initialLocation(),{route,machine:'pc-2'});
  }finally{Object.assign(globalThis,{history:oldHistory,sessionStorage:oldSession,localStorage:oldLocal});}
});

test('cold start after browser kill restores recent thread and falls back to new chat when stale',()=>{
  const threadRoute={project:'C:/work',thread:'thread-7',newChat:false};
  const claudeId='11111111-2222-3333-4444-555555555555';
  const claudeRoute={...serviceHome('claude','C:/work'),claude:claudeId};
  const session=memoryStorage(),local=memoryStorage();
  const oldHistory=globalThis.history,oldSession=globalThis.sessionStorage,oldLocal=globalThis.localStorage;
  Object.assign(globalThis,{history:{state:null},sessionStorage:session,localStorage:local});
  try{
    // Fresh visit lands directly on the new-chat composer.
    assert.deepEqual(initialLocation(1_000),{route:newChatRoute('codex'),machine:''});

    // Save an open thread, then simulate a browser kill (sessionStorage wiped, localStorage intact).
    rememberLocation(threadRoute,'pc-1',10_000);
    session.clear();
    assert.deepEqual(initialLocation(10_000+5*60*1000),{route:threadRoute,machine:'pc-1'});

    // Touching location on backgrounding extends the resume window.
    touchLocation(10_000+25*60*1000);
    assert.deepEqual(initialLocation(10_000+40*60*1000),{route:threadRoute,machine:'pc-1'});

    // After exceeding the cold-start window, keep machine & project but land on new chat.
    assert.deepEqual(
      initialLocation(10_000+25*60*1000+COLD_START_STALE_MS+1),
      {route:newChatRoute('codex','C:/work'),machine:'pc-1'},
    );

    // Same smart resume works for Claude Code and Antigravity routes.
    rememberLocation(claudeRoute,'pc-1',100_000);
    session.clear();
    assert.deepEqual(initialLocation(100_000+10_000),{route:claudeRoute,machine:'pc-1'});
    assert.deepEqual(
      initialLocation(100_000+COLD_START_STALE_MS+1),
      {route:newChatRoute('claude','C:/work'),machine:'pc-1'},
    );

    // Switching apps also persists across browser kills and defaults to new chat when empty/stale.
    const switchedToAg=switchRoute('pc-1',claudeRoute,'antigravity',200_000);
    assert.deepEqual(switchedToAg,newChatRoute('antigravity'));
    session.clear();
    assert.deepEqual(switchRoute('pc-1',switchedToAg,'claude',200_000+1000),claudeRoute);
    assert.deepEqual(
      switchRoute('pc-1',switchedToAg,'claude',200_000+COLD_START_STALE_MS+1),
      newChatRoute('claude','C:/work'),
    );

    // Sign-out clears persisted routes from both storages.
    clearSavedLocation();
    assert.deepEqual(initialLocation(200_000+1000),{route:newChatRoute('codex'),machine:''});
  }finally{Object.assign(globalThis,{history:oldHistory,sessionStorage:oldSession,localStorage:oldLocal});}
});

test('invalid saved routes fall back to home',()=>{
  assert.equal(parseLocation({cmwRoute:{thread:42,project:'C:/work',newChat:false},cmwMachine:'pc'}),null);
  assert.equal(parseLocation({cmwRoute:home,cmwMachine:null}),null);
});
