import {mkdir,cp,copyFile,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
if(process.platform!=='win32')throw new Error('Windows 便携包请在 Windows 构建');
const target=resolve('release',`codex-mobile-web-0.1.0-${Date.now()}`);await mkdir(join(target,'runtime'),{recursive:true});
for(const name of ['build','dist','scripts/windows'])await cp(resolve(name),join(target,name),{recursive:true});
for(const name of ['start.cmd','stop.cmd','connector-only.cmd','QUICKSTART.md','SOURCES.md'])await copyFile(name,join(target,name));
await copyFile(process.execPath,join(target,'runtime','node.exe'));
const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
if(!response.ok)throw new Error('无法获取该版本 Node 许可证，停止生成分发包');
await writeFile(join(target,'runtime','NODE-LICENSE.txt'),await response.text());
// Include licenses of installed packages used in the bundle without shipping credentials or research copies.
const licenses:string[]=[];
async function scan(folder:string){for(const name of await readdir(folder)){if(name.startsWith('.'))continue;const path=join(folder,name);if(!(await stat(path)).isDirectory())continue;if(name.startsWith('@')){await scan(path);continue;}try{const pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));const entries=await readdir(path);const file=entries.find(n=>/^licen[cs]e(\.|$)/i.test(n));if(file)licenses.push(`===== ${pkg.name}@${pkg.version} =====\n${await readFile(join(path,file),'utf8')}`);}catch{}}}
await scan(resolve('node_modules'));await writeFile(join(target,'THIRD-PARTY-LICENSES.txt'),licenses.join('\n\n'));
await writeFile(join(target,'VERSION.txt'),`Codex Mobile Web 0.1.0\nNode ${process.version}\nWindows ${process.arch}\nLocal source build; desktop control requires manual acceptance.\n`);
console.log(target);
