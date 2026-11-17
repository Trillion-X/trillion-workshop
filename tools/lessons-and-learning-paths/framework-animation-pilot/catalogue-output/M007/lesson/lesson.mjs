/*!
Bundled Anatomy geometry license:
MIT License

Copyright (c) 2026 Ryan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import React, { useMemo, useState } from 'react';
import { AnatomyFigure, Button, Container, Input, Text, Textarea, TuningSliderField, mountReactSurface } from '@trillion/ui';
import content from './lesson-content.json';
import { useLessonPractice } from '../../../../../ui/show/isolated-module-surface/use-lesson-practice.mjs';
import { renderContext } from '../../../anatomy-contact-replacement/context-model.mjs';
import { courtSequence } from '../film/court-sequence.mjs';
import voice from '../voice/timeline.json' with { type: 'json' };
import { RACKET_MATERIAL_CSS } from '../../../../../screen-look/show/anatomy/racket-materials.mjs';

const h = React.createElement;
const fields = ['prediction','observation','revision'];
const start = { movement:{x:87.25,y:-205,reach:0,late:0,shotTime:.5,farX:-30}, technique:{x:38,y:-205,reach:0,late:0,shotTime:.5,farX:-30}, reading:{x:38,y:-205,reach:0,late:0,shotTime:1/3,farX:-30} };
const controlLimits = { movement:{x:[-20,120],reach:[0,1]}, technique:{late:[-1,1]}, reading:{farX:[-110,110],shotTime:[0,1]} };
const restorePractice = transfer => {
  try {
    const saved=typeof transfer==='string'?JSON.parse(transfer):transfer;
    if(!saved||typeof saved!=='object'||Array.isArray(saved)||!Object.hasOwn(start,saved.scenario))return null;
    const scenario=saved.scenario,defaults=start[scenario],restored={...defaults};
    const provided=saved.controls;
    if(provided&&typeof provided==='object'&&!Array.isArray(provided)) for(const [key,[min,max]] of Object.entries(controlLimits[scenario])) {
      const value=provided[key];
      if(Number.isFinite(value)&&value>=min&&value<=max)restored[key]=value;
    }
    return {scenario,controls:restored};
  } catch { return null; }
};

function Lesson({ surfaceInput, host }) {
  const [scenario, setScenario] = useState('movement');
  const [controls, setControls] = useState(start);
  const [showSequence, setShowSequence] = useState(false);
  const practiceState = useLessonPractice({host,surfaceInput,fields,messages:content.feedback,requestPrefix:'m007-practice',
    onRestore:record=>{
      const savedPractice=restorePractice(record.transfer);
      if(savedPractice){setScenario(savedPractice.scenario);setControls(previous=>({...previous,[savedPractice.scenario]:savedPractice.controls}));}
    },
  });
  const answers = practiceState.values;
  const values = controls[scenario];
  const sequenceTime = scenario==='movement' ? 3.52 : scenario==='technique' ? 58.72 : 21.29+values.shotTime*3.27;
  const sequenceIndex = scenario==='reading' ? 1 : scenario==='technique' ? 3 : 0;
  const baseSequence = useMemo(() => courtSequence(sequenceTime,sequenceIndex,voice),[sequenceTime,sequenceIndex]);
  const input = useMemo(() => {
    const near={...baseSequence.courtState.near,x:values.x,y:values.y,reach:values.reach};
    if(scenario==='technique')near.swingPhase+=values.late;
    return {...baseSequence,courtState:{...baseSequence.courtState,near,far:{...baseSequence.courtState.far,x:values.farX}}};
  },[baseSequence,values,scenario]);
  const practice = useMemo(() => renderContext(input),[input]);
  const fixedContact = useMemo(() => renderContext(courtSequence(3.52,0,voice)),[]);
  const contactDistance = Math.abs(practice.state.contactOffsetPx);
  const update = action => { if(!practiceState.locked){practiceState.markEdited();action();} };
  const change = (key,value) => update(()=>setControls(previous=>({...previous,[scenario]:{...previous[scenario],[key]:value}})));
  const save = () => practiceState.save({transfer:JSON.stringify({scenario,controls:values})});
  const radio=(text)=>h(Button,{key:text,disabled:practiceState.locked,variant:answers.prediction===text?'primary':'secondary','aria-pressed':answers.prediction===text,onClick:()=>practiceState.setValue('prediction',text)},text);
  const field=(key,label)=>h(Textarea,{key,label,value:answers[key],rows:3,disabled:practiceState.locked,onChange:event=>practiceState.setValue(key,event.target.value)});
  const slider=props=>h(Container,{key:props.key,gap:'xs'},h(Text,{as:'p'},props.label),h(TuningSliderField,props));
  const sliders = practiceState.locked ? [] : scenario==='movement'
    ? [slider({key:'x',label:content.labels.position,value:values.x,min:-20,max:120,step:.25,onChange:value=>change('x',value)}),slider({key:'reach',label:content.labels.reach,value:values.reach,min:0,max:1,step:.01,onChange:value=>change('reach',value)})]
    : scenario==='technique'
      ? [slider({key:'late',label:content.labels.timing,value:values.late,min:-1,max:1,step:.01,onChange:value=>change('late',value)})]
      : [slider({key:'exchange',label:content.labels.exchange,value:Math.round(values.shotTime*100),min:0,max:100,step:1,unit:'%',onChange:value=>change('shotTime',value/100)}),slider({key:'opponent',label:content.labels.opponent,value:values.farX,min:-110,max:110,step:1,onChange:value=>change('farX',value)})];
  const sequence = courtSequence(3.52,0,voice);
  const sequenceFigure = renderContext(sequence);
  return h(Container,{as:'main',className:'anatomy-lesson',maxWidth:'4xl',marginX:'auto',padding:'lg',gap:'xl','data-source-course':surfaceInput.course_id??''},
    h(Container,{className:'anatomy-lesson__opening',gap:'sm'},h(Text,{as:'h1',variant:'heading-xl'},content.title),h('p',null,content.opening)),
    h(Container,{gap:'lg'},
      h('div',{className:'anatomy-lesson__figure'},h(AnatomyFigure,{figure:practice,className:'anatomy-figure--contained',label:content.accessibility.figure,appearanceCss:RACKET_MATERIAL_CSS,viewport:[-80,-100,2080,1320]})),
      h(Container,{className:'anatomy-lesson__controls',gap:'md'},h(Text,{as:'h2',variant:'heading-lg'},content.labels.practice),h('p',null,content.prompt),
        h('div',{className:'anatomy-lesson-choices',role:'group','aria-label':content.accessibility.scenario},...content.scenarios.map(item=>h(Button,{key:item.id,disabled:practiceState.locked,variant:scenario===item.id?'primary':'secondary','aria-pressed':scenario===item.id,onClick:()=>update(()=>setScenario(item.id))},item.label))),
        h('p',null,content.scenarios.find(item=>item.id===scenario).description),practiceState.locked?h('p',null,content.feedback.retryPending):null,...sliders,
        scenario!=='reading'?h('p',{role:'status','aria-live':'polite'},`${content.feedback.separation} ${content.labels.distance}: ${contactDistance.toFixed(1)} ${content.labels.distanceUnit}.`):null,
        scenario==='movement'?h('p',null,`${content.examples[0].description} ${content.feedback.movementBaseline.replace('{distance}',`${Math.abs(fixedContact.state.contactOffsetPx).toFixed(1)} ${content.labels.distanceUnit}`)}`):null,
        scenario==='technique'?h('p',null,content.examples[1].description):null,
        h(Container,{layout:'horizontal',wrap:'wrap',gap:'sm',role:'group','aria-label':content.accessibility.prediction},...content.options.predictions.map(radio)),
        h(Input,{label:content.labels.prediction,value:answers.prediction,disabled:practiceState.locked,onChange:event=>practiceState.setValue('prediction',event.target.value)}),
        field('observation',content.labels.observation),field('revision',content.labels.revision),
        h(Button,{variant:'primary',work:null,disabled:practiceState.saving||practiceState.loading,'aria-label':content.accessibility.save,onClick:save},practiceState.saving?content.labels.busy:content.labels.keep),
        practiceState.status?h('p',{role:'status','aria-live':'polite'},practiceState.status):null)),
    h(Container,{gap:'sm'},h(Text,{as:'h2',variant:'heading-lg'},content.labels.capacities),...content.capacities.map(row=>h('p',{key:row.name},h('strong',null,`${row.name}. `),row.description))),
    h(Container,{gap:'sm'},h(Text,{as:'h2',variant:'heading-lg'},content.labels.loop),...content.loop.map((step,index)=>h('p',{key:step},`${index+1}. ${step}`)),
      h(Text,{as:'h2',variant:'heading-md'},content.labels.reading),h('p',null,content.readingCopy),
      h(Button,{variant:'secondary','aria-pressed':showSequence,onClick:()=>setShowSequence(value=>!value)},content.labels.film),
      showSequence?h('div',null,h('div',{className:'anatomy-lesson__figure'},h(AnatomyFigure,{figure:sequenceFigure,className:'anatomy-figure--contained',label:content.accessibility.figure,appearanceCss:RACKET_MATERIAL_CSS,viewport:[-80,-100,2080,1320]})),h('p',null,content.feedback.film)):null)
  );
}

export function mount(element,{surfaceInput,host}) { return mountReactSurface(element,h(Lesson,{surfaceInput,host})); }
