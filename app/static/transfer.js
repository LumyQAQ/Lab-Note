'use strict';
const transferModes={passage:'传代扩增',replate:'移孔换液 / 扩孔',seed:'实验分装',mix:'合并 / 共培养',assay:'取样 / 实验记录',copy:'复制孔位信息',move:'移动孔位信息',relink:'补充 / 更正来源关联'};
const cultureActionNames={passage:'传代扩增',move:'移孔换液',expand:'扩孔',exchange:'原位换液'};
const combinedCultureLabel='传代 / 移孔 / 扩孔';
function isCultureMode(mode){return mode==='passage'||mode==='replate';}

// Bottle/dish passage retains the existing grouped-vessel and lineage semantics.
// Plate sources and in-place transfers need the physical well-mapping editor.
function cultureEngine(d){
  if(d.keepReplateEditor||d.targets.some(t=>t.sourceKeys.some(key=>d.sources[key]?.id===t.ref)))return 'replate';
  if(d.targets.some(t=>t.cultureIntent==='maintenance'||t.mediumChange?.volume_value||t.distributionOverride||t.continueCellGroup)||d.clearSources)return 'replate';
  const refs=Object.values(d.sources);
  const hasPlate=refs.some(s=>boot.layouts[state.containers.find(c=>c.id===s.id)?.type]);
  if(hasPlate&&(refs.length!==1||state.containers.find(c=>c.id===refs[0].id)?.wells[refs[0].well]?.kind!=='细胞系'))return 'replate';
  return 'passage';
}
function cultureAction(t,d=transferDraft){
  if(!d.smartCulture||!isCultureMode(d.mode)||!t.ref||!t.wells.length||!t.sourceKeys.length)return '';
  if(t.locked&&t.lockedCultureAction)return t.lockedCultureAction;
  const sources=t.sourceKeys.map(k=>d.sources[k]).filter(Boolean);
  if(!sources.length||sources.length!==t.sourceKeys.length)return '';
  const intent=t.cultureIntent||d.defaultCultureIntent||'auto';
  const changesVessel=sources.some(s=>s.id!==t.ref);
  const hasLine=sources.some(s=>state.containers.find(c=>c.id===s.id)?.wells[s.well]?.kind==='细胞系');
  // Count shared condition groups on this destination plate once per physical well.
  const destinations=new Set();
  const keys=new Set(t.sourceKeys);
  for(const branch of d.targets){
    if(branch.ref===t.ref&&branch.sourceKeys.length===keys.size&&branch.sourceKeys.every(key=>keys.has(key))){
      for(const well of branch.wells)destinations.add(sourceKey(branch.ref,well));
    }
  }
  const expands=destinations.size>sources.length;
  if(intent==='passage')return 'passage';
  if(!changesVessel&&sources.length===t.wells.length&&(sources.length===1||t.distribution!=='pooled')){
    const stationary=sources.every(s=>t.wells.includes(s.well)&&(!t.replateMap||t.replateMap[sourceKey(s.id,s.well)]===s.well));
    if(stationary)return 'exchange';
  }
  if(intent==='auto'&&hasLine&&(changesVessel||expands))return 'passage';
  if(expands)return 'expand';
  return 'move';
}
function cultureActionMarkup(t,index,review=false){
  const d=transferDraft;if(!d.smartCulture||!isCultureMode(d.mode)||targetIsLinkOnly(t))return '';
  const action=cultureAction(t),intent=t.cultureIntent||d.defaultCultureIntent||'auto';
  if(!action)return '<p class="muted">选好来源和目标后显示操作与 Day 0。</p>';
  const refs=t.sourceKeys.map(k=>d.sources[k]).filter(Boolean);
  const kinds=refs.map(s=>state.containers.find(c=>c.id===s.id)?.wells[s.well]?.kind);
  const date=review?esc(d.at.slice(0,10)):'操作日';
  let clock=action==='passage'&&kinds.includes('细胞系')?'目标细胞系以'+date+'为 Day 0'+(kinds.includes('原代细胞')?'，原代细胞沿用激活日':''):'沿用各自的来源 Day 0';
  const added=transferOccupiedAction(t)==='append'?occupiedTargetKeys(t):[];
  if(added.length===t.wells.length)return '<p class="muted">加入共培养 · 各组分沿用各自的 Day 0</p>';
  if(added.length)clock+='；'+added.map(esc).join('、')+' 为共培养，沿用各组分的 Day 0';
  const label=(intent==='auto'?'自动判断':'已指定')+' · '+cultureActionNames[action];
  const summary=`<p class="culture-action-summary" role="status"><strong>${label}</strong> · ${clock}</p>`;
  if(review||t.locked)return summary;
  const options=[['auto','自动判断'],['passage','按传代记录'],['maintenance','按移孔 / 换液 / 扩孔记录']];
  return summary+`<details class="culture-intent"><summary>修正本组操作</summary><select aria-label="本组培养操作" data-culture-intent="${index}">${options.map(([value,name])=>`<option value="${value}" ${value===intent?'selected':''}>${name}</option>`).join('')}</select></details>`;
}
function bindCultureIntent(){
  document.querySelectorAll('[data-culture-intent]').forEach(input=>input.onchange=()=>{
    const i=+input.dataset.cultureIntent,t=transferDraft.targets[i];
    if(busy||!t||t.locked)return;
    t.cultureIntent=input.value;
    delete t.occupiedConfirmation;
    invalidateTransfer();renderTransfer();
  });
}
function cultureReceiptLabel(record){
  const labels=[...new Set(record.targets.map(t=>cultureActionNames[t.culture_action]).filter(Boolean))];
  if(labels.length&&record.targets.some(t=>t.operation==='append'))labels.push('加入共培养');
  return labels.join(' / ')||(record.cell_line_passage?'孔板传代':transferModes[record.mode]);
}

let transferDraft=null,transferSerial=0;
function transferContextSnapshot(d=transferDraft){return structuredClone({at:d.at,experiment:d.experiment,notes:d.notes,sources:d.sources,endSources:d.endSources,sourcePickerOpen:d.sourcePickerOpen,sourceDetailsOpen:d.sourceDetailsOpen,sourceViewId:d.sourceViewId,sourceSelectionMode:d.sourceSelectionMode});}
function transferCultureContext(){const d=transferDraft;return d.mode==='assay'?{...d,...d.cultureContext,mode:d.cultureMode}:d;}
function withTransferCulture(action){
  const d=transferDraft;if(d.mode!=='assay')return action();
  const assay=transferContextSnapshot();Object.assign(d,d.cultureContext);d.mode=d.cultureMode;
  try{return action();}finally{Object.assign(d,assay);d.mode='assay';}
}
function switchTransferMode(mode){
  const d=transferDraft;
  if(mode==='culture'){
    if(isCultureMode(d.mode))return;
    mode=d.mode==='assay'&&isCultureMode(d.cultureMode)?d.cultureMode:cultureEngine({...d,sources:d.mode==='assay'?d.cultureContext.sources:d.sources});
  }
  if(busy||mode===d.mode)return;
  const previousMode=d.mode;
  const cultureMode=d.mode==='assay'?d.cultureMode:d.mode;
  if(lockedTransferTargets().length&&mode!=='assay'&&mode!==cultureMode)return toast('请先取消培养去向组锁定，再更换培养操作类型。',true);
  if(mode==='assay'){
    d.cultureMode=d.mode;d.cultureContext=transferContextSnapshot();
    Object.assign(d,d.assayContext||{...structuredClone(d.cultureContext),sources:structuredClone(Object.fromEntries(Object.entries(d.cultureContext.sources).filter(([key])=>sourceOptions().some(s=>s.key===key)))),endSources:[]});
  }else if(d.mode==='assay'){
    d.assayContext=transferContextSnapshot();Object.assign(d,d.cultureContext);
  }
  d.mode=mode;if(mode!=='assay')d.cultureMode=mode;
  if(mode==='replate'&&previousMode!=='assay')initializeReplate();
  invalidateTransfer(previousMode!=='assay'&&mode!=='assay');renderTransfer();
}
function transferLabRecordLocked(id){return !!transferDraft?.labLocks?.[id];}
function rememberTransferExperiment(id,saved=false){
  const record=(state.lab_records||[]).find(r=>r.id===id);if(!record)return;
  const list=transferDraft.savedExperiments||=[],entry=list.find(r=>r.id===id);
  if(entry)Object.assign(entry,{title:record.title,version:record.version,saved:saved||entry.saved});
  else list.push({id,title:record.title,version:record.version,saved});
}
function toggleTransferLabLock(id){
  if(busy)return;
  const d=transferDraft;d.labLocks||={};
  if(d.labLocks[id])delete d.labLocks[id];
  else{const r=(state.lab_records||[]).find(r=>r.id===id);if(!r)return toast('实验记录已不存在。',true);d.labLocks[id]={version:r.version};rememberTransferExperiment(id);}
  invalidateTransfer();renderTransfer();
}
function transferLabClosed(d){return ({savedId})=>{
  if(transferDraft!==d)return;
  if(savedId){d.revision=state.revision;rememberTransferExperiment(savedId,true);}
  invalidateTransfer();render();renderTransfer();if(!$('#transfer-dialog').open)$('#transfer-dialog').showModal();
};}
function editTransferLabRecord(id){
  const d=transferDraft;if(!d||busy)return;
  if(transferLabRecordLocked(id))return toast('此实验已锁定，请先取消锁定。',true);
  const r=(state.lab_records||[]).find(r=>r.id===id);if(!r)return toast('未找到实验记录。',true);
  $('#transfer-dialog').close();
  if(labBeginEditor(r)){labEditor.onClose=transferLabClosed(d);labEditor.revision=d.revision;}
  else $('#transfer-dialog').showModal();
}

