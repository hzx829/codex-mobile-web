import type {ReactNode} from 'react';
import {refractor} from 'refractor';
import type {RootContent} from 'hast';

const languages:Record<string,string>={js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',py:'python',rb:'ruby',rs:'rust',sh:'bash',ps1:'powershell',yml:'yaml',md:'markdown',mdown:'markdown',html:'markup',htm:'markup',svg:'markup',cs:'csharp',h:'c',hpp:'cpp',kt:'kotlin'};
export function syntaxLanguage(name:string){const ext=name.split('.').at(-1)?.toLowerCase()||'',language=languages[ext]||ext;return refractor.registered(language)?language:undefined;}
// react-diff-view consumes a list of nodes; refractor 5 returns a root node.
export const diffRefractor={highlight:(text:string,language:string)=>refractor.highlight(text,language).children};
export function highlightedCode(text:string,name:string):ReactNode {
  const language=syntaxLanguage(name);if(!language||text.length>120000)return text;
  const render=(nodes:RootContent[]):ReactNode=>nodes.map((node,index)=>node.type==='text'?node.value:node.type==='element'?<span key={index} className={Array.isArray(node.properties.className)?node.properties.className.join(' '):undefined}>{render(node.children)}</span>:null);
  try{return render(refractor.highlight(text,language).children);}catch{return text;}
}
