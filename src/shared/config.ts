import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export function readConfig() {
  const file=resolve(process.env.BRIDGE_CONFIG||'.local/config.json');
  let c:any={};try{c=JSON.parse(readFileSync(file,'utf8'));}catch{}
  const token=process.env.BRIDGE_TOKEN||c.token;
  if(typeof token!=='string'||token.length<24)throw new Error('请先运行 setup 配置连接，或设置 BRIDGE_TOKEN（至少 24 位）');
  return {...c,token,port:Number(process.env.PORT||c.port||3340),host:process.env.HOST||c.host||'127.0.0.1',relayUrl:process.env.RELAY_URL||c.relayUrl||'http://127.0.0.1:3340',dataDir:resolve(process.env.BRIDGE_DATA||'.local'),configFile:file};
}
