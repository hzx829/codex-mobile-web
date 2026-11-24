import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {setTimeout as delay} from 'node:timers/promises';
import {ThreadSync, type SyncLink} from '../web/sync/engine.js';
import type {Json} from '../src/shared/types.js';

const turn = (id: string, text: string, images: string[] = []) => ({id, status: 'completed', items: [{id: id + '-a', type: 'agentMessage', role: 'assistant', text, images}]});

/** A link answering opens with what the test gives; frames by hand. */
function link(answer: (payload: Json) => Json) {
  const requests: Json[] = [];
  let frame: (value: Json) => void = () => {};
  const value: SyncLink = {
    online: () => true,
    request: async (_action, payload) => {requests.push(payload);return answer(payload);},
    onFrame: listener => {frame = listener;return () => {};},
    onStatus: () => () => {},
    watch: () => {},
  };
  return {link: value, requests, push: (frameValue: Json) => frame({type: 'live', service: 'codex', threadId: 't', ...frameValue})};
}

test('a followed thread is kept on this device and opens from it, asking only for what changed', async () => {
  const store = await import('../web/sync/idb-store.js');
  await store.clearThreadStore();
  const key = store.threadKey('codex', 'pc', 't');
  const persist = {store: store.threadStore, key, seed: (thread: any) => store.storedSeed('codex', thread)};
  const a = turn('a', 'one'), b = turn('b', 'two', ['data:image/png;base64,AAAA', 'cmw-image:' + 'f'.repeat(64)]);
  const first = link(() => ({epoch: 'e', seq: 0, head: {id: 't', title: 'T', running: true, requests: [{id: 'q'}]}, order: ['a', 'b'],
    entries: [{id: 'a', rev: 'ra', body: a}, {id: 'b', rev: 'rb', body: b}], hasMore: true}));
  const sync = new ThreadSync(first.link, 'codex', 't', null, persist);
  sync.start();await delay(0);
  first.push({epoch: 'e', seq: 1, entries: [{id: 'c', rev: 'rc', body: turn('c', 'three')}]});
  sync.close();
  await store.flushThreadStore();

  // From memory at once, without what only held while it was live.
  const seen = store.storedSeed('codex', store.threadStore.get(key));
  assert.deepEqual(seen!.order, ['a', 'b', 'c']);
  assert.equal(seen!.head.running, false);
  assert.deepEqual(seen!.head.requests, []);
  assert.equal(seen!.hasMore, true);

  // From IndexedDB after a reload: images given inline are not kept, and that turn loses its rev so it comes again.
  const reloaded = await import(`../web/sync/idb-store.js?reload=${Date.now()}`);
  await reloaded.loadThreadStore(2000);
  const stored = reloaded.threadStore.get(key);
  assert.ok(stored, 'Recently used threads are read at start.');
  assert.deepEqual(stored.entries.get('b').body.items[0].images, ['cmw-image:' + 'f'.repeat(64)]);
  assert.equal(stored.entries.get('b').rev, undefined);
  assert.equal(stored.entries.get('a').rev, 'ra');
  const second = link(() => ({epoch: 'e2', seq: 0, head: {id: 't', title: 'T'}, order: ['a', 'b', 'c'], entries: [{id: 'b', rev: 'rb', body: b}], hasMore: true}));
  const again = new ThreadSync(second.link, 'codex', 't', null, {store: reloaded.threadStore, key, seed: (thread: any) => reloaded.storedSeed('codex', thread)});
  assert.equal(again.snapshot.phase, 'cached');
  assert.deepEqual(again.snapshot.order, ['a', 'b', 'c']);
  again.start();await delay(0);
  assert.deepEqual(second.requests[0].have, {a: 'ra', c: 'rc'});
  assert.equal(again.snapshot.phase, 'live');
  again.close();
  await reloaded.clearThreadStore();
  assert.equal(reloaded.threadStore.get(key), null, 'Disconnecting clears what this device kept.');
});
