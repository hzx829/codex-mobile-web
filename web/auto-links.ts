import type {Root,RootContent,Parent,Text,Link,InlineCode} from 'mdast';

/**
 * Makes the addresses agents write as plain text openable, the way Codex's own file links are:
 * web and file addresses in inline code, file paths in prose, and bare web addresses GFM ran into
 * the Chinese punctuation after them. Code blocks, HTML and existing links keep their meaning.
 * The `a` renderer (web/content.tsx) decides what each address opens.
 */

// Full-width punctuation never ends a web address someone wrote in Chinese prose; GFM's autolink takes it in.
const CJK_PUNCTUATION=/[\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2018-\u201f\u2026]/;
const WEB=/^(?:https?:\/\/[^\s<>"'`]+|file:\/\/\/[^\s<>"'`]+)$/i;
const WINDOWS_CODE=/^[a-z]:[\\/][^<>"|*?\n\t]*$/i;
const LINE=String.raw`(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+)?)?`;
// A path with at least one slash and a file extension: `web/content.tsx:35`, `./a/b.md`, `/srv/app/main.go`.
const SLASHED=String.raw`(?:\.{1,2}/|/)?(?:[\w@.+-]+/)+[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`+LINE;
const SLASHED_CODE=new RegExp(`^${SLASHED}$`);
// Neither regex takes a value inside an attribute, such as a Codex citation still being written (web/file-citations.ts).
const SLASHED_TEXT=new RegExp(String.raw`(?<![\w./\\:@%~-]|=")${SLASHED}(?![\w/\\])`,'g');
// Spaces end a Windows path in prose; one with spaces needs backticks or a link.
const WINDOWS_TEXT=/(?<![\w\\/]|=")[a-z]:[\\/][^\s<>"'`|*?\u3000-\u303f\uff00-\uffef]+/gi;
const TRAILING=/[.,;:!?)\]}'"]+$/;

/** `a.com/x.html` is an address without its scheme, not a file. */
function domainLike(path:string){
  const first=path.split('/')[0];
  return /^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}$/i.test(first)&&!first.startsWith('.')&&path.includes('/');
}
function fileUrl(path:string){return encodeURI(path);}

function codeLink(node:InlineCode):Link|null {
  const value=node.value.trim();
  if(!value||value.length>2048)return null;
  if(WEB.test(value))return {type:'link',url:value,children:[node]};
  if(WINDOWS_CODE.test(value)||SLASHED_CODE.test(value)&&!domainLike(value))return {type:'link',url:fileUrl(value),children:[node]};
  return null;
}

/** A link GFM made from a bare address, cut short of the punctuation after it. */
function trimAutolink(node:Link):RootContent[]|null {
  const child=node.children[0];
  if(node.children.length!==1||child.type!=='text')return null;
  const text=child.value,literal=node.url===text||node.url==='http://'+text||node.url==='mailto:'+text;
  const cut=text.search(CJK_PUNCTUATION);
  if(!literal||cut<=0)return null;
  const kept=text.slice(0,cut);
  return [{...node,url:node.url.slice(0,node.url.length-text.length+cut),children:[{type:'text',value:kept}]},{type:'text',value:text.slice(cut)}];
}

type Match={start:number;end:number;path:string};
function trimmed(start:number,path:string):Match|null {
  const clean=path.replace(TRAILING,'');
  return clean?{start,end:start+clean.length,path:clean}:null;
}
/**
 * File paths in a run of prose. `raw` is the Markdown it came from: escapes there drop the backslash
 * before punctuation (`D:\work\.git`), so Windows paths are taken from the source when it differs.
 */
function textPaths(value:string,raw:string|null):Match[] {
  const matches:Match[]=[];
  const windows=[...value.matchAll(WINDOWS_TEXT)];
  const rawWindows=raw!==null&&raw!==value?[...raw.matchAll(WINDOWS_TEXT)]:null;
  if(!rawWindows||rawWindows.length===windows.length)windows.forEach((match,index)=>{
    const found=trimmed(match.index!,match[0]);if(!found)return;
    const source=rawWindows?trimmed(0,rawWindows[index][0])?.path:found.path;
    if(source)matches.push({...found,path:source});
  });
  for(const match of value.matchAll(SLASHED_TEXT)){
    const found=trimmed(match.index!,match[0]);
    if(found&&!domainLike(found.path)&&!matches.some(m=>found.start<m.end&&m.start<found.end))matches.push(found);
  }
  return matches.sort((a,b)=>a.start-b.start);
}

export function remarkAutoLinks(){
  return (tree:Root,file?:{value?:unknown})=>{
    const source=typeof file?.value==='string'?file.value:null;
    function visit(parent:Root|Parent){
      const children:RootContent[]=[];
      for(const node of parent.children){
        if(node.type==='inlineCode'){children.push(codeLink(node)||node);continue;}
        if(node.type==='link'){children.push(...(trimAutolink(node)||[node]));continue;}
        if(node.type==='text'){
          const start=node.position?.start.offset,end=node.position?.end.offset;
          const raw=source!==null&&start!==undefined&&end!==undefined?source.slice(start,end):null;
          const matches=textPaths(node.value,raw);
          if(!matches.length){children.push(node);continue;}
          let at=0;
          for(const match of matches){
            if(match.start>at)children.push({type:'text',value:node.value.slice(at,match.start)} as Text);
            children.push({type:'link',url:fileUrl(match.path),children:[{type:'text',value:match.path}]} as Link);
            at=match.end;
          }
          if(at<node.value.length)children.push({type:'text',value:node.value.slice(at)} as Text);
          continue;
        }
        if('children' in node&&!['linkReference','image','imageReference'].includes(node.type))visit(node);
        children.push(node);
      }
      parent.children=children as typeof parent.children;
    }
    visit(tree);
  };
}
