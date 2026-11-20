'use strict';

function transferCollection(keys){
  const d=transferDraft,signature=JSON.stringify([...keys].sort());
  d.collections||={};
  return d.collections[signature]||=( {id:'COLL-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)),notes:'',amount:''} );
}
function transferAssayUnits(existing=null){
  const d=transferDraft,keys=Object.keys(d.sources),selected=new Set(keys),used=new Set(),units=[];
  const grouped=(d.sourceSelectionMode||'group')!=='single';
  const definitions=[];
  const bindingFor=members=>{
    for(const c of state.containers)for(const g of c.well_groups||[]){
      const bound=g.wells.filter(w=>memberActive(c.wells[w]||{})).map(w=>sourceKey(c.id,w));
      if(bound.length===members.length&&bound.every(k=>members.includes(k)))return {name:g.name,binding_id:g.id};
    }
    return {};
  };
  if(grouped){
    const culture=transferCultureContext();
    if(culture.mode==='replate')for(const t of d.targets)if(t.distribution==='pooled'&&t.sourceKeys.length&&t.sourceKeys.every(k=>selected.has(k)))definitions.push({keys:t.sourceKeys,...bindingFor(t.sourceKeys)});
    for(const c of state.containers)for(const g of c.well_groups||[]){
      const members=g.wells.filter(w=>memberActive(c.wells[w]||{})).map(w=>sourceKey(c.id,w));
      if(members.length&&members.every(k=>selected.has(k)))definitions.push({keys:members,name:g.name,binding_id:g.id});
    }
  }
  for(const definition of definitions){
    const members=[...new Set(definition.keys)];if(members.some(k=>used.has(k)))continue;
    members.forEach(k=>used.add(k));
    const collection=transferCollection(members),refs=members.map(k=>{const s=d.sources[k];return {container_id:s.id,well:s.well};});
    const memberKeys=refs.map(labSourceKey).sort(),cells=[...new Set(members.map(k=>{const s=d.sources[k];return state.containers.find(c=>c.id===s.id)?.wells[s.well]?.cell;}).filter(Boolean))];
    const prior=(existing?.source_groups||[]).find(g=>g.members.length===memberKeys.length&&g.members.every(k=>memberKeys.includes(k)));
    const group=prior?labSourceGroupInput(prior):{id:collection.id,name:definition.name||cells.join(' + ')+' 收集组',members:memberKeys,notes:collection.notes||'',collection_id:collection.id,...(definition.binding_id?{binding_id:definition.binding_id}:{})};
    units.push({kind:'group',key:'GROUP|'+group.id,label:group.name,keys:members,group,collection});
  }
  for(const key of keys)if(!used.has(key)){
    const s=d.sources[key],c=state.containers.find(c=>c.id===s.id);
    units.push({kind:'well',key:labSourceKey({container_id:s.id,well:s.well}),label:c.name+' / '+s.well,keys:[key]});
  }
  return units;
}
function transferAssayGroupsMarkup(d){
  const units=transferAssayUnits(),groups=units.filter(u=>u.kind==='group');
  return `<section class="assay-source-units"><h4>本次取样单位</h4><p class="muted">${groups.length?`${groups.length} 个培养 / 收集组，整组取样默认一组一条样本；每个原孔的记录仍独立保留。`:'当前按所选单孔生成样本；已绑定的完整培养组在“整组”模式下作为一个来源。'}</p>${units.map((unit,index)=>`<div class="assay-source-unit"><strong>${esc(unit.label)}</strong><small>${unit.keys.map(k=>{const s=d.sources[k],c=state.containers.find(c=>c.id===s.id);return esc(c.name+' / '+s.well);}).join(' ＋ ')}</small>${unit.kind==='group'?`<details><summary>整体处理与取样量（可选）</summary><label>收集 / 离心 / 重悬等处理记录<textarea data-assay-group-notes="${index}" placeholder="填写实际处理；未记录的参数留空">${esc(unit.collection.notes||'')}</textarea></label><label>从整组取用的细胞数或体积<input data-assay-group-amount="${index}" value="${esc(unit.collection.amount||'')}" placeholder="注明单位；不自动相加原孔计数"></label></details>`:''}</div>`).join('')}</section>`;
}
function bindTransferAssayGroups(){
  const units=transferAssayUnits();
  for(const [attribute,field] of [['notes','notes'],['amount','amount']])document.querySelectorAll(`[data-assay-group-${attribute}]`).forEach(input=>input.oninput=()=>{
    if(busy)return;const unit=units[+input.getAttribute(`data-assay-group-${attribute}`)];if(!unit?.collection)return;
    unit.collection[field]=input.value;invalidateTransfer(false);
  });
}
