// Read the deployed connector through the relay. No model request or UI action is performed.
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveCodex,resolveWindowsCodex} from '../src/connector/app-server.js';
import type {Json} from '../src/shared/types.js';
// @ts-expect-error The standalone setup helper is distributed without TypeScript declarations.
import {checkConnection} from '../skills/codex-mobile-web-setup/scripts/status.mjs';

export function verifyRuntime(info:Json,expectedBin:string,expectedVersion:string) {
  const actual=info.runtime;
  if(!actual?.bin||!actual.version)throw Error('运行中的连接器未返回实际 Codex 路径和版本，不能确认适配通过');
  const path=(value:string)=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
  if(path(actual.bin)!==path(expectedBin))throw Error(`运行端未跟随本机 Codex：实际 ${actual.version} (${actual.bin})；应为 ${expectedVersion} (${expectedBin})`);
  if(actual.version!==expectedVersion)throw Error(`Codex 运行版本不符：实际 ${actual.version}，应为 ${expectedVersion}`);
  return {status:'passed',layer:'deployed-runtime',runtime:actual,liveChatGPT:false,uiAcceptance:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const bin=process.platform==='win32'?resolveWindowsCodex(process.env.PATH||'',process.env.LOCALAPPDATA||''):resolveCodex();
    const version=execFileSync(bin,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','ignore']}).trim().replace(/^codex(?:-cli)?\s+/,'');
    const receipt={at:new Date().toISOString(),...verifyRuntime(await checkConnection(resolve('.')),bin,version)};
    await mkdir('.local',{recursive:true});await writeFile('.local/runtime-check.json',JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify(receipt));
  }catch(error){
    const message=(error as Error).message;
    await mkdir('.local',{recursive:true});await writeFile('.local/runtime-check.json',JSON.stringify({at:new Date().toISOString(),status:'failed',layer:'deployed-runtime',error:message,liveChatGPT:false,uiAcceptance:false},null,2)+'\n');
    console.error(message);process.exitCode=1;
  }
}
