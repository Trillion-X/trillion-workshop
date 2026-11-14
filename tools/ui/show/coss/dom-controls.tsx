import {beginMediaDrag} from '../selection/media-drag-session.mjs';
import {claimNode,releaseNode} from '../one-owner-per-node';
import {EmptyState} from '../empty-state';
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Input} from './ui/input';
import {Textarea} from './ui/textarea';
import {ScrollArea} from './ui/scroll-area';
import {Checkbox} from './ui/checkbox';
import {Button,buttonVariants,type ButtonProps} from './ui/button';
import {enhanceSelect,enhanceCheckbox} from './native-controls';
import {Copy} from 'lucide-react';
import {Table,TableHeader,TableBody,TableRow,TableHead,TableCell} from './ui/table';
import {StyleChoices,type StyleChoice} from '../style-choices';

type ButtonVariant=NonNullable<ButtonProps['variant']>;

// The shared look of four plain controls, drawn once when this module loads by the page's own renderer into a
// detached element: the server renderer is never shipped to the page for four fixed pieces of markup.
function staticMarkup(element:React.ReactElement){
  const host=document.createElement('div');const root=createRoot(host);
  flushSync(()=>root.render(element));
  const markup=host.innerHTML;root.unmount();return markup;
}
const inputMarkup=staticMarkup(<Input nativeInput/>);
const textareaMarkup=staticMarkup(<Textarea/>);
const copyMarkup=staticMarkup(<Copy size={16} aria-hidden="true"/>);
const tableMarkup=staticMarkup(<Table><TableHeader><TableRow><TableHead/></TableRow></TableHeader><TableBody><TableRow><TableCell/></TableRow></TableBody></Table>);
// No 'dialog' kind: a panel over the page opens through the shared floating
// panel owner (screen-arrangement openWorkPanel), never a native dialog element.
const interactiveKinds=new Set(['button','select','input','form','textarea']);

/**
 * Legacy imperative consumers describe controls with [[button]], [[input]],
 * [[select]], [[textarea]] and [[form]] tokens. The application
 * never emits native interactive HTML itself; this shared owner materializes
 * the semantic elements and then applies the shared Coss appearance.
 */
export function controlMarkup(source:string){
  return String(source??'').replace(/\[\[(\/)?(button|select|input|form|textarea)([^\]]*)\]\]/gi,(_match,closing,kind,attributes)=>closing?`</${String(kind).toLowerCase()}>`:`<${String(kind).toLowerCase()}${attributes}>`);
}

export function setControlMarkup(node:HTMLElement,source:string){
  node.innerHTML=controlMarkup(source);
  decorateControls(node);
  return node;
}

export function insertControlMarkup(node:HTMLElement,position:InsertPosition,source:string){
  node.insertAdjacentHTML(position,controlMarkup(source));
  decorateControls(node);
  return node;
}

export function createControl(kind:'button'|'select'|'input'|'form'|'textarea'){
  if(!interactiveKinds.has(kind))throw new Error(`Unsupported shared control: ${kind}`);
  return document.createElement(kind) as HTMLButtonElement|HTMLSelectElement|HTMLInputElement|HTMLFormElement|HTMLTextAreaElement;
}

