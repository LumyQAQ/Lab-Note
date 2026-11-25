'use strict';

// Relations use original container IDs and wells, including archived records.
function lineageRawUnit(source,id,well) {
  const container=(source?.containers||[]).find(c=>c.id===id);
  return container&&Object.prototype.hasOwnProperty.call(container.wells||{},well)?{container,well,record:container.wells[well]}:null;
}
function lineageRefKey(ref) { return JSON.stringify([ref.id,ref.well]); }
function lineageUnitButton(id,well,label='查看当前记录') {
  const unit=lineageRawUnit(state,id,well),available=!!unit?.record?.cell;
  return `<button type="button" class="text-button" data-culture-link-id="${esc(id)}" data-culture-link-well="${esc(well)}" ${available?'':'disabled'}>${esc(well)} · ${esc(label)}${available?'':'（当前不可用）'}</button>`;
}
function lineageLinksMarkup(container,keys,sourceState=activeState()) {
  if(!container)return '';
  const refs=[...keys].map(key=>displayMemberRef(sourceState,container.id,key)).filter(Boolean).map(ref=>({id:ref.container_id,well:ref.well}));
  const chosen=new Set(refs.map(lineageRefKey)),units=refs.map(ref=>lineageRawUnit(sourceState,ref.id,ref.well)).filter(Boolean);
  const upstream=new Map(),downstream=new Map(),siblings=new Map();
  const put=(collection,ref)=>{const key=lineageRefKey(ref);if(!chosen.has(key)&&!collection.has(key))collection.set(key,ref);};
  for(const unit of units)for(const ref of unit.record.source_refs||[])put(upstream,ref);
  const all=(sourceState?.containers||[]).flatMap(c=>Object.entries(c.wells||{}).map(([well,record])=>({container:c,well,record})));
  for(const unit of all) {
    const ref={id:unit.container.id,well:unit.well};
    if((unit.record.source_refs||[]).some(source=>chosen.has(lineageRefKey(source))))put(downstream,ref);
  }
  for(const unit of all) {
    const ref={id:unit.container.id,well:unit.well},key=lineageRefKey(ref);
    if(chosen.has(key)||upstream.has(key)||downstream.has(key)||!unit.record.cell)continue;
    if(unit.record.pool_id){
      if(units.some(selected=>selected.record.pool_id===unit.record.pool_id))siblings.set(key,ref);
      continue;
    }
    if(!unit.record.lineage_id)continue;
    const origins=new Set((unit.record.source_refs||[]).map(lineageRefKey));
    if(units.some(selected=>!selected.record.pool_id&&selected.record.lineage_id===unit.record.lineage_id&&(selected.record.source_refs||[]).some(source=>origins.has(lineageRefKey(source)))))siblings.set(key,ref);
  }
  const relation=(kind,title,items)=>{
    if(!items.size)return '';
    const groups=new Map();
    for(const ref of items.values()) {
      if(!groups.has(ref.id))groups.set(ref.id,[]);
      groups.get(ref.id).push(ref);
    }
    return `<div class="lineage-relation" data-lineage-relation="${kind}"><strong>${title}</strong>${[...groups.entries()].map(([id,entries])=>{
      const c=(sourceState?.containers||[]).find(item=>item.id===id);
      return `<div class="field"><span>${esc(c?.name||entries[0].name||id)}</span><small class="muted"> · ${esc(id)}</small><div>${entries.map(ref=>{
        const unit=lineageRawUnit(sourceState,id,ref.well),w=unit?.record;
        const status=!w?.cell?'记录不可用':c.status==='archived'||w.member_status==='archived'?'已结束':'在培养';
        return lineageUnitButton(id,ref.well,[w?.cell,status,'查看当前记录'].filter(Boolean).join(' · '));
      }).join('')}</div></div>`;
    }).join('')}</div>`;
  };
  const body=relation('upstream','上游来源',upstream)+relation('siblings','同次分装/铺板/扩孔',siblings)+relation('downstream','下游去向',downstream);
  return body?`<details class="lineage-links"><summary>培养来源关系 · 上游 ${upstream.size} / 同次 ${siblings.size} / 下游 ${downstream.size}</summary>${body}</details>`:'';
}
function bindLineageLinks(root) {
  root.querySelectorAll('[data-culture-link-id]').forEach(button=>button.onclick=()=>{
    if(button.disabled||busy)return;
    const id=button.dataset.cultureLinkId,well=button.dataset.cultureLinkWell;
    if(!lineageRawUnit(state,id,well)?.record?.cell){button.disabled=true;button.textContent+='（当前不可用）';return;}
    if(!canLeave())return;
    dirty=false;
    const dialog=button.closest('#lineage-dialog');
    if(dialog?.open)dialog.close();
    openHomeTarget(id,[well]);
  });
}
