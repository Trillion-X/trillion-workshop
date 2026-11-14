// DOM adaptation of BeautifulUI ChatComposer (MIT, Shane Levine, 2026).
// Source: slev12397/beautiful-ui@ff0f74d62d8be9d89bcb735b3632e31a6ccf88dc.
// Real submit/state remain consumer-owned; no scripted messages or demo timers.
export function enhanceComposer(form){
  if(!form||form.dataset.composerBound)return;form.dataset.composerBound='true';form.classList.add('bui-composer');
  const input=form.querySelector('textarea');if(!input)return;
  const resize=()=>{input.style.height='auto';input.style.height=Math.min(160,Math.max(42,input.scrollHeight))+'px';};
  input.addEventListener('input',resize);input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit();}});resize();
}
