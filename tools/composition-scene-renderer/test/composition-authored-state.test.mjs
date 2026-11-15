import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initSync,answer_composition} from '../../build-engine-modules-for-web-hosts/built-stored-bytes/composition-engine/composition_engine.js';
import {DEFAULT_STRUCTURAL_MATERIALS} from '../../edit-a-document-together/read-data/default-structural-materials.ts';
initSync({module:new WebAssembly.Module(readFileSync(new URL('../../build-engine-modules-for-web-hosts/built-stored-bytes/composition-engine/composition_engine_bg.wasm',import.meta.url)))});
const answer = transaction => JSON.parse(new TextDecoder().decode(answer_composition(new TextEncoder().encode(JSON.stringify({type:'composition-transaction',...transaction})))));
const find = (node,predicate) => predicate(node) ? node : (node.children ?? []).map(child=>find(child,predicate)).find(Boolean);
function material(source) {
  const next=structuredClone(source); let sequence=0;
  const visit=(node,owner)=>{
    node.id=`node:fixture-${++sequence}`;
    if(node.fsm) owner=node.id;
    if(node.visible?.select?.path==='$selfFsm') node.visible.select.path=`[${JSON.stringify(owner)}]`;
    for(const child of node.children ?? []) visit(child,owner);
  };
  visit(next);return next;
}
for (const kind of ['block:toggle','block:toggle-h1','block:toggle-h2','block:toggle-h3']) test(`engine publishes authored expressions beside usable disclosure visibility: ${kind}`,()=>{
  const toggle=material(DEFAULT_STRUCTURAL_MATERIALS.find(row=>row.id===kind).node);
  const session = `authored-proof:${kind}`;
  let reply=answer({session,set_scene:{id:'root',kind:'Container',props:{},visible:true,children:[toggle]}});
  const bodyContainer=find(toggle,node=>typeof node.visible==='object' && (node.children ?? []).some(child=>child.props?.content_role==='body'));
  assert.equal(find(reply.tree,node=>node.id===bodyContainer.id).visible,true,'an open disclosure renders its editable body');
  assert.equal(typeof find(reply.authored_tree,node=>node.id===bodyContainer.id).visible,'object','authored expression remains data');
  reply=answer({session,interactions:[{node_id:toggle.id,event:'toggle'}]});
  assert.equal(find(reply.tree,node=>node.id===bodyContainer.id).visible,false,'the same binding responds to a transition');
});
