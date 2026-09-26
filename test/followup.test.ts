import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitFollowups} from '../web/followup.js';

test('Codex follow-up directive becomes a draft action while surrounding markdown stays intact',()=>{
  const source='建议先改文案。\n\n:codex-followup[修改 deck 文案]{prompt="按这四页建议修改 PSA v2.1 deck 的页面文案和 speaker notes，保留图片、版式及原文件。"}\n\n后续再检查。';
  assert.deepEqual(splitFollowups(source),[
    {kind:'markdown',text:'建议先改文案。\n'},
    {kind:'followup',label:'修改 deck 文案',prompt:'按这四页建议修改 PSA v2.1 deck 的页面文案和 speaker notes，保留图片、版式及原文件。'},
    {kind:'markdown',text:'\n后续再检查。'},
  ]);
});

test('follow-up directives inside code or with invalid payload remain text',()=>{
  const code='```text\n:codex-followup[不会变成按钮]{prompt="secret"}\n```';
  assert.deepEqual(splitFollowups(code),[{kind:'markdown',text:code}]);
  const invalid=':codex-followup[保持原文]{prompt="bad\\q"}';
  assert.deepEqual(splitFollowups(invalid),[{kind:'markdown',text:invalid}]);
});
