import React from 'react';
import {mountSharedContent} from '../coss/workspace-controls';
import {ColorPicker} from './source/packages/react/src/components/ui/ColorPicker';

/** Bridge the upstream picker into existing imperative forms and shared root cleanup. */
export function mountColorPicker(node:HTMLElement,{id,label='Color',value='#746b84',disabled=false,onChange}:{id:string,label?:string,value?:string,disabled?:boolean,onChange?:(color:string)=>void}){
  let current=value;
  node.classList.add('balsa-color-field');
  mountSharedContent(node,<ColorPicker id={id} label={label} accessibleLabel={label} defaultValue={value} disabled={disabled} contained onValueChange={color=>{current=color;onChange?.(color);}}/>);
  return {getValue:()=>current};
}