function registerSharedControlElements(){
  if(typeof customElements==='undefined')return;
  for(const kind of interactiveKinds){
    const name=`coss-${kind}`;
    if(customElements.get(name))continue;
    customElements.define(name,class extends HTMLElement{
      connectedCallback(){
        const control=createControl(kind as 'button'|'select'|'input'|'form'|'textarea');
        for(const attribute of [...this.attributes])control.setAttribute(attribute.name,attribute.value);
        if(kind==='input'){
          // Inputs are void elements; their descriptor must never swallow the
          // following composition while the browser parses an HTML string.
        }else if(kind==='textarea'){
          (control as HTMLTextAreaElement).value=this.textContent||'';
          control.textContent=this.textContent||'';
        }else while(this.firstChild)control.append(this.firstChild);
        this.replaceWith(control);
      }
    });
  }
}
registerSharedControlElements();
export function decorateCopyButton(button:HTMLButtonElement,label:string){
  button.setAttribute('aria-label',label);button.title=label;
  button.innerHTML=copyMarkup;
  button.className=buttonVariants({variant:'ghost',size:'icon'});
  button.dataset.slot='button';
}
export function decorateControls(container:HTMLElement){
  container.classList.add('coss-ui');
  function decorate(){
    for(const input of container.querySelectorAll<HTMLInputElement>('input[type=checkbox]:not([data-checkbox-bound])'))if(!input.closest('[data-shared-root]')&&input.getAttribute('aria-hidden')!=='true')enhanceCheckbox(input);
    for(const table of container.querySelectorAll<HTMLTableElement>('table:not([data-slot])')){
      if(table.closest('[data-shared-root]'))continue;
      const template=document.createElement('template');template.innerHTML=tableMarkup;
      const wrapper=template.content.firstElementChild as HTMLElement,reference=wrapper.querySelector('table')!;
      for(const tag of ['table','thead','tbody','tr','th','td']){
        const sample=wrapper.querySelector(tag)!;
        for(const node of tag==='table'?[table]:table.querySelectorAll(tag)){
          node.classList.add(...sample.className.split(/\s+/));node.setAttribute('data-slot',sample.getAttribute('data-slot')!);
        }
      }
      table.replaceWith(wrapper);reference.replaceWith(table);
    }
    for(const select of container.querySelectorAll<HTMLSelectElement>('select:not([data-select-bound]):not([data-menu-bound])'))if(!select.closest('[data-shared-root]'))enhanceSelect(select);
    for(const button of container.querySelectorAll<HTMLButtonElement>('button:not([data-slot])')){
      if(button.closest('[data-shared-root]'))continue;
      // A caller names emphasis as DATA (data-variant="default" for the one
      // main action, "ghost" for a quiet one); the shared variant paints it.
      // Callers never restyle a decorated button with their own CSS.
      const variant=(button.dataset.variant as ButtonVariant|undefined)||(button.hasAttribute('data-read')?'ghost':button.getAttribute('type')==='submit'?'default':'outline');
      button.classList.add(...buttonVariants({variant}).split(/\s+/));button.dataset.slot='button';
    }
    for(const input of container.querySelectorAll<HTMLInputElement>('input:not([data-slot])')){
      if(input.closest('[data-shared-root]')||input.getAttribute('aria-hidden')==='true'||['checkbox','radio','hidden','range','file'].includes(input.type))continue;
      const template=document.createElement('template');template.innerHTML=inputMarkup;
      const wrapper=template.content.firstElementChild as HTMLElement,reference=wrapper.querySelector('input')!;
      input.classList.add(...reference.className.split(/\s+/));input.dataset.slot='input';
      input.replaceWith(wrapper);reference.replaceWith(input);
    }
    for(const input of container.querySelectorAll<HTMLTextAreaElement>('textarea:not([data-slot])')){
      if(input.closest('[data-shared-root]'))continue;
      const template=document.createElement('template');template.innerHTML=textareaMarkup;
      const wrapper=template.content.firstElementChild as HTMLElement,reference=wrapper.querySelector('textarea')!;
      input.classList.add(...reference.className.split(/\s+/));input.dataset.slot='textarea';
      input.replaceWith(wrapper);reference.replaceWith(input);
    }
  }
  decorate();
  const observer=new MutationObserver(decorate);observer.observe(container,{childList:true,subtree:true});
  return ()=>observer.disconnect();
}

// Adapter for imperative consumers. Focus, dismissal, portal and selection
// semantics belong to the licensed Coss/Base UI components, not the app.
export function mountTextReader(node:HTMLElement,{label='Text',text=''}={}){
  releaseNode(node);node.replaceChildren();
  node.classList.add('coss-ui','coss-text-reader');node.dataset.sharedRoot='true';
  const root=createRoot(node);let current=text,mounted=true;
  claimNode(node,()=>{mounted=false;root.unmount();});
  const draw=()=>flushSync(()=>root.render(<ScrollArea overscrollContain aria-label={label} role="region"><div className="coss-text-reader-content">{current}</div></ScrollArea>));
  draw();return {update:(value:string)=>{if(mounted&&value!==current){current=value;draw();}},destroy:()=>{if(mounted)releaseNode(node);}};
}

