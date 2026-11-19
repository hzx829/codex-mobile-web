import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type ConnectorToken = {token: string; machineId: string};
export type GuestPaths = {root: string; codexHome: string; claudeConfig: string; workspace: string};
export const machineIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;

export function connectorTokens(value: unknown): ConnectorToken[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('connectorTokens 必须是数组');
  const tokens = new Set<string>(), machines = new Set<string>();
  for (const entry of value) {
    if (typeof entry?.token !== 'string' || entry.token.length < 24 ||
        typeof entry.machineId !== 'string' || !machineIdPattern.test(entry.machineId) ||
        tokens.has(entry.token) || machines.has(entry.machineId)) {
      throw new Error('connectorTokens 中有无效或重复的 Token 或电脑 ID');
    }
    tokens.add(entry.token);
    machines.add(entry.machineId);
  }
  return value;
}

export function readConfig() {
  const file=resolve(process.env.BRIDGE_CONFIG||'.local/config.json');
  let c:any={};try{c=JSON.parse(readFileSync(file,'utf8'));}catch{}
  const token=process.env.BRIDGE_TOKEN||c.token;
  if(typeof token!=='string'||token.length<24)throw new Error('请先运行 setup 配置连接，或设置 BRIDGE_TOKEN（至少 24 位）');
  const guest = c.guest === true;
  const root = resolve(guest && typeof c.guestRoot === 'string' ? c.guestRoot : 'guest');
  const guestPaths: GuestPaths | undefined = guest ? {root, codexHome: join(root, 'codex-home'),
    claudeConfig: join(root, 'claude-config'), workspace: join(root, 'workspace')} : undefined;
  return {...c,token,guest,guestPaths,port:Number(process.env.PORT||c.port||3340),host:process.env.HOST||c.host||'127.0.0.1',relayUrl:process.env.RELAY_URL||c.relayUrl||'http://127.0.0.1:3340',dataDir:resolve(process.env.BRIDGE_DATA||'.local'),configFile:file};
}
