import {useEffect,useMemo,useRef,useState} from 'react';
import {Diff,Hunk,Decoration,type FileData} from 'react-diff-view';
import {parseTaskDiff,diffCounts,diffTokens} from './diff';
import {CodeViewer} from './code-viewer';

export function DiffFileView({file,split}:{file:FileData;split:boolean}){
  const tokens=useMemo(()=>diffTokens(file),[file]);
  if(file.isBinary)return <p className="preview-notice">二进制文件发生变化，无法逐行比较。</p>;
  if(!file.hunks.length)return <p className="preview-notice">{file.type==='rename'?`${file.oldPath} → ${file.newPath}`:'文件属性发生变化，没有文本差异。'}</p>;
  return <div className="diff-scroll"><Diff viewType={split?'split':'unified'} diffType={file.type} hunks={file.hunks} tokens={tokens} optimizeSelection>
    {hunks=>hunks.flatMap((hunk,index)=>[<Decoration key={`heading-${index}`}>{hunk.content}</Decoration>,<Hunk key={index} hunk={hunk}/>])}
  </Diff></div>;
}

export function DiffViewer({text,compact}:{text:string;compact:boolean}){
  const files=useMemo(()=>parseTaskDiff(text),[text]),[selected,setSelected]=useState(0),[mode,setMode]=useState<'auto'|'unified'|'split'>('auto'),[raw,setRaw]=useState(false),[wide,setWide]=useState(false);
  const container=useRef<HTMLDivElement>(null),file=files[selected]||files[0];
  const counts=useMemo(()=>files.map(diffCounts),[files]),total=counts.reduce((sum,c)=>({added:sum.added+c.added,removed:sum.removed+c.removed}),{added:0,removed:0});
  useEffect(()=>{const element=container.current;if(!element)return;const observer=new ResizeObserver(()=>setWide(element.clientWidth>=720));observer.observe(element);return()=>observer.disconnect();},[]);
  const split=!compact&&(mode==='split'||mode==='auto'&&wide);
  return <div className="diff-viewer" ref={container}>
    <div className="viewer-toolbar diff-toolbar"><span>{files.length?`${files.length} 个文件`:'本轮差异'}</span>{files.length>0&&<span className="diff-count"><b>+{total.added}</b> <em>−{total.removed}</em></span>}
      {!compact&&file&&!raw&&<select aria-label="差异布局" value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="auto">自动布局</option><option value="unified">上下对比</option><option value="split">左右对比</option></select>}
      {file&&<button aria-pressed={raw} onClick={()=>setRaw(v=>!v)}>{raw?'可视化':'原始 diff'}</button>}
    </div>
    {file&&!raw?<><div className="diff-file-picker"><select aria-label="选择修改文件" value={Math.min(selected,files.length-1)} onChange={e=>setSelected(Number(e.target.value))}>{files.map((f,i)=><option key={i} value={i}>{f.type==='delete'?f.oldPath:f.newPath}　+{counts[i].added} −{counts[i].removed}</option>)}</select><small>{({add:'新增',delete:'删除',modify:'修改',rename:'重命名',copy:'复制'} as const)[file.type]}</small></div><DiffFileView key={selected} file={file} split={split}/></>:<>{!files.length&&<p className="preview-notice">此差异格式暂时无法可视化，以下显示原始内容。</p>}<CodeViewer text={text} name="changes.diff"/></>}
  </div>;
}
