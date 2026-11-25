import { join, resolve } from 'node:path';
import { connectorTokens, readConfig } from '../shared/config.js';
import { createRelay } from './relay.js';
import { TeamStore } from './team/store.js';
import { runTeamCommand } from './team/cli.js';
// Members, devices and the activity log live here; without a writable directory the relay keeps its single shared Token.
const teamDatabase=join(resolve(process.env.BRIDGE_DATA||'.local'),'relay.sqlite');
if(process.argv[2]==='team')process.exit(runTeamCommand(process.argv.slice(3),teamDatabase));
const config=readConfig();
let restricted:unknown=config.connectorTokens;
if(process.env.BRIDGE_CONNECTOR_TOKENS!==undefined){
  try{restricted=JSON.parse(process.env.BRIDGE_CONNECTOR_TOKENS);}
  catch{throw new Error('BRIDGE_CONNECTOR_TOKENS 必须是有效的 JSON 数组');}
}
let team:TeamStore|undefined;
try{team=new TeamStore(teamDatabase);}
catch(error){console.warn(`团队数据库不可用，按个人模式运行（${(error as Error).message}）`);}
const relay=createRelay(config.token,undefined,config.port+1,connectorTokens(restricted),team);
relay.server.listen(config.port,config.host,()=>console.log(`中继已启动：${config.host}:${config.port}${team?.enabled?'（团队模式）':''}`));
relay.previewServer.listen(config.port+1,config.host,()=>console.log(`网页预览代理已启动：${config.host}:${config.port+1}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void relay.close().then(()=>{team?.close();process.exit(0);}));
