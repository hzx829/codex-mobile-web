import {realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename} from 'node:path';
export async function removeTestTemp(path:string){
  const target=await realpath(resolve(path)),root=await realpath(tmpdir());
  if(dirname(target)!==root||!basename(target).startsWith('cmw-'))throw new Error('Temporary cleanup target is outside this test workspace');
  await rm(target,{recursive:true,force:true});
}
