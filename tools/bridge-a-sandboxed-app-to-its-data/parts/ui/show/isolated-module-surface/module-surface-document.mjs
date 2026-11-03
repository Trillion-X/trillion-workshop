// The HTML sink for an untrusted saved screen. Its browsing context has an
// opaque origin, a narrow CSP and a single transferred request capability.
import { moduleSurfaceImportMap } from './module-surface-requests.mjs';

const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The most calls and media leases one saved screen may have waiting at once.
export const MOST_PENDING_REQUESTS = 32;

/** Keep only the page's named look attributes and bounded, plain custom properties. */
export function checkedLook(look) {
  if (!look || typeof look !== 'object' || Array.isArray(look)) return null;
  const attributes = {}, variables = {};
  for (const name of ['data-theme', 'data-screen-look-theme', 'data-look-scheme']) {
    const value = look.attributes?.[name];
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)) attributes[name] = value;
  }
  let kept = 0;
  for (const [name, value] of Object.entries(look.variables ?? {})) {
    if (kept >= 400) break;
    if (/^--[A-Za-z0-9-]{1,80}$/.test(name) && typeof value === 'string' && value.length <= 400 && !/[<>{};]/.test(value)) {
      variables[name] = value;
      kept += 1;
    }
  }
  return { attributes, variables };
}

