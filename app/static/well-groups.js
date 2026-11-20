'use strict';

// Binding metadata changes selection only. Every well keeps its own culture record.
let wellSelectionMode='group';
let wellGroupDraft=null;
function wellGroupFor(container,well){
  return (container?.well_groups||[]).find(group=>group.wells.includes(well))||null;
}
function wellGroupActiveMembers(container,group){
  if(container?.status==='archived')return [];
  return (group?.wells||[]).filter(key=>{const w=container?.wells?.[key];return w&&String(w.cell||'').trim()&&w.member_status!=='archived';});
}
function wellGroupSelection(container,keys,mode=wellSelectionMode){
  const next=new Set(keys);
  if(mode==='group')for(const key of keys){
    const group=wellGroupFor(container,key);
    if(group&&wellGroupActiveMembers(container,group).includes(key))for(const member of wellGroupActiveMembers(container,group))next.add(member);
  }
  return next;
}
function wellGroupSelectionChange(container,previous,next,mode=wellSelectionMode){
  if(mode!=='group')return new Set(next);
  const result=wellGroupSelection(container,next,mode),removed=new Set();
  for(const key of previous)if(!next.has(key)){
    const group=wellGroupFor(container,key);
    if(group&&wellGroupActiveMembers(container,group).includes(key))for(const member of wellGroupActiveMembers(container,group))removed.add(member);
  }
  for(const key of removed)result.delete(key);
  return result;
}
function availableWellGroupMembers(container,pending=null){
  return wellGroupActiveMembers(container,{wells:Object.keys(container?.wells||{})}).filter(key=>{
    const owner=wellGroupFor(container,key);
    return (!owner||(pending?.id&&owner.id===pending.id))&&!(pending?.wells||[]).includes(key);
  });
}
function defaultWellGroupName(container,keys){
  const cells=[...new Set(keys.map(key=>container.wells[key]?.cell).filter(Boolean))];
  return cells.length===1?cells[0].slice(0,120):keys.length?'培养组':'';
}
function wellGroupControlsMarkup(container,readonly){
  if(!boot.layouts[container.type])return '';
  return `<section class="well-group-controls" aria-label="培养组选择">${!readonly?`<div class="well-group-tools"><span class="well-selection-switch" role="group" aria-label="培养组选择范围">${[['group','整组'],['single','单孔']].map(([mode,label])=>`<button type="button" data-well-selection-mode="${mode}" aria-pressed="${wellSelectionMode===mode}" class="${wellSelectionMode===mode?'active':''}">${label}</button>`).join('')}</span><button type="button" class="button secondary well-group-add" id="bind-well-group">＋ 新增培养组</button><span class="muted">${wellSelectionMode==='group'?'点击成员会选中整个培养组':'按单孔选择，可单独操作组内成员'} · 已建 ${container.well_groups?.length||0} 组 · ${availableWellGroupMembers(container).length} 个在培养孔未分组</span></div>`:''}${container.well_groups?.length?`<div class="well-group-chips">${container.well_groups.map(group=>`<span class="well-group-chip"><button type="button" data-well-group-select="${esc(group.id)}" aria-pressed="false" title="点击切换此组；按住 Shift 或 Command/Ctrl 可多选"><strong>${esc(group.name)}</strong><small>${group.wells.map(esc).join(' · ')}</small></button>${!readonly?`<button type="button" data-well-group-edit="${esc(group.id)}" class="well-group-edit" aria-label="编辑培养组 ${esc(group.name)}">编辑</button>`:''}</span>`).join('')}</div>`:''}</section>`;
}
function refreshWellGroupControls(container){
  const button=$('#bind-well-group');
  if(button){button.disabled=busy||availableWellGroupMembers(container).length<2;button.title=button.disabled?'至少需要两个尚未分组的在培养孔':'可继续建立多个培养组，已有组保持不变';}
  document.querySelectorAll('#detail [data-well-group-select]').forEach(button=>{
    const group=(container.well_groups||[]).find(g=>g.id===button.dataset.wellGroupSelect),keys=wellGroupActiveMembers(container,group);
    const pressed=keys.length>0&&keys.every(key=>selected.has(key));button.setAttribute('aria-pressed',String(pressed));button.classList.toggle('selected',pressed);
  });
}
function bindWellGroupControls(container,readonly,selectKeys){
  document.querySelectorAll('#detail [data-well-selection-mode]').forEach(button=>button.onclick=()=>{
    if(busy||frozen||readonly||!canLeave())return;
    dirty=false;wellSelectionMode=button.dataset.wellSelectionMode;
    selected=wellSelectionMode==='single'?new Set():wellGroupSelection(container,selected);renderDetail();
  });
  document.querySelectorAll('#detail [data-well-group-select]').forEach(button=>button.onclick=event=>{
    const group=(container.well_groups||[]).find(g=>g.id===button.dataset.wellGroupSelect);
    if(!group||busy||!canLeave())return;
    const keys=readonly?group.wells:wellGroupActiveMembers(container,group);
    if(event?.shiftKey||event?.metaKey||event?.ctrlKey)selectKeys(keys,true);
    else{dirty=false;selected=new Set(keys);renderDetail();}
  });
  document.querySelectorAll('#detail [data-well-group-edit]').forEach(button=>button.onclick=()=>openWellGroup(button.dataset.wellGroupEdit));
  if($('#bind-well-group'))$('#bind-well-group').onclick=()=>openWellGroup();
  refreshWellGroupControls(container);
}
function wellGroupValidation(container,keys,groupId=''){
  if(!container||!boot.layouts[container.type]||container.status!=='active')return '只能绑定在培养孔板中的孔位。';
  if(keys.length<(groupId?1:2))return groupId?'培养组至少保留 1 个孔。':'请选择至少 2 个已填写且在培养的孔。';
  if(keys.some(key=>!wellGroupActiveMembers(container,{wells:[key]}).length))return '只能选择已填写且在培养的孔位。';
  if(keys.some(key=>{const group=wellGroupFor(container,key);return group&&group.id!==groupId;}))return '所选孔已属于其他培养组，请先编辑或解除原绑定。';
  return '';
}
function refreshWellGroupPreview(){
  if(!wellGroupDraft)return;
  const c=state.containers.find(c=>c.id===wellGroupDraft.containerId),keys=wellGroupDraft.wells,error=wellGroupValidation(c,keys,wellGroupDraft.id);
  $('#well-group-validation').textContent=error||`已选择 ${keys.length} 个孔；每孔的培养记录独立保留。`;
  $('#well-group-save').disabled=!!error||!$('#well-group-name').value.trim()||busy;
  if($('#well-group-save-next'))$('#well-group-save-next').disabled=$('#well-group-save').disabled||availableWellGroupMembers(c,wellGroupDraft).length<2;
  $('#well-group-preview').innerHTML=keys.length?`<div class="well-group-preview-scroll"><table class="well-group-preview-table"><thead><tr><th>孔位 / 细胞</th><th>Day 0 / 批次</th><th>培养基</th><th>处理</th><th>计数</th></tr></thead><tbody>${keys.map(key=>{const w=c.wells[key]||{};return `<tr><th>${esc(key)}<small>${esc(w.cell||'未填写')}</small></th><td>${esc(w.day0||'未填写')}<small>${esc(w.batch||'未填写批次')}</small></td><td>${esc(typeof mediumSummary==='function'?mediumSummary(w.medium)||'未填写':'')}</td><td>${esc([w.treatment,w.concentration,w.treated_at,...(w.active_treatments||[]).map(t=>[t.name,t.concentration,t.started_at].filter(Boolean).join(' · '))].filter(Boolean).join('；')||'未填写')}</td><td>${esc(w.cell_count&&typeof countSummary==='function'?countSummary(w.cell_count):'未填写')}</td></tr>`;}).join('')}</tbody></table></div>`:'<p class="muted">选择要绑定的孔位。</p>';
}
function closeWellGroup(){
  if(busy)return false;
  if(wellGroupDraft?.dirty&&!confirm('培养组修改还未保存。放弃本次修改？'))return false;
  $('#well-group-dialog').close();wellGroupDraft=null;return true;
}
function openWellGroup(groupId=''){
  if(busy||frozen||!canLeave())return;
  const c=current();if(!c||!boot.layouts[c.type]||c.status!=='active')return;
  const existing=(c.well_groups||[]).find(group=>group.id===groupId);
  if(groupId&&!existing)return toast('培养组已变化，请刷新后重试。',true);
  dirty=false;
  const available=availableWellGroupMembers(c);
  if(!existing&&available.length<2)return toast('本板至少需要两个尚未分组的在培养孔；已有组可通过各自的“编辑”调整。',true);
  const keys=existing?[...existing.wells]:[...selected].filter(key=>available.includes(key));
  wellGroupDraft={id:existing?.id||'',containerId:c.id,wells:keys,revision:state.revision,dirty:false,nameEdited:false};
  const d=$('#well-group-dialog');
  d.innerHTML=`<form id="well-group-form" novalidate><div class="dialog-head"><div><span class="eyebrow">CULTURE GROUP</span><h2>${existing?'编辑培养组':'新增培养组'}</h2></div><button type="button" class="icon-button" data-well-group-close aria-label="关闭">×</button></div><p class="muted">绑定后默认整组操作；需要时可切换单孔。每孔的 Day 0、培养基、处理和计数独立保留。</p><label>培养组名称<input id="well-group-name" required maxlength="120" placeholder="选孔后带入细胞名称，可自行修改" value="${esc(existing?.name||defaultWellGroupName(c,keys))}"></label><fieldset class="well-group-candidates"><legend>成员孔位</legend>${Object.entries(c.wells).filter(([key,w])=>w.cell).map(([key,w])=>{const owner=wellGroupFor(c,key),unavailable=owner&&owner.id!==existing?.id||!wellGroupActiveMembers(c,{wells:[key]}).length;return `<label class="well-group-candidate ${unavailable?'is-unavailable':''}"><input type="checkbox" data-well-group-member value="${esc(key)}" ${keys.includes(key)?'checked':''} ${unavailable?'disabled':''}><span><strong>${esc(key)}</strong> ${esc(w.cell)}<small>${owner&&owner.id!==existing?.id?'属于 '+esc(owner.name):w.member_status==='archived'?'已结束':''}</small></span></label>`;}).join('')}</fieldset><p id="well-group-validation" role="status"></p><div id="well-group-preview"></div><p id="well-group-error" class="work-form-error" role="alert" hidden></p><div class="dialog-actions">${existing?'<button type="button" class="button danger" id="well-group-remove">解除绑定</button>':''}<button type="button" class="button secondary" data-well-group-close>取消</button><button type="button" class="button secondary" id="well-group-save-next">保存并新增下一组</button><button type="submit" class="button primary" id="well-group-save">${existing?'保存修改':'保存当前组'}</button></div></form>`;
  d.querySelectorAll('[data-well-group-close]').forEach(button=>button.onclick=closeWellGroup);
  d.oncancel=event=>{event.preventDefault();closeWellGroup();};
  $('#well-group-name').oninput=()=>{wellGroupDraft.dirty=true;wellGroupDraft.nameEdited=true;refreshWellGroupPreview();};
  d.querySelectorAll('[data-well-group-member]').forEach(box=>box.onchange=()=>{if(box.disabled||busy)return;wellGroupDraft.wells=[...d.querySelectorAll('[data-well-group-member]:checked')].map(node=>node.value);if(!wellGroupDraft.id&&!wellGroupDraft.nameEdited)$('#well-group-name').value=defaultWellGroupName(c,wellGroupDraft.wells);wellGroupDraft.dirty=true;refreshWellGroupPreview();});
  $('#well-group-form').onsubmit=saveWellGroup;
  $('#well-group-save-next').onclick=event=>saveWellGroup(event,true);
  if(existing)$('#well-group-remove').onclick=removeWellGroup;
  refreshWellGroupPreview();d.showModal();
}
async function saveWellGroup(event,continueAdding=false){
  event.preventDefault();if(busy||frozen||!wellGroupDraft)return;
  const draft=wellGroupDraft,c=state.containers.find(c=>c.id===draft.containerId),name=$('#well-group-name').value.trim();
  const error=wellGroupValidation(c,draft.wells,draft.id)||(!name?'请填写培养组名称。':'');
  if(error){$('#well-group-error').textContent=error;$('#well-group-error').hidden=false;return;}
  const payload={id:draft.containerId,...(draft.id?{group_id:draft.id}:{}),name,wells:[...draft.wells]};
  await commitWellGroup('well_group_save',payload,continueAdding);
}
async function removeWellGroup(){
  if(busy||frozen||!wellGroupDraft?.id)return;
  if(!confirm('解除此培养组的绑定？所有孔位和培养记录保留。'))return;
  await commitWellGroup('well_group_remove',{id:wellGroupDraft.containerId,group_id:wellGroupDraft.id});
}
async function commitWellGroup(action,payload,continueAdding=false){
  const draft=wellGroupDraft,d=$('#well-group-dialog'),controls=[...d.querySelectorAll('input,button')],disabled=controls.map(control=>control.disabled);
  busy=true;controls.forEach(control=>control.disabled=true);$('#well-group-error').hidden=true;
  try{
    const result=await api('/api/command',{action,payload,revision:draft.revision});state=result.state;
    if(action==='well_group_save')selected=wellGroupSelection(state.containers.find(c=>c.id===draft.containerId),draft.wells);
    wellGroupDraft=null;dirty=false;d.close();busy=false;
    const next=continueAdding&&action==='well_group_save'&&availableWellGroupMembers(state.containers.find(c=>c.id===draft.containerId)).length>=2;
    if(next)selected.clear();
    render();
    if(next){openWellGroup();toast('当前组已保存，请继续选择下一组的孔位。');}
    else toast(action==='well_group_remove'?'已解除培养组绑定，孔位记录保留。':'已保存培养组，每个组都可独立选择和编辑。');
  }catch(error){$('#well-group-error').textContent=error.message;$('#well-group-error').hidden=false;}
  finally{busy=false;controls.forEach((control,i)=>control.disabled=disabled[i]);if(wellGroupDraft)refreshWellGroupPreview();renderUndoControl();}
}
