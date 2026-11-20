'use strict';

function manualGroupMembers(source,ids) {
  return ids.flatMap(id=>{const c=(source.containers||[]).find(c=>c.id===id);return c?Object.entries(c.wells||{}).map(([key,w])=>({container:c,key,well:w})):[];});
}
function manualGroupValidation(source,ids,editingId='') {
  if(!ids.length)return '请选择要合并显示的完整瓶 / 皿容器。';
  const originals=ids.map(id=>(source.containers||[]).find(c=>c.id===id));
  if(originals.some(c=>!c||!(groupType(c.type)&&c.type!=='培养组')))return '只能选择原始培养瓶或培养皿，不能选择孔板。';
  if((source.display_groups||[]).some(g=>g.id!==editingId&&g.container_ids.some(id=>ids.includes(id))))return '已有容器属于其他显示组，请先取消原显示合并。';
  if(originals.some(c=>!Object.keys(c.wells||{}).length))return '所选容器没有已填写的瓶 / 皿成员，请先补全记录。';
  const members=manualGroupMembers(source,ids);
  if(members.length<2||members.length>100)return '请选择合计 2–100 个瓶 / 皿成员。';
  if(members.some(m=>!String(m.well.cell||'').trim()))return '所选容器含未填写细胞的成员，请先补全记录。';
  if(members.some(m=>m.well.components?.length))return '所选成员含混合细胞组成，不能按同株合并显示。';
  if(new Set(members.map(m=>m.well.cell.trim().toLocaleLowerCase())).size!==1)return '所有成员的细胞名称须一致（不区分大小写）。';
  if(new Set(members.map(m=>String(m.well.kind||'').trim())).size!==1||members.some(m=>!m.well.kind))return '所有成员的细胞类型须填写且一致。';
  return '';
}
function manualTreatmentSummary(w) {
  return [w.treatment,w.concentration,w.treated_at,...(w.active_treatments||[]).map(t=>[t.name,t.concentration,t.started_at].filter(Boolean).join(' · '))].filter(Boolean).join('；')||'未填写';
}
function manualMemberRows(members) {
  return members.map(({container:c,key,well:w})=>`<tr><th scope="row"><strong>${esc(c.name)}</strong><small>${esc(c.id)}<br>${esc(c.type)} · ${esc(groupMemberLabel(c,key))}<br>${esc(c.location||'未填写位置')}</small></th><td>${esc(w.cell||'未填写')}<small>${esc(w.kind||'未填写类型')}</small></td><td>${esc(w.batch||'未填写')}</td><td>${esc(w.day0||'未填写')}<small>${esc(w.anchor||'')}</small></td><td>${esc(mediumSummary(w.medium)||'未填写')}</td><td>${esc(manualTreatmentSummary(w))}</td><td>${esc(w.cell_count?countSummary(w.cell_count):'未填写')}</td><td>${c.status==='archived'||w.member_status==='archived'?'已结束':'在培养'}</td></tr>`).join('');
}
let manualGroupDraft=null;
function refreshManualGroupPreview() {
  if(!manualGroupDraft)return;
  const ids=manualGroupDraft.container_ids,members=manualGroupMembers(state,ids),error=manualGroupValidation(state,ids,manualGroupDraft.id);
  $('#manual-group-summary').textContent=`已选择 ${ids.length} 个原始容器 / ${members.length} 个瓶皿成员`;
  $('#manual-group-validation').textContent=error||'同名、同类型细胞。以下逐个保留原记录，日期、批次、配方与计数不做平均。';
  $('#manual-group-validation').classList.toggle('manual-group-invalid',!!error);
  $('#manual-group-save').disabled=!!error||!$('#manual-group-name').value.trim()||busy;
  $('#manual-group-preview').innerHTML=members.length?`<div class="manual-group-table-scroll"><table class="manual-group-table"><thead><tr><th>原始容器 / 成员 / 位置</th><th>细胞 / 类型</th><th>批次</th><th>Day 0</th><th>培养基</th><th>处理</th><th>计数</th><th>状态</th></tr></thead><tbody>${manualMemberRows(members)}</tbody></table></div>`:'<p class="muted">选择后会逐个列出全部成员的原始记录。</p>';
}
function closeManualGroup() {
  if(busy)return false;
  if(manualGroupDraft?.dirty&&!confirm('显示分组还未保存。放弃本次修改？'))return false;
  $('#manual-group-dialog').close();manualGroupDraft=null;return true;
}
function openManualGroup(id) {
  if(busy||frozen||!canLeave())return;
  const existing=(state.display_groups||[]).find(g=>g.id===id);
  if(id&&!existing)return toast('显示分组已变化，请刷新后重试。',true);
  dirty=false;manualGroupDraft={id:existing?.id||'',container_ids:[...(existing?.container_ids||[])],revision:state.revision,dirty:false};
  const candidates=state.containers.filter(c=>(groupType(c.type)&&c.type!=='培养组')),d=$('#manual-group-dialog');
  d.innerHTML=`<form id="manual-group-form" novalidate><div class="dialog-head"><div><span class="eyebrow">DISPLAY GROUP</span><h2>${existing?'编辑显示分组':'手动合并培养组'}</h2></div><button type="button" class="icon-button" data-manual-group-close aria-label="关闭">×</button></div><p class="muted">选择完整的原始瓶 / 皿容器；已有多瓶培养组会连同全部成员加入。合并仅调整显示，保留每瓶记录与历史。</p><label>分组名称<input id="manual-group-name" required maxlength="120" placeholder="例如：Jurkat 扩增培养组" value="${esc(existing?.name||'')}"></label><fieldset class="manual-group-candidates"><legend>选择原始容器</legend>${candidates.map(c=>{const owner=(state.display_groups||[]).find(g=>g.id!==existing?.id&&g.container_ids.includes(c.id)),checked=manualGroupDraft.container_ids.includes(c.id),members=Object.values(c.wells||{});return `<label class="manual-group-candidate ${owner?'is-unavailable':''}"><input type="checkbox" data-manual-group-container value="${esc(c.id)}" ${checked?'checked':''} ${owner?'disabled':''}><span><strong>${esc(c.name)}</strong><small>${esc(c.type)} × ${members.length} · ${esc(c.location||'未填写位置')} · ${c.status==='archived'?'已结束':'在培养'}<br>${esc([...new Set(members.map(w=>w.cell||'未填写细胞'))].join(' · '))}${owner?'<br>已归入：'+esc(owner.name):''}</small></span></label>`;}).join('')||'<p class="muted">还没有可选择的培养瓶或培养皿。</p>'}</fieldset><section class="manual-group-review"><h3>成员记录预览</h3><p id="manual-group-summary"></p><p id="manual-group-validation" role="status"></p><div id="manual-group-preview"></div></section><p id="manual-group-error" class="work-form-error" role="alert" hidden></p><div class="dialog-actions">${existing?'<button type="button" class="button danger" id="manual-group-unmerge">取消显示合并</button>':''}<button type="button" class="button secondary" data-manual-group-close>取消</button><button type="submit" class="button primary" id="manual-group-save">${existing?'保存分组':'合并显示'}</button></div></form>`;
  d.querySelectorAll('[data-manual-group-close]').forEach(b=>b.onclick=closeManualGroup);
  d.oncancel=e=>{e.preventDefault();closeManualGroup();};
  $('#manual-group-name').oninput=()=>{manualGroupDraft.dirty=true;refreshManualGroupPreview();};
  d.querySelectorAll('[data-manual-group-container]').forEach(box=>box.onchange=()=>{manualGroupDraft.container_ids=[...d.querySelectorAll('[data-manual-group-container]:checked')].map(x=>x.value);manualGroupDraft.dirty=true;refreshManualGroupPreview();});
  if(existing)$('#manual-group-unmerge').onclick=()=>unmergeManualGroup(existing.id);
  $('#manual-group-form').onsubmit=saveManualGroup;refreshManualGroupPreview();d.showModal();
}
async function saveManualGroup(event) {
  event.preventDefault();if(busy||!manualGroupDraft)return;
  const draft=manualGroupDraft,name=$('#manual-group-name').value.trim(),error=manualGroupValidation(state,draft.container_ids,draft.id)||(!name?'请填写分组名称。':'');
  const fail=message=>{const el=$('#manual-group-error');el.textContent=message;el.hidden=false;};
  if(error)return fail(error);
  const d=$('#manual-group-dialog'),controls=[...d.querySelectorAll('input,button')],disabled=controls.map(x=>x.disabled);
  busy=true;controls.forEach(x=>x.disabled=true);$('#manual-group-error').hidden=true;
  try {
    const payload={name,container_ids:draft.container_ids};if(draft.id)payload.id=draft.id;
    const result=await api('/api/command',{action:'merge_groups',payload,revision:draft.revision});state=result.state;
    const group=(state.display_groups||[]).find(g=>g.id===draft.id)||(state.display_groups||[]).find(g=>g.container_ids.length===draft.container_ids.length&&g.container_ids.every(id=>draft.container_ids.includes(id)));
    if(group){currentId=group.id;selected=new Set(groupDefaultSelection(current()));if(view==='today'){statusFilter=current().status;search='';experimentFilter='';}}
    manualGroupDraft=null;dirty=false;d.close();render();toast('已合并显示，各成员的原始记录与历史保留');
  }catch(error){fail(error.message);}finally{busy=false;controls.forEach((x,i)=>x.disabled=disabled[i]);if(manualGroupDraft)refreshManualGroupPreview();renderUndoControl();}
}
async function unmergeManualGroup(id) {
  if(busy||frozen||!canLeave())return;
  const group=(state.display_groups||[]).find(g=>g.id===id);if(!group)return;
  if(!confirm('取消“'+group.name+'”的显示合并？各原始容器将分别显示，全部培养记录、关联和历史保留。'))return;
  busy=true;
  try {
    const result=await api('/api/command',{action:'unmerge_groups',payload:{id},revision:manualGroupDraft?.id===id?manualGroupDraft.revision:state.revision});state=result.state;
    if(currentId===id){currentId=group.container_ids[0];const c=current();selected=new Set(c?groupDefaultSelection(c):[]);if(c&&view==='today')statusFilter=c.status;}
    manualGroupDraft=null;dirty=false;$('#manual-group-dialog').close();render();toast('已取消显示合并，原始记录与历史保留');
  }catch(error){toast(error.message,true);}finally{busy=false;renderUndoControl();}
}
