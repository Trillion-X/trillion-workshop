import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {claimNode,releaseNode} from '../one-owner-per-node';
import {flushSync} from 'react-dom';
import {UploadIcon} from 'lucide-react';
import {Dropzone,DropzoneEmptyState} from './dropzone';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export type FileDropzoneOptions={
 onFiles:(files:File[])=>Promise<unknown>|unknown;
 label?:string;description?:string;accept?:Record<string,string[]>;
 multiple?:boolean;disabled?:boolean;
};
export function mountFileDropzone(node:HTMLElement,initial:FileDropzoneOptions){
 // The dropzone owns `node` (one-owner-per-node): a later owner of the same node (a list replacing an empty folder's
 // dropzone) tears this root down first, and this dropzone releases whoever held the node before it.
 let root:ReturnType<typeof createRoot>;let options=initial,destroyed=false;
 const release=()=>{if(destroyed)return;destroyed=true;root.unmount();node.classList.remove('coss-ui','kibo-file-dropzone');delete node.dataset.sharedRoot;delete node.dataset.acceptsExternalFiles;};
 claimNode(node,release);node.dataset.acceptsExternalFiles='true';
 node.replaceChildren();node.classList.add('coss-ui','kibo-file-dropzone');node.dataset.sharedRoot='file-dropzone';
 root=createRoot(node);
 function Surface({options}:{options:FileDropzoneOptions}){
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[count,setCount]=useState(0);
  const busy=useRef(false),alive=useRef(true);
  useEffect(()=>()=>{alive.current=false;},[]);
  async function receive(files:File[]){
   if(!files.length||busy.current||options.disabled)return;
   busy.current=true;setPending(true);setError('');setCount(0);
   try{await options.onFiles(files);if(alive.current)setCount(files.length);}
   catch(error){if(alive.current)setError(errorWords(error, 'The files could not be added. Try again.'));}
   finally{busy.current=false;if(alive.current)setPending(false);}
  }
  return <div aria-busy={pending}>
   <Dropzone accept={options.accept??{'audio/*':[], 'video/*':[]}} multiple={options.multiple!==false}
    maxFiles={options.multiple===false?1:0} disabled={!!options.disabled||pending}
    onError={error=>{if(!busy.current)setError(errorWords(error,'Choose an accepted file.'));}}
    onDrop={receive} className="kibo-file-drop-target" aria-label={options.label||'Add audio or video'}>
    <DropzoneEmptyState><span className="kibo-file-drop-content">
     <UploadIcon aria-hidden="true"/>
     <strong>{pending?'Adding files…':options.label||'Add audio or video'}</strong>
     {options.description!==''&&<span>{options.description??'Drop recordings here, or click to choose files.'}</span>}
    </span></DropzoneEmptyState>
   </Dropzone>
   {error&&<p className="kibo-file-drop-error" role="alert">{error}</p>}
   <span className="kibo-file-drop-status" role="status">{pending?'Adding files…':count?`${count} ${count===1?'file':'files'} added.`:''}</span>
  </div>;
 }
 const render=()=>{if(!destroyed)flushSync(()=>root.render(<Surface options={options}/>));};render();
 return {open:()=>{const input=node.querySelector<HTMLInputElement>('input[type=file]');if(!destroyed&&input&&!input.disabled)input.click();},update:(changes:Partial<FileDropzoneOptions>)=>{options={...options,...changes};render();},destroy:()=>{if(!destroyed)releaseNode(node);}};
}

// A file dragged in from the computer, anywhere over `workspace`, belongs to this
// drop area. The licensed Dropzone still owns the actual drop, picker, acceptance
// rules and file extraction: a drop that lands on the workspace outside a drop
// area is handed to the workspace's Dropzone as the same drop, so choosing,
// dropping on the drop area and dropping anywhere else take one path.
const carriesFiles=(event:DragEvent)=>Array.from(event.dataTransfer?.types||[]).includes('Files');
export function mountWorkspaceFileDropzone(workspace:HTMLElement,initial:FileDropzoneOptions){
 const overlay=document.createElement('div');overlay.className='kibo-workspace-file-overlay';overlay.hidden=true;
 workspace.classList.add('kibo-file-drop-workspace');workspace.dataset.acceptsExternalFiles='true';overlay.dataset.acceptsExternalFiles='true';workspace.append(overlay);
 let options=initial,destroyed=false;
 const handed=new WeakSet<Event>();
 const hide=()=>{overlay.hidden=true;};
 const receive=async(files:File[])=>{hide();return options.onFiles(files);};
 const mounted=mountFileDropzone(overlay,{...options,label:options.label||'Drop to add files',description:options.description||'',onFiles:receive});
 // Show the drop highlight only while the pointer is over this workspace and not
 // over a drop area of its own (an empty folder's dashed drop area, which lights
 // up itself), judged by what is under the pointer apart from the highlight.
 const enter=(event:DragEvent)=>{
  if(destroyed||options.disabled||!carriesFiles(event))return;
  const under=document.elementsFromPoint(event.clientX,event.clientY).find(node=>!overlay.contains(node));
  const ours=!!under&&workspace.contains(under)&&!under.closest('.kibo-file-drop-target');
  overlay.hidden=!ours;
 };
 const allow=(event:DragEvent)=>{
  if(destroyed||options.disabled||!carriesFiles(event))return;
  event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';
 };
 // A drop no drop area took (the highlight's margin, a row, the toolbar) is the same drop on the workspace's Dropzone.
 const land=(event:DragEvent)=>{
  if(destroyed||options.disabled||handed.has(event)||event.defaultPrevented||!carriesFiles(event))return;
  const target=overlay.querySelector('.kibo-file-drop-target');if(!target)return;
  event.preventDefault();event.stopPropagation();
  const same=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:event.dataTransfer,clientX:event.clientX,clientY:event.clientY});
  handed.add(same);target.dispatchEvent(same);
 };
 const leave=(event:DragEvent)=>{if(!event.relatedTarget&&(event.clientX<=0||event.clientY<=0||event.clientX>=innerWidth||event.clientY>=innerHeight))hide();};
 const drop=()=>queueMicrotask(hide),key=(event:KeyboardEvent)=>{if(event.key==='Escape')hide();};
 workspace.addEventListener('dragover',allow);workspace.addEventListener('drop',land);
 document.addEventListener('dragenter',enter,true);document.addEventListener('dragover',enter,true);document.addEventListener('dragleave',leave,true);document.addEventListener('drop',drop,true);document.addEventListener('dragend',hide,true);document.addEventListener('keydown',key,true);window.addEventListener('blur',hide);
 return {open:mounted.open,update:(changes:Partial<FileDropzoneOptions>)=>{options={...options,...changes};mounted.update({...options,onFiles:receive});if(options.disabled)hide();},destroy:()=>{if(destroyed)return;destroyed=true;workspace.removeEventListener('dragover',allow);workspace.removeEventListener('drop',land);document.removeEventListener('dragenter',enter,true);document.removeEventListener('dragover',enter,true);document.removeEventListener('dragleave',leave,true);document.removeEventListener('drop',drop,true);document.removeEventListener('dragend',hide,true);document.removeEventListener('keydown',key,true);window.removeEventListener('blur',hide);mounted.destroy();overlay.remove();workspace.classList.remove('kibo-file-drop-workspace');delete workspace.dataset.acceptsExternalFiles;}};
}
