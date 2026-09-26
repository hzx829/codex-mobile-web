import {useEffect,useMemo,useRef} from 'react';
import {highlightedCode} from './syntax';

export function CodeViewer({text,name='',line}:{text:string;name?:string;line?:number}){
  const gutter=useRef<HTMLDivElement>(null);
  const content=useMemo(()=>{
    const lines=text.split(/\r?\n/),visible=lines.slice(0,10000),source=visible.join('\n');
    return {visible,source,highlighted:highlightedCode(source,name),truncated:lines.length>visible.length};
  },[text,name]);
  useEffect(()=>{if(line)gutter.current?.querySelector(`[data-line="${Math.min(line,content.visible.length)}"]`)?.scrollIntoView({block:'center'});},[line,content]);
  return <>{content.truncated&&<p className="preview-notice">仅显示前 10,000 行，完整内容请下载文件。</p>}<div className="code-viewer">
    <div className="code-gutter" ref={gutter} aria-hidden="true">{content.visible.map((_,i)=><span data-line={i+1} className={i+1===line?'selected-line':''} key={i}>{i+1}</span>)}</div>
    <pre className="code-source"><code>{content.highlighted||' '}</code></pre>
  </div></>;
}
