import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveCodex,resolveWindowsCodex} from '../src/connector/app-server.js';
import {removeTestTemp} from '../scripts/test-temp.js';

test('Windows connector follows the latest desktop Codex before an older npm CLI',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cmw-codex-path-'));
  try {
    const managed=join(root,'OpenAI','Codex','bin');
    const oldDesktop=join(managed,'old','codex.exe');
    const newDesktop=join(managed,'new','codex.exe');
    const npm=join(root,'npm');
    await Promise.all([mkdir(join(managed,'old'),{recursive:true}),mkdir(join(managed,'new'),{recursive:true}),mkdir(npm)]);
    await Promise.all([writeFile(oldDesktop,''),writeFile(newDesktop,''),writeFile(join(npm,'codex.exe'),'')]);
    await utimes(oldDesktop,new Date(1_000),new Date(1_000));
    await utimes(newDesktop,new Date(2_000),new Date(2_000));
    assert.equal(resolveWindowsCodex(npm,root),newDesktop);
    assert.equal(resolveCodex(oldDesktop),oldDesktop);
    assert.equal(resolveWindowsCodex(npm,join(root,'missing')),join(npm,'codex.exe'));
    const directRoot=join(root,'direct');
    const unversioned=join(directRoot,'OpenAI','Codex','bin','codex.exe');
    await mkdir(join(directRoot,'OpenAI','Codex','bin'),{recursive:true});
    await writeFile(unversioned,'');
    assert.equal(resolveWindowsCodex(npm,directRoot),join(npm,'codex.exe'));
  } finally {await removeTestTemp(root);}
});
