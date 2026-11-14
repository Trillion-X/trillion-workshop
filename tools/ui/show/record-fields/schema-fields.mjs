// Destination schemas are data; no platform-specific forms or field names.
// Keep presentation semantics here so every schema-driven form gets the same
// human language and appropriately sized shared control.
const semanticLabels={
  privacy:'Visibility',privacy_status:'Visibility',visibility:'Visibility',
  category:'Category',category_id:'Category',
  title:'Title',caption:'Caption',description:'Description',summary:'Summary',
  tags:'Tags',language:'Language',comment_status:'Comments',comments:'Comments'
};
const longWriting=new Set(['caption','description','summary','content','body','message','text','script','notes','comment','comments','hashtags']);
const words=value=>String(value||'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[-_]+/g,' ').trim();
export function schemaFieldLabel(id,property={}) {
  const title=String(property.title||'').trim();
  if(title)return title;
  const normalized=words(id).toLowerCase().replace(/\s+/g,'_');
  if(semanticLabels[normalized])return semanticLabels[normalized];
  return words(id).replace(/\b\w/g,letter=>letter.toUpperCase())||'Value';
}
function isLongWriting(id,property={}) {
  const normalized=words(id).toLowerCase().replace(/\s+/g,'_');
  return property.format==='textarea'||property.contentMediaType==='text/plain'||longWriting.has(normalized)||Number(property.maxLength)>280;
}
function enumOptions(property={}) {
  // JSON Schema's enum and const branches define the values a person may
  // choose. Optional schema annotations can supply their display names while
  // the underlying IDs remain untouched for the destination owner.
  const branches=Array.isArray(property.oneOf)?property.oneOf:Array.isArray(property.anyOf)?property.anyOf:null;
  const values=Array.isArray(property.enum)?property.enum:branches?.map(option=>option?.const).filter(value=>value!==undefined);
  if(!values||!values.length||!values.every(value=>['string','number','boolean'].includes(typeof value)))return undefined;
  const names=property.enumTitles||property.enumLabels||property['x-enum-labels']||property['x-enumNames'];
  const namedValues=Array.isArray(names)?names:null;
  const namedMap=names&&typeof names==='object'&&!Array.isArray(names)?names:null;
  return values.map((value,index)=>{
    const branch=branches?.find(option=>Object.is(option?.const,value));
    const rawLabel=branch?.title||branch?.label||namedValues?.[index]||namedMap?.[String(value)];
    return {value:String(value),typedValue:value,label:rawLabel?String(rawLabel):words(value).replace(/\b\w/g,letter=>letter.toUpperCase())};
  });
}
export function schemaFields(schema = {}, prefix = [], depth = 0) {
  const fields = [], unsupported = [];
  for (const [id, property] of Object.entries(schema.properties || {})) {
    if(['__proto__','prototype','constructor'].includes(id)){unsupported.push(id);continue;}
    const required = schema.required?.includes(id) || false;
    if(property?.type==='object'&&property.properties&&depth<8){
      const nested=schemaFields(property,[...prefix,id],depth+1);
      fields.push(...nested.fields.map(field=>({...field,required:required&&field.required,objectRequirements:[...(field.objectRequirements||[]),{path:[...prefix,id],required,children:property.required||[]}]})));
      unsupported.push(...nested.unsupported.map(name=>id+' / '+name));continue;
    }
    if(property?.type==='array'&&property.items?.type==='string'){
      fields.push({id,label:schemaFieldLabel(id,property),required,type:'text',multiline:true,valueType:'array',placeholder:'One item per line',itemSchema:property.items,minItems:property.minItems,maxItems:property.maxItems,uniqueItems:property.uniqueItems});continue;
    }
    if (!['string', 'boolean', 'number', 'integer'].includes(property?.type)) {
      if (required) unsupported.push(id);
      continue;
    }
    const options=enumOptions(property);
    const normalizedId=words(id).toLowerCase().replace(/\s+/g,'_');
    if(normalizedId==='category_id'&&!options){unsupported.push(id);continue;}
    fields.push({id, label: schemaFieldLabel(id,property), required,
      type: property.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(property.type) ? 'number' : 'text',
      multiline: property.type === 'string'&&!options&&isLongWriting(id,property), minLength: property.minLength, maxLength: property.maxLength,
      options, defaultValue:property.default,
      min: property.minimum, max: property.maximum, step: property.type === 'integer' ? 1 : 'any',
      valueType: property.type});
  }
  return {fields:fields.map(field=>field.path?field:{...field,path:[...prefix,field.id],id:prefix.length?JSON.stringify([...prefix,field.id]):field.id,label:[...prefix.map(part=>schemaFieldLabel(part)),field.label].join(' / ')}), unsupported};
}

export function schemaValues(fields, values) {
  const entries=fields.flatMap(field => {
    const value = Object.hasOwn(values,field.id)?values[field.id]:field.path?.reduce((node,key)=>node&&Object.hasOwn(node,key)?node[key]:undefined,values);
    if ((value === '' || value === undefined) && !field.required) return [];
    if(field.valueType==='array'){
      const items=Array.isArray(value)?value:String(value??'').split(/\r?\n/).map(item=>item.trim()).filter(Boolean),spec=field.itemSchema||{};
      if(items.length<(field.minItems??(field.required?1:0))||items.length>(field.maxItems??Infinity))throw Error('Check the number of items in '+field.label+'.');
      if(field.uniqueItems&&new Set(items).size!==items.length)throw Error('Remove repeated items from '+field.label+'.');
      if(items.some(item=>typeof item!=='string'||[...item].length<(spec.minLength??0)||[...item].length>(spec.maxLength??Infinity)||Array.isArray(spec.enum)&&!spec.enum.includes(item)))throw Error('Check the items in '+field.label+'.');
      return [[field.id,items]];
    }
    if(field.options){
      const option=field.options.find(option=>option.value===String(value));
      if(!option)throw Error('Choose an available option for '+field.label+'.');
      return [[field.id,option.typedValue]];
    }
    if (field.type === 'number') {
      const number = value === '' || value === undefined ? NaN : Number(value);
      if (!Number.isFinite(number) || (field.valueType === 'integer' && !Number.isInteger(number))) throw Error('Enter a valid number for ' + field.label + '.');
      if ((field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) throw Error('Choose a number in the available range for ' + field.label + '.');
      return [[field.id, number]];
    }
    if(field.valueType==='string'){
      const length=[...String(value??'')].length;
      if(length<(field.minLength??0)||length>(field.maxLength??Infinity))throw Error('Check the length of '+field.label+'.');
    }
    return [[field.id, field.type === 'checkbox' ? value===true||value==='true' : value]];
  });
  const result={};for(const [id,value]of entries){const path=fields.find(field=>field.id===id)?.path||[id];let node=result;for(const key of path.slice(0,-1)){if(!Object.hasOwn(node,key))node[key]={};node=node[key];}node[path.at(-1)]=value;}
  for(const field of fields)for(const group of field.objectRequirements||[]){const value=group.path.reduce((node,key)=>node?.[key],result);if(group.required||value!==undefined){if(!value)throw Error('Complete '+group.path.join(' / ')+'.');for(const key of group.children)if(!Object.hasOwn(value,key)||value[key]==='')throw Error('Complete '+[...group.path,key].join(' / ')+'.');}}
  return result;
}
