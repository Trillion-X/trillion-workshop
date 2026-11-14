import { ISO_CSS } from '../../../screen-look/show/anatomy/iso-style.mjs';
import { SEQUENCE_CSS } from '../../../screen-look/show/anatomy/sequence-style.mjs';
import { escapeHtml as esc } from 'trillion-workshop/tools/write-a-post-for-each-place/read-data/escape-html.mjs';
export function sequencePage(options) {
 const extra = Object.keys(options).filter(key => !['title', 'layers', 'segments', 'scriptHref', 'stageHref', 'materialCss'].includes(key));
 if (extra.length) throw new TypeError(`Unsupported sequence fields: ${extra.join(', ')}`);
 const { title, layers, segments, scriptHref, stageHref, materialCss = '' } = options;
 if (typeof materialCss !== 'string' || /<|@import/i.test(materialCss) || /url\s*\(/i.test(materialCss.replace(/url\(\s*(['"]?)#[\w-]+\1\s*\)/gi,''))) throw new TypeError('Sequence appearance must be local CSS');
 if (new Set(layers.map(layer => layer.id)).size !== layers.length) throw new TypeError('Duplicate sequence layers');
 const identifier = value => { if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new TypeError('Invalid sequence layer'); return value; };
 const path = value => { if (typeof value !== 'string' || !/^\/?[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.js$/.test(value) || value.includes('..') || value.includes('//')) throw new TypeError('Invalid sequence script'); return esc(value); };
 const sizes = layers.map(layer => {
  identifier(layer.id);
  if (!layer.width && !layer.height) return '';
  if (![layer.width, layer.height].every(n => Number.isFinite(n) && n > 0 && n <= 16384)) throw new TypeError('Invalid native figure bounds');
  return `#${layer.id}{width:${layer.width}px;height:${layer.height}px}`;
 }).join('');
 const beats = segments.map(({ start, duration }, i) => {
  if (![start, duration].every(Number.isFinite) || start < 0 || duration <= 0) throw new TypeError('Invalid sequence interval');
  return `<section class="scene" data-start="${start}" data-dur="${duration}" aria-label="${esc(title)} ${i + 1}"></section>`;
 }).join('');
 const hosts = layers.map(layer => `<div id="${identifier(layer.id)}" class="figure-sequence__layer"${layer.width ? ' data-native' : ''}></div>`).join('');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><script src="${path(stageHref)}"></script><style>${ISO_CSS}\n${SEQUENCE_CSS}\n${materialCss}\n${sizes}</style></head><body class="iso" data-theme="light"><main class="stage figure-sequence">${beats}${hosts}</main><script src="${path(scriptHref)}"></script></body></html>`;
}
