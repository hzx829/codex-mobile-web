import {realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename} from 'node:path';
export async function removeTestTemp(path:string){
  const target=await realpath(resolve(path)),root=await realpath(tmpdir());
  if(dirname(target)!==root||!basename(target).startsWith('cmw-'))throw new Error('Temporary cleanup target is outside this test workspace');
  // On Windows a browser's helper processes can hold profile files for a moment after it exits.
  await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
