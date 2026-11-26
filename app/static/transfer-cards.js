'use strict';
let transferSystemDraft=null;
function lockedTransferTargets(){return (transferDraft?.targets||[]).filter(t=>t.locked);}
function transferRefLocked(ref){return !!ref&&lockedTransferTargets().some(t=>t.ref===ref);}
function transferSourceLocked(key){return transferDraft?.mode!=='assay'&&lockedTransferTargets().some(t=>t.sourceKeys.includes(key));}
function lockedTransferDestination(key){return !['assay','replate'].includes(transferDraft?.mode)&&lockedTransferTargets().some(t=>t.wells.some(w=>sourceKey(t.ref,w)===key));}
function assertTransferTargetEditable(index){if(transferDraft.targets[index]?.locked)throw new Error('此去向组已锁定，请先取消锁定。');}
function addExistingTransferTarget(){
  transferDraft.targets.push({ref:'',wells:[],sourceKeys:Object.keys(transferDraft.sources),append:false,treatment:'',concentration:'',systemMode:'same',locked:false});
  invalidateTransfer();renderTransfer();
}
function transferCultureSystem(w){return {medium:w?.medium||null,treatment:w?.treatment||'',concentration:w?.concentration||'',active_treatments:w?.active_treatments||[]};}
function transferPreviousSystem(t,key){
  const prior=typeof previousTargetPlan==='function'?previousTargetPlan(t,key):null;
  if(prior)return transferProjectedSystem(prior.target,key);
  return transferCultureSystem(transferTarget(t.ref)?.wells?.[key]);
}
function transferProjectedSystem(t,key){
  const sourceKeyAt=transferDraft.mode==='replate'&&t.distribution!=='pooled'?replatePairs(t,false).find(p=>p.well===key)?.key:t.sourceKeys[0];
  const sourceSystem=key=>{const s=transferDraft.sources[key];return transferCultureSystem(state.containers.find(c=>c.id===s?.id)?.wells?.[s?.well]);};
  if(t.systemMode==='custom'){
    const ref=t.cultivationReference,basis=ref?.kind==='target'?transferPreviousSystem(t,ref.well):sourceSystem(ref?.key);
    return {...(t.cultivation||{}),active_treatments:t.cultivation?.continue_active?basis.active_treatments:[]};
  }
  if(occupiedTargetKeys(t).includes(key)&&['append','link'].includes(transferOccupiedAction(t)))return transferPreviousSystem(t,key);
  return sourceSystem(sourceKeyAt);
}
function transferCultureOptions(t){
  const c=transferTarget(t.ref);if(!c)return [];
  const existing=t.wells.filter(k=>c.wells?.[k]?.cell||(typeof previousTargetPlan==='function'&&previousTargetPlan(t,k))).map(k=>({key:'target:'+k,label:c.name+' / '+k+'（原目标）',reference:{kind:'target',well:k},well:typeof previousTargetPlan==='function'&&previousTargetPlan(t,k)?transferPreviousSystem(t,k):c.wells[k]}));
  const sources=t.sourceKeys.map(key=>{const s=transferDraft.sources[key],container=state.containers.find(c=>c.id===s?.id);return s&&container?{key:'source:'+key,label:container.name+' / '+s.well+'（来源）',reference:{kind:'source',key},well:container.wells[s.well]}:null;}).filter(Boolean);
  return [...existing,...sources];
}
function transferSameSystemError(t){
  const c=transferTarget(t.ref);if(!c)return '请选择目标容器';
  // Occupied targets keep their own previous system. Empty targets use sources.
  if(transferDraft.mode==='replate'||targetIsLinkOnly(t))return '';
  if(transferOccupiedAction(t)!=='replace'&&t.wells.every(k=>c.wells?.[k]?.cell))return '';
  const options=transferCultureOptions(t).filter(o=>o.reference.kind==='source');
  if(!options.length)return '请选择来源细胞';
  return new Set(options.map(o=>JSON.stringify(transferCultureSystem(o.well)))).size>1?'所选来源的培养体系不同，请点击“修改培养体系”明确设置。':'';
}
function transferPoolSourceError(t){
  const sources=t.sourceKeys.map(k=>{const ref=transferDraft.sources[k];return {ref,well:state.containers.find(c=>c.id===ref?.id)?.wells[ref?.well]};});
  if(!sources.length||sources.some(s=>!s.well))return '请选择有效的整体收集来源。';
  const wells=sources.map(s=>s.well),first=wells[0];
  if(wells.some(w=>w.components?.length))return '合并收集扩孔适用于同来源同处理细胞，混合培养请分别移孔。';
  const fields=['cell','kind','batch','day0','anchor','treatment','concentration'];
  if(wells.some(w=>fields.some(k=>(w[k]||'')!==(first[k]||''))))return '合并收集的细胞、批次、Day 0 和处理须一致；不同组请分别设置去向。';
  if((first.treatment||first.concentration)&&wells.some(w=>(w.treated_at||'')!==(first.treated_at||'')))return '来源处理时间不同，请分别设置收集组。';
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const active=w=>JSON.stringify((w.active_treatments||[]).map(t=>canonical(Object.fromEntries(Object.entries(t).filter(([key])=>!['id','source_treatment_ids'].includes(key))))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if(wells.some(w=>active(w)!==active(first)))return '来源进行中处理、剂量或开始时间不同，请分别设置收集组。';
  const refs=w=>JSON.stringify([...new Set((w.source_refs||[]).map(r=>JSON.stringify([r.id,r.well])))].sort());
  if(wells.some(w=>refs(w)!==refs(first)))return '来源关联不同，请分别设置收集组。';
  if(!(first.source_refs||[]).length&&new Set(sources.map(s=>s.ref.id)).size>1&&!(first.pool_id&&wells.every(w=>w.pool_id===first.pool_id)))return '跨容器整体收集须有相同来源关联或同一收集组凭据。';
  if(t.systemMode!=='custom'&&wells.some(w=>JSON.stringify(canonical(w.medium||null))!==JSON.stringify(canonical(first.medium||null))))return '来源培养基不同，请明确修改目标培养体系。';
  return '';
}
function targetCulturePayload(t,sourceKeys){
  if(transferDraft.mode==='replate'&&t.distribution==='pooled'){const error=transferPoolSourceError(t);if(error)throw new Error(error);}
  if(!t.systemMode)return {}; // Earlier drafts/tests keep their explicit legacy fields.
  if(t.systemMode==='same'){const error=transferSameSystemError(t);if(error)throw new Error(error);return {cultivation_mode:'same'};}
  const spec=t.cultivation;if(!spec)throw new Error('请完成自定义培养体系');
  const reference=t.cultivationReference;
  let wire;
  if(reference?.kind==='source'){
    if(!t.sourceKeys.includes(reference.key))throw new Error('培养体系参照来源已移除，请重新编辑体系');
    wire={kind:'source',source_index:sourceKeys.indexOf(reference.key)};
  }else if(reference?.kind==='target'){
    if(!t.wells.includes(reference.well)||!transferTarget(t.ref)?.wells?.[reference.well]?.cell)throw new Error('培养体系参照目标已移除，请重新编辑体系');
    wire={kind:'target',well:reference.well};
  }
  return {cultivation_mode:'custom',cultivation:spec,...(wire?{cultivation_reference:wire}:{})};
}
function transferTargetFingerprint(t){
  const d=transferCultureContext(),c=transferTarget(t.ref);
  return JSON.stringify({mode:d.mode,at:d.at,experiment:d.experiment,notes:d.notes,
    cultureAction:cultureAction(t,d),cultureIntent:t.cultureIntent,conditionName:t.conditionName,cellLinePassage:!!d.cellLinePassage,ref:t.ref,metadata:c?{name:c.name,type:c.type,quantity:groupQuantity(c),location:c.location}:null,
    wells:t.wells,sourceKeys:t.sourceKeys,sources:t.sourceKeys.map(k=>d.sources[k]),append:t.append,draftAppend:!!t.draftAppend,
    inheritMedium:t.inheritMedium,treatment:t.treatment,concentration:t.concentration,systemMode:t.systemMode,
    cultivation:t.cultivation,reference:t.cultivationReference,seeding:t.seedingEnabled?t.seeding:null,occupiedAction:t.occupiedAction,clearSources:transferDraft.clearSources,distribution:t.distribution||'paired',replateMap:t.replateMap,mediumChange:t.mediumChange});
}
function verifyTransferLocks(){for(const t of lockedTransferTargets())if(t.lockSnapshot!==transferTargetFingerprint(t))throw new Error('已锁定去向组的关联信息发生变化，请取消锁定并重新核对。');}
function lockTransferTarget(index){
  const d=transferDraft,t=d.targets[index];
  transferTargetPayload(t);
  if(d.targets.some((other,j)=>{
    if(other===t||other.ref!==t.ref||!other.wells.some(k=>t.wells.includes(k)))return false;
    const later=j>index?other:t;
    return !(later.draftAppend&&transferOccupiedAction(later)==='append'&&occupiedChangeConfirmed(later));
  }))throw new Error('此去向组与其他组存在重复目标孔位，请先调整。');
  t.anchorPlaceMode=false;t.lockedCultureAction=cultureAction(t);t.lockSnapshot=transferTargetFingerprint(t);t.locked=true;
}
function toggleTransferTargetLock(index){
  const t=transferDraft.targets[index];if(!t||busy)return;
  try{
    if(t.locked){t.locked=false;delete t.lockSnapshot;delete t.lockedCultureAction;}
    else lockTransferTarget(index);
    invalidateTransfer();renderTransfer();
  }catch(error){toast(error.message,true);}
}
function confirmSystemAndContinue(index,rollback){
  const d=transferDraft,t=d.targets[index];
  const finish=()=>{
    lockTransferTarget(index);d.nextSourceTarget=t;
    invalidateTransfer();renderTransfer();
    const pending=d.targets.findIndex(group=>!group.locked);
    const next=pending>=0?$(`[data-target-card="${pending}"]`):$(`[data-next-picker="${index}"]`)||$(`[data-target-card="${index}"]`);
    next?.scrollIntoView?.({block:'start',behavior:'smooth'});
  };
  try{
    if(occupiedTargetKeys(t).length&&!occupiedChangeConfirmed(t)){
      transferTargetPayload(t,true);
      invalidateTransfer();renderTransfer();
      openOccupiedConfirmation(index,false,{accept:finish,cancel:rollback});
    }else finish();
  }catch(error){rollback();toast(error.message,true);}
}
function useSameTransferSystem(index){
  const d=transferDraft,t=d.targets[index];
  if(busy||!t||t.locked)return;
  const original={...t};
  t.systemMode='same';delete t.cultivation;delete t.cultivationReference;
  if(!isCultureMode(d.mode)){invalidateTransfer();renderTransfer();return;}
  confirmSystemAndContinue(index,()=>{Object.assign(t,original);invalidateTransfer();renderTransfer();});
}
function applyTransferLocks(){
  const root=$('#transfer-dialog'),d=transferDraft;if(!root||!d)return;
  root.querySelectorAll('[data-target-card]').forEach(card=>{
    const t=d.targets[+card.dataset.targetCard];
    if(t.locked)card.querySelectorAll('input,select,textarea,button').forEach(el=>{if(!el.matches('[data-target-lock],[data-replate-next],[data-replate-next-new],[data-next-condition]'))el.disabled=true;});
    const metadata=card.querySelector('[data-target-metadata]');if(metadata)metadata.disabled=transferRefLocked(t.ref);
  });
  const any=lockedTransferTargets().length>0;
  const backgroundMode=d.mode==='assay'?d.cultureMode:d.mode;
  const cultureTab=isCultureMode(backgroundMode)?'culture':backgroundMode;
  root.querySelectorAll('[data-mode]').forEach(el=>el.disabled=any&&el.dataset.mode!=='assay'&&el.dataset.mode!==cultureTab);
  root.querySelectorAll('#transfer-at,#transfer-experiment,#transfer-notes,#replate-clear-sources').forEach(el=>el.disabled=any&&d.mode!=='assay');
  root.querySelectorAll('[data-transfer-source]').forEach(el=>el.disabled=transferSourceLocked(el.dataset.transferSource)||lockedTransferDestination(el.dataset.transferSource));
  root.querySelectorAll('[data-source-role],[data-source-amount]').forEach(el=>el.disabled=transferSourceLocked(el.dataset.sourceRole||el.dataset.sourceAmount));
}
function transferDestinationMarkup(d,chosen,targets){
  return `<section class="transfer-destinations"><div class="destination-heading"><div class="destination-icons"><button type="button" class="circle-action" id="add-new-transfer" title="添加新培养容器" aria-label="添加新培养容器">＋</button><button type="button" class="circle-action" id="link-existing-transfer" title="关联已有培养容器及孔位" aria-label="关联已有培养容器及孔位">⇄</button></div><h3>2 · 目标容器与去向</h3></div><p class="muted">＋ 新建容器　⇄ 关联已有容器或共用孔板。信息集中在各去向组内编辑。</p>${lockedTransferTargets().length?'<p class="target-lock-note">锁定组的容器信息、所用来源参数和本次共用操作信息已保护；仍可添加和编辑其他去向组。</p>':''}
  ${d.targets.map((t,i)=>{
    const c=transferTarget(t.ref),keys=c?transferTargetKeys(c):[],same=t.systemMode==='same',locked=!!t.locked;
    const canAnchorPlace=!!(boot.layouts[c?.type]&&d.mode==='replate'&&!locked&&t.sourceKeys.length>1&&replateSourceGeometry(t.sourceKeys));
    const anchorMode=canAnchorPlace&&!!t.anchorPlaceMode;
    const remaining=locked&&isCultureMode(d.mode)?replateRemainingCellSources(t):[];
    return `<section class="transfer-target ${locked?'is-locked':''}" data-target-card="${i}"><div class="section-head"><strong>去向组 ${i+1}${t.conditionName?' · '+esc(t.conditionName):''}${locked?(d.mode==='replate'?' · 当前细胞已确认':' · 已锁定'):''}</strong><div class="actions"><button type="button" class="button ${locked?'primary':'secondary'}" data-target-lock="${i}" aria-pressed="${locked}">${d.mode==='replate'?(locked?'取消确认并修改':'确认当前细胞'):(locked?'取消锁定':'锁定此组')}</button><button type="button" class="text-button" data-target-detach="${i}" ${locked||!c?'disabled':''}>拆为独立目标</button><button type="button" class="text-button" data-remove-target="${i}" ${locked?'disabled':''}>移除</button></div></div>
    ${locked?`<div class="locked-target-summary">${cultureActionMarkup(t,i,true)}<strong>${esc(c.name)} · ${esc(groupTypeLabel(c))}</strong><p>${esc(c.location||'未填位置')} · ${t.wells.map(esc).join('、')}</p><p>来源：${chosen.filter(s=>t.sourceKeys.includes(s.key)).map(s=>esc(s.name+' / '+s.well+' · '+s.cell)).join('；')}</p><p>${targetIsLinkOnly(t)?'仅更正来源 · 孔内信息保留':same?'与前培养体系一致':'已设置自定义培养体系'}</p><p>${targetIsLinkOnly(t)?'':esc(transferSeedingSummary(t,c))}</p>${isCultureMode(d.mode)?`<p class="muted">本组已确认，最终保存时一并写入。</p><div class="actions">${boot.layouts[c.type]&&(d.mode==='passage'||t.distribution==='pooled')?`<button type="button" class="button secondary" data-next-condition="${i}">同一来源继续选目标孔</button>`:''}${d.nextSourceTarget===t&&d.targets.every(group=>group.locked)?'':`<button type="button" class="button secondary" data-replate-next="${i}" ${!remaining.length?'disabled':''}>选下一来源孔</button>`}${d.mode==='replate'&&remaining.length?`<button type="button" class="button secondary" data-replate-next-new="${i}">剩余来源移到新容器</button>`:''}</div>`:''}</div>`:''}
    <fieldset class="target-fields" ${locked?'disabled hidden':''}><label>目标容器<select data-target-ref="${i}"><option value="">请选择已有容器或本次新建容器</option>${targets.map(c=>`<option value="${esc(c.ref)}" ${t.ref===c.ref?'selected':''}>${esc(c.label)}</option>`).join('')}</select></label><fieldset data-target-metadata class="target-fields">${transferTargetEditor(c,i)}</fieldset>
    ${sourcePickerMarkup({scope:'target-'+i,options:replateCellSourceOptions(t,chosen),selectedKeys:t.sourceKeys,viewId:t.sourceViewId,selectionMode:d.sourceSelectionMode||'group',lockedKeys:t.locked?t.sourceKeys:[]})}<p class="muted">${c?groupType(c.type)?'选择本次目标瓶 / 皿':anchorMode?'点击起点孔，按原相对位置放置整组。':'选择目标孔位（支持拖动框选）':'先选择一个目标容器'}</p>
    <div class="transfer-well-grid ${anchorMode?'is-anchor-place':''}" style="grid-template-columns:repeat(${c?(boot.layouts[c.type]?.[1]||1):1},minmax(0,1fr))" data-target-grid="${i}">${keys.map(k=>`<button type="button" class="target-well ${t.wells.includes(k)?'selected':''} ${targetWellDescription(t,k)?'occupied':''}" data-well="${esc(k)}" aria-pressed="${t.wells.includes(k)}" title="${esc(targetWellDescription(t,k))}">${esc(k)}${targetWellContentMarkup(t,k)}</button>`).join('')}</div><div class="actions"><button type="button" class="text-button" data-target-all="${i}">全选</button><button type="button" class="text-button" data-target-none="${i}">取消选择</button>${canAnchorPlace?`<button type="button" class="text-button" data-replate-anchor="${i}" aria-pressed="${anchorMode}">${anchorMode?'点选左上角起点孔':'按相对位置整组放置'}</button>`:''}</div>
    <div data-replate-panel="${i}">${cultureActionMarkup(t,i)}${replateGroupMarkup(t,i)}</div><div data-occupied-panel="${i}">${occupiedTargetControls(t,i)}</div>
    <div data-target-system-fields ${targetIsLinkOnly(t)?'hidden':''}>${transferSeedingMarkup(t,c,i)}
    <div class="target-system-bar"><button type="button" class="button ${same?'primary':'secondary'}" data-system-same="${i}" ${!c?'disabled':''}>${isCultureMode(d.mode)?'与前培养体系一致，确认此组':(same?'✓ ':'')+'与前培养体系一致'}</button><button type="button" class="text-button" data-system-edit="${i}" ${!c?'disabled':''}>${same?'不同？修改培养体系':'编辑自定义体系'}</button></div>
    ${!same?`<p class="muted target-system-summary">${esc(t.cultivation?mediumSummary(t.cultivation.medium)+' · 处理：'+(t.cultivation.treatment||'未记录'):'已有处理设置；可打开完整编辑框')}</p>`:''}
    </div>${d.mode==='replate'?`<div class="replate-confirm-actions"><button type="button" class="button primary" data-replate-confirm="${i}">确认当前细胞</button><p class="muted">固定本组来源、目标孔位与培养条件，再继续安排本板其他细胞；最后统一预览保存。</p></div>`:''}</fieldset></section>${isCultureMode(d.mode)&&locked&&d.nextSourceTarget===t&&d.targets.every(group=>group.locked)&&remaining.length?`<section data-next-picker="${i}" class="next-source-picker"><div class="next-source-picker-head"><h4>选下一来源孔</h4>${d.mode==='replate'?`<button type="button" class="text-button" data-replate-next-new="${i}">改为放到新容器</button>`:''}</div>${sourcePickerMarkup({scope:'next-'+i,options:remaining,viewId:t.nextSourceViewId||t.sourceViewId,selectionMode:d.sourceSelectionMode||'group'})}</section>`:''}`;
  }).join('')||'<div class="panel muted">点击左上角 ＋ 或 ⇄ 添加第一个目标。</div>'}</section>`;
}
function openTransferSystem(index,subset=null){
  if(busy)return;try{assertTransferTargetEditable(index);}catch(e){return toast(e.message,true);}
  const t=transferDraft.targets[index];
  if(subset&&(!subset.length||subset.some(key=>!t.wells.includes(key))))return;
  const options=transferCultureOptions(t).filter(o=>!subset||o.reference.kind==='source'||subset.includes(o.reference.well));
  if(!options.length)return toast('请先选择目标与来源。',true);
  const initial=subset&&transferOccupiedAction(t)==='replace'?options.find(o=>o.reference.kind==='source')||options[0]:options[0];
  const key=t.cultivationReference?.kind==='source'?'source:'+t.cultivationReference.key:t.cultivationReference?.kind==='target'?'target:'+t.cultivationReference.well:initial.key;
  const basis=options.find(o=>o.key===key)||initial,system=t.systemMode==='custom'&&t.cultivation||{...transferCultureSystem(basis.well),continue_active:!!basis.well.active_treatments?.length};
  transferSystemDraft={target:t,index,subset,options,key:basis.key,system:structuredClone(system)};
  renderTransferSystem();$('#transfer-system-dialog').showModal();
}
function applySubsetSystem(editor,recipe,reference){
  const d=transferDraft,t=editor.target,i=editor.index,subset=editor.subset;
  const rest=t.wells.filter(k=>!subset.includes(k));
  if(rest.length&&d.targets.some(other=>other!==t&&other.ref===t.ref&&other.wells.some(k=>t.wells.includes(k)))){
    throw new Error('一个目标孔只能属于一个条件组。请先调整与其他去向组重叠的孔位。');
  }
  const movedReference=t.cultivationReference?.kind==='target'&&subset.includes(t.cultivationReference.well);
  if(rest.length&&t.systemMode==='custom'&&t.cultivation?.continue_active&&movedReference){
    throw new Error('原组正以所选孔为培养体系参照。请先在原组选择保留孔或来源作为参照。');
  }
  const branch=structuredClone(t);
  branch.wells=[...subset];branch.systemMode='custom';branch.cultivation=recipe;branch.cultivationReference=reference;
  delete branch.occupiedConfirmation;
  const replacements=[];
  if(rest.length){
    const original={...t,wells:rest,conditionName:t.conditionName||conditionNameFor(rest),replateAuto:false};
    if(movedReference)delete original.cultivationReference;
    branch.conditionName=conditionNameFor(subset);branch.replateAuto=false;
    for(const group of [original,branch]){
      delete group.occupiedConfirmation;delete group.replateMap;
      if(d.mode==='replate'){group.distribution='pooled';group.distributionOverride='pooled';}
    }
    replacements.push(original);
  }
  replacements.push(branch);
  d.targets.splice(i,1,...replacements);
  const rollback=()=>{d.targets.splice(i,replacements.length,t);invalidateTransfer();renderTransfer();};
  return {index:i+replacements.length-1,rollback};
}
function renderTransferSystem(){
  const d=transferSystemDraft,system=d.system,dialog=$('#transfer-system-dialog');
  dialog.innerHTML=`<form id="transfer-system-form" novalidate><div class="dialog-head"><div><span class="eyebrow">CULTURE CONDITIONS</span><h2>${d.subset?esc(d.subset.join('、')):'去向组 '+(d.index+1)} · 培养体系</h2></div><button type="button" class="icon-button" data-system-cancel aria-label="关闭培养体系编辑">×</button></div><label>从已记录体系载入（切换会替换本弹窗的草稿）<select id="system-reference">${d.options.map(o=>`<option value="${esc(o.key)}" ${o.key===d.key?'selected':''}>${esc(o.label)}</option>`).join('')}</select></label>${mediumEditorMarkup([{medium:system.medium}],null,false,'system-')}<div class="two"><label>目标特殊处理<div class="cell-autocomplete"><textarea id="system-treatment" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="system-treatment-suggestions">${esc(system.treatment||'')}</textarea><div id="system-treatment-suggestions" class="cell-name-suggestions" role="listbox" hidden></div></div></label><label>处理浓度 / 剂量<input id="system-concentration" value="${esc(system.concentration||'')}"></label></div><label class="inline-check"><input type="checkbox" id="system-continue-active" ${system.continue_active?'checked':''}>延续参照记录中已登记的进行中处理</label><p class="muted">${esc((d.options.find(o=>o.key===d.key)?.well.active_treatments||[]).map(x=>x.name+' '+x.concentration).join('；')||'参照记录没有进行中处理')}</p><div class="dialog-actions"><button type="button" class="button secondary" data-system-cancel>取消</button><button type="submit" class="button primary">${d.subset?'应用并确认所选孔':'应用到此去向组'}</button></div></form>`;
  const root=$('#system-medium-editor');bindMediumEditor([{medium:system.medium}],null,root,'system-');
  root.querySelector('.medium-help').textContent='编辑本组完整配方，未知项保留未记录；应用后仍需在主窗口确认保存。';
  root.querySelectorAll('[data-medium-apply]').forEach(box=>{box.checked=true;box.disabled=true;box.closest('.medium-field').classList.add('enabled');});
  attachHistoryAutocomplete($('#system-treatment'),$('#system-treatment-suggestions'),()=>treatmentHistory(state,boot.treatments||[]),{label:'特殊处理',filter:filterTreatments});
  root.querySelectorAll('.medium-list-note').forEach(p=>p.textContent='以下列表作为本组完整设置保存。');
  const close=()=>{dialog.close();transferSystemDraft=null;dirty=false;};
  dialog.oncancel=e=>{e.preventDefault();close();};dialog.querySelectorAll('[data-system-cancel]').forEach(b=>b.onclick=close);
  $('#system-reference').onchange=()=>{const option=d.options.find(o=>o.key===$('#system-reference').value);d.key=option.key;d.system={...transferCultureSystem(option.well),continue_active:!!option.well.active_treatments?.length};renderTransferSystem();};
  $('#transfer-system-form').onsubmit=e=>{
    e.preventDefault();if(transferDraft?.targets[d.index]!==d.target||d.target.locked)return toast('去向组已变化，请重新打开培养体系编辑。',true);
    const medium={...mediumDefaults(d.system.medium),...collectMediumPatch(root)};
    const recipe={medium,treatment:$('#system-treatment').value,concentration:$('#system-concentration').value,continue_active:$('#system-continue-active').checked};
    const reference=structuredClone(d.options.find(o=>o.key===d.key).reference);
    if(d.subset){
      let staged;
      try{staged=applySubsetSystem(d,recipe,reference);}catch(error){return toast(error.message,true);}
      close();confirmSystemAndContinue(staged.index,staged.rollback);return;
    }
    d.target.systemMode='custom';d.target.cultivation=recipe;d.target.cultivationReference=reference;
    close();invalidateTransfer();renderTransfer();
  };
}
