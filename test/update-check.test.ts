import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint,updateAction} from '../scripts/update-check.js';

const installation={bin:'desktop-codex.exe',version:'0.160.0',binaryHash:'binary',desktop:'26.930.4958.0',desktopHash:'app',sourceHash:'source'};
const candidate={fingerprint:fingerprint(installation),installation,checkedAt:'now',checks:'passed' as const,bundleHash:'built',webHash:'web'};
const info={runtime:{bin:installation.bin,version:installation.version,bundleHash:'built'}};
test('desktop-only updates, replaced binaries, and compatibility fixes each invalidate the check cache',()=>{
  for(const change of [{desktop:'26.931.0.0'},{desktopHash:'new app'},{binaryHash:'new binary'},{sourceHash:'fix'}])assert.notEqual(fingerprint({...installation,...change}),candidate.fingerprint);
});
test('new installations need a checked deployment and an idle reload before acceptance',()=>{
  assert.equal(updateAction({...candidate,checks:'failed'},undefined,info),'fix-compatibility');
  assert.equal(updateAction(candidate,undefined,{runtime:{...info.runtime,bundleHash:'old'}}),'deploy-connector');
  assert.equal(updateAction(candidate,undefined,info,'old web'),'deploy-web');
  assert.equal(updateAction(candidate,{fingerprint:candidate.fingerprint,at:'now'},{runtime:{...info.runtime,bin:'old.exe'}}),'reload-runtime');
  assert.equal(updateAction(candidate,undefined,info),'reload-runtime');
  assert.equal(updateAction(candidate,{fingerprint:candidate.fingerprint,at:'now'},info),'none');
});
