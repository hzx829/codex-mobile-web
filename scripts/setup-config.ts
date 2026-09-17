import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hostname,networkInterfaces} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolveCodex} from '../src/connector/app-server.js';

export async function savedSettings(file:string):Promise<any> {
  try {
    const value=JSON.parse(await readFile(file,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
    return value;
  } catch(e:any) {
    if(e.code==='ENOENT')return {};
    throw new Error('连接配置无法读取，请先修复或备份 .local/config.json；未覆盖原配置。');
  }
}
export function defaultRelay() {
  const lan=Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal&&!i.address.startsWith('169.254.'))?.address||'127.0.0.1';
  return `http://${lan}:3340`;
}
export async function prepareSettings(input:any,old:any={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('连接配置格式无效');
  const mode=input.mode||old.mode||'all';
  if(!['all','connector','relay'].includes(mode))throw new Error('启动方式无效');
  const url=new URL(input.relayUrl||old.relayUrl||defaultRelay());
  if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('中继地址应为 http(s)://主机:端口，不包含子路径、查询参数或凭据');
  const configuredToken=typeof input.token==='string'?input.token.trim():undefined;
  let token=configuredToken||(!input.rotate&&old.token);
  if(!token&&mode==='connector'&&!(input.rotate&&old.token))throw new Error('请填写自托管中继使用的 Token');
  token=token||randomBytes(32).toString('base64url');
  if(typeof token!=='string'||token.length<24||/\s/.test(token))throw new Error('Token 至少需要 24 位，且不能包含空白');
  const config:any={...old,token,mode,relayUrl:url.origin,port:old.port||3340,host:old.host||'0.0.0.0',machineId:old.machineId||randomUUID(),machineName:old.machineName||hostname()};
  delete config.roots; // Legacy project allowlists no longer restrict this computer.
  // An explicit blank removes an override; omitted fields retain the user's settings.
  for(const key of ['codexBin','codexHome'] as const) {
    if(input[key]===undefined)continue;
    if(typeof input[key]!=='string')throw new Error('Codex 路径无效');
    if(!input[key].trim()){delete config[key];continue;}
    const path=await realpath(resolve(input[key].trim())),entry=await stat(path);
    if(key==='codexHome'&&!entry.isDirectory())throw new Error('Codex 配置目录必须是文件夹');
    if(key==='codexBin') {
      resolveCodex(path);
      if(!entry.isFile()||(process.platform==='win32'&&!/\.exe$/i.test(path)))throw new Error('请选择 Codex 可执行文件（codex.exe）');
    }
    config[key]=path;
  }
  if(mode==='all') {
    if(url.protocol!=='http:')throw new Error('本机中继使用 HTTP 地址；HTTPS 公网中继请选择“连接自己的中继”');
    config.port=Number(url.port||80);
  }
  return config;
}
