// Shared HTML/control owner for a standalone explanatory figure, rendered from caller copy.
import { plateHtml, iso } from './iso-kit.mjs';
import { ISO_CSS } from '../../../screen-look/show/anatomy/iso-style.mjs';
import { EXPLAINER_CSS } from '../../../screen-look/show/anatomy/explainer-style.mjs';
import { escapeHtml as esc } from '../server-rendered-page/escape-html.mjs';
export function explainerScript(data, machine) {
 const P=machine.projection,origin=iso([0,0,0],P),px=iso([1,0,0],P),pz=iso([0,0,1],P);
 const vx=px.map((n,i)=>n-origin[i]),vz=pz.map((n,i)=>n-origin[i]);
 const runtime={phases:data.phases,example:data.example,vx,vz};
 return `const model=${JSON.stringify(runtime).replace(/</g,'\\u003c')};\n${EXPLAINER_RUNTIME}`;
}
export function explainerPage(data, machine) {
 const fields=(record,allowed,path)=>{
  if(!record||typeof record!=='object'||Array.isArray(record))throw new TypeError(`${path} must be an object`);
  const extra=Object.keys(record).filter(key=>!allowed.includes(key));
  if(extra.length)throw new TypeError(`Unsupported ${path} fields: ${extra.join(', ')}`);
 };
 fields(data,['title','description','headline','phases','example','sections'],'explainer');
 fields(data.example,['title','steps'],'example');
 data.phases.forEach(phase=>fields(phase,['short','title','copy'],'phase'));
 data.sections.forEach(section=>fields(section,['title','copy'],'section'));
 const controls=data.phases.map((phase,i)=>`<button type="button" data-phase="${i}" aria-pressed="${i===0}" tabindex="${i===0?0:-1}"><span>${String(i+1).padStart(2,'0')}</span>${esc(phase.short)}</button>`).join('');
 const card=plateHtml({body:machine.svg});
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${esc(data.description)}"><title>${esc(data.title)}</title><style>${ISO_CSS}\n${EXPLAINER_CSS}</style></head><body class="iso" data-theme="dark"><main><header><a href="https://app.gettrillion.ai" aria-label="Open Trillion">Trillion</a><div class="controls"><button type="button" data-play aria-pressed="true">Pause tour</button><button type="button" data-theme-switch aria-pressed="false">Light</button></div></header><h1>${esc(data.headline)}</h1><div class="layout">${card}<aside class="side"><div class="stage-choices" role="group" aria-label="Explore how Trillion works">${controls}</div><div class="copy"><h2 data-phase-title>${esc(data.phases[0].title)}</h2><p data-phase-copy>${esc(data.phases[0].copy)}</p></div><div class="example"><strong>${esc(data.example.title)}</strong><p data-example>${esc(data.example.steps[0])}</p></div></aside></div><div class="explain">${data.sections.map(s=>`<section><h2>${esc(s.title)}</h2><p>${esc(s.copy)}</p></section>`).join('')}</div><footer><!-- Anatomy by Ryan, MIT. License: ./LICENSE.txt --><a href="https://app.gettrillion.ai">Open Trillion ↗</a></footer><p class="sr" aria-live="polite" data-announcement></p></main><script type="module" src="./figure.js"></script></body></html>`;
}
export const EXPLAINER_RUNTIME=`
const phases=[...document.querySelectorAll('button[data-phase]')];
const play=document.querySelector('[data-play]'),theme=document.querySelector('[data-theme-switch]');
const picker=document.querySelector('[data-picker]'),selected=document.querySelector('[data-selected]'),stamp=document.querySelector('[data-stamp]');
const title=document.querySelector('[data-phase-title]'),copy=document.querySelector('[data-phase-copy]'),example=document.querySelector('[data-example]'),announcement=document.querySelector('[data-announcement]');
const calm=matchMedia('(prefers-reduced-motion: reduce)');
let index=0,playing=!calm.matches,visible=true,hover=false,focused=false,last=0,elapsed=0,x=0,cardX=0,z=0,request=0;
function status(){play.textContent=playing?'Pause tour':'Play tour';play.setAttribute('aria-pressed',String(playing));}
function choose(i,announce=true){index=(i+model.phases.length)%model.phases.length;elapsed=0;const phase=model.phases[index];title.textContent=phase.title;copy.textContent=phase.copy;example.textContent=model.example.steps[index];document.body.dataset.phase=String(index);phases.forEach((b,n)=>{b.setAttribute('aria-pressed',String(n===index));b.tabIndex=n===index?0:-1;});if(announce)announcement.textContent=phase.title+'. '+phase.copy;kick();}
function paint(){picker.setAttribute('transform','translate('+(x*model.vx[0])+' '+(x*model.vx[1])+')');selected.setAttribute('transform','translate('+(cardX*model.vx[0])+' '+(cardX*model.vx[1])+')');stamp.setAttribute('transform','translate('+(z*model.vz[0])+' '+(z*model.vz[1])+')');}
function frame(now){request=0;const dt=Math.min((now-last)/1000,.05);last=now;const touring=playing&&visible&&!hover&&!focused&&!document.hidden&&!calm.matches;if(touring){elapsed+=dt;if(elapsed>=6)choose(index+1);}const target=[0,85,170,250][index];const blend=calm.matches?1:1-Math.exp(-dt/.25);cardX+=(target-cardX)*blend;const tx=index===3&&(cardX>249.7||calm.matches)?215:target;const tz=index===3&&(x<216&&cardX>249.7||calm.matches)?-15:0;x+=(tx-x)*blend;z+=(tz-z)*blend;paint();if(visible&&!document.hidden&&(touring||Math.abs(target-cardX)>.02||Math.abs(tx-x)>.02||Math.abs(tz-z)>.02))kick();else last=0;}
function kick(){if(!request&&visible&&!document.hidden){if(!last)last=performance.now();request=requestAnimationFrame(frame);}}
function hold(){playing=false;status();}
phases.forEach((b,i)=>{b.addEventListener('click',()=>{hold();choose(i);});b.addEventListener('keydown',event=>{if(['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();hold();choose(event.key==='Home'?0:event.key==='End'?3:index+(event.key==='ArrowRight'||event.key==='ArrowDown'?1:-1));phases[index].focus();}});});
play.addEventListener('click',()=>{playing=!playing;status();kick();});theme.addEventListener('click',()=>{const light=document.body.dataset.theme!=='light';document.body.dataset.theme=light?'light':'dark';theme.textContent=light?'Dark':'Light';theme.setAttribute('aria-pressed',String(light));});
const figure=document.querySelector('.iso-figure');figure.addEventListener('pointerenter',()=>hover=true);figure.addEventListener('pointerleave',()=>{hover=false;kick();});document.querySelector('.side').addEventListener('focusin',()=>focused=true);document.querySelector('.side').addEventListener('focusout',event=>{if(!event.currentTarget.contains(event.relatedTarget)){focused=false;kick();}});
document.addEventListener('keydown',event=>{if(event.code==='Space'&&event.target===document.body){event.preventDefault();playing=!playing;status();kick();}});document.addEventListener('visibilitychange',kick);new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible)kick();}).observe(figure);calm.addEventListener('change',()=>{if(calm.matches)hold();kick();});status();choose(0,false);
`;
