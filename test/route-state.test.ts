import {test} from 'node:test';
import assert from 'node:assert/strict';
import {home,initialLocation,parseLocation,rememberLocation} from '../web/route-state.js';

test('a reload restores the current machine, project and thread from history',()=>{
  const route={project:'C:/work',thread:'thread-2',newChat:false};
  const stored=new Map<string,string>();
  const oldHistory=globalThis.history,oldSessionStorage=globalThis.sessionStorage;
  Object.assign(globalThis,{history:{state:{cmwRoute:route,cmwMachine:'pc-2'}},sessionStorage:{getItem:(key:string)=>stored.get(key)||null,setItem:(key:string,value:string)=>stored.set(key,value)}});
  try{
    rememberLocation(home,'pc-1');
    assert.deepEqual(initialLocation(),{route,machine:'pc-2'});
    Object.assign(globalThis,{history:{state:null}});
    rememberLocation(route,'pc-2');
    assert.deepEqual(initialLocation(),{route,machine:'pc-2'});
  }finally{Object.assign(globalThis,{history:oldHistory,sessionStorage:oldSessionStorage});}
});

test('invalid saved routes fall back to home',()=>{
  assert.equal(parseLocation({cmwRoute:{thread:42,project:'C:/work',newChat:false},cmwMachine:'pc'}),null);
  assert.equal(parseLocation({cmwRoute:home,cmwMachine:null}),null);
});
