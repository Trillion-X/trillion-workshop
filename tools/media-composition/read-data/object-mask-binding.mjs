import {createHash} from 'node:crypto';
import {objectMaskGeometry} from './object-mask-geometry.mjs';
export {objectMaskGeometry};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
export function objectMaskBinding({plan,aspect,framing_mode,visual_layers},sources){
 return createHash('sha256').update(JSON.stringify(stable({...JSON.parse(objectMaskGeometry({plan,aspect,framing_mode,visual_layers})),sources}))).digest('hex');
}