function sourceKey(id,well){return id+'|'+well;}
function localMinute(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace(' ','T');}
function vesselKeys(type,quantity=1){const dims=boot.layouts[type];return dims?Array.from({length:dims[0]},(_,r)=>Array.from({length:dims[1]},(_,c)=>String.fromCharCode(65+r)+(c+1))).flat():groupKeys(type,quantity);}
function sourceOptions(includeEnded=false){return state.containers.flatMap(c=>Object.entries(c.wells).filter(([,w])=>w.cell&&(includeEnded||(c.status==='active'&&memberActive(w)))).map(([well,w])=>({key:sourceKey(c.id,well),id:c.id,well,name:c.name,cell:w.cell,kind:w.kind,active:c.status==='active'&&memberActive(w)})));}
function openTransfer(modeOverride){
  if(!canLeave()||busy||frozen)return;
  const c=current();if(!c||c.status!=='active')return;
  const keys=(selected.size?[...selected]:Object.keys(c.wells)).filter(k=>memberActive(c.wells[k]));
  if(!keys.length)return toast('请先选择有细胞的来源孔位。',true);
  const platePassage=modeOverride==='plate-passage';
  if(platePassage&&!keys.some(key=>c.wells[key].kind==='细胞系'))return toast('请选择本次传代的细胞系培养孔。',true);
  const refs=keys.map(key=>displayMemberRef(state,c.id,key)).filter(Boolean);
  dirty=false;
  transferDraft={revision:state.revision,smartCulture:true,keepReplateEditor:platePassage||modeOverride==='replate',
    defaultCultureIntent:platePassage?'passage':modeOverride==='replate'?'maintenance':'auto',clearSources:platePassage||modeOverride==='replate',cellLinePassage:platePassage,mode:platePassage||modeOverride==='replate'?'replate':keys.some(k=>c.wells[k].components)?'mix':'passage',at:localMinute(),experiment:'',notes:'',
    sources:Object.fromEntries(refs.map(ref=>[sourceKey(ref.container_id,ref.well),{id:ref.container_id,well:ref.well,role:'',amount:''}])),newContainers:[],targets:[],endSources:[],review:false,assayType:'flow',assayVariant:'assay',savedExperiments:[],displayGroupId:c.display_group?c.id:null,sourcePickerOpen:false};
  transferDraft.sourceSelectionMode=typeof wellSelectionMode==='undefined'?'group':wellSelectionMode;
  if(isCultureMode(transferDraft.mode))transferDraft.mode=cultureEngine(transferDraft);
  addTransferContainer(c.display_group?c.primary_type:c.type,c.name+(platePassage?' · 孔板传代':modeOverride==='replate'?' · 移孔换液':transferDraft.mode==='replate'?' · 后续培养':' · 后代'),transferDraft.mode==='replate'&&groupType(c.type)?keys.length:groupQuantity(c));
  if(transferDraft.mode==='replate')initializeReplate();
  else if(transferDraft.mode==='passage'&&boot.layouts[c.type]){
    transferDraft.targets[0].wells=[...keys];transferDraft.targets[0].replateAuto=true;
  }
  renderTransfer();$('#transfer-dialog').showModal();
}
function addTransferContainer(type='T25',name='',quantity=1){
  const key='new-'+(++transferSerial);
  transferDraft.newContainers.push({key,type,quantity,name:name||'新容器 '+transferSerial,location:current()?.location||''});
  transferDraft.targets.push({ref:key,wells:groupType(type)?vesselKeys(type,quantity):[vesselKeys(type)[0]],sourceKeys:Object.keys(transferDraft.sources),append:false,treatment:'',concentration:'',systemMode:'same',locked:false});
}
function addNewTransferDestination(){
  const d=transferDraft;
  if(d.mode==='replate'&&d.targets.length>0){
    const sourceIds=[...new Set([...Object.values(d.sources).map(s=>s.id),...d.targets.flatMap(t=>t.cellSourceIds||[])].filter(Boolean))];
    const assigned=new Set(d.targets.flatMap(t=>t.sourceKeys));
    const unassignedInDraft=Object.keys(d.sources).filter(k=>!assigned.has(k));
    const remainingOnPlates=sourceOptions().filter(s=>sourceIds.includes(s.id)&&!assigned.has(s.key));
    const existingAllPooled=d.targets.every(t=>t.distribution==='pooled');
    if(unassignedInDraft.length>0||(remainingOnPlates.length>0&&!existingAllPooled)){
      const prev=transferTarget(d.targets.at(-1)?.ref);
      const isPlate=!!(prev&&boot.layouts[prev.type]);
      const type=isPlate?prev.type:'T25';
      const quantity=isPlate?1:(prev?groupQuantity(prev):1);
      const baseName=isPlate?(prev.name||'新容器').replace(/\s*·\s*第\s*\d+\s*板$/,''):'';
      const name=isPlate?`${baseName} · 第 ${d.newContainers.length+1} 板`:'新容器 '+(transferSerial+1);
      const key='new-'+(++transferSerial);
      d.newContainers.push({key,type,quantity,name,location:prev?.location||current()?.location||''});
      const sourceKeys=unassignedInDraft.length?transferSourceOrder(unassignedInDraft):[];
      d.targets.push({ref:key,wells:[],sourceKeys,distribution:'paired',append:false,treatment:'',concentration:'',systemMode:'same',locked:false,replateAuto:true,continueCellGroup:true,cellSourceIds:sourceIds,sourceViewId:sourceIds[0],addedSourceKeys:[]});
      syncReplateTarget(d.targets.at(-1));
      return;
    }
  }
  addTransferContainer();
  if(d.mode==='replate')syncReplateTarget(d.targets.at(-1));
}
function transferTarget(ref){
  const created=transferDraft.newContainers.find(c=>c.key===ref);if(created)return created;
  const original=state.containers.find(c=>c.id===ref);return original?{...original,...transferDraft.targetUpdates?.[ref]}:undefined;
}
function transferTargetKeys(c){
  const original=c?.id&&state.containers.find(x=>x.id===c.id);
  return groupType(c?.type)&&original&&groupType(original.type)?groupResizeKeys(original,c.type,groupQuantity(c)):vesselKeys(c.type,groupQuantity(c));
}
function pruneTransferTargets(){
  const used=new Set(transferDraft.targets.map(t=>t.ref));
  transferDraft.newContainers=transferDraft.newContainers.filter(c=>used.has(c.key));
  for(const id of Object.keys(transferDraft.targetUpdates||{}))if(!used.has(id))delete transferDraft.targetUpdates[id];
}
function detachTransferTarget(index){
  assertTransferTargetEditable(index);
  const d=transferDraft,t=d.targets[index],c=transferTarget(t.ref);if(!c)return;
  const key='new-'+(++transferSerial);
  d.newContainers.push({key,name:c.name+' · 独立目标',type:c.type,quantity:groupQuantity(c),location:c.location||''});
  const oldKeys=transferTargetKeys(c),newKeys=vesselKeys(c.type,groupQuantity(c));
  t.wells=t.wells.map(w=>newKeys[oldKeys.indexOf(w)]).filter(Boolean);
  if(t.cultivationReference?.kind==='target'){t.systemMode='same';delete t.cultivation;delete t.cultivationReference;}
  t.ref=key;t.append=false;t.replateAuto=d.mode==='replate'&&!t.wells.length;t.anchorPlaceMode=false;
  if(d.mode==='replate')syncReplateTarget(t);else delete t.replateMap;
  pruneTransferTargets();invalidateTransfer();renderTransfer();
}
function updateTransferTarget(ref,patch){
  if(transferRefLocked(ref))throw new Error('此容器已被锁定去向组使用，请先取消锁定，或将当前组拆为独立目标。');
  const d=transferDraft,c=transferTarget(ref);if(!c)return;
  const kind=patch.type||c.type,oldQuantity=groupQuantity(c),quantity=Number(patch.quantity??(groupType(kind)?oldQuantity:1));
  if(!boot.types.includes(kind)||!Number.isInteger(quantity)||quantity<1||quantity>100||(!groupType(kind)&&quantity!==1))throw new Error('瓶/皿数量须为1–100的整数，孔板按一块记录。');
  const shapeChanged=kind!==c.type||quantity!==oldQuantity;
  const autoTargets=new Set(shapeChanged?d.targets.filter(t=>t.ref===ref&&d.mode==='replate'&&t.replateAuto===true&&!!c.key):[]);
  if(shapeChanged){
    const original=c.id&&state.containers.find(x=>x.id===c.id);
    const keys=original&&groupType(original.type)&&groupType(kind)?groupResizeKeys(original,kind,quantity):vesselKeys(kind,quantity),oldKeys=transferTargetKeys(c);
    if(!c.key){
      const original=state.containers.find(x=>x.id===ref);
      if(Object.values(d.sources).some(s=>s.id===ref))throw new Error('本次来源不能同时改类型或数量，请先在培养信息中修改。');
      const entries=Object.entries(original.wells),lost=groupType(original.type)&&groupType(kind)?entries.slice(quantity).filter(([,w])=>w.cell).map(([k])=>k):entries.filter(([k,w])=>w.cell&&!keys.includes(k)).map(([k])=>k);
      if(lost.length)throw new Error('无法保留已有成员记录：'+lost.join('、')+'。请保留数量或先调整记录。');
    }
    d.targets.filter(t=>t.ref===ref).forEach(t=>{
      if(groupType(kind)){
        const all=oldKeys.every(k=>t.wells.includes(k));
        t.wells=!groupType(c.type)||all?[...keys]:t.wells.map(k=>keys[oldKeys.indexOf(k)]).filter(Boolean);
      }else t.wells=t.wells.filter(k=>keys.includes(k));
    });
  }
  patch={...patch,quantity};
  if(c.key)Object.assign(c,patch);else{d.targetUpdates||={};d.targetUpdates[ref]={...(d.targetUpdates[ref]||{id:ref,name:c.name,type:c.type,quantity:oldQuantity,location:c.location}),...patch};}
  if(shapeChanged)d.targets.filter(t=>t.ref===ref).forEach(t=>{t.anchorPlaceMode=false;t.replateAuto=autoTargets.has(t);if(d.mode==='replate')syncReplateTarget(t);else delete t.replateMap;});
  invalidateTransfer();
}
function syncTransferTargetText(ref){
  const c=transferTarget(ref);if(!c)return;
  $('#transfer-dialog').querySelectorAll('[data-target-ref] option').forEach(o=>{if(o.value===ref)o.textContent=(c.key?'本次新建 · ':'')+c.name+' · '+c.type;});
  for(const key of ['name','location']){
    $('#transfer-dialog').querySelectorAll('[data-target-'+key+']').forEach(input=>{if(transferDraft.targets[+input.dataset[key==='name'?'targetName':'targetLocation']].ref===ref&&input!==document.activeElement)input.value=c[key]||'';});
    $('#transfer-dialog').querySelectorAll('[data-new-'+key+']').forEach(input=>{if(transferDraft.newContainers[+input.dataset[key==='name'?'newName':'newLocation']].key===ref&&input!==document.activeElement)input.value=c[key]||'';});
  }
}
function transferTargetEditor(c,index){
  if(!c)return '';
  const sharing=transferDraft.targets.filter(t=>t.ref===(c.key||c.id)).length;
  return `<div class="target-container-editor"><p class="muted">${sharing>1?`共用同一容器 · ${sharing} 个去向组。修改此容器会同步这些组；需分别设置时先拆为独立目标。`:'独立目标 · 本组可直接修改容器信息。'}${!c.key?' 已有容器的修改与本次转移一起保存，原孔位记录保留。':''}</p><div class="new-vessel-row transfer-vessel-row"><label>目标容器名称<input data-target-name="${index}" value="${esc(c.name)}"></label><label>目标容器类型<select data-target-type="${index}">${boot.types.map(t=>`<option ${c.type===t?'selected':''}>${t}</option>`).join('')}</select></label><label>瓶 / 皿数量<input type="number" min="1" max="100" step="1" data-target-quantity="${index}" value="${groupQuantity(c)}" ${groupType(c.type)?'':'disabled'}></label><label>目标存放位置<input data-target-location="${index}" value="${esc(c.location||'')}"></label></div></div>`;
}
function invalidateTransfer(markCulture=true){if(!transferDraft)return;if(markCulture&&transferDraft.mode!=='assay')transferDraft.culturePrepared=true;transferDraft.review=false;transferDraft.reviewPayload=null;refreshOccupiedConfirmLabels();}
function renderTransfer(){
  if(transferDraft.smartCulture&&isCultureMode(transferDraft.mode)&&!lockedTransferTargets().length){
    const prior=transferDraft.mode;
    transferDraft.mode=cultureEngine(transferDraft);
    if(prior==='passage'&&transferDraft.mode==='replate'){
      for(const t of transferDraft.targets)if(t.replateAuto===true)syncReplateTarget(t);
    }
  }
  if(transferDraft.mode==='replate')updateReplateDistributions();
  const d=transferDraft,options=sourceOptions(true).filter(s=>s.active||(!['assay','replate'].includes(d.mode)&&d.showEndedSources)||d.sources[s.key]),chosen=options.filter(s=>d.sources[s.key]);
  const targets=[...d.newContainers.map((c,i)=>({...c,ref:c.key,label:'本次新建 '+(i+1)+' · '+c.name+' · '+c.type})),...state.containers.filter(c=>c.status==='active').map(c=>{const projected=transferTarget(c.id);return {...projected,ref:c.id,label:projected.name+' · '+projected.type};})];
  const sourceContainers=state.containers.filter(c=>c.status==='active'&&chosen.some(s=>s.id===c.id));
  $('#transfer-dialog').innerHTML=`<div class="dialog-head"><div><span class="eyebrow">CULTURE TRANSFER</span><h2>传代 / 开展实验与实验去向</h2></div><button type="button" class="icon-button" id="close-transfer" aria-label="关闭传代窗口">×</button></div>
  <div class="transfer-mode" aria-label="操作类型">${['culture','seed','mix','assay'].map(key=>{const active=key==='culture'?isCultureMode(d.mode):d.mode===key;return `<button type="button" class="button ${active?'primary':'secondary'}" data-mode="${key}" aria-pressed="${active}">${key==='culture'?combinedCultureLabel:transferModes[key]}</button>`;}).join('')}</div>
  <p class="muted">${isCultureMode(d.mode)?'选择来源和目标后，各去向组会显示操作类型及 Day 0，可在保存前修正。':d.mode==='assay'?'优先加入已有未结束实验，也可新建。':'按实际操作选择来源细胞与去向。'}</p>
  ${d.mode!=='assay'&&transferOperationLabel()==='补充 / 更正来源关联'?'<p class="notice">当前仅补充/更正来源关联，不重置培养时间，也不更改孔内记录。下方时间记作本次更正时间。</p>':''}<div class="two"><label>实际操作 / 更正时间（北京时间）<input id="transfer-at" type="datetime-local" value="${esc(d.at)}"></label><label>关联实验编号<input id="transfer-experiment" value="${esc(d.experiment)}" placeholder="例如 EXP-20261115-01"></label></div>
  <h3 class="transfer-step">1 · 当前来源 <span class="muted">${chosen.length} 个培养单元</span></h3><div class="transfer-mode" role="group" aria-label="来源选择方式">${[['group','整组'],['single','单孔']].map(([mode,label])=>`<button type="button" class="button ${(d.sourceSelectionMode||'group')===mode?'primary':'secondary'}" data-transfer-selection="${mode}">${label}</button>`).join('')}</div>
  <div id="transfer-source-picker">${sourcePickerMarkup({scope:'global',options,selectedKeys:Object.keys(d.sources),viewId:d.sourceViewId,selectionMode:d.sourceSelectionMode||'group',lockedKeys:transferGlobalSourceLocks()})}</div>
  ${d.mode!=='assay'&&d.mode!=='replate'?`<label class="inline-check"><input type="checkbox" id="transfer-show-ended" ${d.showEndedSources?'checked':''}>显示已结束的来源（仅用于关联更正）</label>`:''}
  <details id="transfer-source-details" ${d.sourceDetailsOpen?'open':''}><summary>角色 / 加入量（可选）</summary>  ${chosen.length?`<div class="table-wrap"><table><thead><tr><th>选中的来源</th><th>细胞角色（可选）</th><th>${d.mode==='assay'?((d.sourceSelectionMode||'group')==='group'?'各原孔记录量（整组取样量见下方）':'每份样本取用量（可选）'):d.mode==='replate'?'来源加入量 / 收集量（可选）':'每个目标的加入量（可选）'}</th></tr></thead><tbody>${chosen.map(s=>`<tr><td>${esc(s.name)} / ${esc(s.well)}<small>${esc(s.cell)}</small></td><td><input aria-label="${esc(s.name+' '+s.well)} 角色" data-source-role="${esc(s.key)}" value="${esc(d.sources[s.key].role)}" placeholder="如效应细胞 / 靶细胞"></td><td>${unitChoice(`<input aria-label="${esc(s.name+' '+s.well)} 加入量" data-source-amount="${esc(s.key)}" value="${esc(d.sources[s.key].amount)}" placeholder="实际数量或体积，注明单位">`,[...unitPresets.volume,'cells'],'加入量单位',true)}</td></tr>`).join('')}</tbody></table></div>`:''}
<p class="muted">填写实际加入量并注明单位；未填写时不推算来源消耗。</p></details>
  ${d.mode==='replate'?`<label class="inline-check replate-clear"><input type="checkbox" id="replate-clear-sources" ${d.clearSources!==false?'checked':''}>原孔细胞全部移出，保存后清空原孔当前内容</label><p class="muted">未勾选表示仅转移部分、原孔继续保留；原始内容始终保存在移孔换液凭据中。</p>`:''}
  ${d.mode==='assay'?transferAssayMarkup(d):`${transferDestinationMarkup(d,chosen,targets)}
  <h3 class="transfer-step">3 · 来源余量与操作备注</h3><p class="muted">来源默认继续保留。仅在实际用完且无需继续培养时，勾选结束来源容器；孔板仍有未选择细胞时不能整板结束。</p>${sourceContainers.map(c=>`<label class="inline-check"><input type="checkbox" data-end-source="${c.id}" ${d.endSources.includes(c.id)?'checked':''}>本次操作后结束 ${esc(c.name)}${groupQuantity(c)>1?' 中所选的瓶/皿':''}</label>`).join('')}<label>本次操作备注<textarea id="transfer-notes">${esc(d.notes)}</textarea></label>`}
  <div class="dialog-actions"><button class="button secondary" id="cancel-transfer">取消</button><button class="button primary" id="commit-transfer">${d.mode==='assay'?'查看本次操作总预览':'确认并保存转移记录'}</button></div>`;
  $('#close-transfer').onclick=$('#cancel-transfer').onclick=()=>{if(!busy&&confirm('关闭传代窗口？尚未提交的设置不会保存。')){$('#transfer-dialog').close();transferDraft=null;}};
  $('#transfer-dialog').oncancel=e=>{if(busy){e.preventDefault();return;}transferDraft=null;};
  const sourceDetails=$('#transfer-source-details');sourceDetails.ontoggle=()=>{if(transferDraft===d&&$('#transfer-source-details')===sourceDetails)d.sourceDetailsOpen=sourceDetails.open;};
  bindSourcePicker($('#transfer-dialog'),{scope:'global',options,getSelectionMode:()=>d.sourceSelectionMode||'group',getSelected:()=>new Set(Object.keys(d.sources)),lockedKeys:transferGlobalSourceLocks(),canEdit:()=>transferDraft===d&&!busy,onChange:setTransferSourceSelection,onViewChange:id=>{d.sourceViewId=id;renderTransfer();}});
  const guardTarget=(index,action)=>{try{assertTransferTargetEditable(index);action();}catch(error){toast(error.message,true);renderTransfer();}};
  const guardGlobal=action=>{if(d.mode!=='assay'&&lockedTransferTargets().length){toast('请先取消去向组锁定，再修改共用操作信息。',true);renderTransfer();return;}action();};
  document.querySelectorAll('[data-transfer-selection]').forEach(button=>button.onclick=()=>{if(busy)return;d.sourceSelectionMode=button.dataset.transferSelection;invalidateTransfer(false);renderTransfer();});
  if($('#transfer-show-ended'))$('#transfer-show-ended').onchange=e=>{d.showEndedSources=e.target.checked;renderTransfer();};
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>switchTransferMode(b.dataset.mode));
  if($('#replate-clear-sources'))$('#replate-clear-sources').onchange=e=>guardGlobal(()=>{d.clearSources=e.target.checked;invalidateTransfer();renderTransfer();});
  for(const [id,key] of [['transfer-at','at'],['transfer-experiment','experiment'],['transfer-notes','notes']])$('#'+id).oninput=e=>guardGlobal(()=>{d[key]=e.target.value;invalidateTransfer();});
  for(const [attr,key] of [['sourceRole','role'],['sourceAmount','amount']])document.querySelectorAll(`[data-${attr==='sourceRole'?'source-role':'source-amount'}]`).forEach(input=>input.oninput=()=>{
    if(transferSourceLocked(input.dataset[attr])){toast('此来源参数已锁定，请先取消锁定。',true);renderTransfer();return;}
    d.sources[input.dataset[attr]][key]=input.value;invalidateTransfer();
  });
  if($('#add-new-transfer'))$('#add-new-transfer').onclick=()=>{addNewTransferDestination();invalidateTransfer();renderTransfer();};
  if($('#link-existing-transfer'))$('#link-existing-transfer').onclick=addExistingTransferTarget;
  document.querySelectorAll('[data-target-lock]').forEach(b=>b.onclick=()=>toggleTransferTargetLock(+b.dataset.targetLock));
  document.querySelectorAll('[data-remove-target]').forEach(b=>b.onclick=()=>guardTarget(+b.dataset.removeTarget,()=>{const [removed]=d.targets.splice(+b.dataset.removeTarget,1);cleanupReplateCellSources(removed);pruneTransferTargets();invalidateTransfer();renderTransfer();}));
  document.querySelectorAll('[data-target-ref]').forEach(input=>input.onchange=()=>guardTarget(+input.dataset.targetRef,()=>{
    const t=d.targets[+input.dataset.targetRef],before=captureTargetSelection(t);t.ref=input.value;t.append=false;t.replateAuto=false;t.anchorPlaceMode=false;
    if(d.mode==='replate')syncReplateTarget(t);else{t.wells=[];delete t.replateMap;}
    // A previous target-based recipe cannot silently follow a different vessel.
    if(t.cultivationReference?.kind==='target'){t.systemMode='same';delete t.cultivation;delete t.cultivationReference;}
    pruneTransferTargets();invalidateTransfer();renderTransfer();promptOccupiedSelection(d.targets.indexOf(t),before);
  }));
  for(const [attr,key] of [['targetName','name'],['targetLocation','location']]){
    const css=attr.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());document.querySelectorAll(`[data-${css}]`).forEach(input=>input.oninput=()=>guardTarget(+input.dataset[attr],()=>{const ref=d.targets[+input.dataset[attr]].ref;updateTransferTarget(ref,{[key]:input.value});syncTransferTargetText(ref);}));
  }
  document.querySelectorAll('[data-target-type]').forEach(input=>input.onchange=()=>guardTarget(+input.dataset.targetType,()=>{try{updateTransferTarget(d.targets[+input.dataset.targetType].ref,{type:input.value});}finally{renderTransfer();}}));
  document.querySelectorAll('[data-target-quantity]').forEach(input=>input.onchange=()=>guardTarget(+input.dataset.targetQuantity,()=>{try{updateTransferTarget(d.targets[+input.dataset.targetQuantity].ref,{quantity:input.value});}finally{renderTransfer();}}));
  document.querySelectorAll('[data-target-detach]').forEach(b=>b.onclick=()=>guardTarget(+b.dataset.targetDetach,()=>detachTransferTarget(+b.dataset.targetDetach)));
  for(const [i,t] of d.targets.entries())bindSourcePicker($('#transfer-dialog'),{scope:'target-'+i,options:replateCellSourceOptions(t,chosen),getSelectionMode:()=>d.sourceSelectionMode||'group',getSelected:()=>new Set(t.sourceKeys),lockedKeys:t.locked?t.sourceKeys:[],canEdit:()=>transferDraft===d&&!busy&&!t.locked,onChange:keys=>setTransferTargetSourceSelection(i,keys),onViewChange:id=>{t.sourceViewId=id;renderTransfer();}});
  document.querySelectorAll('[data-target-grid]').forEach(grid=>{
    const index=Number(grid.dataset.targetGrid), target=d.targets[index];
    if(target.anchorPlaceMode&&grid.classList.contains('is-anchor-place')){
      grid.onclick=event=>{
        const btn=event.target?.closest?.('[data-well]');
        if(!btn||btn.disabled||busy)return;
        placeReplateAtAnchor(index,btn.dataset.well);
      };
      return;
    }
    let previewWells=null;
    bindWellSelection(grid,{touchRange:true,
      getSelected:()=>new Set(previewWells||target.wells),
      canStart:()=>!busy&&!target.locked,
      onChange:(next,preview)=>{
        if(target.locked)return;
        for(const button of grid.querySelectorAll('[data-well]')){
          const selected=next.has(button.dataset.well);
          button.classList.toggle('selected',selected);
          button.setAttribute('aria-pressed',String(selected));
        }
        previewWells=preview?new Set(next):null;
        if(preview)return;
        const before=captureTargetSelection(target);
        setReplateTargetWells(target,next);
        invalidateTransfer();
        if(isCultureMode(d.mode)&&d.targets.length>1){
          // A second destination may use the same pool. Update both summaries.
          renderTransfer();
        }else{
          refreshOccupiedTargetUi(index);
          if(d.mode==='replate'||d.mode==='passage'){
            $(`[data-replate-panel="${index}"]`).innerHTML=cultureActionMarkup(target,index)+replateGroupMarkup(target,index);
            bindCultureIntent();
            bindReplateControls();
          }
        }
        promptOccupiedSelection(index,before);
      }
    });
  });
  document.querySelectorAll('[data-target-all]').forEach(b=>b.onclick=()=>guardTarget(+b.dataset.targetAll,()=>{const t=d.targets[+b.dataset.targetAll],c=transferTarget(t.ref),before=captureTargetSelection(t);setReplateTargetWells(t,c?transferTargetKeys(c):[]);invalidateTransfer();renderTransfer();promptOccupiedSelection(d.targets.indexOf(t),before);}));
  document.querySelectorAll('[data-target-none]').forEach(b=>b.onclick=()=>guardTarget(+b.dataset.targetNone,()=>{const t=d.targets[+b.dataset.targetNone];setReplateTargetWells(t,[]);invalidateTransfer();renderTransfer();}));
  document.querySelectorAll('[data-target-append]').forEach(input=>input.oninput=()=>guardTarget(+input.dataset.targetAppend,()=>{d.targets[+input.dataset.targetAppend].append=input.checked;invalidateTransfer();}));
  document.querySelectorAll('[data-system-same]').forEach(b=>b.onclick=()=>useSameTransferSystem(+b.dataset.systemSame));
  document.querySelectorAll('[data-system-edit]').forEach(b=>b.onclick=()=>openTransferSystem(+b.dataset.systemEdit));
  bindCultureIntent();
  bindTransferSeeding();
  bindOccupiedTargets();
  bindReplateControls();
  if(d.mode==='assay')bindTransferAssayGroups();
  applyTransferLocks();
  document.querySelectorAll('[data-end-source]').forEach(b=>b.onchange=()=>{setTransferEndChoice(b.dataset.endSource,b.checked,true);invalidateTransfer();});
  $('#commit-transfer').onclick=()=>previewTransfer();
  if(d.mode==='assay'){
    if($('#transfer-lab-type'))$('#transfer-lab-type').onchange=()=>{d.assayType=$('#transfer-lab-type').value;d.assayVariant=Object.keys(boot.lab_schema.modules[d.assayType].variants)[0];renderTransfer();};
    if($('#transfer-lab-variant'))$('#transfer-lab-variant').onchange=()=>{d.assayVariant=$('#transfer-lab-variant').value;};
    if($('#transfer-existing-lab'))$('#transfer-existing-lab').onchange=()=>{d.assayRecordId=$('#transfer-existing-lab').value;renderTransfer();};
    document.querySelectorAll('[data-assay-destination]').forEach(b=>b.onclick=()=>{d.assayDestination=b.dataset.assayDestination;renderTransfer();});
    document.querySelectorAll('[data-lab-transfer-lock]').forEach(b=>b.onclick=()=>toggleTransferLabLock(b.dataset.labTransferLock));
    document.querySelectorAll('[data-transfer-lab-edit]').forEach(b=>b.onclick=()=>editTransferLabRecord(b.dataset.transferLabEdit));
    $('#transfer-open-lab').onclick=openTransferLabRecord;
  }
}

