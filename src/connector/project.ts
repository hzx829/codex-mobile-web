import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { BridgeError } from '../shared/types.js';

export function within(root:string,path:string) { const rel=relative(root,path);return rel===''||(!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&rel!=='..'&&!isAbsolute(rel)); }
export async function projectPath(roots:string[],path:string) {
  const canonical=await realpath(resolve(path));
  for(const root of roots)if(within(await realpath(root),canonical))return canonical;
  throw new BridgeError('outside_project','该路径不在已连接项目中');
}
export async function readProjectFile(roots:string[],cwd:string,path:string) {
  const base=await projectPath(roots,cwd);
  const target=await projectPath(roots,resolve(base,path));
  if(!within(base,target))throw new BridgeError('outside_project','文件不在当前会话目录中');
  const info=await stat(target);
  if(!info.isFile())throw new BridgeError('invalid','请选择文件');
  if(info.size>2*1024*1024)throw new BridgeError('too_large','文件超过 2 MiB，请在电脑查看');
  const data=await readFile(target);
  const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
  if(mime[extname(target).toLowerCase()])return {path,mime:mime[extname(target).toLowerCase()],data:data.toString('base64')};
  if(data.includes(0))throw new BridgeError('binary','暂不支持预览此类文件');
  return {path,mime:'text/plain',text:data.toString('utf8')};
}
