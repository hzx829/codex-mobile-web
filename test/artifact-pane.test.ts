import assert from 'node:assert/strict';
import test from 'node:test';
import {pageToRestore, paneActions} from '../web/artifact-pane.js';
import type {TurnView} from '../src/shared/types.js';

const a = 'https://claude.ai/artifact/AAAAAAAAAAAA', b = 'https://claude.ai/artifact/BBBBBBBBBBBB';
const turn = (id: string, status: string, pages?: TurnView['pages']): TurnView => ({id, status, items: [], canFork: false, ...(pages ? {pages} : {})});

test('a conversation opens with the page it had open, or its newest page when nothing was recorded', () => {
  const turns = [turn('1', 'completed', [{url: a, title: 'A', changed: 't1', shown: 't1'}]), turn('2', 'completed', [{url: b, title: 'B', changed: 't2', shown: 't2'}]),
    turn('3', 'completed', [{url: b, title: 'B', earlier: true}, {url: a, title: 'A', earlier: true}])];
  assert.deepEqual(pageToRestore(turns, null), {url: b, title: 'B', open: true});
  assert.deepEqual(pageToRestore(turns, a), {url: a, title: 'A', open: true});
  assert.equal(pageToRestore(turns, ''), null, 'a closed pane stays closed');
  assert.equal(pageToRestore(turns, 'https://claude.ai/artifact/GONEGONEGONE'), null);
  assert.equal(pageToRestore([turn('1', 'completed')], null), null);
});

test('a publish or an open brings the page up once; later changes only renew the copy', () => {
  const seen = new Map<string, string>();
  const history = [turn('1', 'completed', [{url: a, title: 'A', changed: 't1', shown: 't1'}])];
  assert.deepEqual(paneActions(history, seen, true), [], 'history is taken as seen');
  assert.deepEqual(paneActions(history, seen), []);
  // A new turn creates a page, then fills it through its database while still running.
  const created = [...history, turn('2', 'inProgress', [{url: b, title: 'B', changed: 't2', shown: 't2'}])];
  assert.deepEqual(paneActions(created, seen), [{url: b, title: 'B', fresh: 't2', open: true}]);
  const filling = [...history, turn('2', 'inProgress', [{url: b, title: 'B', changed: 't3', shown: 't2'}])];
  assert.deepEqual(paneActions(filling, seen), [], 'writes during the turn wait for its end');
  const done = [...history, turn('2', 'completed', [{url: b, title: 'B', changed: 't3', shown: 't2'}])];
  assert.deepEqual(paneActions(done, seen), [{url: b, title: 'B', fresh: 't3', open: false}]);
  assert.deepEqual(paneActions(done, seen), []);
  // An earlier page opened again in a later turn comes up again, and its older turn does not undo that.
  const reopened = [...done, turn('3', 'inProgress', [{url: a, title: 'A', changed: 't4', shown: 't4'}, {url: b, title: 'B', earlier: true}])];
  assert.deepEqual(paneActions(reopened, seen), [{url: a, title: 'A', fresh: 't4', open: true}]);
  assert.deepEqual(paneActions(reopened, seen), []);
});
