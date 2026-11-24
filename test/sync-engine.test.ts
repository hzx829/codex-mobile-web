import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ThreadSync, applyPatch, type SyncLink, type SyncView} from '../web/sync/engine.js';
import type {Json} from '../src/shared/types.js';

const turn = (id: string, text: string) => ({id, status: 'completed', items: [{id: id + '-a', type: 'agentMessage', role: 'assistant', text}]});
const entry = (body: Json, rev = 'r-' + body.id + '-' + body.items[0].text) => ({id: body.id, rev, body});

/** A link whose answers the test queues; frames and status are pushed by hand. */
function fakeLink() {
  const answers: ((payload: Json) => Json | Promise<Json>)[] = [], requests: Json[] = [], watches: unknown[] = [];
  let frame: (value: Json) => void = () => {}, status: (online: boolean) => void = () => {};
  let online = true;
  const link: SyncLink = {
    online: () => online,
    request: async (action, payload) => {requests.push({action, ...payload});const next = answers.shift();if (!next) throw {code: 'none', message: 'no answer'};return next(payload);},
    onFrame: listener => {frame = listener;return () => {frame = () => {};};},
    onStatus: listener => {status = listener;return () => {status = () => {};};},
    watch: (target, owner) => {watches.push(owner ? {target, owner} : target);},
  };
  return {link, answers, requests, watches, push: (value: Json) => frame({type: 'live', service: 'claude', threadId: 'c', ...value}),
    setOnline: (value: boolean) => {online = value;status(value);}};
}
const turnsOf = (view: SyncView) => view.order.map(id => view.entries.get(id)!.body.items[0].text);

test('a cached seed shows at once, then the answer replaces it and asks only for what changed', async () => {
  const fake = fakeLink(), a = turn('a', 'one'), b = turn('b', 'two');
  fake.answers.push(() => ({epoch: 'e', seq: 4, head: {title: 'fresh'}, order: ['a', 'b'], entries: [entry(b)], hasMore: false}));
  const sync = new ThreadSync(fake.link, 'claude', 'c', {head: {title: 'old'}, order: ['a'], bodies: [a], revs: {a: 'r-a-one'}, hasMore: true});
  assert.equal(sync.snapshot.phase, 'cached');
  sync.start();await delay(0);
  assert.deepEqual(fake.requests[0], {action: 'sync.open', service: 'claude', threadId: 'c', have: {a: 'r-a-one'}, from: 'a'});
  assert.deepEqual(fake.watches[0], {service: 'claude', threadId: 'c'});
  assert.equal(sync.snapshot.phase, 'live');
  assert.equal(sync.snapshot.head!.title, 'fresh');
  assert.deepEqual(turnsOf(sync.snapshot), ['one', 'two']);
  assert.equal(sync.snapshot.hasMore, false);
  sync.close();
  assert.deepEqual(fake.watches.at(-1), {target: null, owner: {service: 'claude', threadId: 'c'}});
});

test('frames that follow on apply; frames sent while opening wait for the answer; a gap opens again', async () => {
  const fake = fakeLink(), a = turn('a', 'Hel');
  let release!: () => void;
  fake.answers.push(() => new Promise(resolve => {release = () => resolve({epoch: 'e', seq: 1, head: {running: true}, order: ['a'], entries: [entry(a)], hasMore: false});}));
  const sync = new ThreadSync(fake.link, 'claude', 'c');
  sync.start();await delay(0);
  // Sent before the answer: the first is already in it, the second follows on.
  fake.push({epoch: 'e', seq: 1, patches: [{id: 'a', rev: 'x', ops: [{i: 'a-a', o: 0, t: 'Hel'}], fields: {}}]});
  fake.push({epoch: 'e', seq: 2, patches: [{id: 'a', rev: 'r2', ops: [{i: 'a-a', o: 3, t: 'lo'}], fields: {}}]});
  release();await delay(0);
  assert.deepEqual(turnsOf(sync.snapshot), ['Hello']);
  fake.push({epoch: 'e', seq: 3, entries: [entry(turn('b', 'next'))], head: {running: null}});
  assert.deepEqual(turnsOf(sync.snapshot), ['Hello', 'next']);
  assert.equal('running' in sync.snapshot.head!, false, 'A null head field is removed.');
  fake.answers.push(() => ({epoch: 'e', seq: 9, head: {}, order: ['a', 'b'], entries: [], hasMore: false}));
  fake.push({epoch: 'e', seq: 7, entries: []});
  await delay(0);
  assert.equal(fake.requests.length, 2, 'A gap opens again.');
  assert.deepEqual(fake.requests[1].have, {a: 'r2', b: 'r-b-next'});
  sync.close();
});

