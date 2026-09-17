import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionListLoader} from '../web/session-list-loader.js';

function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};}
test('polling while a project list is slow accepts its original result and clears loading',async()=>{
  const loader=new SessionListLoader(),slow=deferred<string[]>();let reads=0,busy=false;const results:string[][]=[];
  const handlers={start:()=>{busy=true;},result:(value:string[])=>results.push(value),error:()=>assert.fail('unexpected error'),finish:()=>{busy=false;}};
  const read=()=>{reads++;return slow.promise;};
  const first=loader.load('growth',read,handlers);
  for(let tick=0;tick<6;tick++)await loader.load('growth',read,handlers);
  assert.equal(reads,1);assert.equal(busy,true);
  slow.resolve(['growth-thread']);await first;
  assert.deepEqual(results,[['growth-thread']]);assert.equal(busy,false);
  await loader.load('growth',async()=>['new-thread'],handlers);assert.deepEqual(results.at(-1),['new-thread']);
});
test('project switches discard stale results and errors without clearing the current loading state',async()=>{
  const loader=new SessionListLoader(),old=deferred<string>(),current=deferred<string>();let busy=false;const results:string[]=[],errors:unknown[]=[];
  const handlers={start:()=>{busy=true;},result:(value:string)=>results.push(value),error:(error:unknown)=>errors.push(error),finish:()=>{busy=false;}};
  const previous=loader.load('growth',()=>old.promise,handlers),next=loader.load('lingan',()=>current.promise,handlers);
  old.reject(Error('old timeout'));await previous;assert.equal(busy,true);assert.deepEqual(errors,[]);
  current.resolve('lingan');await next;assert.deepEqual(results,['lingan']);assert.equal(busy,false);
  const canceled=deferred<string>(),pending=loader.load('growth',()=>canceled.promise,handlers);loader.invalidate();canceled.resolve('stale machine');await pending;assert.deepEqual(results,['lingan']);
  await loader.load('growth',async()=>{throw Error('current timeout');},handlers);assert.equal(errors.length,1);assert.equal(busy,false);
});
