import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, isAbsolute, extname } from 'node:path';
import { BridgeError } from '../shared/types.js';

export async function projectDirectory(path:string) {
  if(!isAbsolute(path))throw new BridgeError('invalid','请使用电脑上的完整项目路径');
  const canonical=await realpath(path);
  if(!(await stat(canonical)).isDirectory())throw new BridgeError('invalid','项目目录无效');
  return canonical;
}
export async function readProjectFile(cwd:string,path:string) {
  if(!isAbsolute(path)&&!isAbsolute(cwd))throw new BridgeError('invalid','该会话没有工作目录，请填写电脑上的完整文件路径');
  const target=await realpath(isAbsolute(path)?path:resolve(cwd,path));
  const info=await stat(target);
  if(!info.isFile())throw new BridgeError('invalid','请选择文件');
  if(info.size>2*1024*1024)throw new BridgeError('too_large','文件超过 2 MiB，请在电脑查看');
  const data=await readFile(target);
  const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
  if(mime[extname(target).toLowerCase()])return {path,mime:mime[extname(target).toLowerCase()],data:data.toString('base64')};
  if(data.includes(0))throw new BridgeError('binary','暂不支持预览此类文件');
  return {path,mime:'text/plain',text:data.toString('utf8')};
}
