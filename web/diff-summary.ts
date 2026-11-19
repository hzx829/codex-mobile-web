/** File and line counts for the change card; avoids loading the diff viewer just to label the button. */
export function diffSummary(text:string){
  let files=0,added=0,removed=0;
  for(const line of text.split('\n')){
    if(line.startsWith('diff --git '))files++;
    else if(line.startsWith('+')&&!line.startsWith('+++ '))added++;
    else if(line.startsWith('-')&&!line.startsWith('--- '))removed++;
  }
  return {files,added,removed};
}