function transferOpenExperiments(){
  const rank={running:0,planned:1,draft:2};
  return (state.lab_records||[]).filter(labIsOpenExperiment).slice().sort((a,b)=>rank[a.status]-rank[b.status]||(b.updated_at||b.record_date||'').localeCompare(a.updated_at||a.record_date||''));
}
function transferAssayEntriesMarkup(d,preview=false){
  if(!d.savedExperiments?.length)return '';
  return `<section class="transfer-experiment-list"><h3>本次实验安排</h3>${d.savedExperiments.map(entry=>{
    const r=(state.lab_records||[]).find(r=>r.id===entry.id),locked=transferLabRecordLocked(entry.id);
    return `<div class="transfer-experiment-entry"><div><strong>${esc(r?.title||entry.title)}</strong><small>${esc(entry.id)} · ${r?esc(labTypeLabel(r)+' / '+labVariant(r).label+' · '+labStatusLabel(r)):''} · ${entry.saved!==false?'本次已保存':'仅锁定，尚未追加来源'}${locked?' · 已锁定':''}</small></div><div class="actions"><button type="button" class="text-button" ${preview?'data-review-lab':'data-transfer-lab-edit'}="${esc(entry.id)}" ${!r||(!preview&&locked)?'disabled':''}>${preview&&locked?'取消锁定并修改':'编辑实验'}</button>${!preview?`<button type="button" class="button secondary" data-lab-transfer-lock="${esc(entry.id)}">${locked?'取消锁定':'锁定此实验'}</button>`:''}</div></div>`;
  }).join('')}<p class="muted">实验记录单独保存；锁定保护本次窗口中的编辑，可取消锁定。其他实验可继续安排。</p></section>`;
}
function transferAssayMarkup(d){
  const modules=boot.lab_schema?.modules||{},choices=['flow','western','pcr','elisa','luci','treatment'].filter(k=>modules[k]),existing=transferOpenExperiments();
  if(!d.assayDestination)d.assayDestination=existing.length?'existing':'new';
  if(!d.assayRecordId&&existing.length)d.assayRecordId=existing[0].id;
  const selectedRecord=existing.find(r=>r.id===d.assayRecordId),locked=transferLabRecordLocked(d.assayRecordId);
  if(!choices.includes(d.assayType))d.assayType=choices[0];
  const variants=modules[d.assayType]?.variants||{};if(!variants[d.assayVariant])d.assayVariant=Object.keys(variants)[0];
  return `<section class="transfer-assay"><h3>2 · 选择实验去向</h3><div class="transfer-mode">${[['existing','已有未结束实验'],['new','新建实验']].map(([key,label])=>`<button type="button" class="button ${d.assayDestination===key?'primary':'secondary'}" data-assay-destination="${key}">${label}</button>`).join('')}</div>
  ${d.assayDestination==='existing'?`<label>选择已有实验<select id="transfer-existing-lab"><option value="">${existing.length?'请选择未结束实验':'暂无未结束实验，可点击“新建实验”'}</option>${existing.map(r=>`<option value="${esc(r.id)}" ${r.id===d.assayRecordId?'selected':''}>${esc(r.title)} · ${esc(labVariant(r).label)} · ${esc(labStatusLabel(r))} · ${esc(r.record_date)}</option>`).join('')}</select></label>${selectedRecord?`<p class="muted">${esc(selectedRecord.id)} · ${esc(labTypeLabel(selectedRecord))} / ${esc(labVariant(selectedRecord).label)} <button type="button" class="text-button" data-lab-transfer-lock="${esc(selectedRecord.id)}">${locked?'取消锁定':'锁定此实验'}</button></p>`:d.assayRecordId?'<p class="muted">原选择已结束或不可用，请重新选择。</p>':''}<p class="muted">追加所选细胞来源与样本，保留原样本和结果；已关联的来源保留原关联快照，不重复追加样本。保存后返回此处。</p>`:`<div class="two"><label>实验模块<select id="transfer-lab-type">${choices.map(k=>`<option value="${k}" ${d.assayType===k?'selected':''}>${esc(modules[k].label)}</option>`).join('')}</select></label><label>记录阶段<select id="transfer-lab-variant">${Object.entries(variants).map(([key,v])=>`<option value="${key}" ${d.assayVariant===key?'selected':''}>${esc(v.label)}</option>`).join('')}</select></label></div><p class="muted">按当前选择的来源生成样本行，保存后返回这里。</p>`}
  ${transferAssayGroupsMarkup(d)}<label>取样 / 分装备注<textarea id="transfer-notes">${esc(d.notes)}</textarea></label><button type="button" class="button primary" id="transfer-open-lab" ${!Object.keys(d.sources).length||(d.assayDestination==='existing'?(!selectedRecord||locked):!choices.length)?'disabled':''}>${d.assayDestination==='existing'?'进入所选实验记录':'进入新实验记录'} →</button>${locked&&d.assayDestination==='existing'?'<p class="muted">此实验已锁定。可取消锁定后编辑，或选择其他实验。</p>':''}${transferAssayEntriesMarkup(d)}</section>`;
}
function openTransferLabRecord(){
  const d=transferDraft;if(!d||busy||d.mode!=='assay')return;
  if(d.revision!==state.revision)return toast('来源记录已变化，请重新打开分装窗口。',true);
  const sources=Object.values(d.sources),available=sourceOptions();
  if(!sources.length||sources.some(s=>!available.some(x=>x.id===s.id&&x.well===s.well)))return toast('请选择有效的来源细胞。',true);
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(d.at)||!Number.isFinite(Date.parse(d.at)))return toast('请填写有效的取样 / 分装时间。',true);
  const existing=d.assayDestination==='existing'?(state.lab_records||[]).find(r=>r.id===d.assayRecordId):null;
  if(d.assayDestination==='existing'&&(!labIsOpenExperiment(existing)||transferLabRecordLocked(existing.id)))return toast('请选择未结束且未锁定的实验。',true);
  const type=existing?.type||d.assayType,stage=existing?.variant||d.assayVariant;
  const module=boot.lab_schema?.modules[type],variant=module?.variants[stage];
  if(!variant)return toast('实验模块尚未载入，请刷新页面。',true);
  const sampleTable=variant.tables.find(t=>t.key===(stage==='blot'?'lanes':'samples'));
  const refs=sources.map(s=>({container_id:s.id,well:s.well}));
  const sourceLines=sources.map(s=>{const c=state.containers.find(c=>c.id===s.id);return `${c.name} / ${s.well}${s.role?' · 角色：'+s.role:''}${s.amount?' · 原孔记录量：'+s.amount:''}`;});
  const units=transferAssayUnits(existing),groups=units.filter(unit=>unit.kind==='group').map(unit=>unit.group);
  const rows=units.map(unit=>{
    const s=d.sources[unit.keys[0]],row={row_id:labRowId(),sample:unit.label,source:unit.key};
    if(sampleTable?.columns.some(f=>f.key==='notes'))row.notes=unit.kind==='group'?[`来自 ${unit.keys.length} 个原孔的同一收集组`,unit.collection.amount?'整组取样量：'+unit.collection.amount:'',unit.group.notes||''].filter(Boolean).join('；'):[s.role?'角色：'+s.role:'',s.amount?'取用量：'+s.amount:''].filter(Boolean).join('；');
    return row;
  });
  const preset={variant:stage,title:`${variant.label} · ${d.experiment||d.at.slice(0,10)}`,record_date:d.at.slice(0,10),experiment:d.experiment,
    notes:[d.notes,d.experiment?'安排时关联实验编号：'+d.experiment:'','从传代 / 开展实验窗口安排；取样 / 分装登记时间：'+d.at.replace('T',' '),...sourceLines].filter(Boolean).join('\n'),
    tables:sampleTable?{[sampleTable.key]:rows}:{},source_groups:groups,revision:d.revision,
    onClose:transferLabClosed(d)};
  $('#transfer-dialog').close();
  const opened=existing?openExistingLabRecordFromTransfer(existing.id,refs,preset):openNewLabRecord(type,refs,preset);
  if(!opened)$('#transfer-dialog').showModal();
}