export function moduleSurfaceDocument({ moduleUrl, importMap, nonce, serviceOrigin, stylesheetUrl = null }) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('A screen could not open.');
  const module = new URL(moduleUrl);
  const origin = new URL(serviceOrigin).origin;
  if (module.origin !== origin || !(module.pathname.startsWith('/workshop/modules/') || module.pathname.startsWith('/workspace/'))) throw new Error('A screen could not open.');
  const stylesheet = stylesheetUrl ? new URL(stylesheetUrl, origin) : null;
  if (stylesheet && (stylesheet.origin !== origin || !stylesheet.pathname.startsWith('/workspace/') || !stylesheet.pathname.endsWith('.css') || stylesheet.search || stylesheet.hash)) throw new Error('A screen could not open.');
  const policy = [
    "default-src 'none'", `script-src 'nonce-${nonce}' ${origin}/workspace/ ${origin}/workshop/modules/`,
    `style-src 'unsafe-inline' ${origin}/workspace/`, `img-src data: blob: ${origin}/namespace/bytes/`, "connect-src 'none'", `font-src ${origin}/workspace/`,
    `media-src ${origin}/namespace/bytes/`, "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'",
  ].join('; ');
  const imports = json(moduleSurfaceImportMap({ import_map: importMap }, origin));
  const bootstrap = `(()=>{
    const host=document.getElementById('host');
    let port=null,dispose=null,update=null,surfaceInput={},callId=0,closed=false,inputVersion=0,observer=null;
    let updateQueue=Promise.resolve(),resolveMounted;
    const mountedReady=new Promise(resolve=>{resolveMounted=resolve;});
    const pending=new Map();
    const say=m=>port&&port.postMessage(m);
    const checkedLook=(${checkedLook.toString()});
    const applyLook=given=>{
      const look=checkedLook(given);if(!look)return;
      const root=document.documentElement;
      for(const name of ['data-theme','data-screen-look-theme','data-look-scheme']){if(look.attributes[name])root.setAttribute(name,look.attributes[name]);else root.removeAttribute(name);}
      for(let i=root.style.length-1;i>=0;i--){const name=root.style[i];if(name.startsWith('--'))root.style.removeProperty(name);}
      for(const [name,value] of Object.entries(look.variables))root.style.setProperty(name,value);
      if(document.body){if(look.variables['--bg-primary'])document.body.style.setProperty('background-color',look.variables['--bg-primary']);else document.body.style.removeProperty('background-color');}
      let sizes=document.getElementById('look-type-sizes');
      if(!sizes){sizes=document.createElement('style');sizes.id='look-type-sizes';document.head.append(sizes);}
      sizes.textContent=Object.keys(look.variables).filter(name=>/^--font-size-[a-z0-9-]+$/.test(name)).sort().map(name=>'[class~="text-[length:var('+name+')]"]{font-size:var('+name+')}').join(' ');
    };
    const fail=()=>say({type:'failure'});
    const enqueueUpdate=(input,id)=>{
      updateQueue=updateQueue.catch(()=>{}).then(async()=>{
        await mountedReady;
        if(closed)return;
        if(typeof update!=='function'){say({type:'update-refused',id});return;}
        const accepted=await update({surfaceInput:input});
        say({type:accepted===false?'update-refused':'update-accepted',id});
      }).catch(()=>{say({type:'update-refused',id});});
      return updateQueue;
    };
    window.addEventListener('message',async function start(e){
      if(e.source!==parent||e.data?.type!=='trillion-module-surface:init'||e.ports.length!==1)return;
      window.removeEventListener('message',start);
      port=e.ports[0];
      surfaceInput=e.data.surfaceInput&&typeof e.data.surfaceInput==='object'?e.data.surfaceInput:{};
      applyLook(e.data.look);
      const initialUpdateId=typeof e.data.inputUpdateId==='string'?e.data.inputUpdateId:null;
      port.onmessage=async ev=>{
        const m=ev.data;
        if(!m||typeof m!=='object')return;
        if(m.type==='response'||m.type==='media-response'){
          const p=pending.get(m.id);if(!p)return;pending.delete(m.id);
          if(m.ok){p.resolve(m.value);return;}
          const task=m.type==='response'?m.taskOutcome:null;
          const value=task?.task;
          const states=new Set(['working','scheduled','waiting','failed','cancelled','unknown']);
          const effects=new Set(['dispatching','unknown','rejected','succeeded']);
          if(task?.type==='resource-task-outcome'&&value&&typeof value==='object'&&!Array.isArray(value)
            &&typeof value.task_id==='string'&&value.task_id.trim()&&value.task_id.length<=200
            &&typeof value.request_key==='string'&&value.request_key.trim()&&value.request_key.length<=200
            &&states.has(value.state)&&(!('effect_state'in value)||effects.has(value.effect_state))){
            const error=new Error('The resource action has not completed. Keep its request key to recover its status.');
            error.name='ResourceTaskOutcomeError';error.code='resource_task_outcome';
            error.task=Object.freeze({task_id:value.task_id,request_key:value.request_key,state:value.state,...(effects.has(value.effect_state)?{effect_state:value.effect_state}:{})});
            p.reject(error);return;
          }
          p.reject(new Error('This request could not be completed.'));
        }else if(m.type==='look'){
          applyLook(m.look);
        }else if(m.type==='update'){
          inputVersion++;
          surfaceInput=m.surfaceInput&&typeof m.surfaceInput==='object'?m.surfaceInput:{};
          if(typeof m.id==='string')void enqueueUpdate(surfaceInput,m.id);
        }else if(m.type==='dispose'){
          closed=true;observer?.disconnect();
          for(const p of pending.values())p.reject(new Error('This screen is closed.'));
          pending.clear();try{await dispose?.()}catch{}port.close();port=null;
        }
      };
      port.start?.();
      try{
        const mod=await import(${json(module.href)});
        if(typeof mod.mount!=='function')throw new Error();
        const api={call:(name,input={})=>new Promise((resolve,reject)=>{
          if(pending.size>=${MOST_PENDING_REQUESTS})return reject(new Error('This screen has too many requests waiting.'));
          const id=String(++callId);pending.set(id,{resolve,reject});say({type:'call',id,name,input});
        }),mediaUrl:identity=>new Promise((resolve,reject)=>{
          if(pending.size>=${MOST_PENDING_REQUESTS})return reject(new Error('This screen has too many requests waiting.'));
          const id=String(++callId);pending.set(id,{resolve,reject});say({type:'media',id,identity});
        })};
        const mounted=await mod.mount(host,{surfaceInput,host:api});
        dispose=typeof mounted==='function'?mounted:mounted?.unmount||null;
        update=typeof mounted==='function'?mounted.update:mounted?.update;
        resolveMounted();
        if(closed){await dispose?.();return;}
        if(initialUpdateId)say({type:'update-accepted',id:initialUpdateId});
        let lastHeight=0;
        const measure=()=>{
          const height=Math.ceil(Math.max(host.getBoundingClientRect().bottom,host.scrollHeight));
          if(height!==lastHeight){lastHeight=height;say({type:'size',height});}
        };
        observer=new ResizeObserver(measure);observer.observe(host);measure();say({type:'ready'});
      }catch{resolveMounted();fail();}
    },{once:false});
  })();`;
  const inner = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${attr(policy)}"><title>Tool screen</title>${stylesheet ? `<link rel="stylesheet" href="${attr(stylesheet.href)}">` : ''}<script type="importmap" nonce="${nonce}">${imports}</script></head><body class="screen-look-page" style="margin:0"><div id="host"></div><script type="module" nonce="${nonce}">${bootstrap}</script></body></html>`;
  // A script-only sandbox still permits its own navigation. This trusted outer frame restricts its child to
  // about: documents, so a generated screen cannot put a granted private value in an outbound navigation URL.
  // Separate opaque origins also keep the screen from editing this policy or touching its parent document.
  const outerPolicy = `default-src 'none'; frame-src about:; script-src 'nonce-${nonce}' ${origin}/workspace/ ${origin}/workshop/modules/; style-src 'unsafe-inline' ${origin}/workspace/; img-src data: blob: ${origin}/namespace/bytes/; media-src ${origin}/namespace/bytes/; font-src ${origin}/workspace/; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`;
  const relay = `window.addEventListener('message',function init(e){if(e.source!==parent||e.data?.type!=='trillion-module-surface:init'||e.ports.length!==1)return;window.removeEventListener('message',init);document.getElementById('screen').contentWindow.postMessage(e.data,'*',e.ports);});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr(outerPolicy)}"><title>Tool screen</title></head><body style="margin:0"><iframe id="screen" title="Tool screen" sandbox="allow-scripts" srcdoc="${attr(inner)}" style="display:block;width:100%;height:100vh;border:0"></iframe><script nonce="${nonce}">${relay}</script></body></html>`;
}
