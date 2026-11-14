import { plateHtml, pageHtml } from './iso-kit.mjs';
import { escapeHtml as esc } from 'trillion-workshop/tools/write-a-post-for-each-place/read-data/escape-html.mjs';
import { CONTROLLED_FIGURE_CSS } from '../../../screen-look/show/anatomy/controlled-figure-style.mjs';

// The controls live beside the figure. Its body remains a single validated SVG.
export function controlledFigurePage(options) {
 const allowed=['title','svg','min','max','step','value','controlLabel','controlName','toggleLabel','script','materialCss','width'];
 if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Figure page options must be an object');
 const extra=Object.keys(options).filter(key=>!allowed.includes(key));
 if(extra.length)throw new TypeError(`Unsupported controlled figure fields: ${extra.join(', ')}`);
 const {title,svg,min,max,step,value,controlLabel,controlName,toggleLabel,script='',materialCss='',width=1100}=options;
 if(![min,max,step,value,width].every(Number.isFinite)||min>=max||step<=0||value<min||value>max||width<=0)throw new TypeError('Invalid figure control bounds');
 for(const text of [title,controlLabel,controlName,toggleLabel])if(typeof text!=='string'||!text.trim())throw new TypeError('Figure controls need names');
 if(typeof materialCss!=='string'||/<|@import/i.test(materialCss)||/url\s*\(/i.test(materialCss.replace(/url\(\s*(['"]?)#[\w-]+\1\s*\)/gi,'')))throw new TypeError('Figure appearance must be local CSS');
 const figure=plateHtml({body:svg});
 const controls=`<div class="object-controls"><label for="figure-time">${esc(controlLabel)}</label><input id="figure-time" data-time type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${esc(controlName)}"><button type="button" data-theme>${esc(toggleLabel)}</button></div>`;
 return pageHtml({title,theme:'light',width,body:`<style>${CONTROLLED_FIGURE_CSS}\n${materialCss}</style>${figure}${controls}`,script});
}
