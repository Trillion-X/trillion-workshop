import {identityOf} from '../../../shared-code/src/typed-operation-contract.mjs';
// Stable native placement DATA. The generation fixes shard count; provider and
// public Space identity remain separate from these concrete invariant writers.
export const CONTENT_SHARD_COUNT = 32;
export function contentShardIndex(key) {
  const encoded = /^shard(\d{2}):/.exec(String(key ?? ''));
  if (encoded && Number(encoded[1]) < CONTENT_SHARD_COUNT) return Number(encoded[1]);
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(String(key ?? ''))) hash = Math.imul(hash ^ byte,16777619) >>> 0;
  return hash % CONTENT_SHARD_COUNT;
}
export const contentShardAddress = (spaceId,index) => {
  if (typeof spaceId !== 'string' || !spaceId || !Number.isInteger(index) || index < 0 || index >= CONTENT_SHARD_COUNT) throw new Error('A Space and stable content shard are required.');
  return `space:content:${spaceId}:shard:${index}`;
};
export const shardKey = (index,key) => `shard${String(index).padStart(2,'0')}:${key}`;
export const contentItemAffinity = input => input?.item_id ?? input?.anchor?.record ?? input?.record ?? input?.reply_to ?? input?.source_ref ?? input?.private_ref ?? input?.relay;
export function contentCommandShard(operation,input) {
  if (['readSpaceRecord','writeSpaceRecord','deleteSpaceRecord','hasBoardRecord'].includes(operation)) return contentShardIndex(input.address);
  if (operation === 'boardCommit') {
    const shards = new Set((input.changes ?? []).map(change => contentShardIndex(change.address)));
    return shards.size === 1 ? [...shards][0] : null;
  }
  if (operation === 'addSpaceItems') {
    const anchors=new Set((input.items??[]).map(item=>item.anchor?.record).filter(Boolean));
    if(anchors.size===1&&(input.items??[]).every(item=>item.anchor?.record))return contentShardIndex([...anchors][0]);
    return contentShardIndex(input.request_key??identityOf(input.items??[]));
  }
  if (operation === 'spaceAgents') return contentShardIndex(input.input?.handoff_id ?? input.input?.to_agent ?? input.input?.agent_id ?? input.relay);
  return contentShardIndex(contentItemAffinity(input));
}
