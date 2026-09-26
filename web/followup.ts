export type ContentPart={kind:'markdown';text:string}|{kind:'followup';label:string;prompt:string};

export function splitFollowups(text:string):ContentPart[] {
  const parts:ContentPart[]=[],lines:string[]=[],directive=/^ {0,3}:codex-followup\[([^\]\n]{1,100})\]\{prompt=("(?:\\.|[^"\\]){1,4000}")\}\s*$/;
  let fence='';
  const flush=()=>{if(lines.length)parts.push({kind:'markdown',text:lines.splice(0).join('\n')});};
  for(const line of text.split('\n')){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence='';lines.push(line);continue;}
    const match=!fence&&!/^(?: {4}|\t)/.test(line)?line.match(directive):null;
    if(match){
      try{const prompt=JSON.parse(match[2]);if(typeof prompt==='string'&&prompt.trim()&&prompt.length<=4000){flush();parts.push({kind:'followup',label:match[1],prompt});continue;}}catch{}
    }
    lines.push(line);
  }
  flush();
  return parts;
}
