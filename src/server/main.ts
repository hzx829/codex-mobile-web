import { readConfig } from '../shared/config.js';
import { createRelay } from './relay.js';
const config=readConfig();
const relay=createRelay(config.token);
relay.server.listen(config.port,config.host,()=>console.log(`中继已启动：${config.host}:${config.port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void relay.close().then(()=>process.exit(0)));
