import {useState,type DragEvent} from 'react';
import {clipboardFiles} from './attachments';

const carriesFiles=(e:DragEvent)=>Array.from(e.dataTransfer.types||[]).includes('Files');

/** Drag-and-drop of files onto a composer: `dragging` while files hover over it, `accept` gets the dropped files. */
export function useFileDrop(accept:(files:File[])=>void,disabled=false){
  const [dragging,setDragging]=useState(false);
  function over(e:DragEvent<HTMLElement>){
    if(!carriesFiles(e))return;
    e.preventDefault();e.dataTransfer.dropEffect=disabled?'none':'copy';
    if(!dragging)setDragging(true);
  }
  return {dragging,handlers:{
    onDragEnter:over,onDragOver:over,
    onDragLeave(e:DragEvent<HTMLElement>){if(!e.currentTarget.contains(e.relatedTarget as Node|null))setDragging(false);},
    onDrop(e:DragEvent<HTMLElement>){
      if(!carriesFiles(e))return;
      e.preventDefault();setDragging(false);
      const files=clipboardFiles(e.dataTransfer);
      if(!disabled&&files.length)accept(files);
    },
  }};
}
