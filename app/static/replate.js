'use strict';
function transferSourceOrder(keys){
  const order=new Map(sourceOptions(true).map((s,i)=>[s.key,i]));
  return [...keys].sort((a,b)=>(order.get(a)??1e9)-(order.get(b)??1e9));
}
function transferGlobalSourceLocks(){
  return new Set(sourceOptions(true).filter(s=>transferSourceLocked(s.key)||lockedTransferDestination(s.key)).map(s=>s.key));
}
function setTransferSourceSelection(keys){
  const d=transferDraft;if(!d||busy)return;
  const next=new Set(keys),old=Object.keys(d.sources),available=new Map(sourceOptions(true).map(s=>[s.key,s]));
  if(old.some(key=>transferSourceLocked(key)&&!next.has(key))||[...next].some(key=>!d.sources[key]&&lockedTransferDestination(key)))return toast('所选来源与锁定去向冲突，请先取消相应锁定。',true);
  if([...next].some(key=>!available.has(key)))return toast('来源已变化，请重新选择。',true);
  const follows=d.mode!=='assay'&&d.targets.length===1&&!d.targets[0].locked&&old.length===d.targets[0].sourceKeys.length&&old.every(k=>d.targets[0].sourceKeys.includes(k));
  d.sources=Object.fromEntries(transferSourceOrder(next).map(key=>{const s=available.get(key);return [key,d.sources[key]||{id:s.id,well:s.well,role:'',amount:''}];}));
  if(d.mode!=='assay'){
    for(const t of d.targets)if(!t.locked)t.sourceKeys=t.sourceKeys.filter(k=>next.has(k));
    if(follows)d.targets[0].sourceKeys=Object.keys(d.sources);
    if(d.mode==='replate')d.targets.filter(t=>!t.locked).forEach(t=>syncReplateTarget(t));
  }
  if(d.mode==='replate'&&!Object.keys(d.sources).some(key=>available.get(key)?.kind==='细胞系'))d.cellLinePassage=false;
  d.endSources=d.endSources.filter(id=>Object.values(d.sources).some(s=>s.id===id));
  invalidateTransfer();renderTransfer();
}
function setTransferTargetSourceSelection(index,keys){
  const d=transferDraft,t=d.targets[index];if(busy||!t)return;
  try{assertTransferTargetEditable(index);}catch(e){return toast(e.message,true);}
  if(t.continueCellGroup){
    const available=new Map(replateCellSourceOptions(t).map(s=>[s.key,s]));
    if([...keys].some(k=>!available.has(k)))return toast('请选择本板尚未安排的细胞来源。',true);
    t.addedSourceKeys||=[];
    for(const key of keys)if(!d.sources[key]){const s=available.get(key);d.sources[key]={id:s.id,well:s.well,role:'',amount:''};t.addedSourceKeys.push(key);}
    for(const key of t.addedSourceKeys)if(!keys.has(key)&&!d.targets.some(other=>other!==t&&other.sourceKeys.includes(key)))delete d.sources[key];
    t.addedSourceKeys=t.addedSourceKeys.filter(k=>keys.has(k));
  }else if([...keys].some(k=>!d.sources[k]))return toast('请先在当前来源中选择这些培养单元。',true);
  t.sourceKeys=transferSourceOrder(keys);
  if(d.mode==='replate')syncReplateTarget(t);
  invalidateTransfer();renderTransfer();
}
function replateCellSourceOptions(t,fallback=[]){
  if(!t.continueCellGroup)return fallback;
  const assigned=new Set(transferDraft.targets.filter(other=>other!==t).flatMap(other=>other.sourceKeys));
  return sourceOptions().filter(s=>t.cellSourceIds.includes(s.id)&&(!assigned.has(s.key)||t.sourceKeys.includes(s.key)));
}
function replateRemainingCellSources(t){
  const ids=t.cellSourceIds||[...new Set(t.sourceKeys.map(k=>transferDraft.sources[k]?.id).filter(Boolean))];
  const assigned=new Set(transferDraft.targets.flatMap(group=>group.sourceKeys));
  return sourceOptions().filter(s=>ids.includes(s.id)&&!assigned.has(s.key));
}
function confirmReplateCellGroup(index){
  const t=transferDraft?.targets[index];if(busy||transferDraft?.mode!=='replate'||!t||t.locked)return;
  toggleTransferTargetLock(index);
  if(t.locked){toast('当前细胞已确认，可继续添加同板其他细胞，最后统一预览保存。');$(`[data-target-card="${index}"]`)?.scrollIntoView?.({block:'start',behavior:'smooth'});}
}
function addReplateCellGroup(index,chosenKeys=null){
  const d=transferDraft,t=d?.targets[index];if(busy||!d||!isCultureMode(d.mode)||!t?.locked)return;
  const pending=d.targets.findIndex(group=>!group.locked);
  if(pending>=0){toast('请先完成当前待确认的一组。');$(`[data-target-card="${pending}"]`)?.scrollIntoView?.({block:'start',behavior:'smooth'});return;}
  if(!replateRemainingCellSources(t).length)return toast('本板已无尚未安排的细胞，可查看总预览并保存。');
  const ids=t.cellSourceIds||[...new Set(t.sourceKeys.map(k=>d.sources[k]?.id).filter(Boolean))];
  d.targets.push({ref:t.ref,wells:[],sourceKeys:[],distribution:'paired',append:false,treatment:'',concentration:'',systemMode:'same',locked:false,replateAuto:false,continueCellGroup:true,cellSourceIds:ids,sourceViewId:t.sourceViewId||ids[0],addedSourceKeys:[]});
  d.nextSourceTarget=null;
  if(chosenKeys?.size)setTransferTargetSourceSelection(d.targets.length-1,chosenKeys);
  else{invalidateTransfer();renderTransfer();}
  $(`[data-target-card="${d.targets.length-1}"]`)?.scrollIntoView?.({block:'start',behavior:'smooth'});
}
function cleanupReplateCellSources(t){
  for(const key of t.addedSourceKeys||[])if(!transferDraft.targets.some(other=>other.sourceKeys.includes(key)))delete transferDraft.sources[key];
  transferDraft.endSources=transferDraft.endSources.filter(id=>Object.values(transferDraft.sources).some(s=>s.id===id));
}
// Recompute only the editable draft. Saved receipts keep their recorded distribution.
function replateBinding(t){
  const selected=new Set(t.sourceKeys);
  let full=false, covered=0, matchedGroups=0;
  for(const c of state.containers){
    for(const group of c.well_groups||[]){
      const keys=group.wells.filter(w=>memberActive(c.wells[w])).map(w=>sourceKey(c.id,w));
      const overlap=keys.filter(k=>selected.has(k)).length;
      if(!overlap)continue;
      covered+=overlap;
      matchedGroups++;
      if(overlap===keys.length&&overlap===selected.size)full=true;
    }
  }
  return {full, spansGroups:matchedGroups>1||(covered>0&&covered<selected.size)};
}
function replateDecision(t){
  const n=t.sourceKeys.length, m=t.wells.length;
  if(t.conditionName!==undefined)return {mode:'pooled'};
  if(t.distributionOverride)return {mode:t.distributionOverride};
  if(!n||!m)return {mode:'paired'};
  const binding=replateBinding(t);
  const shared=transferDraft.targets.some(other=>other!==t&&other.ref&&other.wells.length&&
    other.sourceKeys.length===n&&other.sourceKeys.every(k=>t.sourceKeys.includes(k))&&
    !(other.locked&&other.distribution==='paired')&&other.distributionOverride!=='paired');
  const groupSelected=n>1&&binding.full&&transferDraft.sourceSelectionMode!=='single';
  if(n===m&&!groupSelected&&!shared)return {mode:'paired'};
  const problem=binding.spansGroups?'所选来源分属不同培养组，请分别安排目标。':transferPoolSourceError(t);
  return problem?{mode:'paired',problem}:{mode:'pooled'};
}
function updateReplateDistributions(){
  if(transferDraft.mode!=='replate')return;
  for(const t of transferDraft.targets){
    if(!t.locked)t.distribution=replateDecision(t).mode;
  }
}
function initializeReplate(){
  const d=transferDraft;d.clearSources??=true;
  for(const c of d.newContainers)if(!d.smartCulture&&c.name.endsWith(' · 后代'))c.name=c.name.slice(0,-5)+' · 移孔换液';
  for(const t of d.targets){t.distribution||='paired';t.replateAuto??=!!transferTarget(t.ref)?.key;syncReplateTarget(t);}
}
function syncReplateTarget(t,force=false){
  if(transferDraft.mode!=='replate'||t.locked)return;
  const c=transferTarget(t.ref);if(!c)return;
  const sources=transferSourceOrder(t.sourceKeys),valid=transferTargetKeys(c);
  if(!force&&t.distributionOverride==='paired'&&t.replateMap){
    t.replateMap=Object.fromEntries(sources.map(key=>[key,valid.includes(t.replateMap[key])?t.replateMap[key]:'']));
    t.wells=[...new Set(Object.values(t.replateMap).filter(Boolean))];return;
  }
  if(!force&&(!c.key||t.replateAuto===false)){
    setReplateTargetWells(t,t.wells.filter(k=>valid.includes(k)));return;
  }
  const keys=sources.map(k=>transferDraft.sources[k]?.well);
  const sameCoordinates=keys.length===new Set(keys).size&&keys.every(k=>valid.includes(k));
  t.wells=sameCoordinates?keys:groupType(c.type)?valid.slice(0,keys.length):[];
  t.replateAuto=true;delete t.replateMap;
}
function replatePairs(t,strict=true){
  if(t.distribution==='pooled')return [];
  const d=transferDraft,c=transferTarget(t.ref),sources=transferSourceOrder(t.sourceKeys),valid=c?transferTargetKeys(c):[];
  const targets=[...t.wells].sort((a,b)=>valid.indexOf(a)-valid.indexOf(b));
  if(strict&&sources.length!==targets.length)throw new Error(`逐孔对应须一一对应：本组 ${sources.length} 个来源、${targets.length} 个目标，请为每个来源指定一个目标。请核对选中的孔位或分组。`);
  const map=t.replateMap||Object.fromEntries(sources.map((k,i)=>[k,targets[i]||'']));
  const pairs=sources.map(key=>({key,source:d.sources[key],well:map[key]||''}));
  if(strict&&(pairs.some(p=>!targets.includes(p.well))||new Set(pairs.map(p=>p.well)).size!==pairs.length))throw new Error('移孔对应有重复或缺失，请调整对应或重新按孔位顺序对应。');
  return pairs;
}
function setReplateTargetWells(t,nextWells){
  if(t.locked)throw new Error('此去向组已锁定，请先取消锁定。');
  const next=[...nextWells],c=transferTarget(t.ref),valid=c?transferTargetKeys(c):[];
  if(new Set(next).size!==next.length)throw new Error('目标孔位重复，请选择不同目标。');
  if(next.some(k=>!valid.includes(k)))throw new Error('目标孔位已变化，请重新选择。');
  const oldPairs=transferDraft.mode==='replate'?replatePairs(t,false):[];
  t.wells=next;t.replateAuto=false;
  if(transferDraft.mode!=='replate')return;
  updateReplateDistributions();
  if(t.distribution==='pooled'){
    delete t.replateMap;
    return;
  }
  const used=new Set(),map={};
  const sources=transferSourceOrder(t.sourceKeys);
  for(const {key,well} of oldPairs){
    if(next.includes(well)&&!used.has(well)){map[key]=well;used.add(well);}
  }
  for(const key of sources){
    const same=transferDraft.sources[key]?.well;
    if(!map[key]&&next.includes(same)&&!used.has(same)){map[key]=same;used.add(same);}
  }
  const free=valid.filter(k=>next.includes(k)&&!used.has(k));
  for(const key of sources)if(!map[key])map[key]=free.shift()||'';
  t.replateMap=map;
}
function replateExternalOccupiedKeys(t){
  const d=transferDraft,c=transferTarget(t.ref);if(!c)return [];
  const pairs=replatePairs(t,false),moving=new Set(Object.values(d.sources).map(s=>sourceKey(s.id,s.well)));
  return t.wells.filter(well=>{
    if(!c.wells?.[well]?.cell)return false;
    const pair=pairs.find(p=>p.well===well);
    if(t.distribution!=='pooled'&&pair?.source?.id===t.ref&&pair.source.well===well)return false;
    return !(d.clearSources!==false&&moving.has(sourceKey(t.ref,well)));
  });
}
function conditionNameFor(wells){
  return wells.length<=3?wells.join('、')+' 组':wells[0]+' 等 '+wells.length+' 孔组';
}
function conditionSplitMarkup(t,index){
  const c=transferTarget(t.ref);
  if(!isCultureMode(transferDraft.mode)||!c||!boot.layouts[c.type]||!t.sourceKeys.length||t.locked)return '';
  const rename=t.conditionName!==undefined?`<details class="condition-rename"><summary>修改组名</summary><label>条件组名称<input data-condition-name="${index}" maxlength="120" value="${esc(t.conditionName)}"></label></details>`:'';
  if(!t.wells.length||targetIsLinkOnly(t)||(transferDraft.mode==='replate'&&t.sourceKeys.length>1&&t.distribution!=='pooled'))return rename;
  if(t.wells.length===1)return `<button type="button" class="text-button" data-next-condition="${index}">同一来源再选其他目标孔</button>`+rename;
  const chips=t.wells.map(well=>`<button type="button" class="button secondary" data-condition-well="${esc(well)}" aria-label="单独设置 ${esc(well)} 培养体系">${esc(well)}</button>`).join('');
  const picker=`<div class="condition-quick" data-condition-picker="${index}"><span>单独设培养体系</span><div class="condition-well-list">${chips}</div>
  ${t.wells.length>2?'<button type="button" class="text-button" data-condition-multi aria-pressed="false">多孔同设</button><button type="button" class="button secondary" data-condition-edit hidden>编辑所选孔</button>':''}</div>`;
  return (t.wells.length>8?`<details><summary>分孔设置培养体系（${t.wells.length} 个目标孔）</summary>${picker}</details>`:picker)+rename;
}
function conditionGroupPayload(t){
  if(t.conditionName===undefined)return {};
  const name=t.conditionName.trim();
  if(!name)throw new Error('请填写条件组名称。');
  return {condition_group:name};
}
function bindConditionSplit(){
  document.querySelectorAll('[data-condition-name]').forEach(input=>input.oninput=()=>{
    const t=transferDraft.targets[+input.dataset.conditionName];
    if(t.locked||busy)return;
    t.conditionName=input.value;invalidateTransfer();
  });
  document.querySelectorAll('[data-condition-picker]').forEach(panel=>{
    const i=+panel.dataset.conditionPicker,buttons=[...panel.querySelectorAll('[data-condition-well]')];
    const multi=panel.querySelector('[data-condition-multi]'),edit=panel.querySelector('[data-condition-edit]');
    const subset=()=>buttons.filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.conditionWell);
    if(multi)multi.onclick=()=>{
      const on=multi.getAttribute('aria-pressed')!=='true';
      multi.setAttribute('aria-pressed',String(on));multi.textContent=on?'取消多选':'多孔同设';edit.hidden=!on;edit.disabled=true;
      buttons.forEach(b=>b.setAttribute('aria-pressed','false'));
    };
    buttons.forEach(b=>b.onclick=()=>{
      if(multi?.getAttribute('aria-pressed')!=='true')return openTransferSystem(i,[b.dataset.conditionWell]);
      b.setAttribute('aria-pressed',String(b.getAttribute('aria-pressed')!=='true'));
      const count=subset().length;edit.disabled=!count;edit.textContent=count?'编辑所选 '+count+' 孔':'编辑所选孔';
    });
    if(edit)edit.onclick=()=>{const wells=subset();if(wells.length)openTransferSystem(i,wells);};
  });
}
function replateGroupMarkup(t,index){
  if(transferDraft.mode!=='replate')return conditionSplitMarkup(t,index);
  const c=transferTarget(t.ref),pooled=t.distribution==='pooled',pairs=replatePairs(t,false),valid=c?transferTargetKeys(c):[],matching=t.sourceKeys.length===t.wells.length&&t.wells.length>0&&pairs.every(p=>p.well);
  const {problem}=replateDecision(t);
  const counts=`${t.sourceKeys.length} 个来源${pooled?'整体收集':''} → ${t.wells.length} 个目标`;
  let message=pooled?counts:counts+' · 逐孔对应';
  if(!t.sourceKeys.length)message='请选择来源孔';
  else if(!t.wells.length)message='请选择目标孔位';
  else if(!pooled&&!matching)message=counts+' · 待补全对应关系';
  const choices=[['auto','自动判断'],['paired','逐孔对应'],['pooled','整组收集']];
  const corrections=choices.map(([value,label])=>`<button type="button" class="button secondary" data-replate-distribution="${index}" data-distribution="${value}" aria-pressed="${(t.distributionOverride||'auto')===value}" ${t.locked?'disabled':''}>${label}</button>`).join('');
  const assignments=pooled?replateMappingReview(t):`<div class="actions"><button type="button" class="text-button" data-replate-same="${index}" ${!c?'disabled':''}>沿用来源孔位</button><button type="button" class="text-button" data-replate-reset="${index}">按孔位顺序重新对应</button></div><div class="table-wrap"><table><thead><tr><th>来源细胞 / 原位置</th><th>目标位置</th></tr></thead><tbody>${pairs.map(p=>{
    const parent=state.containers.find(c=>c.id===p.source?.id);
    return `<tr><td><strong>${esc(parent?.wells[p.source?.well]?.cell||'')}</strong><small>${esc(parent?.name||'来源')} / ${esc(p.source?.well||'')}</small></td><td><select aria-label="${esc(p.source?.well||'来源')} 的目标位置" data-replate-map="${index}" data-source-key="${esc(p.key)}" ${!c?'disabled':''}><option value="" ${!p.well?'selected':''}>待分配</option>${valid.map(k=>`<option value="${esc(k)}" ${p.well===k?'selected':''}>${esc(k)}${targetWellDescription(t,k)?' · '+esc(targetWellDescription(t,k)):''}</option>`).join('')}</select></td></tr>`;
  }).join('')}</tbody></table></div>`;
  return `<section class="replate-group">${conditionSplitMarkup(t,index)}<p class="replate-summary" role="status"><strong>${esc(message)}</strong></p>${problem?`<p class="replate-attention">${esc(problem)}</p>`:''}<details class="replate-mapping" data-replate-details="${index}" ${t.mappingOpen?'open':''}><summary>查看或修正孔位对应</summary><div class="replate-corrections" ${t.conditionName!==undefined?'hidden':''} role="group" aria-label="修正对应方式">${corrections}</div>${assignments}</details><details class="replate-volume"><summary>记录换入培养基体积（可选）</summary><div class="two"><label>每孔 / 瓶 / 皿换入体积<input data-replate-volume="${index}" inputmode="decimal" value="${esc(t.mediumChange?.volume_value||'')}" placeholder="未记录"></label><label>体积单位<input data-replate-volume-unit="${index}" value="${esc(t.mediumChange?.volume_unit||'mL')}" placeholder="例如 mL、μL"></label></div></details></section>`;
}
function bindReplateControls(){
  bindConditionSplit();
  if(!isCultureMode(transferDraft.mode))return;
  document.querySelectorAll('[data-next-picker]').forEach(panel=>{
    const i=+panel.dataset.nextPicker,t=transferDraft.targets[i];
    bindSourcePicker(panel,{scope:'next-'+i,options:replateRemainingCellSources(t),getSelected:()=>new Set(),
      viewId:t.nextSourceViewId||t.sourceViewId,selectionMode:transferDraft.sourceSelectionMode||'group',
      canEdit:()=>!busy&&t.locked&&transferDraft.targets.every(group=>group.locked),
      onViewChange:id=>{t.nextSourceViewId=id;renderTransfer();},onChange:keys=>{if(keys.size)addReplateCellGroup(i,keys);}});
  });
  document.querySelectorAll('[data-next-condition]').forEach(b=>b.onclick=()=>{
    const i=+b.dataset.nextCondition,d=transferDraft,t=d.targets[i];
    if(busy||!t.wells.length||!t.sourceKeys.length)return;
    const pending=d.targets.findIndex(group=>!group.locked);
    if(t.locked&&pending>=0){$(`[data-target-card="${pending}"]`)?.scrollIntoView?.({block:'start'});return;}
    if(!t.locked){
      t.conditionName=t.conditionName||conditionNameFor(t.wells);t.replateAuto=false;
      delete t.replateMap;delete t.occupiedConfirmation;
      if(d.mode==='replate'){t.distribution='pooled';t.distributionOverride='pooled';}
    }
    d.nextSourceTarget=null;
    const branch={ref:t.ref,sourceKeys:[...t.sourceKeys],wells:[],systemMode:'same',locked:false,replateAuto:false,append:false,
      conditionName:'条件组 '+(d.targets.length+1),cultureIntent:t.cultureIntent,sourceViewId:t.sourceViewId};
    if(d.mode==='replate'){branch.distribution='pooled';branch.distributionOverride='pooled';}
    d.targets.push(branch);invalidateTransfer();renderTransfer();
    $(`[data-target-grid="${d.targets.length-1}"]`)?.scrollIntoView?.({block:'center'});
  });
  document.querySelectorAll('[data-replate-confirm]').forEach(b=>b.onclick=()=>confirmReplateCellGroup(+b.dataset.replateConfirm));
  document.querySelectorAll('[data-replate-next]').forEach(b=>b.onclick=()=>addReplateCellGroup(+b.dataset.replateNext));
  const edit=(index,fn)=>{if(busy)return;try{assertTransferTargetEditable(index);const before=captureTargetSelection(transferDraft.targets[index]);fn();invalidateTransfer();renderTransfer();promptOccupiedSelection(index,before);}catch(e){toast(e.message,true);renderTransfer();}};
  document.querySelectorAll('[data-replate-details]').forEach(panel=>panel.ontoggle=()=>{
    if(panel.isConnected)transferDraft.targets[+panel.dataset.replateDetails].mappingOpen=panel.open;
  });
  document.querySelectorAll('[data-replate-distribution]').forEach(b=>b.onclick=()=>edit(+b.dataset.replateDistribution,()=>{
    const t=transferDraft.targets[+b.dataset.replateDistribution],next=b.dataset.distribution;
    if(!['auto','paired','pooled'].includes(next))return;
    t.distributionOverride=next==='auto'?null:next;
    t.mappingOpen=true;
    setReplateTargetWells(t,t.wells);
  }));
  document.querySelectorAll('[data-replate-same]').forEach(b=>b.onclick=()=>edit(+b.dataset.replateSame,()=>{
    const t=transferDraft.targets[+b.dataset.replateSame];t.distributionOverride='paired';t.mappingOpen=true;syncReplateTarget(t,true);
  }));
  document.querySelectorAll('[data-replate-reset]').forEach(b=>b.onclick=()=>edit(+b.dataset.replateReset,()=>{
    const t=transferDraft.targets[+b.dataset.replateReset];t.distributionOverride='paired';t.mappingOpen=true;delete t.replateMap;t.replateAuto=false;
  }));
  document.querySelectorAll('[data-replate-map]').forEach(input=>input.onchange=()=>edit(+input.dataset.replateMap,()=>{
    const t=transferDraft.targets[+input.dataset.replateMap],pairs=replatePairs(t,false),value=input.value,c=transferTarget(t.ref);
    if(value&&!transferTargetKeys(c).includes(value))throw new Error('目标孔位已变化，请重新选择。');
    if(value&&pairs.some(p=>p.key!==input.dataset.sourceKey&&p.well===value))throw new Error(`目标 ${value} 已分配给其他来源，不能重复。请先为该来源另选位置或设为待分配。`);
    t.distributionOverride='paired';t.mappingOpen=true;
    t.replateMap=Object.fromEntries(pairs.map(p=>[p.key,p.well]));t.replateMap[input.dataset.sourceKey]=value;
    t.wells=Object.values(t.replateMap).filter(Boolean);t.replateAuto=false;
  }));
  for(const [attr,key] of [['replateVolume','volume_value'],['replateVolumeUnit','volume_unit']]){
    const css=attr.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());
    document.querySelectorAll(`[data-${css}]`).forEach(input=>input.oninput=()=>{if(busy)return;const i=+input.dataset[attr];try{assertTransferTargetEditable(i);}catch(e){return toast(e.message,true);}const t=transferDraft.targets[i];t.mediumChange||={volume_value:'',volume_unit:'mL'};t.mediumChange[key]=input.value;invalidateTransfer();});
  }
}
function replateTargetPayload(t,previewOccupied=false){
  const d=transferDraft,c=transferTarget(t.ref),distribution=t.distribution||'paired',sourceKeys=Object.keys(d.sources);
  if(!['paired','pooled'].includes(distribution))throw new Error('请选择逐孔对应或合并收集后扩孔。');
  const issue=replateDecision(t).problem;
  if(issue&&t.wells.length!==t.sourceKeys.length)throw new Error(issue+' 请分别安排目标孔，或补全逐孔对应。');
  const pooled=distribution==='pooled',pairs=pooled?[]:replatePairs(t),keys=pooled?transferSourceOrder(t.sourceKeys):pairs.map(p=>p.key),wells=pooled?[...t.wells]:pairs.map(p=>p.well);
  if(!c||!c.name.trim()||!keys.length||!wells.length)throw new Error('请完整选择移孔来源与目标。');
  for(const key of keys){const s=d.sources[key],parent=state.containers.find(c=>c.id===s?.id);if(!s||!parent||parent.status!=='active'||!memberActive(parent.wells[s.well]))throw new Error('移孔来源必须仍在培养且有细胞。');}
  if(wells.some(well=>!transferTargetKeys(c).includes(well)))throw new Error('目标孔位已变化。');
  if(new Set(wells).size!==wells.length)throw new Error('目标孔位重复，请选择不同目标。');
  let mediumChange={};
  if(t.mediumChange?.volume_value?.trim()){
    const value=t.mediumChange.volume_value.trim(),unit=t.mediumChange.volume_unit?.trim();
    if(!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value)||!unit)throw new Error('换入体积须为非负数字，并填写单位。');
    mediumChange={medium_change:{volume_value:value,volume_unit:unit}};
  }
  return {...(c.key?{new_key:c.key}:{id:c.id}),distribution,...(d.smartCulture?{culture_action:cultureAction(t)}:{}),...conditionGroupPayload(t),...(distribution==='pooled'&&typeof transferCollection==='function'?{collection_id:transferCollection(keys).id}:{}),wells,source_indices:keys.map(key=>sourceKeys.indexOf(key)),...targetOccupiedPayload(t,previewOccupied),...targetCulturePayload(t,sourceKeys),...targetSeedingPayload(t),...mediumChange};
}
function validateReplateAssignments(targets,sourceCount){
  const assignments=new Map(),destinations=new Set();
  for(const [groupIndex,t] of targets.entries()){
    const distribution=t.distribution||'paired',indices=t.source_indices||[],wells=t.wells||[];
    if(!['paired','pooled'].includes(distribution))throw new Error('请选择有效的移孔分配方式。');
    if(!indices.length||!wells.length)throw new Error('每个去向组都需要来源和目标。');
    if(indices.some(i=>!Number.isInteger(i)||i<0||i>=sourceCount)||new Set(indices).size!==indices.length)throw new Error('来源编号无效或重复，请重新选择来源。');
    if(distribution==='paired'&&indices.length!==wells.length)throw new Error('逐孔对应须为每个来源指定一个目标。');
    for(const well of wells){const key=JSON.stringify([t.id?'existing':'new',t.id||t.new_key,well]);if(destinations.has(key)&&!(t.occupied_action==='append'&&t.draft_append&&t.occupied_confirmed))throw new Error('目标孔位重复，请调整去向组。');destinations.add(key);}
    const pool=distribution==='pooled'?'pool:'+JSON.stringify([...indices].sort((a,b)=>a-b)):null;
    for(const index of indices){
      const owner=pool||'paired:'+groupIndex+':'+index;
      if(assignments.has(index)&&(distribution!=='pooled'||assignments.get(index)!==owner))throw new Error('来源组存在重叠或重复使用。只有完全相同的整组来源可以共同分到多个收集扩孔去向组。');
      assignments.set(index,owner);
    }
  }
  if(assignments.size!==sourceCount)throw new Error('有来源尚未分配去向，请补充或取消该来源。');
}
function replateMappingReview(t){
  const c=transferTarget(t.ref);
  const resetClock=transferDraft.smartCulture?cultureAction(t)==='passage':transferDraft.cellLinePassage;
  const coCultured=transferOccupiedAction(t)==='append'?occupiedTargetKeys(t):[];
  const dayLabel=(w,well)=>((well&&coCultured.includes(well))||coCultured.length===t.wells.length)
    ? '组分 Day 0 '+esc(w?.day0||'未记录')
    : resetClock&&w?.kind==='细胞系'&&!w.components?.length
    ? '来源 Day 0 '+esc(w.day0)+'，传代后 Day 0 '+esc(transferDraft.at.slice(0,10))
    : 'Day 0 '+esc(w?.day0||'未记录')+'（保持）';
  const assignments=t.distribution==='pooled'?`<div class="replate-review-pool"><strong>${t.sourceKeys.length} 个来源整体收集 → ${t.wells.length} 个目标</strong><p>整体收集来源：${transferSourceOrder(t.sourceKeys).map(key=>{const s=transferDraft.sources[key],source=state.containers.find(c=>c.id===s?.id),w=source?.wells[s?.well];return `${esc(source?.name||'来源')} / <strong>${esc(s?.well||'')}</strong> · ${esc(w?.cell||'')} · ${dayLabel(w)}`;}).join('<br>')}</p><p>重铺到 ${esc(c?.name||'目标')}：${t.wells.map(well=>`<strong>${esc(well)}</strong>`).join('、')||'未选择'}</p><p>每个目标均来自上述整组来源；细胞数和体积未自动等分。</p></div>`:replatePairs(t,false).map(p=>{const source=state.containers.find(c=>c.id===p.source?.id),w=source?.wells[p.source?.well];return `<p>${esc(source?.name||'来源')} / <strong>${esc(p.source?.well||'')}</strong> → ${esc(c?.name||'目标')} / <strong>${esc(p.well||'未选择')}</strong><br>${esc(w?.cell||'')} · ${dayLabel(w,p.well)}</p>`;}).join('');
  return `<div class="replate-review-pairs">${assignments}<p>${transferDraft.clearSources!==false?'原孔全部移出，原孔若未同时作为目标则清空；原始信息保留在凭据。':'仅转移部分，未作为目标的原孔记录继续保留；已有目标的替换须单独核对。'}${t.mediumChange?.volume_value?' 换入体积：'+esc(t.mediumChange.volume_value+' '+t.mediumChange.volume_unit)+' / 培养单元。':''}</p></div>`;
}
