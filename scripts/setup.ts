import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {hostname,networkInterfaces} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import QRCode from 'qrcode';
import {resolveCodex} from '../src/connector/app-server.js';
const args=process.argv.slice(2),value=(key:string)=>{const i=args.indexOf(key);return i>=0?args[i+1]:undefined;};
const dir=resolve('.local'),file=join(dir,'config.json');await mkdir(dir,{recursive:true});
let old:any={};try{old=JSON.parse(await readFile(file,'utf8'));}catch{}
const lan=Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal&&!i.address.startsWith('169.254.'))?.address||'127.0.0.1';
const interactive=!args.includes('--yes');const input=interactive?createInterface({input:stdin,output:stdout}):null;
try {
  const defaultRoot=value('--root')||old.roots?.[0]||process.cwd();
  const root=resolve(interactive?(await input!.question(`项目目录 [${defaultRoot}]: `)||defaultRoot):defaultRoot);
  const defaultUrl=value('--relay')||old.relayUrl||`http://${lan}:3340`;
  const relayUrl=interactive?(await input!.question(`手机可访问的中继地址 [${defaultUrl}]: `)||defaultUrl):defaultUrl;
  const url=new URL(relayUrl);if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.username||url.password)throw new Error('请填写 http(s)://主机:端口，不包含子路径或凭据');
  const token=value('--token')||(!args.includes('--rotate')&&old.token)||randomBytes(32).toString('base64url');
  if(token.length<24)throw new Error('Token 至少需要 24 位');
  const {realpath,stat}=await import('node:fs/promises');const canonical=await realpath(root);if(!(await stat(canonical)).isDirectory())throw new Error('项目目录无效');
  const config={...old,token,relayUrl:url.origin,port:old.port||3340,host:old.host||'0.0.0.0',machineId:old.machineId||randomUUID(),machineName:old.machineName||hostname(),roots:[canonical]};
  await writeFile(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  const link=new URL(url);link.hash=new URLSearchParams({token}).toString();
  const qr=await QRCode.toDataURL(link.href,{width:320,margin:2});
  await writeFile(join(dir,'connect-qr.png'),Buffer.from(qr.split(',')[1],'base64'));
  const escaped=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  await writeFile(join(dir,'connect.html'),`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Codex 随行</title><style>body{font:16px/1.7 system-ui;background:#f5f7f5;color:#254535;max-width:520px;margin:6vh auto;padding:24px}img{width:280px;max-width:100%;border-radius:20px}code{word-break:break-all;background:#e7ece3;padding:8px;display:block;border-radius:8px}a{color:#347056}small{color:#889880}</style><h1>用手机接上电脑</h1><p>手机和电脑处于同一网络时，扫描下方二维码。公网使用请填入自己的 HTTPS 中继地址。</p><img alt="连接二维码" src="${qr}"><p><a href="${escaped(link.href)}">在这台电脑打开网页 ↗</a></p><p>中继：${escaped(url.origin)}</p><details><summary>手工连接 Token</summary><code>${escaped(token)}</code></details><p>项目：${escaped(canonical)}</p><small>二维码包含连接凭证，请保留在自己的设备中。配置文件位于 .local/config.json。</small></html>`);
  let found='';try{found=resolveCodex();}catch{}
  console.log(`配置已保存。${found?'已识别本机 Codex。':'未识别 Codex，请设置 CODEX_BIN 后启动连接器。'}\n连接二维码：${join(dir,'connect.html')}\n中继地址：${url.origin}`);
}finally{input?.close();}
