import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareSettings,savedSettings} from '../scripts/setup-config.js';
import {connectionPage} from '../scripts/connection-page.js';
import {removeTestTemp} from '../scripts/test-temp.js';

test('configuration preserves identity and Codex settings, matches local port, and requires remote credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-setup-'));
  try {
    const project=join(dir,'中文 项目');await mkdir(project);
    const first=await prepareSettings({roots:[project],relayUrl:'http://127.0.0.1:4444'});
    assert.equal(first.port,4444);assert.ok(first.token.length>=24);
    const old={...first,profile:'my-profile',codexHome:project,roots:[project,dir]};
    const next=await prepareSettings({relayUrl:'https://relay.example',mode:'connector'},old);
    assert.equal(next.token,first.token);assert.equal(next.machineId,first.machineId);
    assert.deepEqual(next.roots,old.roots);assert.equal(next.profile,old.profile);assert.equal(next.codexHome,project);
    const rotated=await prepareSettings({rotate:true},first);assert.notEqual(rotated.token,first.token);assert.equal(rotated.machineId,first.machineId);
    assert.notEqual((await prepareSettings({rotate:true},next)).token,next.token);
    const cleared=await prepareSettings({codexHome:''},old);assert.equal(cleared.codexHome,undefined);
    await assert.rejects(prepareSettings({roots:[dir],mode:'connector',relayUrl:'https://relay.example'}),/Token/);
    for(const relayUrl of ['https://relay.example/path','https://relay.example?token=secret','https://relay.example#secret','http://user:pass@relay.example'])await assert.rejects(prepareSettings({relayUrl},first));
    await assert.rejects(prepareSettings({roots:[]},first),/项目目录/);
    await assert.rejects(prepareSettings({codexBin:project},first),/可执行文件/);
  } finally {await removeTestTemp(dir);}
});

test('damaged settings are not silently replaced and connection page escapes local values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-config-'));
  try {
    const file=join(dir,'config.json');assert.deepEqual(await savedSettings(file),{});
    await writeFile(file,'{broken');await assert.rejects(savedSettings(file),/未覆盖/);assert.equal(await readFile(file,'utf8'),'{broken');
    const page=connectionPage({relayUrl:'http://127.0.0.1:3340',token:'</script><script>bad()</script>',machineId:'pc',roots:['<project>']},'data:image/png;base64,abc','codex-cli test');
    assert.ok(!page.includes('<script>bad()'));
    assert.ok(page.includes('&lt;project&gt;'));
    const script=page.match(/<script>([\s\S]*)<\/script>/)![1];new Function(script);
    assert.ok(!script.includes('session.create'));
  } finally {await removeTestTemp(dir);}
});