function transferTargetPayload(t,previewOccupied=false){
  if(transferDraft.mode==='replate')return replateTargetPayload(t,previewOccupied);
  const d=transferDraft,sourceKeys=Object.keys(d.sources),c=transferTarget(t.ref);
  if(!c||!t.wells.length||!t.sourceKeys.length)throw new Error('每个去向组都需要容器、目标孔位和来源。');
  if(!c.name.trim())throw new Error('请填写目标容器名称。');
  if(t.sourceKeys.some(k=>!d.sources[k]))throw new Error('来源已改变，请重新选择。');
  const occupiedPayload=targetOccupiedPayload(t,previewOccupied),linkOnly=occupiedPayload.occupied_action==='link';
  for(const key of t.sourceKeys){const source=d.sources[key],parent=state.containers.find(c=>c.id===source.id),well=parent?.wells[source.well];if(!well?.cell)throw new Error('来源细胞已不可用，请重新选择。');if(!linkOnly&&(parent.status!=='active'||!memberActive(well)))throw new Error('已结束来源仅能用于来源关联更正。');}
  if(!linkOnly&&d.mode!=='mix'&&t.sourceKeys.length!==1){
    const ss=t.sourceKeys.map(k=>d.sources[k]),ids=new Set(ss.map(s=>s.id)),parent=state.containers.find(c=>c.id===ss[0]?.id),display=(state.display_groups||[]).find(g=>g.id===d.displayGroupId);
    const native=ids.size===1&&parent&&groupType(parent.type)&&groupQuantity(parent)>1,merged=display&&ss.every(s=>display.container_ids.includes(s.id));
    if(!native&&!merged)throw new Error('普通传代仅支持单来源或同组多个瓶/皿；不同来源同孔请选择合并培养。');
  }
  const valid=transferTargetKeys(c);
  for(const key of t.wells){
    if(!valid.includes(key))throw new Error('目标孔位已变化，请重新选择。');
    if((linkOnly?t.sourceKeys.map(k=>d.sources[k]):Object.values(d.sources)).some(s=>s.id===t.ref&&s.well===key))throw new Error('来源和目标不能是同一个培养单元。');
  }
  const source_indices=t.sourceKeys.map(k=>sourceKeys.indexOf(k));
  return {...(c.key?{new_key:c.key}:{id:c.id}),wells:t.wells,source_indices,...(d.mode==='passage'?conditionGroupPayload(t):{}),...(d.smartCulture&&d.mode==='passage'&&!linkOnly?{culture_action:cultureAction(t)}:{}),append:occupiedPayload.occupied_action==='append'||(!occupiedPayload.occupied_action&&d.mode==='mix'&&t.append),...occupiedPayload,...(linkOnly?{}:{inherit_medium:!t.systemMode&&d.mode!=='mix'&&t.inheritMedium!==false,treatment:t.treatment,concentration:t.concentration,...targetCulturePayload(t,sourceKeys),...targetSeedingPayload(t)})};
}
function transferPayload(){
  const d=transferDraft,sourceKeys=Object.keys(d.sources);
  verifyTransferLocks();
  if(d.mode==='assay')throw new Error('检测去向请点击“进入实验记录”填写并保存。');
  if(!sourceKeys.length||!d.targets.length)throw new Error('请选择来源并添加至少一个去向组。');
  const used=new Set();
  const targets=d.targets.map(t=>{
    const payload=transferTargetPayload(t);
    for(const key of t.wells){const full=t.ref+'|'+key;if(used.has(full)&&!(payload.occupied_action==='append'&&payload.draft_append&&payload.occupied_confirmed))throw new Error('同一目标孔出现多次，请合并为一个去向组。');used.add(full);}
    return payload;
  });
  if(d.mode==='replate')validateReplateAssignments(targets,sourceKeys.length);
  const usedExisting=new Set(targets.map(t=>t.id).filter(Boolean));
  return {mode:d.mode,...(d.mode==='replate'?{clear_sources:d.clearSources!==false,...(!d.smartCulture&&d.cellLinePassage?{cell_line_passage:true}:{})}:{}),at:d.at,experiment:d.experiment,notes:d.notes,display_group_id:d.displayGroupId||null,sources:Object.values(d.sources),new_containers:d.newContainers,targets,target_updates:Object.values(d.targetUpdates||{}).filter(c=>usedExisting.has(c.id)),end_sources:d.endSources.filter(id=>groupQuantity(state.containers.find(c=>c.id===id))===1),end_members:d.endSources.filter(id=>groupQuantity(state.containers.find(c=>c.id===id))>1).map(id=>({id,wells:Object.values(d.sources).filter(s=>s.id===id).map(s=>s.well)}))};
}
function returnTransferEdit(targetIndex=null,source=false){
  if(busy)return;
  $('#transfer-review-dialog').close();invalidateTransfer(false);
  if(targetIndex!==null||source){
    if(transferDraft.mode==='assay')switchTransferMode(transferDraft.cultureMode);
    if(targetIndex!==null){const t=transferDraft.targets[targetIndex];if(t){t.locked=false;delete t.lockSnapshot;}renderTransfer();}
    const element=targetIndex!==null?$(`[data-target-card="${targetIndex}"]`):$('#transfer-at');
    element?.scrollIntoView?.({block:'center'});(element?.querySelector?.('input')||element)?.focus?.();
  }
}
function transferEndingContexts(includeCulture){
  const d=transferDraft;if(!includeCulture)return [d];
  const culture=d.mode==='assay'?d.cultureContext:d,assay=d.mode==='assay'?d:d.assayContext;
  return [culture,assay].filter(Boolean);
}
function transferReviewSourceScope(includeCulture=transferDraft.reviewHasCulture){
  const contexts=transferEndingContexts(includeCulture);
  return {sources:Object.assign({},...contexts.map(c=>c.sources)),endSources:[...new Set(contexts.flatMap(c=>c.endSources||[]))],
    at:contexts.map(c=>c.at).filter(Boolean).sort().at(-1)||'',notes:contexts.map(c=>c.notes).filter(Boolean).join('\n')};
}
function setTransferEndChoice(id,checked,includeCulture){
  for(const context of transferEndingContexts(includeCulture)){
    if(!Object.values(context.sources).some(s=>s.id===id))continue;
    context.endSources=checked?[...new Set([...context.endSources,id])]:context.endSources.filter(value=>value!==id);
  }
}
function transferReviewEndChoices(scope,includeCulture){
  const groups=new Map();
  for(const source of Object.values(scope.sources||{})){
    if(!groups.has(source.id))groups.set(source.id,{id:source.id,wells:[]});
    const entry=groups.get(source.id);if(!entry.wells.includes(source.well))entry.wells.push(source.well);
  }
  return [...groups.values()].map(entry=>{
    const c=state.containers.find(c=>c.id===entry.id),partial=c&&groupType(c.type)&&groupQuantity(c)>1;
    let reason='';
    if(!c||c.status!=='active'||entry.wells.some(k=>!memberActive(c.wells[k]||{})))reason='来源已结束或不可用';
    else if(!groupType(c.type)&&Object.entries(c.wells).some(([k,w])=>memberActive(w)&&!entry.wells.includes(k)))reason='孔板还有未选择的细胞，不能结束整板';
    else if(includeCulture&&transferDraft.targets.some(t=>t.ref===entry.id&&t.wells.some(k=>!partial||entry.wells.includes(k))))reason='所选结束范围包含本次培养目标，不能结束';
    return {...entry,c,partial,reason};
  });
}
function transferReviewEndMarkup(scope,includeCulture){
  const choices=transferReviewEndChoices(scope,includeCulture),d=transferDraft,count=scope.endSources.length;
  return `<section class="review-target review-end-section"><h4>操作后的来源培养状态</h4><p>${count?'已选择结束 '+count+' 个来源容器 / 所选成员':'来源默认继续培养'}</p><div id="review-end-panel" ${d.reviewEndOpen||count?'':'hidden'}><p class="muted">勾选本次操作后用完、不再继续培养的来源；点击下方“确认”后才生效。未勾选的来源继续培养。去向组锁定不影响此选择。</p>${choices.map(({id,wells,c,partial,reason})=>`<div class="review-end-choice"><label class="inline-check"><input type="checkbox" data-review-end-source="${esc(id)}" ${scope.endSources.includes(id)?'checked':''} ${reason?'disabled':''}><span>${esc(c?.name||id)} · ${partial?'仅结束所选瓶 / 皿：':'结束整个容器 · 所选：'}${wells.map(esc).join('、')}</span></label>${reason?`<p class="muted">${esc(reason)}</p>`:''}</div>`).join('')||'<p class="muted">暂无已选择的来源。</p>'}</div></section>`;
}
function transferReviewOperation(includeCulture){
  const d=transferDraft,scope=transferReviewSourceScope(includeCulture),choices=transferReviewEndChoices(scope,includeCulture);
  for(const id of scope.endSources){const choice=choices.find(c=>c.id===id);if(!choice)throw new Error('结束培养的来源已变化，请重新选择。');if(choice.reason)throw new Error(choice.reason);}
  const finish=()=>({at:scope.at,sources:Object.values(scope.sources).map(s=>({id:s.id,well:s.well})),end_sources:[...scope.endSources],experiment_ids:(d.savedExperiments||[]).filter(r=>r.saved!==false).map(r=>r.id),notes:scope.notes});
  let operation;
  if(includeCulture){
    const payload=withTransferCulture(()=>transferPayload());
    if(scope.endSources.length&&(d.mode==='assay'||d.assayContext)){
      payload.end_sources=[];payload.end_members=[];payload.finish_sampling=finish();
    }
    operation={action:'transfer',payload};
  }else operation=scope.endSources.length?{action:'finish_sampling',payload:finish()}:{action:null,payload:null};
  if(d.homeReview&&d.confirmHomeReview){
    const c=displayContainers().find(c=>c.id===d.homeReview.id),ids=c?.container_ids||[c?.id];
    if(!c||!Object.values(scope.sources).some(s=>ids.includes(s.id)))throw new Error('今日核对的容器不在本次来源中，请调整来源或取消同时核对。');
    if(operation.action)operation.payload.check_after=c.id;
    else operation={action:'check',payload:{id:c.id,reason:'experiment'}};
  }
  return operation;
}

