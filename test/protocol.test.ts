import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONNECTOR_FEATURES,PROTOCOL_VERSION,connectorReport} from '../src/shared/protocol.js';
import {connectorHas,versionGap} from '../web/features.js';

test('a relay keeps only a sane protocol and well-formed feature names', () => {
  assert.deepEqual(connectorReport({protocol: 1, features: ['live', 'live', 'claude.implementModes', '', 'a b', 3]}), {protocol: 1, features: ['live', 'claude.implementModes']});
  assert.deepEqual(connectorReport({protocol: '1', features: 'live'}), {});
  assert.deepEqual(connectorReport({protocol: 1.5}), {});
  assert.equal(connectorReport({features: Array.from({length: 100}, (_, i) => `f${i}`)}).features!.length, 64);
});

test('the page tells which side needs updating', () => {
  const current = {id: 'pc', name: 'pc', protocol: PROTOCOL_VERSION, features: [...CONNECTOR_FEATURES]};
  assert.equal(versionGap(current), undefined);
  assert.equal(connectorHas(current, 'claude.implementModes'), true);
  assert.equal(versionGap({id: 'pc', name: 'pc'}), 'connector', 'a connector from before features were reported');
  assert.equal(connectorHas({id: 'pc', name: 'pc'}, 'live'), false);
  assert.equal(versionGap({...current, features: ['live']}), 'connector');
  assert.equal(versionGap({...current, protocol: PROTOCOL_VERSION + 1}), 'page');
});
