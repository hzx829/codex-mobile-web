import type {Root,RootContent,Parent,Text,Link} from 'mdast';

// Transform prose only: code, HTML and existing links keep their original meaning.
export function remarkFileCitations(){
  return (tree:Root)=>{
    function visit(parent:Root|Parent){
      const children:RootContent[]=[];
      for(const node of parent.children){
        if(node.type==='text'){
          const pattern=/:codex-file-citation\{((?:\s*[\w-]+="[^"\n]*")*\s*)\}/g;
          let start=0;
          for(const match of node.value.matchAll(pattern)){
            const attributes=Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"\n]*)"/g)].map(value=>[value[1],value[2]]));
            const path=attributes.path;
            if(!path?.trim()||/[\u0000-\u001f]/.test(path)||/^[\\/]{2}/.test(path)||(/^[a-z][a-z\d+.-]*:/i.test(path)&&!/^[a-z]:[\\/]/i.test(path)))continue;
            if(match.index!>start)children.push({type:'text',value:node.value.slice(start,match.index)} as Text);
            const name=path.replace(/\\/g,'/').split('/').pop()||path;
            children.push({type:'link',url:encodeURI(path),children:[{type:'text',value:name}]} as Link);
            start=match.index!+match[0].length;
          }
          // Untouched text keeps its node, and with it the source position later plugins read (web/auto-links.ts).
          if(!start)children.push(node);
          else if(start<node.value.length)children.push({type:'text',value:node.value.slice(start)} as Text);
        }else{
          if('children' in node&&!['link','linkReference','image','imageReference'].includes(node.type))visit(node);
          children.push(node);
        }
      }
      parent.children=children as typeof parent.children;
    }
    visit(tree);
  };
}
