// Internal canonical source reservation. Uses the SAME introduction allowance
// as ordinary requests/stays. Neither an admission route nor a second ledger.
export function reserveNetworkAiPingSource(host,{from,to,agent_id:agent,job:work,request_key:key},{id,at}={}){
 if(!host?.sql?.exec||typeof host.ctx?.storage?.transactionSync!=='function'||typeof host.charge!=='function'
  ||[from,to,agent,work,key,id,at].some(value=>typeof value!=='string'||!value)
  ||!Number.isFinite(Date.parse(at)))throw new TypeError('An original validated AI ping and canonical source transaction are required.');
 return host.ctx.storage.transactionSync(()=>{
  // Recheck AFTER the recipient settings await. A concurrent same-key command
  // may already have reserved/delivered the original even across a UTC day.
  const held=host.sql.exec('SELECT * FROM network_ai_pings WHERE from_relay=? AND request_key=? LIMIT 1',from,key).toArray()[0];
  if(held){
   if(held.to_relay!==to||held.agent_id!==agent||held.job!==work)throw new Error('That request key already names different work.');
   if(!['pending','sent'].includes(held.status)||!Number.isSafeInteger(held.cost)||held.cost<0)throw new Error('The original AI ping reservation is unavailable.');
   return held;
  }
  // Preserve the SAME actual self-public-name projection before first delivery.
  // A retry must not mutate the recipient's immutable handoff input identity.
  const listing=host.sql.exec('SELECT name FROM listings WHERE relay=? LIMIT 1',from).toArray()[0];
  const from_name=listing?(listing.name||'Member'):'A member';
  const cost=host.charge(from,to);
  if(!Number.isSafeInteger(cost)||cost<0)throw new TypeError('The canonical Network introduction charge must be synchronous and exact.');
  host.sql.exec("INSERT INTO network_ai_pings(id,from_relay,to_relay,agent_id,job,request_key,status,cost,created_at,from_name) VALUES(?,?,?,?,?,?,'pending',?,?,?)",id,from,to,agent,work,key,cost,at,from_name);
  return {id,from_relay:from,to_relay:to,agent_id:agent,job:work,request_key:key,status:'pending',cost,created_at:at,from_name};
 });
}

// Old pending rows may already have been accepted under an unknown old name.
// NULL cannot be backfilled from today's profile or retried with guessed input.
export function networkAiPingDeliveryInput(row){
 if(['agent_id','job','request_key','from_relay','from_name'].some(key=>typeof row?.[key]!=='string'||!row[key]))
  throw new Error('The original AI ping sender name requires its accepted handoff proof before retry.');
 return {agent_id:row.agent_id,job:row.job,request_key:`${row.from_relay}:${row.request_key}`,from_relay:row.from_relay,from_name:row.from_name};
}
