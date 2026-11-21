import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Ledger, requestActor} from '../src/connector/ledger.js';
import {Control} from '../src/connector/control.js';
import {claudeUserText, markCodexSenders, sendersByText, textKey, type SenderRecord} from '../src/connector/message-senders.js';
import {TeamStore} from '../src/server/team/store.js';
import {refreshSenderNames} from '../src/server/team/actions.js';
import {sendersShown} from '../web/senders.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const ada = {id: 'u-ada', name: 'Ada'}, bo = {id: 'u-bo', name: 'Bo'};
const record = (sender: {id: string; name: string}, fields: Partial<SenderRecord>): SenderRecord => ({turnId: null, kind: 'text', textHash: null, sender, ...fields});
const user = (id: string, text = id) => ({id, type: 'userMessage', role: 'user', text});

test('Codex messages take the senders of the sends recorded for their turn', () => {
  const turns: any[] = [
    {id: 't1', items: [user('a'), {id: 'r', role: 'assistant', text: 'ok'}, user('b')]},
    {id: 't2', items: [user('c'), user('d')]},
    {id: 't3', items: [user('e')]},
  ];
  markCodexSenders(turns, [
    record(ada, {turnId: 't1', kind: 'start'}), record(bo, {turnId: 't1', kind: 'steer'}),
    // Someone also typed into t2 on the desktop: only the message that started the turn is named.
    record(bo, {turnId: 't2', kind: 'start'}),
  ]);
  assert.deepEqual(turns.flatMap(turn => turn.items.filter((item: any) => item.role === 'user').map((item: any) => [item.id, item.sender?.name])),
    [['a', 'Ada'], ['b', 'Bo'], ['c', 'Bo'], ['d', undefined], ['e', undefined]]);
  // A phone steering a turn that started on the desktop names nobody rather than the wrong message.
  const desktop: any[] = [{id: 't4', items: [user('f'), user('g')]}];
  markCodexSenders(desktop, [record(ada, {turnId: 't4', kind: 'steer'})]);
  assert.equal(desktop[0].items.some((item: any) => item.sender), false);
});

test('text matching pairs the newest messages with the newest sends', () => {
  const senders = sendersByText(
    [{id: '1', text: '继续'}, {id: '2', text: 'fix the build\r\n'}, {id: '3', text: '继续'}, {id: '4', text: 'typed on the computer'}],
    [record(ada, {textHash: textKey('继续')}), record(bo, {textHash: textKey('fix the build')}), record(bo, {textHash: textKey('继续')})]);
  assert.deepEqual([...senders].map(([id, sender]) => [id, sender.name]).sort(), [['1', 'Ada'], ['2', 'Bo'], ['3', 'Bo']]);
  assert.equal(claudeUserText({type: 'user', message: {content: [{type: 'image'}, {type: 'text', text: 'look'}]}}), 'look');
  assert.equal(claudeUserText({type: 'user', message: {content: [{type: 'tool_result', content: 'x'}]}}), undefined);
  assert.equal(claudeUserText({type: 'user', parent_tool_use_id: 'task', message: {content: 'inside a subagent'}}), undefined);
  assert.equal(claudeUserText({type: 'assistant', message: {content: 'hi'}}), undefined);
});

test('the connector records the sender of a desktop turn started from the phone', async () => {
  const ledger = new Ledger(':memory:');
  class Runtime extends EventEmitter {requests = new Map();rpc() {throw Error('desktop turn must stay on desktop');}close() {}}
  class Desktop extends EventEmitter {
    clientId = 'desktop';states = new Map<string, any>([['s', {hostId: 'local'}]]);
    async follow() {return {id: 's', turns: [], requests: []};}
    async request() {return {result: {turn: {id: 'desktop-turn'}}};}
    close() {}
  }
  const control = new Control(ledger, new Runtime() as any, new Desktop() as any);
  try {
    const send = () => control.handle({id: randomUUID(), action: 'turn.send', payload: {threadId: 's', source: 'desktop', generation: control.generation, expectedTurnId: null, text: 'hi', opId: `${Date.now()}:${randomUUID()}`}});
    await requestActor.run({userId: ada.id, name: ada.name}, send);
    // Without a team the relay names nobody, and nothing is recorded.
    await send();
    assert.deepEqual(ledger.senders('codex', 's'), [{turnId: 'desktop-turn', kind: 'start', textHash: null, sender: ada}]);
    ledger.recordSender({service: 'claude', threadId: 'c', opId: 'unknown-op', kind: 'text', text: 'x'});
    assert.deepEqual(ledger.senders('claude', 'c'), []);
  } finally {control.close();}
});

test('the relay shows senders under their current names, and labels appear once two people took part', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-senders-'));
  const store = new TeamStore(join(dir, 'relay.sqlite'));
  try {
    const member = store.createUser({name: 'Bo', role: 'member'});
    const result: any = {turns: [{id: 't', items: [{id: 'a', role: 'user', sender: {id: member.id, name: 'Old name'}}, {id: 'b', role: 'user', sender: {id: 'gone', name: 'Former'}}]}],
      messages: [{id: 'm', role: 'user', sender: {id: member.id, name: 'Old'}}]};
    store.updateUser(member.id, {name: 'Bo Chen'});
    refreshSenderNames(store, result);
    assert.deepEqual([...result.turns[0].items, ...result.messages].map((item: any) => item.sender.name), ['Bo Chen', 'Former', 'Bo Chen']);
  } finally {store.close();await removeTestTemp(dir);}
  assert.equal(sendersShown('me', [{id: 'me', name: 'Me'}, undefined]), false);
  assert.equal(sendersShown('me', [{id: 'me', name: 'Me'}, {id: 'you', name: 'You'}]), true);
  assert.equal(sendersShown(null, [{id: 'you', name: 'You'}]), false);
});
