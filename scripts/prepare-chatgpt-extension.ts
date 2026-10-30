import {cp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {browserPairing} from '../src/connector/chatgpt.js';
import {readConfig} from '../src/shared/config.js';

const config=readConfig(),destination=join(config.dataDir,'chatgpt-extension');
await mkdir(destination,{recursive:true});
await cp(resolve('src/chatgpt-extension'),destination,{recursive:true});
await writeFile(join(destination,'pairing.json'),JSON.stringify(browserPairing(config.dataDir,config.chatgptPort||3342))+'\n',{mode:0o600});
console.log(`扩展已准备好：${destination}\n在 Chrome / Edge 扩展管理页打开开发者模式，加载此目录。\n打开已登录的 ChatGPT 页面，点击扩展，选择“连接当前 ChatGPT 页面”。`);
