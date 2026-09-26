import {parseDiff,tokenize,markEdits,type FileData} from 'react-diff-view';
import {diffRefractor,syntaxLanguage} from './syntax';

export function parseTaskDiff(text:string):FileData[]{
  // Preserve unfamiliar or incomplete formats through the raw view.
  if(!/^diff --git /m.test(text))return [];
  try{
    const normalized=text.replace(/\r\n/g,'\n'),files=parseDiff(normalized,{nearbySequences:'zip'}),sections=normalized.split(/(?=^diff --git )/m).filter(part=>part.startsWith('diff --git '));
    return files.map((file,index)=>{
      const metadata=(sections[index]||'').split(/^@@/m)[0];
      const oldPath=metadata.match(/^--- (.+)$/m)?.[1],newPath=metadata.match(/^\+\+\+ (.+)$/m)?.[1];
      if(oldPath)file.oldPath=gitPath(oldPath);
      if(newPath)file.newPath=gitPath(newPath);
      if(/^Binary files |^GIT binary patch/m.test(metadata))file.isBinary=true;
      if(/^new file mode /m.test(metadata))file.type='add';
      if(/^deleted file mode /m.test(metadata))file.type='delete';
      return file;
    });
  }catch{return [];}
}
function gitPath(value:string){
  let path=value.split('\t')[0];
  if(path.startsWith('"')){
    try{path=JSON.parse(path.replace(/(?:\\[0-7]{3})+/g,sequence=>new TextDecoder().decode(Uint8Array.from([...sequence.matchAll(/\\([0-7]{3})/g)],match=>parseInt(match[1],8)))));}catch{}
  }
  return path.replace(/^[ab]\//,'');
}
export function diffCounts(file:FileData){
  let added=0,removed=0;
  for(const hunk of file.hunks)for(const change of hunk.changes){if(change.type==='insert')added++;else if(change.type==='delete')removed++;}
  return {added,removed};
}
export function diffTokens(file:FileData){
  const hunks=file.hunks,changes=hunks.flatMap(h=>h.changes);
  // Tokenization fills the gaps before hunks; don't allocate huge sparse files.
  if(changes.length>3000||changes.reduce((sum,c)=>sum+c.content.length,0)>120000||hunks.some(h=>Math.max(h.oldStart+h.oldLines,h.newStart+h.newLines)>30000))return undefined;
  const language=syntaxLanguage(file.newPath||file.oldPath),enhancers=[markEdits(hunks,{type:'line'})];
  try{return tokenize(hunks,language?{highlight:true,refractor:diffRefractor,language,enhancers}:{highlight:false,enhancers});}catch{return undefined;}
}
