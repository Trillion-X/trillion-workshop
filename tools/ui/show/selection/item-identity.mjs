export function itemIdentity({name='',appearance={}}={}){
  const icon=typeof appearance.icon==='string'?appearance.icon.trim():'';
  return {text:icon||[...name.trim()][0]?.toLocaleUpperCase()||'?',color:/^#[0-9a-f]{6}$/i.test(appearance.color||'')?appearance.color:'#746b84'};
}
