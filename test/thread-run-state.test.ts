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

test('a session whose turn ended but whose background work goes on shows a ring, not a done mark', async () => {
  const {createElement} = await import('react');
  const {renderToStaticMarkup} = await import('react-dom/server');
  const {ThreadRow} = await import('../web/thread-menu.js');
  const row = (thread: Record<string, unknown>, active: boolean | null) => renderToStaticMarkup(createElement(ThreadRow, {thread: {id: 'bg-row', title: 'Deploy', ...thread}, selected: false, time: '', active, open: () => {}}));
  assert.match(row({background: 2}, false), /background-dot[^>]*title="2 个后台任务运行中"/);
  assert.match(row({background: true}, false), /background-dot[^>]*title="后台任务运行中"/);
  assert.doesNotMatch(row({background: 2}, null), /background-dot/, 'offline rows do not show a stale background ring');
  assert.doesNotMatch(row({background: true}, null), /background-dot/, 'offline boolean background stays hidden');
  assert.doesNotMatch(row({background: 2}, true), /background-dot/, 'a running turn outranks its background work');
  assert.match(row({background: 2}, true), /running-dot/);
  assert.doesNotMatch(row({background: 0}, false), /background-dot/);
});

test('a background re-read of the first page keeps the sessions loaded with "more"', async () => {
  const {refreshedPage} = await import('../web/antigravity-sidebar.js');
  const loaded = [{id: 'a', v: 1}, {id: 'b', v: 1}, {id: 'c', v: 1}, {id: 'd', v: 1}];
  assert.deepEqual(refreshedPage(loaded, [{id: 'c', v: 2}, {id: 'a', v: 2}]), [{id: 'c', v: 2}, {id: 'a', v: 2}, {id: 'b', v: 1}, {id: 'd', v: 1}]);
});

test('reconcileSidebarStatus keeps offline/stale caches unknown, prefers newer polls across lists, and lets liveThread win', async () => {
  const {reconcileSidebarStatus} = await import('../web/antigravity-sidebar.js');
  // Offline returns empty map so rows pass active=null.
  assert.equal(reconcileSidebarStatus(false, [{items: [{id: 'a', running: true}], fetchedAt: 100}]).size, 0);
  // Unrefreshed cached list (fetchedAt=0) stays unknown.
  assert.equal(reconcileSidebarStatus(true, [{items: [{id: 'a', running: false}], fetchedAt: 0}]).size, 0);
  // Newer poll wins between Recent and ProjectTree so duplicate rows agree.
  const merged = reconcileSidebarStatus(true, [
    {items: [{id: 'a', running: false, background: 0}], fetchedAt: 100},
    {items: [{id: 'a', running: true, background: true}], fetchedAt: 200},
  ]);
  assert.equal(merged.get('a')?.running, true);
  assert.equal(merged.get('a')?.background, true);
  // Open conversation live status overrides older list polls immediately.
  const withLive = reconcileSidebarStatus(true, [{items: [{id: 'a', running: true}], fetchedAt: 200}], {id: 'a', running: false, background: 2});
  assert.equal(withLive.get('a')?.running, false);
  assert.equal(withLive.get('a')?.background, 2);
});
