import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyRuntime} from '../scripts/runtime-check.js';

test('deployed checks reject an old execution binary even when the configured model appears current',()=>{
  const info={model:'gpt-6.1-sol',runtime:{bin:'old-codex.exe',version:'0.146.0'}};
  assert.throws(()=>verifyRuntime(info,'desktop-codex.exe','0.160.0'),/未跟随/);
});

test('deployed checks reject unknown or mismatched runtime versions and do not claim live model or UI coverage',()=>{
  assert.throws(()=>verifyRuntime({model:'gpt-6.1-sol'},'desktop-codex.exe','0.160.0'),/不能确认/);
  assert.throws(()=>verifyRuntime({runtime:{bin:'desktop-codex.exe',version:'0.146.0'}},'desktop-codex.exe','0.160.0'),/版本不符/);
  const result=verifyRuntime({runtime:{bin:'desktop-codex.exe',version:'0.160.0'}},'desktop-codex.exe','0.160.0');
  assert.equal(result.status,'passed');assert.equal(result.liveChatGPT,false);assert.equal(result.uiAcceptance,false);
});
