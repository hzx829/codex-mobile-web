import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

export async function writeBundleLicenses(target:string) {
  const licenses:string[]=[];
  async function scan(folder:string){for(const name of await readdir(folder)){
    if(name.startsWith('.'))continue;const path=join(folder,name);if(!(await stat(path)).isDirectory())continue;
    if(name.startsWith('@')){await scan(path);continue;}
    try{const pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8')),entries=await readdir(path);
      const file=entries.find(n=>/^licen[cs]e(\.|$)/i.test(n));if(file)licenses.push(`===== ${pkg.name}@${pkg.version} =====\n${await readFile(join(path,file),'utf8')}`);
    }catch{}
  }}
  await scan(resolve('node_modules'));await writeFile(join(target,'THIRD-PARTY-LICENSES.txt'),licenses.join('\n\n'));
}
