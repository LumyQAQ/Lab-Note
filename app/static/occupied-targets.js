'use strict';
let occupiedConfirmationDraft=null;
const occupiedActionLabels={link:'仅补充 / 更正来源关联',replace:'按本次设置替换孔内记录',append:'加入已有细胞（合并培养）'};
const occupiedSelectionFields=['ref','wells','replateMap','replateAuto','distribution','distributionOverride','occupiedAction','occupiedConfirmation','append','draftAppend'];
function captureTargetSelection(t){
  return structuredClone(Object.fromEntries(occupiedSelectionFields.filter(key=>Object.hasOwn(t,key)).map(key=>[key,t[key]])));
}
function occupiedContext(){return typeof transferCultureContext==='function'?transferCultureContext():transferDraft;}
function occupiedSourceKeysAt(t,key){
  if(occupiedContext().mode==='replate'&&t.distribution!=='pooled')return replatePairs(t,false).filter(p=>p.well===key).map(p=>p.key);
  return [...(t.sourceKeys||[])];
}
function occupiedSourceRecords(keys){
  const d=occupiedContext();
  return keys.map(key=>{const source=d.sources[key],container=state.containers.find(c=>c.id===source?.id);return {key,source,container,record:container?.wells?.[source?.well]};});
}
// Owners are returned in staging order. The record list contains only the sources
// that actually arrive at this coordinate (one source for paired replate).
function plannedTargetOwners(t,key,beforeOnly=true){
  const targets=transferDraft?.targets||[],position=targets.indexOf(t);
  return targets.flatMap((target,index)=>{
    if(target===t||target.ref!==t.ref||!target.wells.includes(key)||(beforeOnly&&position>=0&&index>=position))return [];
    const sourceKeys=occupiedSourceKeysAt(target,key);
    return [{target,index,key,sourceKeys,records:occupiedSourceRecords(sourceKeys)}];
  });
}
function previousTargetPlan(t,key){return plannedTargetOwners(t,key).at(-1)||null;}
function savedTargetMovingOut(t,key){
  const d=occupiedContext();
  return d.mode==='replate'&&d.clearSources!==false&&Object.values(d.sources).some(s=>s.id===t.ref&&s.well===key);
}
function savedTargetOccupied(t,key){
  const c=transferTarget(t.ref);if(!c?.wells?.[key]?.cell||savedTargetMovingOut(t,key))return false;
  // Updating the same paired source in place does not add a second population.
  if(occupiedContext().mode==='replate'&&t.distribution!=='pooled'&&replatePairs(t,false).some(p=>p.well===key&&p.source?.id===t.ref&&p.source.well===key))return false;
  return true;
}
function occupiedTargetKeys(t){return (t.wells||[]).filter(key=>savedTargetOccupied(t,key)||plannedTargetOwners(t,key).length);}
function occupiedSelectionKeys(t){return (t.wells||[]).filter(key=>savedTargetOccupied(t,key)||plannedTargetOwners(t,key,false).length);}
function plannedOwnerCells(owner){return [...new Set(owner.records.map(s=>s.record?.cell).filter(Boolean))].join(' ＋ ')||'待指定来源';}
function targetWellDescriptions(t,key){
  const previous=transferTarget(t.ref)?.wells?.[key],labels=[];
  if(previous?.cell)labels.push({kind:savedTargetMovingOut(t,key)?'moving':'occupied',text:(savedTargetMovingOut(t,key)?'本次移出: ':'已有: ')+previous.cell});
  for(const owner of plannedTargetOwners(t,key,false))labels.push({kind:'planned',text:'本次已安排: '+plannedOwnerCells(owner)+' / 组'+(owner.index+1)});
  return labels;
}
function targetWellContentMarkup(t,key){return targetWellDescriptions(t,key).map(label=>`<small class="target-well-content target-well-content-${label.kind}">${esc(label.text)}</small>`).join('');}
function targetWellDescription(t,key){return targetWellDescriptions(t,key).map(label=>label.text).join('；');}
function transferOccupiedAction(t){if(t.occupiedAction)return t.occupiedAction;if(occupiedContext().mode==='replate')return 'replace';return occupiedContext().mode==='mix'&&t.append?'append':'link';}
function targetIsLinkOnly(t){return !!occupiedTargetKeys(t).length&&transferOccupiedAction(t)==='link';}
function occupiedScopedPlan(t,keys){
  const d=occupiedContext(),c=transferTarget(t.ref),scope=[...new Set(keys)].sort();
  const incoming=scope.map(key=>[key,occupiedSourceRecords(occupiedSourceKeysAt(t,key)).map(s=>({key:s.key,source:s.source,record:s.record}))]);
  return {mode:d.mode,at:d.at,experiment:d.experiment,notes:d.notes,clearSources:d.clearSources,cultureAction:cultureAction(t,d),cellLinePassage:!!d.cellLinePassage,
    ref:t.ref,container:c?{name:c.name,type:c.type,quantity:c.quantity,location:c.location}:null,
    action:transferOccupiedAction(t),draftAppend:!!t.draftAppend,distribution:t.distribution||'paired',incoming,
    inheritMedium:t.inheritMedium,treatment:t.treatment,concentration:t.concentration,systemMode:t.systemMode,
    cultivation:t.cultivation,reference:t.cultivationReference,seeding:t.seedingEnabled?t.seeding:null,mediumChange:t.mediumChange};
}
function occupiedScopeSignature(t,keys,includeFollowing=false){
  const scope=[...new Set(keys)].sort(),c=transferTarget(t.ref);
  return JSON.stringify({plan:occupiedScopedPlan(t,scope),previous:scope.map(key=>({key,
    saved:savedTargetOccupied(t,key)?c.wells[key]:null,
    planned:plannedTargetOwners(t,key,!includeFollowing).map(owner=>occupiedScopedPlan(owner.target,[key]))}))});
}
function occupiedChangeSignature(t){return occupiedScopeSignature(t,occupiedTargetKeys(t));}
function occupiedChangeConfirmed(t){return !!t.occupiedConfirmation&&t.occupiedConfirmation===occupiedChangeSignature(t);}
function conditionGroupOverlap(t,keys){
  return ['replate','passage'].includes(occupiedContext().mode)&&keys.some(key=>
    plannedTargetOwners(t,key,false).some(owner=>t.conditionName!==undefined||owner.target.conditionName!==undefined));
}
function targetOccupiedPayload(t,previewOnly=false){
  const occupied=occupiedTargetKeys(t);if(!occupied.length)return {};
  const action=transferOccupiedAction(t),planned=occupied.some(key=>plannedTargetOwners(t,key).length);
  if(!Object.hasOwn(occupiedActionLabels,action))throw new Error('请选择如何变更已占用孔');
  if(action==='link'&&(occupied.length!==t.wells.length||planned))throw new Error('仅更正来源适用于已填写的孔；空孔或本次已安排的孔请另设去向组。');
  if(action==='append'&&conditionGroupOverlap(t,occupied))throw new Error('一个目标孔仅可属于一个条件组。');
  if(planned&&(action!=='append'||!t.draftAppend))throw new Error('此孔本次已有安排，请选择覆盖原记录或加入共培养。');
  if(!previewOnly&&!occupiedChangeConfirmed(t))throw new Error('请先点击“核对已有孔变更”，查看前后内容并确认。');
  return {occupied_action:action,occupied_confirmed:!previewOnly,draft_append:action==='append'&&planned&&!!t.draftAppend};
}
function occupiedTargetControls(t,index){
  const keys=occupiedTargetKeys(t);if(!keys.length)return '';
  const action=transferOccupiedAction(t),confirmed=occupiedChangeConfirmed(t);
  return `<section class="occupied-target-controls"><strong>已选 ${keys.length} 个已占用培养单元</strong><label>这次如何变更<select data-occupied-action="${index}">${Object.entries(occupiedActionLabels).filter(([key])=>occupiedContext().mode!=='replate'||key!=='link').map(([key,label])=>`<option value="${key}" ${action===key?'selected':''}>${esc(label)}</option>`).join('')}</select></label><p class="muted">${action==='link'?'只更正来源，保留孔内细胞、Day 0、培养基、处理与计数。':'旧孔完整内容会保留在变更凭据中，可查看并撤销。'}</p><button type="button" class="button secondary" data-occupied-confirm="${index}">${confirmed?'已核对 · 再次查看':'核对已有孔变更'}</button></section>`;
}
function restoreOccupiedSelection(t,before,conflicts){
  if(!before)return;
  if(t.ref===before.ref){
    for(const key of occupiedSelectionFields){if(Object.hasOwn(before,key))t[key]=structuredClone(before[key]);else delete t[key];}
  }else{
    // Ref changes can prune a temporary vessel; never resurrect it on cancel.
    const rejected=new Set(conflicts);t.wells=t.wells.filter(key=>!rejected.has(key));
    if(t.replateMap)t.replateMap=Object.fromEntries(Object.entries(t.replateMap).map(([key,well])=>[key,rejected.has(well)?'':well]));
    t.replateAuto=false;t.append=false;delete t.occupiedAction;delete t.occupiedConfirmation;delete t.draftAppend;
  }
}
function replacePlannedTargetOverlaps(t,keys){
  const d=transferDraft,removedSourceKeys=new Set(),scope=new Set(keys);
  for(const other of [...d.targets]){
    if(other===t||other.ref!==t.ref||!other.wells.some(key=>scope.has(key)))continue;
    const oldSources=[...other.sourceKeys];
    if(occupiedContext().mode==='replate'&&other.distribution!=='pooled'){
      const retained=replatePairs(other,false).filter(pair=>!scope.has(pair.well));
      other.sourceKeys=retained.map(pair=>pair.key);other.replateMap=Object.fromEntries(retained.map(pair=>[pair.key,pair.well]));other.replateAuto=false;
    }
    other.wells=other.wells.filter(key=>!scope.has(key));
    if(!other.wells.length)d.targets.splice(d.targets.indexOf(other),1);
    for(const key of oldSources)if(!d.targets.includes(other)||!other.sourceKeys.includes(key))removedSourceKeys.add(key);
    other.locked=false;delete other.lockSnapshot;delete other.occupiedConfirmation;
    if(other.addedSourceKeys)other.addedSourceKeys=other.addedSourceKeys.filter(key=>other.sourceKeys.includes(key));
  }
  for(const key of removedSourceKeys)if(!d.targets.some(other=>other.sourceKeys.includes(key)))delete d.sources[key];
  d.endSources=(d.endSources||[]).filter(id=>Object.values(d.sources).some(s=>s.id===id));
  pruneTransferTargets();
}
function occupiedSourceMarkup(records){return records.map(s=>`<section class="occupied-source"><strong>${esc(s.container?.name||s.source?.id||'来源')} / ${esc(s.source?.well||'未分配')} · ${esc(s.record?.cell||'待指定来源')}</strong>${s.record?occupiedWellDetails(s.record):''}</section>`).join('');}
function occupiedBeforeMarkup(t,keys,includeFollowing=false){
  const c=transferTarget(t.ref);
  return keys.map(key=>`<section class="occupied-comparison"><h3>${esc(c?.name||'目标')} / ${esc(key)}</h3>${savedTargetOccupied(t,key)?`<p><strong>已有记录 · ${esc(c.wells[key].cell)}</strong></p>${occupiedWellDetails(c.wells[key])}<p>原来源：${(c.wells[key].source_refs||[]).map(s=>esc((s.name||s.id)+' / '+s.well)).join('；')||'未关联'}</p>`:''}${plannedTargetOwners(t,key,!includeFollowing).map(owner=>`<div class="occupied-planned"><strong>本次已安排 · 去向组 ${owner.index+1}${owner.target.locked?' · 已锁定':''}</strong>${occupiedSourceMarkup(owner.records)}</div>`).join('')}</section>`).join('');
}
function promptOccupiedSelection(index,before){
  const d=transferDraft,t=d?.targets[index];if(busy||!t||t.locked)return false;
  const keys=occupiedSelectionKeys(t);if(!keys.length)return false;
  const allOwnersPrecede=keys.every(key=>plannedTargetOwners(t,key,false).every(owner=>owner.index<d.targets.indexOf(t)));
  if(allOwnersPrecede&&occupiedChangeConfirmed(t))return false;
  const dialog=$('#occupied-target-dialog'),signature=occupiedScopeSignature(t,keys,true),snapshot=structuredClone(before||{ref:t.ref,wells:[]});
  occupiedConfirmationDraft={kind:'selection',draft:d,target:t,before:snapshot,keys,signature};
  const pending=keys.some(key=>plannedTargetOwners(t,key,false).length),overlap=conditionGroupOverlap(t,keys);
  dialog.innerHTML=`<div class="dialog-head"><div><span class="eyebrow">TARGET ALREADY IN USE</span><h2>所选孔已有细胞，如何处理？</h2></div><button type="button" class="icon-button" id="close-occupied-change" aria-label="取消本次选择">×</button></div><p>先核对原记录与本次来源，再选择这次安排。此处只更新草稿，最后仍需在总预览中保存。</p>${occupiedBeforeMarkup(t,keys,true)}<h3>这次加入的来源</h3>${occupiedSourceMarkup(occupiedSourceRecords([...new Set(keys.flatMap(key=>occupiedSourceKeysAt(t,key)))]))}${overlap?'<p class="muted">这个孔已划入其他条件组。覆盖可将孔位改分到本组，也可取消选择。</p>':pending?'<p class="occupied-choice-consequence">覆盖会从其它去向组撤销重叠孔位并解除受影响组的锁定；逐孔对应同时撤销对应来源，整体收集组只要仍有目标就保留全部来源。没有目标的组会取消，来源仅在没有其它去向时撤销选择。加入共培养会保留原安排，并将本组排在原安排之后。</p>':'<p class="muted">覆盖会替换所选孔内记录；加入共培养会保留原细胞并加入本次来源。原记录在最终保存后保留于变更凭据。</p>'}<div class="dialog-actions occupied-choice-actions"><button type="button" class="button secondary" data-occupied-choice="replace">覆盖原记录</button><button type="button" class="button primary" data-occupied-choice="append" ${overlap?'disabled':''}>加入共培养</button><button type="button" class="button secondary" data-occupied-choice="cancel">选错了，取消选择</button></div>`;
  const close=()=>{occupiedConfirmationDraft=null;dialog.oncancel=null;dialog.close();};
  const cancel=()=>{if(transferDraft===d&&d.targets.includes(t)){restoreOccupiedSelection(t,snapshot,keys);invalidateTransfer();renderTransfer();}close();};
  $('#close-occupied-change').onclick=cancel;
  dialog.oncancel=event=>{event.preventDefault();cancel();};
  dialog.querySelectorAll('[data-occupied-choice]').forEach(button=>button.onclick=()=>{
    const action=button.dataset.occupiedChoice;if(action==='cancel')return cancel();
    if(overlap&&action==='append')return;
    if(d!==transferDraft||!d.targets.includes(t)||t.locked||signature!==occupiedScopeSignature(t,keys,true))return toast('来源或目标已变化，请取消选择后重新核对。',true);
    if(action==='replace')replacePlannedTargetOverlaps(t,keys);
    else if(pending){d.targets.splice(d.targets.indexOf(t),1);d.targets.push(t);}
    t.occupiedAction=action;t.append=action==='append';t.draftAppend=action==='append'&&pending;
    if(d.mode==='replate')updateReplateDistributions();
    t.occupiedConfirmation=occupiedChangeSignature(t);invalidateTransfer();renderTransfer();close();
  });
  if(!dialog.open)dialog.showModal();return true;
}
function refreshOccupiedConfirmLabels(){
  document.querySelectorAll('[data-occupied-confirm]').forEach(b=>{const t=transferDraft?.targets[+b.dataset.occupiedConfirm];if(t)b.textContent=occupiedChangeConfirmed(t)?'已核对 · 再次查看':'核对已有孔变更';});
}
function refreshOccupiedTargetUi(index){
  const t=transferDraft.targets[index],card=$(`[data-target-card="${index}"]`);if(!card||!t)return;
  const panel=card.querySelector('[data-occupied-panel]');if(panel)panel.innerHTML=occupiedTargetControls(t,index);
  const fields=card.querySelector('[data-target-system-fields]');if(fields)fields.hidden=targetIsLinkOnly(t);bindOccupiedTargets();
}
function bindOccupiedTargets(){
  document.querySelectorAll('[data-occupied-action]').forEach(input=>input.onchange=()=>{
    const index=+input.dataset.occupiedAction;try{assertTransferTargetEditable(index);}catch(e){toast(e.message,true);renderTransfer();return;}
    const t=transferDraft.targets[index],before=captureTargetSelection(t);t.occupiedAction=input.value;t.append=input.value==='append';delete t.occupiedConfirmation;invalidateTransfer();renderTransfer();
    if(t.wells.some(key=>plannedTargetOwners(t,key,false).length))promptOccupiedSelection(index,before);
  });
  document.querySelectorAll('[data-occupied-confirm]').forEach(b=>b.onclick=()=>openOccupiedConfirmation(+b.dataset.occupiedConfirm));
}
function occupiedWellDetails(w){
  return `<p>细胞：${esc(w?.cell||'未记录')} · 批次：${esc(w?.batch||'未记录')}<br>Day 0：${esc(w?.day0||'未记录')} · ${esc(w?.anchor||'')}<br>处理：${esc(w?.treatment||'未记录')} · 浓度：${esc(w?.concentration||'未记录')}</p>${typeof mediumDetailsMarkup==='function'?mediumDetailsMarkup(w?.medium):''}${typeof countDetailsMarkup==='function'?countDetailsMarkup(w?.cell_count):''}${typeof seedingDetailsMarkup==='function'?seedingDetailsMarkup(w?.seeding):''}`;
}
function occupiedPreviousPopulation(t,key){
  const saved=transferTarget(t.ref)?.wells?.[key];
  let records=savedTargetOccupied(t,key)?[saved]:[];
  for(const owner of plannedTargetOwners(t,key)){
    const action=occupiedTargetKeys(owner.target).includes(key)?transferOccupiedAction(owner.target):'replace',incoming=owner.records.map(s=>s.record).filter(Boolean);
    if(action==='link')continue;
    records=action==='append'?[...records,...incoming]:incoming;
  }
  return records.flatMap(record=>record.components?.length?record.components:[record]);
}
function occupiedResultSummary(t){
  const d=occupiedContext(),action=transferOccupiedAction(t);
  if(action==='link')return '<p>孔内原记录保持不变，仅更新来源引用并生成更正凭据。</p>';
  if(d.mode==='replate'&&action!=='append')return replateMappingReview(t);
  return `<div class="occupied-result-summary">${occupiedTargetKeys(t).map(key=>{
    const source=occupiedSourceRecords(occupiedSourceKeysAt(t,key)).map(s=>s.record).filter(Boolean);
    if(action==='append'||d.mode==='mix'){
      const parts=[...(action==='append'?occupiedPreviousPopulation(t,key):[]),...source.flatMap(w=>w.components?.length?w.components:[w])];
      return `<p><strong>${esc(key)}</strong> → ${[...new Set(parts.map(w=>w.cell))].map(esc).join(' ＋ ')}<br>加入共培养；各组分保留自己的培养 Day 0。</p>`;
    }
    const first=source[0]||{},reset=d.mode==='passage'&&first.kind==='细胞系';
    return `<p><strong>${esc(key)}</strong> → ${esc(first.cell||'未选来源')}<br>保存后 Day 0：${esc(reset?d.at.slice(0,10):first.day0||'未记录')} · ${esc(reset?'传代':first.anchor||'')}</p>`;
  }).join('')}${d.mode==='replate'?replateMappingReview(t):''}<p class="muted">旧孔内容完整保留在凭据中；原计数不沿用，以下来源计数仅供核对。</p></div>`;
}
function openOccupiedConfirmation(index,returnToReview=false,after=null){
  if(busy)return;
  const d=transferDraft,t=d.targets[index];
  if(!t)return;
  if(!t.locked&&t.wells.some(key=>plannedTargetOwners(t,key,false).length)&&(!t.draftAppend||transferOccupiedAction(t)!=='append'))return promptOccupiedSelection(index,captureTargetSelection(t));
  try{assertTransferTargetEditable(index);transferTargetPayload(t,true);}catch(e){return toast(e.message,true);}
  const action=transferOccupiedAction(t),c=transferTarget(t.ref),signature=occupiedChangeSignature(t);
  occupiedConfirmationDraft={kind:'review',target:t,index,signature,returnToReview};
  const sources=t.sourceKeys.map(key=>{const s=d.sources[key],container=state.containers.find(c=>c.id===s?.id);return {...s,container,record:container?.wells[s?.well]};}).filter(s=>s.record);
  const dialog=$('#occupied-target-dialog');
  dialog.innerHTML=`<div class="dialog-head"><div><span class="eyebrow">OCCUPIED WELL REVIEW</span><h2>确认已占用孔的变更</h2></div><button type="button" class="icon-button" id="close-occupied-change" aria-label="关闭已有孔核对">×</button></div><p><strong>${esc(occupiedActionLabels[action])}</strong> · ${esc(c.name)}</p><p class="muted">${action==='link'?'仅更正来源关联，不重新传代、不重置培养日期、不覆盖孔内信息。':'确认后将按本次来源与设置变更所选孔，原有记录保留在凭据中。'} 此处确认仅更新草稿，仍需在总预览中最终保存。</p><h3>变更前</h3>${occupiedBeforeMarkup(t,occupiedTargetKeys(t))}<h3>变更后</h3>${occupiedResultSummary(t)}<p>${action==='link'?'孔内原记录保持不变，来源将关联为：':'使用以下来源；细胞组成、培养日期与条件按本次模式保存：'}</p>${sources.map(s=>`<section class="panel"><strong>${esc(s.container.name)} / ${esc(s.well)} · ${esc(s.record.cell)}</strong><small>${esc(s.id)} · ${s.container.status==='active'&&memberActive(s.record)?'在培养':'已结束来源'}</small>${action==='link'?'':occupiedWellDetails(s.record)}</section>`).join('')}${action==='link'?'':`<p>${esc(transferSeedingSummary(t,c))}</p>${transferReviewCultivation(t)}`}<div class="dialog-actions"><button type="button" class="button secondary" id="cancel-occupied-change">取消</button><button type="button" class="button primary" id="accept-occupied-change">确认这项变更</button></div>`;
  const close=()=>{dialog.oncancel=null;dialog.close();occupiedConfirmationDraft=null;if(returnToReview)previewTransfer();};
  const cancel=()=>{close();after?.cancel();};
  $('#cancel-occupied-change').onclick=$('#close-occupied-change').onclick=cancel;
  dialog.oncancel=e=>{e.preventDefault();cancel();};
  $('#accept-occupied-change').onclick=()=>{
    if(d!==transferDraft||d.targets[index]!==t||t.locked||signature!==occupiedChangeSignature(t))return toast('来源或目标已变化，请重新打开核对。',true);
    t.occupiedConfirmation=signature;invalidateTransfer();renderTransfer();close();
    if(after){try{after.accept();}catch(error){after.cancel();toast(error.message,true);}}
  };
  if(!dialog.open)dialog.showModal();
}
function transferOperationLabel(){
  const d=transferDraft;
  if(d.targets?.length&&d.targets.every(t=>t.wells.length&&occupiedTargetKeys(t).length===t.wells.length&&targetIsLinkOnly(t)))return '补充 / 更正来源关联';
  if(d.smartCulture&&isCultureMode(d.mode))return [...new Set(d.targets.map(t=>cultureActionNames[cultureAction(t)]).filter(Boolean))].join(' / ')||combinedCultureLabel;
  return d.mode==='replate'&&d.cellLinePassage?'孔板传代':transferModes[d.mode];
}
function openLineageCorrection(){
  const c=current();if(!c||frozen||busy||!selected.size)return;
  const refs=[...selected].map(k=>displayMemberRef(state,c.id,k)).filter(Boolean);
  if(!refs.length)return;
  const wells=refs.map(r=>({ref:r,container:state.containers.find(c=>c.id===r.container_id)})).filter(x=>x.container?.wells[x.ref.well]?.cell);
  if(wells.length!==refs.length)return toast('请选择已填写的目标培养单元。',true);
  if(c.status!=='active')return toast('请先恢复目标培养记录，再更正来源。',true);
  const previousDraft=transferDraft;openTransfer();const d=transferDraft;if(!d||d===previousDraft)return;
  d.mode='seed';d.newContainers=[];d.targets=[];d.sources={};d.showEndedSources=true;d.culturePrepared=true;
  const groups=new Map();
  for(const {ref,container} of wells){
    const keys=[];
    for(const parent of container.wells[ref.well].source_refs||[]){
      const p=state.containers.find(c=>c.id===parent.id);if(!p?.wells[parent.well]?.cell)continue;
      const key=sourceKey(parent.id,parent.well);d.sources[key]={id:parent.id,well:parent.well,role:'',amount:''};keys.push(key);
    }
    const groupKey=JSON.stringify([ref.container_id,[...keys].sort()]);
    if(!groups.has(groupKey))groups.set(groupKey,{ref:ref.container_id,wells:[],sourceKeys:keys,append:false,treatment:'',concentration:'',systemMode:'same',occupiedAction:'link',locked:false});
    groups.get(groupKey).wells.push(ref.well);
  }
  d.targets=[...groups.values()];d.sourcePickerOpen=!Object.keys(d.sources).length;renderTransfer();
}
