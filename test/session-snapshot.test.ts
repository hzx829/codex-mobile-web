import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionSnapshot} from '../src/connector/session-snapshot.js';
import {normalizeSession} from '../src/connector/normalize.js';
import {knownSnapshot,restoreSnapshot} from '../web/session-snapshot.js';
import {refreshHistory} from '../web/thread-history.js';
import {MAX_FRAME} from '../src/shared/types.js';

const fixture=()=>({...normalizeSession({id:'s',turns:Array.from({length:20},(_,i)=>({id:`t${i}`,status:'completed',items:[{id:`i${i}`,type:'agentMessage',text:'x'.repeat(10000)}]}))},'desktop',[]),generation:'g'});

test('live refresh transfers only changed turns, preserving order, old clients and metadata',()=>{
  const raw=fixture(),initial=restoreSnapshot(null,sessionSnapshot(raw));
  const unchanged=sessionSnapshot(raw,knownSnapshot(initial));
  assert.equal(unchanged.turns.length,0);assert.equal(unchanged.turnOrder.length,20);
  assert.ok(JSON.stringify(unchanged).length<JSON.stringify(initial).length/100);
  assert.equal(refreshHistory(initial,restoreSnapshot(initial,unchanged)),initial);
  const next=structuredClone(raw);next.turns.at(-1)!.items[0].text='updated';next.running=true;
  const delta=sessionSnapshot(next,knownSnapshot(initial));assert.deepEqual(delta.turns.map(turn=>turn.id),['t19']);
  const restored=restoreSnapshot(initial,delta);assert.equal(restored.running,true);assert.equal(restored.turns[0],initial.turns[0]);assert.equal(restored.turns.at(-1)!.items[0].text,'updated');
  assert.equal(sessionSnapshot(next).turns.length,20,'Old phones receive full snapshots.');
  assert.deepEqual(restoreSnapshot(null,raw),raw,'New phones accept legacy connectors.');
  for(const change of [{generation:'new'},{source:'connector' as const},{id:'other'}])assert.equal(sessionSnapshot({...raw,...change},knownSnapshot(initial)).turns.length,20);
  assert.throws(()=>restoreSnapshot(null,delta),/同步不完整/);
});

test('image-heavy history stays below the frame limit and leaves older turns reachable',()=>{
  const raw=fixture(),image=`data:image/png;base64,${Buffer.alloc(2*1024*1024).toString('base64')}`;
  for(const turn of raw.turns)turn.items[0].images=Array(4).fill(image);
  const page=sessionSnapshot(raw);
  assert.ok(Buffer.byteLength(JSON.stringify({type:'response',result:page}))<MAX_FRAME);
  assert.deepEqual(page.turnOrder,['t19']);assert.equal(page.hasMore,true);assert.deepEqual(page.nextCursor,{before:'t19'});
  const earlier=sessionSnapshot({...raw,turns:raw.turns.slice(0,-1)});
  assert.deepEqual(earlier.turnOrder,['t18']);assert.deepEqual(earlier.nextCursor,{before:'t18'});
});
