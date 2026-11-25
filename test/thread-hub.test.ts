import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ThreadHub, entryDiff, revOf, type ThreadSource} from '../src/connector/thread-hub.js';
import type {SyncFrame} from '../src/shared/sync.js';

const turn = (id: string, text: string, extra: object = {}) => ({id, status: 'completed', canFork: true, items: [{id: id + '-a', type: 'agentMessage', role: 'assistant', text}], ...extra});

/** A thread whose state the test changes; `poke` stands for the source saying it changed. */
function fixture(entries: any[], head: any = {title: 't', running: false}) {
  let version = 1, state = {head, entries};
  const pokes: ((id: string) => void)[] = [];
  const source: ThreadSource = {
    version: async () => String(version),
    state: async () => state,
    watch: poke => {pokes.push(poke);},
  };
  const frames: SyncFrame[] = [];
  const hub = new ThreadHub(frame => {frames.push(frame);});
  hub.register('claude', source);
  const change = async (next: {head?: any; entries?: any[]}) => {
    state = {head: next.head ?? state.head, entries: next.entries ?? state.entries};version++;
    for (const poke of pokes) poke('c');
    await delay(60);
  };
  return {hub, frames, change, open: (extra: object = {}) => hub.open({service: 'claude', threadId: 'c', ...extra})};
}

test('opening sends only the entries the phone lacks and follows on from the frame number it gives', async () => {
  const a = turn('a', 'one'), b = turn('b', 'two');
  const {hub, open} = fixture([a, b]);
  try {
    const first = await open();
    assert.deepEqual(first.order, ['a', 'b']);
    assert.deepEqual(first.entries.map(entry => entry.id), ['a', 'b']);
    assert.equal(first.seq, 0);
    assert.equal(first.hasMore, false);
    const again = await open({have: {a: revOf(a), b: 'stale'}});
    assert.deepEqual(again.entries.map(entry => entry.id), ['b'], 'Entries held at the same rev cost only their ID.');
    assert.equal(again.epoch, first.epoch);
  } finally {hub.close();}
});

test('a growing reply is pushed as the text appended; a new turn as a new entry; head changes as fields', async () => {
  const a = turn('a', 'one');
  const earlier = 'An answer long enough that sending what was added beats sending it all again. '.repeat(4);
  const {hub, frames, change, open} = fixture([a, turn('b', earlier, {status: 'inProgress'})], {title: 't', running: true});
  try {
    const snapshot = await open();
    await change({entries: [a, turn('b', earlier + 'More', {status: 'inProgress'})]});
    assert.equal(frames.length, 1);
    assert.equal(frames[0].seq, snapshot.seq + 1);
    assert.deepEqual(frames[0].patches, [{id: 'b', rev: revOf(turn('b', earlier + 'More', {status: 'inProgress'})), ops: [{i: 'b-a', o: earlier.length, t: 'More'}], fields: {}}]);
    assert.equal(frames[0].entries, undefined);
    assert.equal(frames[0].order, undefined);
    await change({head: {title: 't', running: false}, entries: [a, turn('b', earlier + 'More'), turn('c', 'next')]});
    const frame = frames[1];
    assert.equal(frame.seq, snapshot.seq + 2);
    assert.deepEqual(frame.head, {running: false});
    assert.deepEqual(frame.patches?.map(patch => [patch.id, patch.fields]), [['b', {status: 'completed'}]]);
    assert.deepEqual(frame.entries?.map(entry => entry.id), ['c']);
    assert.equal(frame.order, undefined, 'Appending needs no order.');
  } finally {hub.close();}
});

test('a rewritten history sends the new order; nothing changed sends nothing', async () => {
  const a = turn('a', 'one'), b = turn('b', 'two');
  const {hub, frames, change, open} = fixture([a, b]);
  try {
    await open();
    await change({});
    assert.equal(frames.length, 0, 'A new version with the same content sends no frame.');
    await change({entries: [a, turn('x', 'edited')]});
    assert.deepEqual(frames[0].order, ['a', 'x']);
    assert.deepEqual(frames[0].entries?.map(entry => entry.id), ['x']);
  } finally {hub.close();}
});

test('a second phone opening first brings the followers up to date, so both agree on the frame number', async () => {
  const a = turn('a', 'one');
  const {hub, frames, open} = fixture([a]);
  try {
    const first = await open();
    // Changed without telling the hub; the next open finds it.
    (hub as any).sources.get('claude').state = async () => ({head: {title: 't2', running: false}, entries: [a]});
    (hub as any).sources.get('claude').version = async () => '99';
    const second = await open();
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].head, {title: 't2'});
    assert.equal(second.seq, first.seq + 1);
    assert.equal(second.head.title, 't2');
  } finally {hub.close();}
});

test('a page brings the entries before an ID, newest last', async () => {
  const list = Array.from({length: 70}, (_, index) => turn('t' + index, 'x'));
  const {hub, open} = fixture(list);
  try {
    const snapshot = await open();
    assert.equal(snapshot.order.length, 60);
    assert.equal(snapshot.order[0], 't10');
    assert.equal(snapshot.hasMore, true);
    const page = await hub.page({service: 'claude', threadId: 'c', before: 't10', limit: 4});
    assert.deepEqual(page.order, ['t6', 't7', 't8', 't9']);
    assert.equal(page.hasMore, true);
    const reopened = await open({from: 't6'});
    assert.equal(reopened.order[0], 't6', 'An open from an earlier entry keeps what the phone shows.');
  } finally {hub.close();}
});

test('item diffs cover every field and give up on removed or reordered items', () => {
  const before = {id: 'a', status: 'inProgress', step: {text: 'x'}, items: [{id: '1', text: 'a', type: 't'}]};
  assert.deepEqual(entryDiff(before, {id: 'a', status: 'completed', items: [{id: '1', text: 'ab', type: 't'}, {id: '2', text: '', type: 't'}]}),
    {ops: [{i: '1', o: 1, t: 'b'}, {i: '2', item: {id: '2', text: '', type: 't'}}], fields: {status: 'completed', step: null}});
  assert.deepEqual(entryDiff(before, {...before, items: [{id: '1', text: 'a', type: 't', sender: {id: 'u', name: 'U'}}]})?.ops,
    [{i: '1', item: {id: '1', text: 'a', type: 't', sender: {id: 'u', name: 'U'}}}], 'A changed field besides the text replaces the item.');
  assert.equal(entryDiff(before, {...before, items: []}), null);
  assert.equal(entryDiff(before, {...before, items: [{id: '9', text: 'a', type: 't'}]}), null);
});
