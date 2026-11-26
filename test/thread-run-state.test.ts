import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextRunState,runMark} from '../web/thread-run-state.js';

test('a run blinks while active, stays as a steady dot once it ends unseen, and clears when opened',()=>{
  assert.equal(runMark(undefined,true,false),'running');
  assert.equal(nextRunState(undefined,true,false),'running');
  assert.equal(runMark('running',false,false),'done');
  assert.equal(nextRunState('running',false,false),'done');
  assert.equal(runMark('done',false,false),'done');
  assert.equal(runMark('done',false,true),'');
  assert.equal(nextRunState('done',false,true),undefined);
});

test('a run that ends in the open conversation is already seen, and idle threads show nothing',()=>{
  assert.equal(runMark('running',false,true),'');
  assert.equal(nextRunState('running',false,true),undefined);
  assert.equal(runMark(undefined,false,false),'');
  assert.equal(nextRunState(undefined,false,false),undefined);
});

test('an offline computer (unknown state) neither shows a run nor marks one finished',()=>{
  assert.equal(nextRunState('running',null,false),'running');
  assert.equal(runMark('running',null,false),'');
  assert.equal(runMark('done',null,false),'done');
});
