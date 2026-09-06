import { BridgeError, type Json } from '../shared/types.js';
const methods:Record<string,string>={
  'item/commandExecution/requestApproval':'thread-follower-command-approval-decision',
  'item/fileChange/requestApproval':'thread-follower-file-approval-decision',
  'item/permissions/requestApproval':'thread-follower-permissions-request-approval-response',
  'item/tool/requestUserInput':'thread-follower-submit-user-input',
  'mcpServer/elicitation/request':'thread-follower-submit-mcp-server-elicitation-response',
};
export function approvalResult(req:Json,response:Json):{method:string;result:Json;field:string} {
  const method=methods[req.method];
  if(!method)throw new BridgeError('unsupported','此类请求请在电脑端处理');
  if(req.method==='item/commandExecution/requestApproval'||req.method==='item/fileChange/requestApproval') {
    const options=req.params?.availableDecisions||['accept','acceptForSession','decline','cancel'];
    if(!options.some((v:any)=>JSON.stringify(v)===JSON.stringify(response.decision)))throw new BridgeError('invalid','审批选项无效');
    return {method,result:{decision:response.decision},field:'decision'};
  }
  if(req.method==='item/permissions/requestApproval') {
    if(!['turn','session'].includes(response.scope))throw new BridgeError('invalid','授权范围无效');
    return {method,result:{permissions:response.allow?req.params.permissions:{},scope:response.scope},field:'response'};
  }
  if(req.method==='item/tool/requestUserInput') {
    const answers:Json={};
    for(const q of req.params.questions||[]) {
      const a=response.answers?.[q.id]?.answers;
      if(!Array.isArray(a)||!a.length||a.some(v=>typeof v!=='string'||!v.trim()||v.length>10_000))throw new BridgeError('invalid','请回答所有问题');
      answers[q.id]={answers:a};
    }
    return {method,result:{answers},field:'response'};
  }
  if(!['accept','decline','cancel'].includes(response.action))throw new BridgeError('invalid','回应无效');
  if(req.params?.mode==='url'&&response.action==='accept')throw new BridgeError('unsupported','需要外部授权的请求请在电脑端处理');
  return {method,result:{action:response.action,content:response.content??null},field:'response'};
}
