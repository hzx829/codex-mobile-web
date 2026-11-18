import {cp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {coworkPairing} from '../src/connector/cowork.js';
import {readConfig} from '../src/shared/config.js';

const config=readConfig(),destination=join(config.dataDir,'cowork-extension');
await mkdir(destination,{recursive:true});
await cp(resolve('src/cowork-extension'),destination,{recursive:true});
await writeFile(join(destination,'pairing.json'),JSON.stringify(coworkPairing(config.dataDir,config.coworkPort||config.chatgptPort||3342))+'\n',{mode:0o600});
console.log(`扩展已准备好：${destination}\n首次使用请在 Chrome / Edge 扩展管理页加载此目录。已安装时点击重新加载。\n打开已登录的 Claude 页面，点击扩展，选择“连接当前页面”。`);
