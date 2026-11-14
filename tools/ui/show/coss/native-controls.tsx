// parts/ui/show/coss/native-controls.tsx
//
// Purpose
//   A native select or checkbox drawn as the shared one (`enhanceSelect`, `enhanceCheckbox`): the native element stays
//   the value, focus, label, form and event owner, and the shared control follows it. Kept apart from the other
//   control mounts in workspace-controls.tsx (which re-exports both), so decorating a panel's controls loads only these.
import React from 'react';
import {disposers,mountSharedContent as mount} from './shared-content';
import {Select,SelectTrigger,SelectValue,SelectPopup,SelectItem} from './ui/select';
import {Checkbox} from './ui/checkbox';

// The native select remains the form's single value owner. The source Select
// receives changes from events, option/disabled mutations and property writes.
export function enhanceSelect(select:HTMLSelectElement){
  if(select.dataset.selectBound||select.dataset.menuBound||select.multiple)return;
  select.dataset.selectBound='true';
  const host=document.createElement('span');host.className='coss-select-host';select.after(host);
  const label=select.getAttribute('aria-label')||[...select.labels||[]].map(l=>l.childNodes[0]?.textContent?.trim()).filter(Boolean).join(' ')||select.name;
  select.classList.add('coss-native-value');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  const descriptors=['value','selectedIndex'].map(key=>[key,Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,key)!] as const);
  let drawing=false;
  const render=()=>{if(drawing||!host.isConnected)return;drawing=true;
    const options=[...select.options].map(o=>({value:o.value,label:o.text,disabled:o.disabled||Boolean(o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled)}));
    mount(host,<Select value={select.value} items={options} disabled={select.disabled} onValueChange={value=>{
      if(value===null)return;descriptors[0][1].set!.call(select,value);select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));render();
    }}><SelectTrigger aria-label={label}><SelectValue/></SelectTrigger><SelectPopup portalProps={{className:'coss-ui'}} alignItemWithTrigger={false}>{options.map((o,i)=><SelectItem key={o.value+':'+i} value={o.value} disabled={o.disabled}>{o.label}</SelectItem>)}</SelectPopup></Select>);drawing=false;
  };
  for(const [key,descriptor] of descriptors)Object.defineProperty(select,key,{configurable:true,get(){return descriptor.get!.call(this);},set(value){descriptor.set!.call(this,value);render();}});
  const invalid=(event:Event)=>{event.preventDefault();host.querySelector<HTMLElement>('[role=combobox]')?.focus();host.querySelector('[role=combobox]')?.setAttribute('aria-invalid','true');};
  select.addEventListener('change',render);select.addEventListener('input',render);select.addEventListener('invalid',invalid);
  const reset=()=>queueMicrotask(render);select.form?.addEventListener('reset',reset);
  const observer=new MutationObserver(render);observer.observe(select,{childList:true,subtree:true,attributes:true,characterData:true});
  disposers.set(host,()=>{observer.disconnect();select.removeEventListener('change',render);select.removeEventListener('input',render);select.removeEventListener('invalid',invalid);select.form?.removeEventListener('reset',reset);for(const [key]of descriptors)delete (select as any)[key];});
  render();return host;
}

// Keep the native input as the focus, label, form and event owner. Coss owns
// its visible checkbox; the transparent native hit target preserves callers.
export function enhanceCheckbox(input:HTMLInputElement){
  // Licensed checkbox/switch roots already own their hidden form input and
  // visible control. Decorating that implementation input paints a second
  // control and moves nodes that the original React root still owns.
  if(input.closest('[data-slot="checkbox"],[data-slot="switch"],[role="checkbox"],[role="switch"]'))return;
  if(input.dataset.checkboxBound)return;input.dataset.checkboxBound='true';
  const wrapper=document.createElement('span'),host=document.createElement('span');
  wrapper.className='coss-native-checkbox';host.className='coss-checkbox-face';
  input.replaceWith(wrapper);wrapper.append(input,host);
  const descriptors=['checked','indeterminate'].map(key=>[key,Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,key)!] as const);
  const render=()=>{if(!host.isConnected)return;mount(host,<Checkbox checked={input.checked} indeterminate={input.indeterminate} disabled={input.disabled} readOnly tabIndex={-1} aria-hidden="true"/>);};
  for(const [key,descriptor]of descriptors)Object.defineProperty(input,key,{configurable:true,get(){return descriptor.get!.call(this);},set(value){descriptor.set!.call(this,value);render();}});
  input.addEventListener('change',render);input.addEventListener('input',render);
  const form=input.form,reset=()=>queueMicrotask(render);form?.addEventListener('reset',reset);
  const observer=new MutationObserver(render);observer.observe(input,{attributes:true});
  disposers.set(host,()=>{observer.disconnect();input.removeEventListener('change',render);input.removeEventListener('input',render);form?.removeEventListener('reset',reset);for(const [key]of descriptors)delete (input as any)[key];});
  render();
}
