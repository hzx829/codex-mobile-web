import { connectorTokens, readConfig } from '../shared/config.js';
import { createRelay } from './relay.js';
const config=readConfig();
let restricted:unknown=config.connectorTokens;
if(process.env.BRIDGE_CONNECTOR_TOKENS!==undefined){
  try{restricted=JSON.parse(process.env.BRIDGE_CONNECTOR_TOKENS);}
  catch{throw new Error('BRIDGE_CONNECTOR_TOKENS 必须是有效的 JSON 数组');}
}
const relay=createRelay(config.token,undefined,config.port+1,connectorTokens(restricted));
relay.server.listen(config.port,config.host,()=>console.log(`中继已启动：${config.host}:${config.port}`));
relay.previewServer.listen(config.port+1,config.host,()=>console.log(`网页预览代理已启动：${config.host}:${config.port+1}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void relay.close().then(()=>process.exit(0)));
