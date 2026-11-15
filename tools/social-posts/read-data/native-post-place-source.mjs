// The host supplies its admitted current place rows. A configured publisher never falls back to shipped rows
// when its publication owner is unavailable: that could revive a withdrawn definition.
import bootstrap from '../records/post-place-records.json' with {type:'json'};
import defaults from '#tools/marketplace-defaults/src/marketplace-defaults.json' with { type: 'json' };
import { dataRows } from '#tools/shared-code/src/data-rows.mjs';

export async function loadPostPlaces(env,options={}){
 const selected=await resolveMarketplaceContentSource(env,{file:'records/post-place-records.json',pointer:'/records'},bootstrap.records,options);
 return dataRows('post-place',{records:selected.found?selected.value:[]});
}

// Adapt the former native publication dependency to a host capability. `source` returns final post-place values;
// rewrap only their row envelope so the original loader above keeps the original dataRows selection.
async function resolveMarketplaceContentSource(env, coordinate, shipped, { source, current = async () => {} } = {}) {
  if (source !== undefined) {
    if (typeof source !== 'function') throw new TypeError('The admitted post-place source must be a function.');
    const places = await source();
    await current();
    if (!Array.isArray(places)) throw new TypeError('The admitted post-place source must return its current place rows.');
    return { found: true, value: places.map(payload => ({ kind: 'post-place', payload })) };
  }
  const configured = defaults.default_publishers.some(row => row.account?.from === 'env'
    && env?.[row.account.key] && env?.PERSON);
  if (configured) throw Object.assign(new Error('The host must provide its admitted current post-place source.'),
    { status: 503, code: 'marketplace_content_source_unavailable' });
  return { found: true, value: shipped };
}
