import type {AppServer} from './app-server.js';
import {EnvHttpProxyAgent} from 'undici';
import {BridgeError,type Json} from '../shared/types.js';
import {MAX_VOICE_BYTES,MAX_VOICE_DURATION_MS,voiceMimeTypes} from '../shared/voice.js';

// Desktop dictation uses this private endpoint, not the model provider's Responses API.
const endpoint='https://chatgpt.com/backend-api/transcribe';
const userAgent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
let dispatcher:EnvHttpProxyAgent|undefined;
const fetchVoice:typeof fetch=(input,init)=>{
  // Node fetch does not use HTTP(S)_PROXY by default. Keep this agent local to dictation.
  dispatcher??=new EnvHttpProxyAgent();
  return fetch(input,{...init,dispatcher} as RequestInit);
};

export async function transcribeVoice(runtime:Pick<AppServer,'rpc'>,payload:Json,fetcher:typeof fetch=fetchVoice):Promise<{text:string}> {
  const {audio,mimeType,durationMs}=payload;
  const extension=typeof mimeType==='string'&&Object.hasOwn(voiceMimeTypes,mimeType)?voiceMimeTypes[mimeType]:undefined;
  if(!extension)throw new BridgeError('invalid_audio','录音格式不支持，请切换系统键盘或更换浏览器');
  if(typeof durationMs!=='number'||!Number.isFinite(durationMs)||durationMs<=0||durationMs>MAX_VOICE_DURATION_MS+2000)throw new BridgeError('invalid_audio','录音不能超过 2 分钟，请重新录制');
  if(typeof audio!=='string'||!audio.length||audio.length>4*Math.ceil(MAX_VOICE_BYTES/3))throw new BridgeError('invalid_audio','录音为空或超过 8 MiB，请重新录制');
  const bytes=Buffer.from(audio,'base64');
  if(!bytes.length||bytes.length>MAX_VOICE_BYTES||bytes.toString('base64')!==audio)throw new BridgeError('invalid_audio','录音数据无效，请重新录制');
  const signal=AbortSignal.timeout(90_000);
  for(let attempt=0;attempt<2;attempt++) {
    let auth:Json;
    try{auth=await runtime.rpc('getAuthStatus',{includeToken:true,refreshToken:attempt>0},10_000);}
    catch{throw new BridgeError('voice_auth','无法读取 Codex 登录状态，请在电脑上检查登录后重试');}
    if(!['chatgpt','chatgptAuthTokens'].includes(auth?.authMethod)||typeof auth.authToken!=='string'||!auth.authToken.trim())throw new BridgeError('voice_auth','Codex 识别需要在电脑上的 Codex 登录 ChatGPT，也可切换系统键盘');
    const body=new FormData();body.append('file',new Blob([bytes],{type:mimeType}),`codex.${extension}`);
    let response:Response;
    try{response=await fetcher(endpoint,{method:'POST',headers:{Authorization:`Bearer ${auth.authToken.replace(/^Bearer\s+/i,'').trim()}`,'User-Agent':userAgent},body,signal,redirect:'error'});}
    catch{throw new BridgeError('voice_failed',signal.aborted?'语音识别超时，请重试':'无法连接语音识别服务，请检查电脑网络后重试');}
    if(!response.ok){
      await response.body?.cancel();
      if(response.status===401&&attempt===0)continue;
      if(response.status===401||response.status===403)throw new BridgeError('voice_auth','语音服务未接受当前登录，请在电脑上检查 ChatGPT 登录，或切换系统键盘');
      if(response.status===429)throw new BridgeError('voice_limit','语音识别暂时达到限额，请稍后重试或切换系统键盘');
      throw new BridgeError('voice_failed','语音识别失败，请重试或切换系统键盘');
    }
    let result:Json;
    try{result=await response.json();}catch{throw new BridgeError('voice_failed','语音服务返回无效结果，请重试');}
    if(typeof result?.text!=='string'||!result.text.trim())throw new BridgeError('voice_empty','没有识别到文字，请重新录制');
    if(result.text.length>100_000)throw new BridgeError('voice_failed','识别结果过长，请缩短录音');
    return {text:result.text.trim()};
  }
  throw new BridgeError('voice_auth','请在电脑上的 Codex 重新登录 ChatGPT');
}