function changeReviewEndSource(id,checked){
  if(busy)return;
  const d=transferDraft,scope=transferReviewSourceScope(),choice=transferReviewEndChoices(scope,d.reviewHasCulture).find(c=>c.id===id);
  if(!choice||choice.reason){toast(choice?.reason||'来源已变化，请重新选择。',true);previewTransfer();return;}
  setTransferEndChoice(id,checked,d.reviewHasCulture);
  if(d.reviewHasCulture)d.culturePrepared=true;
  d.reviewEndOpen=true;invalidateTransfer(false);renderTransfer();previewTransfer();
}
function transferReviewCultivation(t){
  const c=transferTarget(t.ref),options=transferCultureOptions(t);
  const linkOnly=targetIsLinkOnly(t),replace=occupiedTargetKeys(t).length&&transferOccupiedAction(t)==='replace';
  const details=system=>`<p>${esc(system.medium?mediumSummary(system.medium):'培养基未记录')}</p><p>特殊处理：${esc(system.treatment||'未记录')} · 浓度：${esc(system.concentration||'未记录')}</p><p>进行中处理：${(system.active_treatments||[]).length?(system.active_treatments||[]).map(x=>esc(x.name+' '+(x.concentration||'')+' · 开始 '+(x.started_at||'未记录'))).join('；'):'无已登记的进行中处理'}</p>`;
  if(occupiedTargetKeys(t).length&&transferOccupiedAction(t)==='append'&&t.systemMode!=='custom')return `<div class="review-cultivation"><strong>共培养沿用目标原培养体系；空孔沿用来源体系</strong>${t.wells.map(key=>`<p>${esc(key)}</p>${details(transferProjectedSystem(t,key))}`).join('')}</div>`;
  if(transferDraft.mode==='replate'&&t.systemMode!=='custom'){
    if(t.distribution==='pooled')return `<div class="review-cultivation"><strong>整组沿用共同培养体系</strong>${details(transferCultureSystem(options.find(o=>o.reference.kind==='source')?.well))}</div>`;
    return `<div class="review-cultivation"><strong>逐孔沿用各自来源培养基与处理</strong>${replatePairs(t,false).map(p=>{const source=state.containers.find(c=>c.id===p.source?.id)?.wells[p.source?.well];return `<p>${esc(p.source?.well||'')} → ${esc(p.well||'未选目标')}</p>${details(transferCultureSystem(source))}`;}).join('')}</div>`;
  }
  if(!linkOnly&&t.systemMode==='custom'){
    const ref=t.cultivationReference,basis=options.find(o=>ref?.kind==='source'?o.reference.kind==='source'&&o.reference.key===ref.key:o.reference.kind==='target'&&o.reference.well===ref?.well);
    const system={...(t.cultivation||{}),active_treatments:t.cultivation?.continue_active?(basis?.well?.active_treatments||[]):[]};
    return `<div class="review-cultivation"><strong>自定义培养体系</strong><p>参照：${esc(basis?.label||'未选参照')} · ${t.cultivation?.continue_active?'延续参照中的进行中处理':'不延续原进行中处理'}</p>${details(system)}</div>`;
  }
  if(!linkOnly&&t.systemMode!=='same')return `<p>${esc('处理：'+(t.treatment||'未填写')+'；浓度：'+(t.concentration||'未填写'))}</p>`;
  const systems=new Map(),source=options.find(o=>o.reference.kind==='source');
  for(const key of t.wells){
    const previous=c?.wells?.[key],system=transferCultureSystem(previous?.cell&&!replace?previous:source?.well),signature=JSON.stringify(system);
    if(!systems.has(signature))systems.set(signature,{system,wells:[]});systems.get(signature).wells.push(key);
  }
  return `<div class="review-cultivation"><strong>${linkOnly?'保留各孔原培养信息':replace?'使用来源培养体系':'与前培养体系一致'}</strong>${[...systems.values()].map(({system,wells})=>`<p>${wells.map(esc).join('、')}</p>${details(system)}`).join('')}</div>`;
}
function transferReviewMarkup(operation,error,includeCulture,endScope){
  const d=transferDraft,options=sourceOptions(true);
  const sourceText=s=>{const c=state.containers.find(c=>c.id===s.id);return `${c?.name||s.id} / ${s.well}${s.role?' · '+s.role:''}${s.amount?' · 每目标加入 '+s.amount:''}`;};
  return `<div class="dialog-head"><div><span class="eyebrow">OPERATION REVIEW</span><h2>本次细胞操作总预览</h2></div><button type="button" class="icon-button" id="close-transfer-review" aria-label="关闭总预览">×</button></div>
  <div id="transfer-review" class="transfer-review">${error?`<p class="lab-error" role="alert">${esc(error)}</p>`:''}
  ${includeCulture?`<div class="section-head"><h3>${esc(transferOperationLabel())} · 待保存</h3><button type="button" class="text-button" id="review-edit-sources">修改来源 / 时间</button></div><p>${esc(d.at.replace('T',' '))}（北京时间） · 实验编号 ${esc(d.experiment||'未填写')}</p><p>${Object.values(d.sources).map(s=>esc(sourceText(s))).join('<br>')||'尚未选择来源'}</p>
  ${d.targets.map((t,i)=>{const c=transferTarget(t.ref);return `<section class="review-target"><div class="section-head"><h4>去向组 ${i+1}${t.conditionName?' · '+esc(t.conditionName):''}${t.locked?' · 已锁定':''}</h4>${occupiedTargetKeys(t).length?`<span>${esc(occupiedActionLabels[transferOccupiedAction(t)])}${occupiedChangeConfirmed(t)?' · 已确认':' · 待核对'}</span>${!occupiedChangeConfirmed(t)?`<button type="button" class="text-button" data-review-occupied="${i}">核对已有孔变更</button>`:''}`:''}<button type="button" class="text-button" data-review-target="${i}">${t.locked?'取消锁定并修改':'修改此组'}</button></div>${cultureActionMarkup(t,i,true)}${d.mode==='replate'?replateMappingReview(t):`<p>${t.sourceKeys.map(k=>{const s=options.find(x=>x.key===k);return esc(s?s.name+' / '+s.well+' · '+s.cell:k);}).join(' ＋ ')||'未选来源'}<br>→ <strong>${esc(c?.name||'未选目标')}</strong> · ${c?esc(groupTypeLabel(c)):''} · ${esc(c?.location||'未填位置')}<br>目标：${t.wells.map(esc).join('、')||'未选孔位'}${t.append?'（加入已有细胞）':''}</p>`}${targetIsLinkOnly(t)?'<p>仅更正来源；孔内细胞、日期、培养基、处理和计数均保留。</p>':`<p>${esc(transferSeedingSummary(t,c))}</p>`}${transferReviewCultivation(t)}</section>`;}).join('')||'<p>尚未设置培养去向</p>'}
  <section class="review-target"><div class="section-head"><h4>来源余量与备注</h4><button type="button" class="text-button" id="review-edit-disposition">修改</button></div><p>${d.endSources.length?'操作后结束：'+d.endSources.map(id=>{const c=state.containers.find(c=>c.id===id);return esc((c?.name||id)+(groupQuantity(c)>1?' 中所选瓶/皿':''));}).join('；'):d.mode==='replate'&&d.clearSources?'保留来源容器，清空已全部移出且未作为目标的原孔':'来源继续培养'}</p><p>${esc(d.notes||'未填写备注')}</p></section>`:'<p class="muted">尚未安排培养转移。实验记录已在各自表单中保存。</p>'}
  ${transferAssayEntriesMarkup(d,true)}${transferReviewEndMarkup(endScope,includeCulture)}${d.homeReview?`<label class="inline-check"><input type="checkbox" id="review-check-home" ${d.confirmHomeReview?'checked':''}><span>完成本次操作后确认 ${esc(d.homeReview.name)} 今日核对（已结束的来源除外）</span></label>`:''}</div><p class="muted">${operation?.action==='transfer'?'确认后保存培养转移及所选来源结束状态。实验记录保持独立，不会重复创建。':operation?.action==='finish_sampling'?'确认后结束已勾选来源的培养，原记录与实验关联保留。':'确认后完成本次安排；未选择结束培养时不改变来源状态。'}</p><div class="dialog-actions review-final-actions"><button type="button" class="button secondary" id="review-end-cultures" aria-expanded="${!!d.reviewEndOpen||!!endScope.endSources.length}">操作后结束细胞培养</button><button type="button" class="button secondary" id="return-transfer-edit">返回修改</button><button type="button" class="button primary" id="save-reviewed-transfer" ${!operation?'disabled':''}>${includeCulture?'最终确认并保存':'确认'}</button></div>`;
}
function previewTransfer(saveError=''){
  const d=transferDraft;if(!d||busy)return;
  const includeCulture=d.mode!=='assay'||!!d.culturePrepared;
  let operation=null,error=saveError;
  try{operation=transferReviewOperation(includeCulture);}catch(e){error=error||e.message;}
  const endScope=transferReviewSourceScope(includeCulture);
  const draw=()=>transferReviewMarkup(operation,error,includeCulture,endScope);
  const markup=includeCulture?withTransferCulture(draw):draw();
  d.review=!!operation;d.reviewPayload=operation?JSON.stringify(operation):null;d.reviewHasCulture=includeCulture;
  const dialog=$('#transfer-review-dialog');dialog.innerHTML=markup;
  dialog.oncancel=e=>{e.preventDefault();returnTransferEdit();};
  $('#close-transfer-review').onclick=$('#return-transfer-edit').onclick=()=>returnTransferEdit();
  $('#review-end-cultures').onclick=()=>{d.reviewEndOpen=!(d.reviewEndOpen||transferReviewSourceScope().endSources.length);previewTransfer();$('#review-end-panel')?.scrollIntoView?.({block:'center'});};
  dialog.querySelectorAll('[data-review-end-source]').forEach(box=>box.onchange=()=>changeReviewEndSource(box.dataset.reviewEndSource,box.checked));
  if($('#review-check-home'))$('#review-check-home').onchange=e=>{if(busy)return;d.confirmHomeReview=e.target.checked;invalidateTransfer(false);previewTransfer();};
  if($('#review-edit-sources'))$('#review-edit-sources').onclick=()=>returnTransferEdit(null,true);
  if($('#review-edit-disposition'))$('#review-edit-disposition').onclick=()=>{returnTransferEdit(null,true);$('#transfer-notes')?.scrollIntoView?.({block:'center'});};
  dialog.querySelectorAll('[data-review-occupied]').forEach(b=>b.onclick=()=>{returnTransferEdit(null,true);openOccupiedConfirmation(+b.dataset.reviewOccupied,true);});
  dialog.querySelectorAll('[data-review-target]').forEach(b=>b.onclick=()=>returnTransferEdit(+b.dataset.reviewTarget));
  dialog.querySelectorAll('[data-review-lab]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.reviewLab;returnTransferEdit();switchTransferMode('assay');
    if(transferDraft.labLocks)delete transferDraft.labLocks[id];
    renderTransfer();editTransferLabRecord(id);
  });
  if($('#save-reviewed-transfer'))$('#save-reviewed-transfer').onclick=commitTransfer;
  if(!dialog.open)dialog.showModal();
}
async function commitTransfer(){
  const d=transferDraft;if(busy||!d)return;
  if(!d.review||!$('#transfer-review-dialog').open)return previewTransfer();
  let operation;
  try{
    operation=transferReviewOperation(d.reviewHasCulture);
    if(JSON.stringify(operation)!==d.reviewPayload){previewTransfer('内容已变化，请核对更新后的预览再确认。');return;}
  }catch(error){previewTransfer(error.message);return;}
  busy=true;$('#transfer-dialog').querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=true);
  $('#transfer-review-dialog').querySelectorAll('button,input').forEach(el=>el.disabled=true);
  try{
    if(operation.action){const result=await api('/api/command',{action:operation.action,payload:operation.payload,revision:d.revision});state=result.state;}
    selected.clear();dirty=false;transferDraft=null;busy=false;
    $('#transfer-review-dialog').close();$('#transfer-dialog').close();render();toast(operation.action==='transfer'?'培养转移已保存，可在流转记录中追溯。':operation.action==='finish_sampling'?'本次安排已确认，已结束所选来源培养，原记录保留。':'本次安排已确认，来源继续培养。');
  }catch(error){busy=false;renderTransfer();previewTransfer(error.message);}finally{busy=false;if(typeof renderUndoControl==='function')renderUndoControl();}
}
function bindLineageButtons(root){root.querySelectorAll('[data-lineage]').forEach(b=>b.onclick=()=>openLineage(b.dataset.lineage));if(typeof bindLineageLinks==='function')bindLineageLinks(root);}
async function openLineage(id){
  try{
    const record=await api('/api/transfers/'+encodeURIComponent(id));
    $('#lineage-dialog').innerHTML=`<div class="dialog-head"><div><span class="eyebrow">${esc(record.id)}</span><h2>${esc(cultureReceiptLabel(record))} · 来源与去向</h2></div><button class="icon-button" id="close-lineage" aria-label="关闭来源记录">×</button></div><p>${esc(record.at.replace('T',' '))} · 北京时间</p>${record.mode==='replate'?`<p class="muted">${record.targets.some(t=>t.culture_action)?'各目标孔的操作与 Day 0 见下表。':record.cell_line_passage?'目标细胞系按传代日计时。':'目标沿用来源 Day 0。'}来源历史与原计数见快照。</p>`:''}${record.mode==='relink'?'<p class="muted">此记录为来源关联更正，保留原孔细胞与培养信息；下方来源快照为更正时捕获。</p>':''}${record.undone?`<div class="history-banner">这次记录已于 ${esc(shortTime(record.undone_at))} 撤销。凭据原样保留，当前培养已回退。</div>`:''}<p class="muted">实验：${esc(record.experiment||'未填写')} · ${esc(record.notes)}</p>${record.post_operation_endings?`<section class="panel"><h3>操作后结束的来源培养</h3><p>${record.post_operation_endings.end_sources.map(id=>esc(id)+' / '+record.post_operation_endings.sources.filter(s=>s.id===id).map(s=>esc(s.well)).join('、')).join('<br>')}</p><p class="muted">${esc(record.post_operation_endings.at)} · ${esc(record.post_operation_endings.notes||'')}</p></section>`:''}${(record.collection_groups||[]).map((g,i)=>`<section class="panel"><h3>收集组 ${i+1} · ${g.source_indices.length} 个来源 → ${g.targets.length} 个目标</h3><p>${g.source_indices.map(index=>esc(record.sources[index].name+' / '+record.sources[index].well)).join(' ＋ ')}<br>→ ${g.targets.map(target=>esc((record.targets.find(t=>t.id===target.id)?.name||target.id)+' / '+target.well)).join('、')}</p><p class="muted">${esc(g.id)} · 整体收集后重新分装；未按目标数自动分摊来源计数或体积。</p></section>`).join('')}<h3>当时的来源记录</h3>${record.sources.map(s=>`<div class="panel"><strong>${esc(s.name)} / ${esc(s.well)} · ${esc(s.snapshot.cell)}</strong><p class="muted">${esc(s.id)} · ${esc(s.role||'未填写角色')} · ${record.mode==='replate'?'来源记录量':'每个目标加入量'}：${esc(s.amount||'未填写')}</p>${typeof lineageUnitButton==='function'?lineageUnitButton(s.id,s.well,'查看来源当前记录'):''}${componentSummary(s.snapshot,record.at.slice(0,10))}${mediumDetailsMarkup(s.snapshot.medium)}${countDetailsMarkup(s.snapshot.cell_count)}${seedingDetailsMarkup(s.snapshot.seeding)}<p class="muted">来源当时处理：${esc(s.snapshot.treatment||'未填写')}</p>${s.snapshot.notes?`<p class="muted">来源当时备注：${esc(s.snapshot.notes)}</p>`:''}${[...new Set([s.snapshot.maintenance_id,s.snapshot.lineage_correction_id,s.snapshot.lineage_id,s.snapshot.placement_id].filter(Boolean))].map(id=>`<button class="text-button" data-lineage="${esc(id)}">继续向上追溯 ↗</button>`).join('')}</div>`).join('')}<h3>目标记录</h3><div class="table-wrap"><table><thead><tr><th>目标容器 / 孔位</th><th>对应来源</th><th>已有组成</th></tr></thead><tbody>${record.targets.map(t=>`<tr><td>${esc(t.name)} / ${esc(t.well)}${t.condition_group?' · '+esc(t.condition_group):''}<small>${esc(t.id)}${t.culture_action?' · '+esc(cultureActionNames[t.culture_action])+' · Day 0 '+esc(t.result?.day0||'未记录'):''}${t.operation?' · '+esc({link:'仅更正来源',replace:'替换记录',append:'加入已有细胞',seed:'新目标',replate:t.culture_action?'逐孔对应':'逐孔移孔换液',expand:t.culture_action?'整体收集':'合并收集后扩孔'}[t.operation]||t.operation):''}</small>${typeof lineageUnitButton==='function'?lineageUnitButton(t.id,t.well,'查看目标当前记录'):''}${seedingDetailsMarkup(t.result?.seeding)}${t.medium_change?.volume_value?`<small>换入 ${esc(t.medium_change.volume_value+' '+t.medium_change.volume_unit)}</small>`:''}</td><td>${t.source_indices.map(i=>esc(record.sources[i].name+' / '+record.sources[i].well)).join('<br>')}</td><td>${t.previous?esc(t.previous.cell):'空目标'}${t.previous_planned?'<small>本次前序去向组已安排的细胞</small>':''}${t.previous?`<details><summary>查看原目标培养信息</summary>${mediumDetailsMarkup(t.previous.medium)}${countDetailsMarkup(t.previous.cell_count)}${seedingDetailsMarkup(t.previous.seeding)}</details>`:''}${t.previous?.lineage_correction_id?`<br><button class="text-button" data-lineage="${esc(t.previous.lineage_correction_id)}">查看上一次来源更正</button>`:''}${t.previous?.lineage_id?`<br><button class="text-button" data-lineage="${esc(t.previous.lineage_id)}">查看目标原来源</button>`:''}</td></tr>`).join('')}</tbody></table></div>`;
    $('#close-lineage').onclick=()=>$('#lineage-dialog').close();bindLineageButtons($('#lineage-dialog'));if(!$('#lineage-dialog').open)$('#lineage-dialog').showModal();
  }catch(error){toast(error.message,true);}
}
async function openContainerTransfers(id){
  try{
    const records=await api('/api/transfers?container='+encodeURIComponent(id));
    $('#lineage-dialog').innerHTML=`<div class="dialog-head"><h2>来源与去向记录</h2><button class="icon-button" id="close-lineage" aria-label="关闭来源记录">×</button></div>${records.length?records.map(r=>`<div class="panel"><strong>${esc(cultureReceiptLabel(r))} · ${esc(r.at.replace('T',' '))}</strong>${r.undone?'<span class="pill amber">已撤销</span>':''}<p class="muted">${r.sources.map(s=>esc(s.name+' / '+s.well)).join(' ＋ ')}<br>→ ${r.targets.map(t=>esc(t.name+' / '+t.well)).join('、')}</p><button class="button secondary" data-lineage="${esc(r.id)}">打开流转凭据</button></div>`).join(''):'<p class="muted">该容器还没有传代、分装或合并记录。</p>'}`;
    $('#close-lineage').onclick=()=>$('#lineage-dialog').close();bindLineageButtons($('#lineage-dialog'));if(!$('#lineage-dialog').open)$('#lineage-dialog').showModal();
  }catch(error){toast(error.message,true);}
}
