// Searchable multi-choice anatomy adapted from BeautifulUI SearchList and
// ApprovalCard, MIT (c) 2026 Shane Levine. Labels and choices are consumer data.
export function mountChoiceList(container,{items,name,selected=[],label,onChange}){
  const chosen=new Set(selected);container.replaceChildren();container.classList.add('bui-choice-list');
  const search=document.createElement('input');search.type='search';search.placeholder=label;search.setAttribute('aria-label',label);container.append(search);
  const list=document.createElement('div');list.className='bui-choice-rows';container.append(list);
  for(const item of items){const row=document.createElement('label');row.className='bui-choice';row.dataset.search=[item.label,item.detail].join(' ').toLowerCase();const input=document.createElement('input');input.type='checkbox';input.name=name;input.value=item.id;input.checked=chosen.has(item.id);const text=document.createElement('span');text.textContent=item.label;row.append(input,text);if(item.detail){const detail=document.createElement('small');detail.textContent=item.detail;text.append(detail);}input.onchange=()=>{input.checked?chosen.add(item.id):chosen.delete(item.id);onChange?.([...chosen]);};list.append(row);}
  search.oninput=()=>{for(const row of list.children)row.hidden=!row.dataset.search.includes(search.value.toLowerCase());};
  return {selected:()=>[...chosen]};
}
