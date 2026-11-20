/**
 * Splits markdown into top-level blocks that render the same on their own.
 *
 * A streaming reply grows at its end. Rendering each block separately lets React
 * keep finished blocks and parse only the last one on every update.
 *
 * A split happens only at a blank line outside fenced code, before a line that
 * starts in the first column and cannot continue the previous block. List items,
 * indented continuations and footnote or link definitions stay with what comes
 * before them. Text with link reference definitions is not split at all, since a
 * definition applies to the whole document.
 */
const fenceOpen=/^ {0,3}(`{3,}|~{3,})/;
const continues=/^(?:[\s\[]|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$))/;
const definition=/^ {0,3}\[[^\]\n]+\]:/m;

export function markdownBlocks(text:string):string[] {
  if(text.length<400||definition.test(text))return [text];
  const blocks:string[]=[],lines=text.split('\n');
  let current:string[]=[],fence='',blank=false;
  for(const line of lines) {
    if(fence) {
      current.push(line);
      const close=line.match(fenceOpen);
      if(close&&close[1][0]===fence[0]&&close[1].length>=fence.length&&!line.slice(close[0].length).trim())fence='';
      continue;
    }
    if(blank&&line&&!continues.test(line)&&current.some(value=>value.trim())){blocks.push(current.join('\n'));current=[];}
    const open=line.match(fenceOpen);
    // A backtick fence's info string cannot contain backticks; otherwise it is inline code.
    if(open&&!(open[1][0]==='`'&&line.slice(open[0].length).includes('`')))fence=open[1];
    current.push(line);blank=!line.trim();
  }
  if(current.length)blocks.push(current.join('\n'));
  return blocks;
}