test('an answer counting on an entry no longer held asks again without any', async () => {
  const fake = fakeLink(), a = turn('a', 'one');
  fake.answers.push(() => ({epoch: 'e', seq: 0, head: {}, order: ['a', 'gone'], entries: [], hasMore: false}));
  fake.answers.push(payload => ({epoch: 'e', seq: 0, head: {}, order: ['a'], entries: [entry(a)], hasMore: false, asked: payload}));
  const sync = new ThreadSync(fake.link, 'claude', 'c', {head: {}, order: ['a'], bodies: [a], revs: {a: 'r-a-one'}, hasMore: false});
  sync.start();await delay(0);await delay(0);
  assert.deepEqual(fake.requests[1].have, {});
  assert.deepEqual(turnsOf(sync.snapshot), ['one']);
  sync.close();
});

test('pages add earlier entries; a new order joins onto what is held before it', async () => {
  const fake = fakeLink();
  fake.answers.push(() => ({epoch: 'e', seq: 0, head: {}, order: ['c1', 'c2'], entries: [entry(turn('c1', '1')), entry(turn('c2', '2'))], hasMore: true}));
  const sync = new ThreadSync(fake.link, 'claude', 'c');
  sync.start();await delay(0);
  fake.answers.push(() => ({order: ['c0'], entries: [entry(turn('c0', '0'))], hasMore: false}));
  await sync.page(10);
  assert.deepEqual(fake.requests[1], {action: 'sync.page', service: 'claude', threadId: 'c', before: 'c1', limit: 10});
  assert.deepEqual(sync.snapshot.order, ['c0', 'c1', 'c2']);
  assert.equal(sync.snapshot.hasMore, false);
  fake.push({epoch: 'e', seq: 1, order: ['c1', 'x'], entries: [entry(turn('x', 'edited'))]});
  assert.deepEqual(sync.snapshot.order, ['c0', 'c1', 'x']);
  sync.close();
});

test('offline it waits; back online it opens again', async () => {
  const fake = fakeLink();
  fake.setOnline(false);
  const sync = new ThreadSync(fake.link, 'claude', 'c');
  sync.start();await delay(0);
  assert.equal(fake.requests.length, 0);
  fake.answers.push(() => ({epoch: 'e', seq: 0, head: {}, order: [], entries: [], hasMore: false}));
  fake.setOnline(true);await delay(0);
  assert.equal(fake.requests.length, 1);
  assert.equal(sync.snapshot.phase, 'live');
  fake.setOnline(false);
  assert.equal(sync.snapshot.phase, 'offline');
  sync.close();
});

test('patches append text, add or replace items and change fields; text not caught up is refused', () => {
  const body = {id: 'a', status: 'inProgress', items: [{id: '1', text: 'ab'}]};
  assert.deepEqual(applyPatch(body, {ops: [{i: '1', o: 1, t: 'bc'}, {i: '2', item: {id: '2', text: ''}}], fields: {status: 'completed'}}),
    {id: 'a', status: 'completed', items: [{id: '1', text: 'abc'}, {id: '2', text: ''}]});
  assert.throws(() => applyPatch(body, {ops: [{i: '1', o: 5, t: 'x'}], fields: {}}));
  assert.throws(() => applyPatch(body, {ops: [{i: 'missing', o: 0, t: 'x'}], fields: {}}));
});
