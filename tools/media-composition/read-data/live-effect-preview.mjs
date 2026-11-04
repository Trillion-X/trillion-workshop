// Only describe effects the browser can display. Unsupported filters retain an
// explicit rendered-preview requirement instead of silently appearing applied.
export function liveEffectPreview(preset){
 if(preset.live_lut)return {lut:preset.live_lut,approximate:false};
 const chains=preset.effects?.map(node=>node.template)||[preset.grade];
 const filters=[];let vignette=false;
 for(const chain of chains){
  if(typeof chain!=='string')return null;
  for(const part of chain.split(',')){
   if(/^vignette(?:=|$)/.test(part)){vignette=true;continue;}
   if(part==='hue=s=0'){filters.push('grayscale(1)');continue;}
   if(part.startsWith('eq=')){
    for(const setting of part.slice(3).split(':')){
     const [key,raw]=setting.split('='),value=Number(raw);if(!Number.isFinite(value))return null;
     if(key==='saturation')filters.push(`saturate(${value})`);
     else if(key==='contrast')filters.push(`contrast(${value})`);
     else if(key==='brightness')filters.push(`brightness(${Math.max(0,1+value)})`);
     else if(key==='gamma'&&value===1)continue;
     else return null;
    }
    continue;
   }
   return null;
  }
 }
 return {filter:filters.join(' '),vignette,approximate:true};
}

export function parseCube(text){
 let size=0,min=[0,0,0],max=[1,1,1];const values=[];
 for(const raw of text.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#')||line.startsWith('TITLE'))continue;const fields=line.split(/\s+/);
  if(fields[0]==='LUT_3D_SIZE'){size=Number(fields[1]);continue;}
  if(fields[0]==='DOMAIN_MIN'){min=fields.slice(1).map(Number);continue;}
  if(fields[0]==='DOMAIN_MAX'){max=fields.slice(1).map(Number);continue;}
  if(fields.length!==3||fields.some(value=>!Number.isFinite(Number(value))))return null;values.push(...fields.map(Number));
 }
 if(!Number.isInteger(size)||size<2||size>65||values.length!==size**3*3||min.length!==3||max.length!==3||min.some((value,i)=>!Number.isFinite(value)||!Number.isFinite(max[i])||max[i]<=value))return null;
 return {size,min,max,values};
}
