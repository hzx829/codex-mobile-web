import { readConfig } from '../shared/config.js';
import { createRelay } from './relay.js';
const config=readConfig();
const relay=createRelay(config.token,undefined,config.port+1);
relay.server.listen(config.port,config.host,()=>console.log(`中继已启动：${config.host}:${config.port}`));
relay.previewServer.listen(config.port+1,config.host,()=>console.log(`网页预览代理已启动：${config.host}:${config.port+1}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void relay.close().then(()=>process.exit(0)));