// `empty` says what nothing means here. There are two ways to have nothing: no
// items at all, and a search that matches none of them. The second one is the
// easier to miss, because the rows are all still there with hidden set on
// them, so the list keeps its wrapper and shows an empty box.
export function mountChoiceList(container:HTMLElement,{items,name,selected=[],label,heading,onChange,onActivate,searchable=true,selectAllLabel,dragType,onDragData,empty}:any){
  // Release before emptying, so a previous writer on this node tears down
  // while the DOM still matches what it rendered. Same hazard as the library
  // grid: a root that outlives its children throws on the next render.
  releaseNode(container);
  container.replaceChildren();container.classList.add('coss-ui');
  const root=createRoot(container);let chosen=new Set<string>(selected),updateSelection:(values:Set<string>)=>void=()=>{};
  claimNode(container,()=>root.unmount());
  function Choices(){const [query,setQuery]=useState(''),[values,setValues]=useState(chosen);updateSelection=setValues;
    const matches=(item:any)=>[item.label,item.detail].join(' ').toLowerCase().includes(query.toLowerCase());
    const showing=items.filter(matches).length;
    return <section className="coss-choices" aria-label={heading||label}>{heading&&<h3 className="coss-choice-list-title">{heading}</h3>}{searchable&&<Input type="search" aria-label={label} placeholder={label} value={query} onChange={e=>setQuery(e.target.value)}/>}
      {selectAllLabel&&<label className="coss-choice" data-control-row><Checkbox checked={items.length>0&&items.every((i:any)=>values.has(i.id))} indeterminate={values.size>0&&!items.every((i:any)=>values.has(i.id))} onCheckedChange={checked=>{const updated=new Set<string>(checked?items.map((i:any)=>i.id):[]);chosen=updated;setValues(updated);onChange?.([...updated]);}}/><span>{selectAllLabel}</span></label>}
      <div className="coss-choice-rows">{showing===0&&<EmptyState {...(query?{title:'Nothing matches that',action:'Clear the search',onAction:()=>setQuery('')}:(empty||{}))}/>}{items.map((item:any)=><label key={item.id} className="coss-choice" data-control-row draggable={Boolean(dragType&&onDragData)} onDragStart={event=>{if(!dragType||!onDragData)return;beginMediaDrag(event.dataTransfer,dragType,onDragData(item.id));}} hidden={!matches(item)}>
        {onActivate?<Button aria-label={item.label} variant={values.has(item.id)?'secondary':'ghost'} className="choice-insert" title={item.detail||undefined} onClick={()=>onActivate(item.id)}>{item.label}</Button>:<><Checkbox name={name} value={item.id} checked={values.has(item.id)} onCheckedChange={checked=>{const updated=new Set(values);checked?updated.add(item.id):updated.delete(item.id);chosen=updated;setValues(updated);onChange?.([...updated]);}}/>
        <span>{item.label}{item.detail&&<small>{item.detail}</small>}</span></>}
      </label>)}</div>
    </section>;
  }
  flushSync(()=>root.render(<Choices/>));
  return {selected:()=>[...chosen],setSelected:(ids:string[])=>{chosen=new Set(ids);flushSync(()=>updateSelection(chosen));onChange?.([...chosen]);},destroy:()=>releaseNode(container)};
}

// `single`: exactly one choice is on (choosing another moves it); otherwise
// each chip toggles. `variant` names an appearance screen-look draws
// (`.coss-choice-chips[data-variant=…]`), for example "segmented".
export function mountChoiceChips(container:HTMLElement,{items,selected=[],label,onChange,single=false,variant,wrap=false}:any){
  releaseNode(container);
  container.replaceChildren();container.classList.add('coss-ui');
  container.dataset.sharedRoot='true';
  const root=createRoot(container);let mounted=true,chosen=new Set<string>(selected),updateSelection:(values:Set<string>)=>void=()=>{};
  claimNode(container,()=>{mounted=false;root.unmount();});
  function Choices(){const [values,setValues]=useState(chosen);updateSelection=setValues;
    const toggle=(id:string)=>{if(single&&values.has(id))return;const updated=single?new Set([id]):new Set(values);if(!single)updated.has(id)?updated.delete(id):updated.add(id);chosen=updated;setValues(updated);onChange?.([...updated]);};
    return <fieldset className="coss-choice-chips" data-variant={variant||undefined} data-wrap={wrap||undefined}><legend>{label}</legend><div className="coss-choice-chip-row">{items.map((item:any)=><Button key={item.id} size="sm" variant="outline" aria-pressed={values.has(item.id)} data-pressed={values.has(item.id)?'':undefined} title={item.description||item.detail||undefined} onClick={()=>toggle(item.id)}>{item.label}</Button>)}</div></fieldset>;
  }
  flushSync(()=>root.render(<Choices/>));
  return {selected:()=>[...chosen],setSelected:(ids:string[])=>{if(!mounted)return;chosen=new Set(ids);flushSync(()=>updateSelection(chosen));onChange?.([...chosen]);},destroy:()=>{if(mounted)releaseNode(container);}};
}

// One choice among visual presets, each shown as a sample of its own result
// (caption styles, text looks, themes), mounted into an element: the shared
// StyleChoices control (../style-choices), holding the choice for the page.
export function mountStyleChoices(container:HTMLElement,{items,selected,label,onChange}:{items:StyleChoice[];selected?:string;label:string;onChange?:(id:string)=>void}){
  releaseNode(container);
  container.replaceChildren();container.classList.add('coss-ui');
  const root=createRoot(container);let chosen=selected,updateSelection:(id?:string)=>void=()=>{};
  claimNode(container,()=>root.unmount());
  function Choices(){const [value,setValue]=useState(chosen);updateSelection=setValue;
    return <StyleChoices items={items} value={value} label={label} onChange={id=>{chosen=id;setValue(id);onChange?.(id);}}/>;
  }
  flushSync(()=>root.render(<Choices/>));
  return {selected:()=>chosen,setSelected:(id:string)=>{chosen=id;flushSync(()=>updateSelection(id));},destroy:()=>releaseNode(container)};
}
