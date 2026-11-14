import { createSignal } from 'solid-js';
import { render, delegateEvents, clearDelegatedEvents } from 'solid-js/web';
import { Slider, SliderTrack, SliderFill, SliderThumb, SliderGroup, SliderLabel } from './source/slider';

export interface RangeSliderOptions {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  label: string;
  onChange?: (value: [number, number]) => void;
  disabled?: boolean;
  minStepsBetweenThumbs?: number;
}
export interface RangeSliderMount {
  update: (options: Partial<RangeSliderOptions>) => void;
  dispose: () => void;
}
const mounts = new WeakMap<HTMLElement, RangeSliderMount>();
function checked(options: RangeSliderOptions): RangeSliderOptions {
  const {min,max,step,value,label,onChange}=options;
  if (![min,max,step].every(Number.isFinite) || max<=min || step<=0 || step>max-min)
    throw new TypeError('Choose a valid range and a positive step.');
  if (!Array.isArray(value) || value.length!==2 || !value.every(Number.isFinite) || value[0]<min || value[1]>max || value[0]>value[1])
    throw new TypeError('Choose a start and end inside the range.');
  if (typeof label!=='string' || !label.trim() || (onChange!==undefined && typeof onChange!=='function'))
    throw new TypeError('Provide a label and a valid change callback.');
  const separation=options.minStepsBetweenThumbs??0;
  if (!Number.isInteger(separation) || separation<0 || value[1]-value[0]+Number.EPSILON<separation*step)
    throw new TypeError('Choose a range with enough space between its handles.');
  return {...options,value:[...value] as [number,number]};
}
export function mountRangeSlider(node: HTMLElement, options: RangeSliderOptions): RangeSliderMount {
  const initial=checked(options);
  mounts.get(node)?.dispose();
  const [state,setState]=createSignal(initial);
  let disposed=false;
  // Solid's documented delegation target accepts EventTarget at runtime.
  // Dispatch inside this island before a surrounding dialog stops arrow keys.
  delegateEvents(['keydown'],node as unknown as Document);
  const stopHandledKey=(event:KeyboardEvent)=>{if(event.defaultPrevented)event.stopPropagation();};
  node.addEventListener('keydown',stopHandledKey);
  const unmount=render(() => <div class="diffusion-range">
    <Slider minValue={state().min} maxValue={state().max} step={state().step}
      value={state().value} disabled={state().disabled} minStepsBetweenThumbs={state().minStepsBetweenThumbs??0}
      onChange={values=>{
        if(disposed)return;
        const value:[number,number]=[values[0],values[1]];
        const callback=state().onChange;
        setState(previous=>({...previous,value}));
        callback?.([...value]);
      }}>
      <SliderGroup><SliderLabel>{state().label}</SliderLabel><output aria-live="off">{state().value.join(' – ')}</output></SliderGroup>
      <SliderTrack><SliderFill/><SliderThumb aria-label={state().label+' start'}/><SliderThumb aria-label={state().label+' end'}/></SliderTrack>
    </Slider>
  </div>,node);
  const control:RangeSliderMount={
    update(patch){if(disposed)throw new Error('This range control has been closed.');setState(checked({...state(),...patch}));},
    dispose(){if(disposed)return;disposed=true;node.removeEventListener('keydown',stopHandledKey);clearDelegatedEvents(node as unknown as Document);unmount();if(mounts.get(node)===control)mounts.delete(node);},
  };
  mounts.set(node,control);
  return control;
}
