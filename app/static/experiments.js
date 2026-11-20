'use strict';
/* Structured lab records. Field and table definitions come from the server schema. */
let labModuleFilter = 'all', labStatusFilter = 'unfinished', labSearch = '';
let drugStatusFilter = '', drugSearch = '';
let labEditor = null;
const labClone = value => JSON.parse(JSON.stringify(value));
const labModules = () => boot.lab_schema?.modules || {};
const labRecords = (source = state) => source?.lab_records || [];
const labExperimentModules = () => Object.entries(labModules()).filter(([type])=>type!=='drug');
const labIsExperiment = record => !!record && record.type!=='drug' && !!labModules()[record.type];
const labIsOpenExperiment = record => labIsExperiment(record) && ['draft','planned','running'].includes(record.status);
const labSourceKey = source => `${source.container_id}|${source.well}|${source.snapshot_id || ''}`;
const labTableSourceKey = source => source.table_key || labSourceKey(source);
function labSourceGroupInput(group){return Object.fromEntries(['id','name','members','notes','binding_id','collection_id'].filter(key=>Object.hasOwn(group,key)).map(key=>[key,labClone(group[key])]));}
function labGroupChoice(group,individuals=[]){
  const sources=group.sources||group.members.map(key=>individuals.find(s=>labTableSourceKey(s)===key||labSourceKey(s)===key)).filter(Boolean);
  return {key:group.key||'GROUP|'+group.id,table_key:group.table_key||group.key||'GROUP|'+group.id,is_group:true,source_group:{...group,sources}};
}
function labSourceGroupsForEditor(individuals=[]){
  const editor=labEditor,groups=(editor.record.source_groups||[]).map(g=>labGroupChoice(g,individuals));
  for(const id of editor.record.record_refs){
    const captured=(editor.original.record_refs||[]).find(ref=>ref.id===id),record=captured&&!editor.refreshRefs?(captured.snapshot||captured):labRecords().find(r=>r.id===id);
    if(!record)continue;
    for(const group of record.all_source_groups||record.source_groups||[]){const key=group.table_key||group.key||'GROUP|'+group.id,suffix=key.startsWith('OBS_GROUP|')?key:group.id;groups.push(labGroupChoice({...group,table_key:`OBS_GROUP|${id}|${record.version||captured?.version}|${suffix}`},individuals));}
  }
  return groups;
}
function labObservedSources(record){return [...(record.all_cell_sources||record.cell_sources||[]),...(record.all_source_groups||record.source_groups||[]).flatMap(g=>g.sources||[])];}
function labSourceCountLabel(record){
  const groups=record.all_source_groups||record.source_groups||[];
  if(!groups.length)return `${(record.all_cell_sources||record.cell_sources||[]).length} 个细胞来源`;
  return `${groups.length} 个收集组 · ${new Set(labObservedSources(record).map(s=>s.container_id+'|'+s.well)).size} 个原孔`;
}
function labBoundSourcePreset(type,variant,sourceRefs){
  if(typeof wellSelectionMode==='undefined'||wellSelectionMode!=='group')return {};
  const available=new Set(sourceRefs.filter(s=>!s.snapshot_id).map(labSourceKey)),used=new Set(),groups=[];
  for(const c of state.containers)for(const binding of c.well_groups||[]){
    const members=binding.wells.filter(w=>memberActive(c.wells[w]||{})).map(w=>labSourceKey({container_id:c.id,well:w}));
    if(members.length&&members.every(k=>available.has(k))){groups.push({id:'SG-'+labRowId(),name:binding.name,members,binding_id:binding.id});members.forEach(k=>used.add(k));}
  }
  if(!groups.length)return {};
  const table=labModules()[type].variants[variant].tables.find(t=>t.key===(variant==='blot'?'lanes':'samples'));
  const rows=groups.map(g=>({row_id:labRowId(),sample:g.name,source:'GROUP|'+g.id}));
  for(const source of sourceRefs)if(!used.has(labSourceKey(source))){const c=state.containers.find(c=>c.id===source.container_id);rows.push({row_id:labRowId(),sample:(c?.name||source.container_id)+' / '+source.well,source:labSourceKey(source)});}
  return {source_groups:groups,...(table?{tables:{[table.key]:rows}}:{})};
}
function labSourceGroupsMarkup(record,readonly=false){
  const groups=readonly?(record.all_source_groups||record.source_groups||[]).map(g=>labGroupChoice(g)):labSourceGroupsForEditor(labEffectiveSourceChoices().filter(s=>!s.is_group));
  if(!groups.length)return '';
  return `<section class="lab-relations"><h3>收集组来源</h3><p class="muted">样本选择一个培养 / 收集组时，代表从这个整体取样；下方各原孔观察分别保存，不相加计数或覆盖培养信息。</p>${groups.map(choice=>{const g=choice.source_group,used=Object.values(record.tables||{}).flat().some(row=>row.source===choice.table_key),direct=(record.source_groups||[]).some(x=>x.id===g.id)&&!choice.table_key.startsWith('OBS_GROUP|');return `<details class="lab-captured"><summary>${esc(g.name)} · ${g.sources.length} 个原孔</summary><p>${g.sources.map(s=>esc(labSourceLabel(s))).join('<br>')}</p>${g.notes?`<p>${esc(g.notes)}</p>`:''}${g.collection_id?`<small>收集关联：${esc(g.collection_id)}</small>`:''}${!readonly&&direct?`<button type="button" class="text-button" data-lab-remove-group="${esc(g.id)}" ${used?'disabled':''} title="先调整引用此组的样本行来源，再移除此组">移除此收集组</button>`:''}</details>`;}).join('')}</section>`;
}
const labStatusLabel = record => labModules()[record.type]?.statuses.find(item => item[0] === record.status)?.[1] || record.status;
const labTypeLabel = record => labModules()[record.type]?.label || record.type;
const labVariant = record => labModules()[record.type]?.variants[record.variant] || {label:record.variant, fields:[], tables:[]};
const labRowId = () => globalThis.crypto?.randomUUID?.() || `row-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const labNucleicUnits = {unit:['ng/μL','μg/μL','ng/mL','μg/mL','mg/mL','nM','μM'],volume_unit:['μL','mL','L']};
const labProteinConcentrationUnits = ['mg/mL','μg/μL','μg/mL','ng/μL','ng/mL'];
const labVolumeUnits = ['μL','mL','L'];
function labTableUnits(table) {
  const r=labEditor?.record;
  if(r?.type==='pcr'&&r.variant==='extraction'&&table==='samples')return labNucleicUnits;
  if(r?.type==='western'&&r.variant==='protein'&&table==='samples')return {volume_unit:labVolumeUnits};
  if(r?.type==='western'&&r.variant==='bca'&&['samples','standards'].includes(table))return {unit:labProteinConcentrationUnits};
  if(r?.type==='luci'&&r.variant==='assay'&&['samples','raw_plate','summary'].includes(table))return {unit:['RLU','counts','cps','仪器原始Lum读数（单位未显示）']};
  if(r?.type==='drug'&&r.variant==='aliquot'){
    if(table==='preprocessing')return {duration_unit:['min','h','s']};
    if(['aliquots','usage'].includes(table))return {unit:[...labVolumeUnits,'mg','g']};
  }
  return {};
}
const labUnitOverrideKey = (table,row,key) => JSON.stringify([labEditor.record.type,labEditor.record.variant,table,row,key]);
function labRecordButton(record) {
  return `<button type="button" class="lab-record-link" data-lab-record="${esc(record.id)}"><strong>${esc(record.title || record.id)}</strong><small>${esc(record.id)} · ${esc(labVariant(record).label)} · ${esc(labStatusLabel(record))}</small></button>`;
}
function labCompleteButton(record) {
  return frozen||!labIsOpenExperiment(record)?'':`<button type="button" class="button secondary lab-complete-button" data-lab-complete="${esc(record.id)}" ${busy?'disabled':''}>标记完成</button>`;
}
function bindLabCompleteButtons(root) {
  root.querySelectorAll('[data-lab-complete]').forEach(button=>button.onclick=()=>completeLabRecord(button.dataset.labComplete));
}
function labConfirmStatusChange(record,status) {
  return record.status!=='completed'||status==='completed'||confirm(`“${record.title||record.id}”已完成。确认将状态改为“${labStatusLabel({...record,status})}”？`);
}
async function completeLabRecord(id) {
  return setLabRecordStatus(id,'completed',{confirmCompletion:true});
}
async function setLabRecordStatus(id,status,{confirmCompletion=false}={}) {
  if(frozen||labEditor?.readonly)return;
  if(busy)return toast('正在保存，请稍后再修改实验状态。',true);
  if(dirty)return toast('请先保存当前修改，再修改实验状态。',true);
  if(typeof transferLabRecordLocked==='function'&&transferLabRecordLocked(id))return toast('这份实验记录在当前转移会话中已锁定，请先解锁再修改状态。',true);
  const saved=labRecords().find(record=>record.id===id);
  if(!labIsExperiment(saved)||!labModules()[saved.type].statuses.some(([key])=>key===status))return toast('这份实验记录或目标状态已变化，请刷新后核对。',true);
  if(confirmCompletion&&!labIsOpenExperiment(saved))return toast('这份实验记录已结束或不能标记完成，请刷新后核对。',true);
  if(saved.status===status)return;
  const r=labClone(saved),revision=state.revision;
  const payload={id:r.id,type:r.type,variant:r.variant,title:r.title,record_date:r.record_date,status,experiment:r.experiment,notes:r.notes,data:r.data,tables:r.tables,files:r.files,
    cell_sources:(r.cell_sources||[]).map(s=>({container_id:s.container_id,well:s.well,...(s.snapshot_id?{snapshot_id:s.snapshot_id}:{})})),
    record_refs:(r.record_refs||[]).map(ref=>typeof ref==='string'?ref:ref.id),refresh_sources:false,refresh_refs:false};
  if(Object.hasOwn(r,'source_groups'))payload.source_groups=r.source_groups.map(labSourceGroupInput);
  const targetLabel=labStatusLabel({...r,status});
  if(!labConfirmStatusChange(r,status))return;
  if(confirmCompletion&&!confirm(`将“${r.title||r.id}”标记为已完成？`))return;
  busy=true;
  document.querySelectorAll('[data-lab-complete],[data-lab-status]').forEach(control=>control.disabled=true);
  try{const result=await api('/api/command',{action:'lab_record_save',revision,payload});state=result.state;busy=false;render();toast(`实验状态已改为${targetLabel}。`);}
  catch(error){toast(error.message,true);}
  finally{busy=false;document.querySelectorAll('[data-lab-complete],[data-lab-status]').forEach(control=>control.disabled=!!frozen||!!labEditor?.readonly||!!(typeof transferLabRecordLocked==='function'&&transferLabRecordLocked(control.dataset.labStatus||control.dataset.labComplete)));if(typeof renderUndoControl==='function')renderUndoControl();}
}
function labInlineStatusMarkup(record) {
  if(frozen||!labIsExperiment(record))return `<span class="pill ${['completed','available'].includes(record.status)?'green':'amber'}">${esc(labStatusLabel(record))}</span>`;
  const locked=typeof transferLabRecordLocked==='function'&&transferLabRecordLocked(record.id);
  return `<select class="lab-inline-status" data-lab-status="${esc(record.id)}" aria-label="${esc(record.title||record.id)}的状态" ${busy||locked?'disabled':''}>${labModules()[record.type].statuses.map(([key,label])=>`<option value="${esc(key)}" ${record.status===key?'selected':''}>${esc(label)}</option>`).join('')}</select>`;
}
function bindLabStatusControls(root) {
  root.querySelectorAll('[data-lab-status]').forEach(control=>control.onchange=async()=>{
    const id=control.dataset.labStatus,previous=labRecords().find(r=>r.id===id)?.status;
    await setLabRecordStatus(id,control.value);
    control.value=labRecords().find(r=>r.id===id)?.status||previous;
  });
}
function labOverviewMarkup() {
  const all = labRecords(frozen?.state||state),records=all.filter(labIsExperiment),inventory=all.filter(r=>r.type==='drug'),unfinished=records.filter(labIsOpenExperiment).sort((a,b)=>(b.record_date||'').localeCompare(a.record_date||'')||(b.updated_at||'').localeCompare(a.updated_at||''));
  return `<section class="lab-overview"><div class="section-head"><div><span class="eyebrow">CONNECTED EXPERIMENTS</span><h2>关联实验记录</h2><p class="muted">${records.length} 份记录 · ${unfinished.length} 份未完成 · ${records.filter(r=>r.status==='completed').length} 份已完成</p></div><button type="button" class="button secondary" data-lab-browse="all">查看实验记录 ↗</button></div><div class="lab-module-grid">${labExperimentModules().map(([key,module]) => `<button type="button" class="lab-module-card" data-lab-browse="${esc(key)}"><span>${esc(module.prefix)}</span><strong>${esc(module.label)}</strong><small>${records.filter(r=>r.type===key).length} 份记录 · ${Object.values(module.variants).map(v=>esc(v.label)).join(' / ')}</small></button>`).join('')}</div>${unfinished.length?`<div class="lab-pending"><h3>待完成的实验 <span class="muted">${unfinished.length} 份${unfinished.length>6?' · 最近 6 份':''}</span></h3>${unfinished.slice(0,6).map(r=>`<div class="lab-pending-row"><div>${labRecordButton(r)}<small class="muted">${esc(labTypeLabel(r))} · ${esc(r.record_date||'—')}</small></div>${labCompleteButton(r)}</div>`).join('')}</div>`:''}<p class="muted">记录样本与原始结果，关联培养来源和上游记录。</p></section><div class="lab-inventory-shortcut"><span>药物配制 / 存储 · ${inventory.length} 份记录 · ${inventory.filter(r=>r.status==='available').length} 份在用 / 可用</span><button type="button" class="text-button" data-drug-browse>打开药物库存 ↗</button></div>`;
}
function bindLabOverview(root) {
  root.querySelectorAll('[data-lab-browse]').forEach(button => button.onclick = () => {
    if (!canLeave() || busy) return;
    dirty = false; frozen = null; labModuleFilter = button.dataset.labBrowse; labStatusFilter='unfinished';labSearch='';view = 'labs'; render();
  });
  root.querySelectorAll('[data-drug-browse]').forEach(button=>button.onclick=()=>{
    if(!canLeave()||busy)return;
    dirty=false;frozen=null;drugStatusFilter='';drugSearch='';view='drugs';render();
  });
  bindLabRecordLinks(root);bindLabCompleteButtons(root);
}
function renderExperiments() { renderLabRecordPage(false); }
function renderDrugs() { renderLabRecordPage(true); }
function renderLabRecordPage(inventory) {
  const source = frozen?.state || state,records=labRecords(source).filter(r=>inventory?r.type==='drug':labIsExperiment(r));
  const modules=inventory?[['drug',labModules().drug]]:labExperimentModules();
  if(!inventory&&labModuleFilter!=='all'&&!modules.some(([key])=>key===labModuleFilter))labModuleFilter='all';
  const status=inventory?drugStatusFilter:labStatusFilter,searchTerm=inventory?drugSearch:labSearch;
  const statuses=inventory?[['','全部状态'],...(labModules().drug?.statuses||[])]:[['unfinished','未完成（草稿 / 计划 / 进行中）'],['all','全部状态'],['completed','已完成'],['archived','已取消 / 归档'],...new Map(modules.flatMap(([,module])=>module.statuses.filter(([key])=>!['completed','cancelled'].includes(key)))).entries()];
  $('#content').innerHTML = `<section class="lab-page"><div class="section-head"><div><span class="eyebrow">${inventory?'REAGENT INVENTORY':'LABORATORY RECORDS'}</span><h2>${inventory?'药物配制 / 存储':'实验记录'}</h2><p class="muted">${inventory?'记录母液配制、分装、使用与存储位置。':'从细胞来源到样本、检测与原始文件，逐项保存可追溯记录。'}</p></div>${frozen?'<span class="pill amber">历史只读</span>':`<div class="actions">${inventory?'<button type="button" id="lab-new-aliquot" class="button secondary">＋ 新建分装记录</button>':''}<button type="button" id="lab-new" class="button primary">${inventory?'＋ 新建配制记录':'＋ 新建实验记录'}</button></div>`}</div>${inventory?'':`<div class="lab-tabs" role="group" aria-label="实验模块">${[['all','全部实验'],...modules.map(([key,module])=>[key,module.label])].map(([key,label])=>`<button type="button" class="button ${key===labModuleFilter?'primary':'secondary'}" data-lab-tab="${esc(key)}" aria-pressed="${key===labModuleFilter}">${esc(label)} <span>${key==='all'?records.length:records.filter(r=>r.type===key).length}</span></button>`).join('')}</div>`}<div class="lab-filters"><label>搜索记录<input type="search" id="lab-search" value="${esc(searchTerm)}" placeholder="${inventory?'标题、编号、药物或存储信息':'标题、编号、实验分组或细胞'}"></label><label>记录状态<select id="lab-status">${statuses.map(([key,label])=>`<option value="${esc(key)}" ${status===key||(!inventory&&!status&&key==='all')?'selected':''}>${esc(label)}</option>`).join('')}</select></label></div><div id="lab-record-list"></div></section>`;
  const drawList = () => {
    const currentStatus=inventory?drugStatusFilter:labStatusFilter,currentSearch=inventory?drugSearch:labSearch;
    const matches = records.filter(r=>(inventory||labModuleFilter==='all'||r.type===labModuleFilter)&&(!currentStatus||currentStatus==='all'||(currentStatus==='unfinished'?labIsOpenExperiment(r):currentStatus==='archived'?r.status==='cancelled':r.status===currentStatus))&&JSON.stringify([r.id,r.title,r.experiment,r.data,(r.all_cell_sources||r.cell_sources||[]).map(s=>[s.container_name,s.well,s.snapshot?.cell])]).toLowerCase().includes(currentSearch.toLowerCase()));
    $('#lab-record-list').innerHTML = matches.length?`<div class="table-wrap"><table><thead><tr><th>记录</th><th>${inventory?'类型':'模块 / 阶段'}</th><th>状态</th><th>日期</th><th>来源 / 上游</th></tr></thead><tbody>${matches.slice().sort((a,b)=>(b.record_date||'').localeCompare(a.record_date||'')).map(r=>`<tr><td>${labRecordButton(r)}${r.experiment?`<small>实验：${esc(r.experiment)}</small>`:''}</td><td>${esc(labTypeLabel(r))}<small>${esc(labVariant(r).label)}</small></td><td>${labInlineStatusMarkup(r)}${labCompleteButton(r)}</td><td>${esc(r.record_date||'—')}<small>版本 ${esc(r.version||1)}</small></td><td>${esc(labSourceCountLabel(r))}<small>${(r.record_refs||[]).length} 份上游记录</small></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty-state"><h3>暂无匹配的${inventory?'药物配制 / 存储':'实验'}记录</h3><p class="muted">新建记录，或调整搜索与状态条件。</p></div>`;
    bindLabRecordLinks($('#lab-record-list'));bindLabCompleteButtons($('#lab-record-list'));bindLabStatusControls($('#lab-record-list'));
  };
  document.querySelectorAll('[data-lab-tab]').forEach(button=>button.onclick=()=>{labModuleFilter=button.dataset.labTab;renderExperiments();});
  $('#lab-search').oninput=e=>{if(inventory)drugSearch=e.target.value;else labSearch=e.target.value;drawList();};
  $('#lab-status').onchange=e=>{if(inventory)drugStatusFilter=e.target.value;else labStatusFilter=e.target.value;drawList();};
  if($('#lab-new'))$('#lab-new').onclick=()=>openNewLabRecord(inventory?'drug':labModuleFilter==='all'?undefined:labModuleFilter,[],inventory?{variant:'stock'}:{});
  if($('#lab-new-aliquot'))$('#lab-new-aliquot').onclick=()=>openNewLabRecord('drug',[],{variant:'aliquot'});
  drawList();
}
function linkedLabRecordsMarkup(containerId, wellKeys = []) {
  const source=frozen?.state||state, keys=[...wellKeys];
  const c=displayContainers(source).find(c=>c.id===containerId);
  const refs=(keys.length?keys:Object.keys(c?.wells||{})).map(key=>displayMemberRef(source,containerId,key)).filter(Boolean);
  const collections=new Set((keys.length?keys:Object.keys(c?.wells||{})).flatMap(k=>{const w=c?.wells[k];return [w?.collection_id,...(w?.incoming_collection_ids||[]),...(w?.components||[]).map(p=>p.collection_id)];}).filter(Boolean));
  const bindings=new Set((c?.well_groups||[]).filter(g=>!keys.length||g.wells.some(k=>keys.includes(k))).flatMap(g=>[g.id,g.parent_group_id]).filter(Boolean));
  const records=labRecords(source).filter(record=>labObservedSources(record).some(s=>refs.some(ref=>ref.container_id===s.container_id&&ref.well===s.well))||(record.all_source_groups||record.source_groups||[]).some(g=>(g.collection_id&&collections.has(g.collection_id))||(g.binding_id&&bindings.has(g.binding_id))));
  const occupied=keys.filter(k=>c?.wells[k]?.cell);
  return `<section class="lab-linked"><h4>关联实验记录</h4>${records.length?records.map(labRecordButton).join(''):'<p class="muted">暂无关联记录</p>'}${occupied.length?`<button type="button" class="button secondary" data-lab-from-container="${esc(containerId)}" data-lab-from-wells="${esc(JSON.stringify(occupied))}">＋ 从所选细胞新建实验</button>`:''}</section>`;
}
function bindLabRecordLinks(root) {
  root.querySelectorAll('[data-lab-record]').forEach(button=>button.onclick=()=>openLabRecord(button.dataset.labRecord,frozen||undefined));
  root.querySelectorAll('[data-lab-from-container]').forEach(button=>button.onclick=()=>openNewLabRecord(undefined,JSON.parse(button.dataset.labFromWells).map(well=>displayMemberRef(frozen?.state||state,button.dataset.labFromContainer,well)).filter(Boolean).map(ref=>({...ref,...(frozen?.id?{snapshot_id:String(frozen.id)}:{})}))));
}
function labSourceCandidates(source, snapshotId = '') {
  return (source?.containers||[]).flatMap(c=>Object.entries(c.wells||{}).filter(([,w])=>w.cell).map(([well,w])=>({container_id:c.id,container_name:c.name,container_type:c.type,well,snapshot_id:snapshotId,snapshot:w})));
}
function labSourceLabel(source) {
  if(source.is_group){const g=source.source_group;return `${g.name}（${g.sources.map(s=>(s.container_name||s.container_id)+' / '+s.well).join(' ＋ ')}）`;}
  return `${source.container_name||source.container_id} / ${source.well} · ${source.snapshot?.cell||'已捕获来源'}${source.snapshot_id?' · 历史 '+source.snapshot_id:''}`;
}
function labBeginEditor(record, readonly = false, context = null) {
  if(!readonly&&record.id&&typeof transferLabRecordLocked==='function'&&transferLabRecordLocked(record.id)){
    toast('这份实验记录在当前转移会话中已锁定，请先解锁再编辑。',true);return false;
  }
  if (busy || !canLeave()) return false;
  dirty=false;
  const captured = record.cell_sources || [], choices=new Map();
  labSourceCandidates(state).forEach(s=>choices.set(labSourceKey(s),s));
  if(frozen?.id)labSourceCandidates(frozen.state,String(frozen.id)).forEach(s=>choices.set(labSourceKey(s),s));
  captured.forEach(s=>choices.set(labSourceKey(s),{...choices.get(labSourceKey(s)),...s}));
  labEditor={record:labClone(record),readonly,context,revision:state.revision,choices,scope:'',scopeSources:labSourceCandidates(state),snapshots:null,saving:false,variants:{},unitOverrides:new Set(),refreshSources:false,refreshRefs:false};
  labEditor.record.cell_sources=captured.map(s=>({container_id:s.container_id,well:s.well,...(s.snapshot_id?{snapshot_id:s.snapshot_id}:{})}));
  labEditor.record.record_refs=(record.record_refs||[]).map(r=>typeof r==='string'?r:r.id);
  labEditor.original=labClone(record);
  // Saved cells, including blanks, and preset units are explicit choices. New blank cells can inherit.
  for(const [table,rows] of Object.entries(record.tables||{}))for(const row of rows)for(const key of Object.keys(labTableUnits(table))){
    if(record.id||row[key])labEditor.unitOverrides.add(labUnitOverrideKey(table,row.row_id,key));
  }
  labDrawEditor();
  if(!readonly)labCollectEditor();
  labEditor.baseline=labDraftFingerprint();
  const dialog=$('#lab-record-dialog');
  dialog.oncancel=event=>{event.preventDefault();labCloseEditor();};
  if(!dialog.open)dialog.showModal();
  return true;
}
function openLabRecord(id, readonlyState) {
  const context=readonlyState?.state?readonlyState:readonlyState?{state:readonlyState,id:frozen?.id}:null;
  const record=labRecords(context?.state||state).find(r=>r.id===id);
  if (!record) return toast('没有找到这份实验记录。',true);
  return labBeginEditor(record,!!context,context);
}
function openNewLabRecord(type, sourceRefs = [], preset = {}) {
  type=labModules()[type]?type:(!sourceRefs.length&&view==='drugs'?'drug':labExperimentModules()[0]?.[0]);
  if(!type)return toast('实验模块定义尚未载入。',true);
  const variant=labModules()[type].variants[preset.variant]?preset.variant:Object.keys(labModules()[type].variants)[0];
  if(!Object.hasOwn(preset,'source_groups')&&!preset.tables)preset={...preset,...labBoundSourcePreset(type,variant,sourceRefs)};
  const opened=labBeginEditor({type,variant,title:preset.title||'',record_date:preset.record_date||boot.today,status:'draft',experiment:preset.experiment||'',notes:preset.notes||'',data:{},tables:preset.tables||{},files:[],cell_sources:sourceRefs,record_refs:[],...(preset.source_groups?.length?{source_groups:preset.source_groups}:{})});
  if(opened){labEditor.onClose=preset.onClose;if(preset.revision!==undefined)labEditor.revision=preset.revision;}
  return opened;
}
function openExistingLabRecordFromTransfer(id, sourceRefs = [], preset = {}) {
  const original=labRecords().find(record=>record.id===id);
  if(!labIsOpenExperiment(original)){toast(original?'只能追加到草稿、计划或进行中的实验。':'没有找到这份实验记录。',true);return false;}
  if(!labBeginEditor(original))return false;
  const editor=labEditor,r=editor.record,existing=new Set(r.cell_sources.map(labSourceKey));
  editor.onClose=preset.onClose;
  if(preset.revision!==undefined)editor.revision=preset.revision;
  let added=0,retained=0;
  for(const group of preset.source_groups||[]){r.source_groups||=[];if(!r.source_groups.some(g=>g.id===group.id))r.source_groups.push(labClone(group));}
  for(const [key,source] of new Map(sourceRefs.map(source=>[labSourceKey(source),source]))){
    if(existing.has(key)){retained++;continue;}
    if(!editor.choices.has(key))editor.choices.set(key,labClone(source));
    r.cell_sources.push({container_id:source.container_id,well:source.well,...(source.snapshot_id?{snapshot_id:source.snapshot_id}:{})});
    existing.add(key);added++;
  }
  for(const table of labVariant(r).tables){
    const rows=r.tables[table.key]||=[],sources=new Set(rows.map(row=>row.source).filter(Boolean)),ids=new Set(rows.map(row=>row.row_id));
    for(const supplied of preset.tables?.[table.key]||[]){
      if(supplied.source&&sources.has(supplied.source))continue;
      const row=labClone(supplied);
      if(!row.row_id||ids.has(row.row_id))row.row_id=labRowId();
      for(const unit of Object.keys(labTableUnits(table.key))){
        if(row[unit])editor.unitOverrides.add(labUnitOverrideKey(table.key,row.row_id,unit));
        else row[unit]=rows.at(-1)?.[unit]||'';
      }
      rows.push(row);ids.add(row.row_id);if(row.source)sources.add(row.source);
    }
  }
  if(preset.notes)r.notes=[r.notes,preset.notes].filter(Boolean).join('\n\n');
  editor.transferNotice=`追加 ${added} 个细胞来源；${retained} 个已关联来源保留原始捕获快照，未刷新观察状态。`;
  labDrawEditor();labCollectEditor();dirty=labDraftFingerprint()!==editor.baseline;
  return true;
}
function labDraftFingerprint() {
  return JSON.stringify([labEditor.record,labEditor.refreshSources,labEditor.refreshRefs]);
}
function labCloseEditor(force = false) {
  if (!labEditor || labEditor.saving) return false;
  if(!labEditor.readonly)labCollectEditor();
  if(!force&&!labEditor.readonly&&labDraftFingerprint()!==labEditor.baseline&&!confirm('实验记录尚未保存。放弃这些修改并关闭？'))return false;
  const onClose=labEditor.onClose,savedId=labEditor.savedRecordId;
  $('#lab-record-dialog').close();labEditor=null;dirty=false;
  if(onClose)onClose({savedId});
  return true;
}
function labControl(field, value, attrs = '') {
  value=value??'';
  const label=esc(field.label), common=`aria-label="${label}" ${attrs}`;
  if(field.type==='textarea')return `<textarea ${common}>${esc(value)}</textarea>`;
  if(field.type==='select'||field.type==='source'){
    let options=field.type==='source'?labEffectiveSourceChoices().map(s=>[labTableSourceKey(s),labSourceLabel(s)+(s.observed_at?' · 观察 '+s.observed_at:' · 当前关联')]):(field.options||[]).map(v=>Array.isArray(v)?v:[v,field.option_labels?.[v]||v]);
    if(value&&!options.some(([key])=>key===value))options=[...options,[value,`${value}（需核对来源）`]];
    return `<select ${common}><option value="">未填写</option>${options.map(([key,text])=>`<option value="${esc(key)}" ${String(key)===String(value)?'selected':''}>${esc(text)}</option>`).join('')}</select>`;
  }
  const type=field.type==='datetime'?'datetime-local':field.type||'text';
  return `<input ${common} type="${esc(type)}" value="${esc(type==='datetime-local'?labDateTimeDisplay(value):value)}" ${type==='datetime-local'?`step="any" data-lab-original-time="${esc(value)}"`:''} ${type==='number'?`step="${field.integer?'1':'any'}" ${field.min!==undefined?`min="${field.min}"`:''}`:''}>`;
}
function labDateTimeDisplay(value){
  if(!value||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value))return value;
  const instant=new Date(value);if(!Number.isFinite(instant.getTime()))return value;
  const display=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(instant).replace(' ','T');
  const fraction=/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  return display+(fraction?'.'+fraction:'');
}
function labTableControl(table, row, field) {
  const attrs=`data-lab-column="${esc(field.key)}"`;
  if(!labTableUnits(table.key)[field.key])return labControl(field,row[field.key],attrs);
  const listId=`lab-unit-${table.key}-${row.row_id}-${field.key}`;
  return `<div class="cell-autocomplete lab-unit-control">${labControl(field,row[field.key],`${attrs} autocomplete="off" placeholder="输入或选择单位" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(listId)}"`)}<div id="${esc(listId)}" class="cell-name-suggestions lab-unit-suggestions" role="listbox" aria-label="${esc(field.label)}选项" hidden></div></div>`;
}
function labTableMarkup(table, rows) {
  return `<section class="lab-table-section"><div class="section-head"><h3>${esc(table.label)}</h3><button type="button" class="button secondary" data-lab-add-row="${esc(table.key)}">＋ 添加一行</button></div><div class="lab-table-scroll"><table><thead><tr>${table.columns.map(f=>`<th>${esc(f.label)}${f.required?' *':''}</th>`).join('')}<th>操作</th></tr></thead><tbody>${rows.map(row=>`<tr data-lab-table="${esc(table.key)}" data-row-id="${esc(row.row_id)}">${table.columns.map(f=>`<td>${labTableControl(table,row,f)}</td>`).join('')}<td><button type="button" class="text-button" data-lab-remove-row="${esc(row.row_id)}" aria-label="删除${esc(table.label)}此行">删除</button></td></tr>`).join('')}</tbody></table>${rows.length?'':'<p class="muted lab-table-empty">尚未填写数据，点击“添加一行”开始。</p>'}</div></section>`;
}
function labCapturedSourceMarkup(source, inherited = false) {
  const w=source.snapshot||{}, date=(source.observed_at||source.captured_at||'').slice(0,10)||boot.today;
  return `<details class="lab-captured"><summary>${inherited?'上游来源 · ':''}${esc(labSourceLabel(source))} · Day ${esc(w.day??'—')}</summary><p class="muted">捕获 ${esc(source.captured_at||'—')} · 观测 ${esc(source.observed_at||'—')} · 状态版本 ${esc(source.state_revision??'—')}<br>处理：${esc(w.treatment||'未填写')} · 浓度：${esc(w.concentration||'—')}<br>实验编号：${esc(w.experiment||'—')} · 备注：${esc(w.notes||'—')}</p>${typeof componentSummary==='function'?componentSummary(w,date):''}${typeof mediumDetailsMarkup==='function'?mediumDetailsMarkup(w.medium):''}${typeof countDetailsMarkup==='function'?countDetailsMarkup(w.cell_count):''}${typeof seedingDetailsMarkup==='function'?seedingDetailsMarkup(w.seeding):''}<button type="button" class="text-button" data-lab-current-container="${esc(source.container_id)}" data-lab-current-well="${esc(source.well)}">查看当前容器 / 孔位 ↗</button></details>`;
}
function labFilePathMarkup(path) {
  return /^https?:\/\//i.test(path||'')?`<a href="${esc(path)}" target="_blank" rel="noopener noreferrer">${esc(path)}</a>`:`<code>${esc(path||'未填写路径')}</code>`;
}
function labStructuredDataMarkup(record,readonly=false) {
  const variant=labVariant(record), sources=new Map((record.all_cell_sources||record.cell_sources||[]).map(s=>[labTableSourceKey(s),labSourceLabel(s)+(s.observed_at?' · 观察 '+s.observed_at:'')]));
  for(const group of record.all_source_groups||record.source_groups||[]){const choice=labGroupChoice(group);sources.set(choice.table_key,labSourceLabel(choice));}
  const valueText=(field,value)=>field.type==='source'?(sources.get(value)||value):(field.option_labels?.[value]||value);
  const sections=variant.sections||[{fields:variant.fields.map(f=>f.key),tables:variant.tables.map(t=>t.key)}];
  return sections.map(section=>{
    const fields=(section.fields||[]).map(key=>variant.fields.find(f=>f.key===key));
    const tables=(section.tables||[]).map(key=>variant.tables.find(t=>t.key===key));
    const fieldMarkup=!fields.length?'':readonly?`<dl class="lab-read-fields">${fields.map(f=>`<div><dt>${esc(f.label)}</dt><dd>${esc(record.data?.[f.key]||'—')}</dd></div>`).join('')}</dl>`:`<div class="lab-editor-grid">${fields.map(f=>`<label class="${f.type==='textarea'?'lab-span-two':''}">${esc(f.label)}${f.required?' *':''}${labControl(f,record.data[f.key],`data-lab-field="${esc(f.key)}"`)}</label>`).join('')}</div>`;
    const tableMarkup=tables.map(t=>!readonly?labTableMarkup(t,record.tables?.[t.key]||[]):`<section class="lab-table-section"><h3>${esc(t.label)}</h3><div class="lab-table-scroll"><table><thead><tr>${t.columns.map(f=>`<th>${esc(f.label)}</th>`).join('')}</tr></thead><tbody>${(record.tables?.[t.key]||[]).map(row=>`<tr>${t.columns.map(f=>`<td>${esc(valueText(f,row[f.key])??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table>${record.tables?.[t.key]?.length?'':'<p class="muted">尚未填写</p>'}</div></section>`).join('');
    if(section.collapsed)return `<details class="lab-optional-section"><summary>${esc(section.label)}</summary>${fieldMarkup}${tableMarkup}</details>`;
    return `${section.label?`<h3 class="lab-field-heading">${esc(section.label)}</h3>`:''}${fieldMarkup}${tableMarkup}`;
  }).join('');
}
function labReadonlyDataMarkup(record) {
  return `${labStructuredDataMarkup(record,true)}${labSourceGroupsMarkup(record,true)}<h3>原始文件索引</h3><p class="muted">仅保存路径/链接；原文件不随备份复制</p>${(record.files||[]).map(f=>`<div class="lab-file"><strong>${esc(f.label||'未命名文件')}</strong>${labFilePathMarkup(f.path)}<p>${esc(f.description||'')}</p></div>`).join('')}`;
}
function labRelationsMarkup() {
  const editor=labEditor, r=editor.record, captured=(editor.original.cell_sources||[]).filter(s=>s.snapshot&&s.captured_at), all=editor.original.all_cell_sources||[];
  const captures=new Set(captured.map(labSourceKey));
  const refRecords=editor.context?.state?labRecords(editor.context.state):labRecords();
  const upstream=(editor.original.record_refs||[]).filter(ref=>typeof ref!=='string');
  return `<section class="lab-relations"><h3>细胞来源</h3><p class="muted">关联时保存细胞状态。填写实验记录不会修改培养记录或扣减库存。</p>${editor.readonly?'':`<label>来源范围<select id="lab-source-scope"><option value="">当前培养状态</option>${(editor.snapshots||[]).map(s=>`<option value="${esc(s.id)}" ${String(s.id)===String(editor.scope)?'selected':''}>${esc(s.date)} · ${esc(s.at)} · #${esc(s.id)}</option>`).join('')}</select></label><button type="button" class="text-button" id="lab-load-snapshots">载入历史快照列表</button><div class="lab-source-choices">${labVisibleSourceChoices().map(s=>{const key=labSourceKey(s);return `<label class="lab-check"><input type="checkbox" data-lab-source="${esc(key)}" ${r.cell_sources.some(selected=>labSourceKey(selected)===key)?'checked':''}><span>${esc(labSourceLabel(s))}${captures.has(key)?'<small>保留已捕获的来源</small>':''}</span></label>`;}).join('')||'<p class="muted">此范围没有已填写的培养单元。</p>'}</div><label class="lab-check"><input type="checkbox" id="lab-refresh-sources" ${editor.refreshSources?'checked':''}>重新捕获所选细胞来源状态</label>`}${captured.map(s=>labCapturedSourceMarkup(s)).join('')}${all.filter(s=>!captures.has(labSourceKey(s))).map(s=>labCapturedSourceMarkup(s,true)).join('')}<h3>上游记录 / 药物批次</h3><p class="muted">保存上游记录的关联版本，可连接提取 → BCA → WB、核酸提取 → PCR 或药物处理与检测。</p>${editor.readonly?'':`<div class="lab-source-choices">${refRecords.filter(other=>other.id!==r.id).map(other=>`<label class="lab-check"><input type="checkbox" data-lab-ref="${esc(other.id)}" ${r.record_refs.includes(other.id)?'checked':''}><span>${esc(other.title||other.id)}<small>${esc(other.id)} · ${esc(labVariant(other).label)} · ${esc(labStatusLabel(other))} · v${esc(other.version)}</small></span></label>`).join('')||'<p class="muted">尚无其他实验记录。</p>'}</div><label class="lab-check"><input type="checkbox" id="lab-refresh-refs" ${editor.refreshRefs?'checked':''}>更新关联记录版本快照</label>`}${upstream.map(ref=>`<details class="lab-captured"><summary>${esc(ref.title||ref.id)} · 关联时版本 ${esc(ref.version)} · ${esc(ref.captured_at||'')}</summary><button type="button" class="text-button" data-lab-open-upstream="${esc(ref.id)}">打开${editor.readonly?'此快照中的':'当前'}上游记录 ↗</button>${labReadonlyDataMarkup(ref.snapshot?{...ref,...ref.snapshot}:ref)}</details>`).join('')}</section>`;
}
function labEffectiveSourceChoices() {
  const editor=labEditor, merged=new Map();
  for(const selected of editor.record.cell_sources){const key=labSourceKey(selected);merged.set(key,{...(editor.choices.get(key)||selected),table_key:key});}
  for(const id of editor.record.record_refs){
    const captured=(editor.original.record_refs||[]).find(ref=>ref.id===id);
    const record=captured&&!editor.refreshRefs?(captured.snapshot||captured):labRecords().find(ref=>ref.id===id);
    for(const source of record?.all_cell_sources||record?.cell_sources||[]){const key=source.observed_at?'OBS|'+labSourceKey(source)+'|'+source.observed_at:labTableSourceKey(source);if(!merged.has(key))merged.set(key,{...source,table_key:key});}
  }
  for(const group of labSourceGroupsForEditor([...merged.values()]))merged.set(group.table_key,group);
  return [...merged.values()];
}
function labVisibleSourceChoices() {
  const merged=new Map(labEditor.scopeSources.map(s=>[labSourceKey(s),s]));
  (labEditor.original.cell_sources||[]).forEach(s=>{const key=labSourceKey(s);merged.set(key,labEditor.choices.get(key)||s);});
  labEditor.record.cell_sources.forEach(s=>{const key=labSourceKey(s);merged.set(key,labEditor.choices.get(key)||s);});
  return [...merged.values()];
}
function labDrawEditor() {
  const editor=labEditor,r=editor.record,module=labModules()[r.type],variant=labVariant(r),readonly=editor.readonly;
  const exportSuffix=editor.context?.id?`?snapshot=${encodeURIComponent(editor.context.id)}`:'';
  $('#lab-record-dialog').innerHTML=`<form id="lab-record-form" novalidate><div class="dialog-head"><div><span class="eyebrow">${esc(r.id||'NEW LAB RECORD')}${r.version?' · V'+esc(r.version):''}</span><h2>${readonly?'查看实验记录':r.id?'编辑实验记录':'新建实验记录'}</h2></div><button type="button" id="lab-close" class="icon-button" aria-label="关闭实验记录">×</button></div>${readonly?'<div class="history-banner">历史快照只读 · 以下为保存时的记录及关联版本。</div>':''}${editor.transferNotice?`<p id="lab-transfer-notice" class="muted" role="status">${esc(editor.transferNotice)}</p>`:''}${r.id?`<div class="actions"><a class="button secondary" href="/api/lab/records/${encodeURIComponent(r.id)}.html${exportSuffix}" target="_blank" rel="noopener">导出 HTML</a><a class="button secondary" href="/api/lab/records/${encodeURIComponent(r.id)}.json${exportSuffix}">导出 JSON</a></div>`:''}<div class="lab-editor-grid"><label>模块<select id="lab-type" ${r.id||readonly?'disabled':''}>${Object.entries(labModules()).filter(([key])=>r.type==='drug'?key==='drug':key!=='drug').map(([key,m])=>`<option value="${esc(key)}" ${key===r.type?'selected':''}>${esc(m.label)}</option>`).join('')}</select></label><label>阶段<select id="lab-variant" ${r.id||readonly?'disabled':''}>${Object.entries(module.variants).map(([key,v])=>`<option value="${esc(key)}" ${key===r.variant?'selected':''}>${esc(v.label)}</option>`).join('')}</select></label><label class="lab-span-two">标题<input data-lab-common="title" value="${esc(r.title)}" ${readonly?'readonly':''}></label><label>记录日期<input type="date" data-lab-common="record_date" value="${esc(r.record_date)}" ${readonly?'readonly':''}></label><label>状态<select data-lab-common="status" ${readonly?'disabled':''}>${module.statuses.map(([key,label])=>`<option value="${esc(key)}" ${key===r.status?'selected':''}>${esc(label)}</option>`).join('')}</select></label><label class="lab-span-two">实验分组 / 编号<input data-lab-common="experiment" value="${esc(r.experiment)}" ${readonly?'readonly':''}></label><label class="lab-span-two">备注<textarea data-lab-common="notes" ${readonly?'readonly':''}>${esc(r.notes)}</textarea></label></div>${readonly?labReadonlyDataMarkup(editor.original):`<p class="muted">* 标记非草稿记录所需的信息。空白草稿可先保存，记录日期与状态按实际情况填写。</p>${labStructuredDataMarkup(r)}<section class="lab-table-section"><div class="section-head"><h3>原始文件索引</h3><button type="button" class="button secondary" id="lab-add-file">＋ 添加文件路径</button></div><p class="muted">仅保存路径/链接；原文件不随备份复制</p><div class="lab-file-edit-list">${r.files.map((file,index)=>`<div class="lab-file-edit" data-lab-file="${index}"><label>文件标签<input data-file-part="label" value="${esc(file.label)}"></label><label>路径 / 链接<input data-file-part="path" value="${esc(file.path)}" placeholder="本机路径或 https:// 链接"></label><label>说明<input data-file-part="description" value="${esc(file.description)}"></label><button type="button" class="text-button" data-lab-remove-file="${index}">删除</button></div>`).join('')}</div></section>`}${!readonly?labSourceGroupsMarkup(r):''}${labRelationsMarkup()}<p id="lab-save-error" class="lab-error" role="alert" hidden></p><div class="dialog-actions lab-editor-actions"><button type="button" class="button secondary" id="lab-cancel">${readonly?'关闭':'取消'}</button>${readonly?'':'<button type="submit" class="button primary" id="lab-save">保存记录</button>'}</div></form>`;
  labBindEditor();
}
function labReadValue(control, descriptor) {
  if(descriptor.type==='datetime'&&control.hasAttribute('data-lab-original-time')&&!control.dataset.labTimeEdited)return control.dataset.labOriginalTime;
  return control.value;
}
function labCollectEditor() {
  if(!labEditor||labEditor.readonly)return;
  const form=$('#lab-record-form');if(!form)return;
  const r=labEditor.record,variant=labVariant(r);
  form.querySelectorAll('[data-lab-common]').forEach(input=>r[input.dataset.labCommon]=input.value);
  form.querySelectorAll('[data-lab-field]').forEach(input=>{const field=variant.fields.find(f=>f.key===input.dataset.labField);r.data[field.key]=labReadValue(input,field);});
  variant.tables.forEach(t=>{const rows=[...form.querySelectorAll('[data-lab-table]')].filter(row=>row.dataset.labTable===t.key);r.tables[t.key]=rows.map(row=>{const data={row_id:row.dataset.rowId};row.querySelectorAll('[data-lab-column]').forEach(input=>{const f=t.columns.find(f=>f.key===input.dataset.labColumn);data[f.key]=labReadValue(input,f);});return data;});});
  r.files=[...form.querySelectorAll('[data-lab-file]')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-file-part]')].map(input=>[input.dataset.filePart,input.value])));
  const selectedSources=new Map([...form.querySelectorAll('[data-lab-source]:checked')].map(input=>[input.dataset.labSource,labEditor.choices.get(input.dataset.labSource)]));
  const sourceKeys=[...new Set([...r.cell_sources.map(labSourceKey).filter(key=>selectedSources.has(key)),...selectedSources.keys()])];
  r.cell_sources=sourceKeys.map(key=>{const s=selectedSources.get(key);return {container_id:s.container_id,well:s.well,...(s.snapshot_id?{snapshot_id:s.snapshot_id}:{})};});
  const visibleRefs=new Set([...form.querySelectorAll('[data-lab-ref]')].map(input=>input.dataset.labRef)),selectedRefs=[...form.querySelectorAll('[data-lab-ref]:checked')].map(input=>input.dataset.labRef);
  r.record_refs=[...new Set([...r.record_refs.filter(id=>!visibleRefs.has(id)||selectedRefs.includes(id)),...selectedRefs])];
  labEditor.refreshSources=!!$('#lab-refresh-sources')?.checked;
  labEditor.refreshRefs=!!$('#lab-refresh-refs')?.checked;
}
function labBindEditor() {
  const form=$('#lab-record-form'), editor=labEditor;
  $('#lab-close').onclick=$('#lab-cancel').onclick=()=>labCloseEditor();
  form.querySelectorAll('[data-lab-current-container]').forEach(button=>button.onclick=()=>{const id=button.dataset.labCurrentContainer,key=button.dataset.labCurrentWell;if(labCloseEditor())openHomeTarget(id,[key]);});
  form.querySelectorAll('[data-lab-open-upstream]').forEach(button=>button.onclick=()=>{
    const id=button.dataset.labOpenUpstream,context=editor.context,onClose=editor.onClose;
    // Keep the arranging window suspended until the final related editor closes.
    editor.onClose=null;
    if(!labCloseEditor()){editor.onClose=onClose;return;}
    if(openLabRecord(id,context||undefined)){
      if(onClose){labEditor.onClose=onClose;labEditor.revision=editor.revision;}
    }else if(onClose)onClose({});
  });
  if(editor.readonly){form.onsubmit=e=>e.preventDefault();return;}
  form.oninput=()=>{dirty=true;};
  form.onchange=()=>{dirty=true;};
  form.querySelectorAll('[data-lab-column="source"]').forEach(control=>control.addEventListener('change',()=>{
    labCollectEditor();form.querySelectorAll('[data-lab-remove-group]').forEach(button=>{button.disabled=Object.values(editor.record.tables||{}).flat().some(row=>row.source==='GROUP|'+button.dataset.labRemoveGroup);});
  }));
  form.querySelectorAll('.lab-unit-control input').forEach(input=>{
    const key=input.dataset.labColumn,table=input.closest('[data-lab-table]').dataset.labTable,list=document.getElementById(input.getAttribute('aria-controls'));
    attachHistoryAutocomplete(input,list,()=>labTableUnits(table)[key],{label:'单位',filter:filterTreatments});
    input.onclick=()=>input.dispatchEvent(new input.ownerDocument.defaultView.Event('focus'));
    const inherit=()=>{
      const row=input.closest('[data-lab-table]'),rows=[...form.querySelectorAll('[data-lab-table]')].filter(row=>row.dataset.labTable===table);
      editor.unitOverrides.add(labUnitOverrideKey(table,row.dataset.rowId,key));
      let previous=input.value;
      for(const next of rows.slice(rows.indexOf(row)+1)){
        const control=next.querySelector(`[data-lab-column="${key}"]`);
        if(!editor.unitOverrides.has(labUnitOverrideKey(table,next.dataset.rowId,key)))control.value=previous;
        previous=control.value;
      }
    };
    for(const event of ['input','change'])input.addEventListener(event,inherit);
  });
  form.querySelectorAll('[data-lab-original-time]').forEach(input=>{for(const name of ['input','change'])input.addEventListener(name,()=>input.dataset.labTimeEdited='true');});
  const rerender=action=>{labCollectEditor();action();dirty=true;labDrawEditor();};
  form.querySelectorAll('[data-lab-remove-group]').forEach(button=>button.onclick=()=>{
    const id=button.dataset.labRemoveGroup;if(Object.values(editor.record.tables||{}).flat().some(row=>row.source==='GROUP|'+id))return;
    rerender(()=>{editor.record.source_groups=editor.record.source_groups.filter(g=>g.id!==id);});
  });
  const switchVariant=(type,variant)=>{
    labCollectEditor();const r=editor.record;
    editor.variants[r.type+'/'+r.variant]={data:r.data,tables:r.tables};
    const saved=editor.variants[type+'/'+variant]||{data:{},tables:{}};
    r.type=type;r.variant=variant;r.data=saved.data;r.tables=saved.tables;
    if(!labModules()[type].statuses.some(([value])=>value===r.status))r.status='draft';
    dirty=true;labDrawEditor();
  };
  $('#lab-type').onchange=e=>switchVariant(e.target.value,Object.keys(labModules()[e.target.value].variants)[0]);
  $('#lab-variant').onchange=e=>switchVariant(editor.record.type,e.target.value);
  form.querySelectorAll('[data-lab-add-row]').forEach(button=>button.onclick=()=>rerender(()=>{
    const key=button.dataset.labAddRow,rows=editor.record.tables[key]||=[],row={row_id:labRowId()};
    for(const unit of Object.keys(labTableUnits(key)))row[unit]=rows.at(-1)?.[unit]||'';
    rows.push(row);
  }));
  form.querySelectorAll('[data-lab-remove-row]').forEach(button=>button.onclick=()=>rerender(()=>{const key=button.closest('[data-lab-table]').dataset.labTable;editor.record.tables[key]=editor.record.tables[key].filter(row=>row.row_id!==button.dataset.labRemoveRow);}));
  $('#lab-add-file').onclick=()=>rerender(()=>editor.record.files.push({label:'',path:'',description:''}));
  form.querySelectorAll('[data-lab-remove-file]').forEach(button=>button.onclick=()=>rerender(()=>editor.record.files.splice(Number(button.dataset.labRemoveFile),1)));
  form.querySelectorAll('[data-lab-source],[data-lab-ref],#lab-refresh-refs').forEach(input=>input.onchange=()=>rerender(()=>{}));
  $('#lab-load-snapshots').onclick=async()=>{
    labCollectEditor();const button=$('#lab-load-snapshots');button.disabled=true;
    try{const list=await api('/api/snapshots');if(labEditor!==editor||editor.saving)return;labCollectEditor();editor.snapshots=list;labDrawEditor();}
    catch(error){toast(error.message,true);button.disabled=false;}
  };
  $('#lab-source-scope').onchange=async e=>{
    labCollectEditor();const next=e.target.value;e.target.disabled=true;
    try{const snapshot=next?await api('/api/snapshots/'+encodeURIComponent(next)):null;if(labEditor!==editor||editor.saving)return;labCollectEditor();editor.scope=next;editor.scopeSources=labSourceCandidates(snapshot?.state||state,next);editor.scopeSources.forEach(source=>{const key=labSourceKey(source);if(!editor.choices.has(key))editor.choices.set(key,source);});labDrawEditor();}
    catch(error){toast(error.message,true);e.target.disabled=false;e.target.value=editor.scope;}
  };
  form.onsubmit=async event=>{
    event.preventDefault();if(editor.saving||busy)return;labCollectEditor();
    const r=editor.record,payload={type:r.type,variant:r.variant,title:r.title,record_date:r.record_date,status:r.status,experiment:r.experiment,notes:r.notes,data:r.data,tables:r.tables,files:r.files,cell_sources:r.cell_sources,record_refs:r.record_refs,refresh_sources:editor.refreshSources,refresh_refs:editor.refreshRefs,...(r.id?{id:r.id}:{})};
    if(Object.hasOwn(r,'source_groups'))payload.source_groups=r.source_groups.map(labSourceGroupInput);
    if(!labConfirmStatusChange(editor.original,r.status))return;
    editor.saving=true;busy=true;$('#lab-save-error').hidden=true;
    form.querySelectorAll('button,input,select,textarea').forEach(input=>{input.dataset.labWasDisabled=String(input.disabled);input.disabled=true;});
    try{const result=await api('/api/command',{action:'lab_record_save',revision:editor.revision,payload});state=result.state;const returning=!!editor.onClose;editor.savedRecordId=r.id||state.lab_records.at(-1).id;editor.saving=false;busy=false;labCloseEditor(true);if(!returning){if(!r.id){frozen=null;view=r.type==='drug'?'drugs':'labs';if(r.type!=='drug')labModuleFilter=r.type;}render();}toast('实验记录已保存。');}
    catch(error){editor.saving=false;busy=false;form.querySelectorAll('button,input,select,textarea').forEach(input=>{input.disabled=input.dataset.labWasDisabled==='true';});$('#lab-save-error').textContent=error.message;$('#lab-save-error').hidden=false;toast(error.message,true);}
  };
}
