'use strict';
const activityKinds={observe:'观察',medium_change:'换液',topup:'补液',treatment:'添加处理',end_treatment:'结束处理',sample:'取样',count:'计数',note:'其他备注'};
let activityDraft=null, journalRequest=0;
function workTime(value){return value?String(value).replace('T',' ').slice(0,19):'—';}
function journalMarkup(entries){
  if(!entries?.length)return '<p class="work-empty">暂无记录。</p>';
  return `<ol class="work-timeline">${entries.map(e=>`<li class="${e.undone?'is-undone':''}"><div class="work-event-heading"><strong>${esc(e.title||e.action)}</strong><span class="pill ${e.is_operation?'green':''}">${e.is_operation?(e.undone?'操作记录':'实际操作'):'记录修改'}</span>${e.undone?'<span class="pill amber">已撤销</span>':''}</div><p class="work-event-summary">${esc(e.summary||'')}</p><p class="muted">${esc((e.containers||[]).map(c=>c.name||c.id).join(' · '))}${e.wells?.length?' / '+esc(e.wells.join('、')):''}</p><div class="work-event-times"><span>实际发生：${esc(workTime(e.occurred_at))}</span><span>录入：${esc(workTime(e.recorded_at))}</span>${e.undone?`<span>撤销：${esc(workTime(e.undone_at))}</span>`:''}</div></li>`).join('')}</ol>`;
}
function renderWorkday(){
  const work=boot.workday;
  if(!work){$('#content').innerHTML='<div class="panel">今日工作尚未载入。请刷新页面。</div>';return;}
  const summaries=typeof homeActiveSummary==='function'?new Map(displayContainers().map(c=>[c.id,homeActiveSummary(c)])):new Map();
  const n=work.counts||{},containers=sortCulturesByCheck((work.containers||[]).filter(c=>c.status==='active').map(c=>{
    const summary=summaries.get(c.id);return summary?{...c,type:summary.type,primary_type:summary.primary_type,quantity:summary.quantity}:c;
  }));
  $('#content').innerHTML=`<div class="work-stats">${[[n.active,'在培养','个容器'],[n.pending,'待核对','逐个检查当前记录'],[n.checked,'已核对','今日已检查'],[n.operations,'实际操作','今日追加操作'],[n.edits,'记录修改','今日资料变更']].map(([v,label,help])=>`<div><b>${esc(v??0)}</b><span>${label}</span><small>${help}</small></div>`).join('')}</div><div class="section-head"><div><h2>今日工作</h2><span class="muted">${esc(work.date)} · 北京时间</span></div><div class="actions"><button class="button primary" id="work-add-activity" ${!containers.some(c=>c.status==='active'&&c.occupied)?'disabled':''}>＋ 记录操作</button><button class="button secondary" id="work-save-snapshot">保存今日快照</button><button class="button secondary" id="work-add-container">新增容器</button><button class="text-button" id="work-journal">查看全部日志</button></div></div><div class="notice"><span>逐个核对当前培养；操作可按实际发生时间补记。<br><span class="muted">${work.snapshot?`今日快照：${esc(workTime(work.snapshot.at))} · ${work.snapshot.verified?'已核对':'保留未核对标记'}${work.snapshot.up_to_date===false?' · 之后有新记录，可重新保存快照':''}`:'今日尚未保存快照'}${work.baseline?` · 参考留档：${esc(work.baseline.date)}`:''}</span></span><button class="text-button" id="work-cultures">打开当前培养 ↗</button></div><div class="work-containers">${containers.map(c=>`<article class="work-container"><div class="card-top"><span class="pill">${esc(groupTypeLabel(c))}</span><span class="pill ${c.checked?'green':'amber'}">${c.status!=='active'?'已结束':c.checked?'已核对':'待核对'}</span></div><h3>${esc(c.name)}</h3><p class="muted">${esc(c.id)} · ${esc(c.occupied)} 个培养单元${c.new_today?' · 今日新建':''}<br>今日操作 ${esc(c.operation_count||0)} 次 · 记录修改 ${esc(c.edit_count||0)} 次${c.active_treatment_count?` · 进行中处理 ${esc(c.active_treatment_count)}`:''}</p><div class="work-card-actions"><button class="button secondary" data-work-open="${esc(c.id)}">打开培养</button><button class="button secondary" data-work-activity="${esc(c.id)}" ${!c.occupied||c.status!=='active'?'disabled':''}>记录操作</button><button class="text-button" data-work-journal="${esc(c.id)}">日志</button></div><button class="work-check" data-work-check="${esc(c.id)}" ${c.checked||c.status!=='active'||!c.occupied?'disabled':''}>${c.status!=='active'?'培养已结束':c.checked?'✓ 今日已核对':'已检查，无新增变化'}</button></article>`).join('')||'<div class="panel"><h3>还没有在培养的容器</h3><p class="muted">新增容器后，填写细胞与起始日期。</p></div>'}</div><div class="section-head"><div><h2>今日时间线</h2><span class="muted">实际操作与记录修改分别标记；撤销记录继续保留。</span></div></div>${journalMarkup(work.timeline)}`;
  $('#work-save-snapshot').onclick=()=>saveSnapshot(false);$('#work-add-activity').onclick=()=>openActivity();$('#work-add-container').onclick=showCreate;
  $('#work-journal').onclick=()=>openJournal();$('#work-cultures').onclick=()=>switchView('today');
  document.querySelectorAll('[data-work-open]').forEach(b=>b.onclick=()=>{const id=b.dataset.workOpen,c=displayContainers().find(c=>c.id===id);openHomeTarget(id,groupType(c?.type)?groupDefaultSelection(c):Object.keys(c?.wells||{}).filter(k=>memberActive(c.wells[k])));});
  document.querySelectorAll('[data-work-activity]').forEach(b=>b.onclick=()=>openActivity(b.dataset.workActivity));
  document.querySelectorAll('[data-work-journal]').forEach(b=>b.onclick=()=>openJournal(b.dataset.workJournal));
  document.querySelectorAll('[data-work-check]').forEach(b=>b.onclick=async()=>{
    if(busy||!canLeave())return;busy=true;b.disabled=true;
    try{const result=await api('/api/command',{action:'check',payload:{id:b.dataset.workCheck},revision:state.revision});state=result.state;dirty=false;render();toast('已记录本次核对');}
    catch(error){toast(error.message,true);b.disabled=false;}finally{busy=false;renderUndoControl();}
  });
}
function activeTreatmentMarkup(wells){
  const entries=wells.flatMap((w,i)=>(w.active_treatments||[]).map(t=>({well:w.key||w.well||w.id||String(i+1),...t})));
  if(!entries.length)return '';
  return `<section class="active-treatments"><h4>进行中处理</h4>${entries.map(t=>`<p><strong>${esc(t.name)}</strong>${t.concentration?' · '+esc(t.concentration):''}<br><span class="muted">${esc(t.well)} · 开始 ${esc(workTime(t.started_at))}</span></p>`).join('')}</section>`;
}
function activityUnitMarkup(key){return `<div class="cell-autocomplete"><input id="activity-${key}" data-activity="${key}" autocomplete="off" placeholder="输入或选择单位" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="activity-${key}-suggestions"><div id="activity-${key}-suggestions" class="cell-name-suggestions" role="listbox" aria-label="单位选项" hidden></div></div>`;}
function activityField(key){return $('#activity-dialog').querySelector(`[data-activity="${key}"]`);}
function activityWells(){return [...$('#activity-dialog').querySelectorAll('[data-activity-well]:checked')].map(x=>x.value);}
function activityContainer(){return displayContainers().find(c=>c.id===activityField('id').value);}
function activityReadCount(){
  const v=Object.fromEntries(['mode','coefficient','exponent','unit','count_volume_value','count_volume_unit'].map(k=>[k,activityField(k).value.trim()]));
  return {mode:v.mode,coefficient:v.coefficient,exponent:v.exponent,unit:v.unit,volume_value:v.mode==='concentration'?v.count_volume_value:'',volume_unit:v.mode==='concentration'?v.count_volume_unit:'',measured_at:activityField('occurred_at').value};
}
function activityEndOptions(){
  const root=$('#activity-end-options'),old=new Set([...root.querySelectorAll('input:checked')].map(x=>x.value)),c=activityContainer(),keys=activityWells();
  const common=keys.length?(c.wells[keys[0]].active_treatments||[]).filter(t=>keys.every(k=>(c.wells[k].active_treatments||[]).some(other=>other.id===t.id))):[];
  root.innerHTML=common.map(t=>`<label class="inline-check"><input type="checkbox" data-activity-treatment value="${esc(t.id)}" ${old.has(t.id)?'checked':''}><span>${esc(t.name)}${t.concentration?' · '+esc(t.concentration):''}<small>开始 ${esc(workTime(t.started_at))}</small></span></label>`).join('')||'<p class="muted">所选培养单元没有共同的进行中处理。请调整孔位选择。</p>';
}
function activityRenderWells(preferred){
  const c=activityContainer(),keys=Object.keys(c?.wells||{}).filter(k=>memberActive(c.wells[k])),choice=preferred||keys;
  $('#activity-wells').innerHTML=keys.map(k=>`<label class="activity-well"><input type="checkbox" data-activity-well value="${esc(k)}" ${choice.includes(k)?'checked':''}><span><strong>${esc(groupMemberLabel(c,k))}</strong><small>${esc(c.wells[k].cell)}</small></span></label>`).join('')||'<p class="muted">此容器尚未填写细胞。请先在培养信息中填写。</p>';
  const note=$('#activity-group-note');if(note)note.hidden=!groupType(c?.type);
  activityEndOptions();
}
function activitySync(){
  activityField('occurred_at').max=localMinute();
  const kind=activityField('kind').value,volume=['medium_change','topup','sample'].includes(kind);
  $('#activity-dialog').querySelectorAll('[data-activity-section]').forEach(section=>{
    const shown=section.dataset.activitySection==='volume'?volume:section.dataset.activitySection===kind;
    section.hidden=!shown;section.querySelectorAll('input,select,textarea').forEach(input=>input.disabled=!shown);
  });
  activityField('details').required=['observe','note'].includes(kind);
  activityField('treatment').required=kind==='treatment';
  activityField('volume_unit').required=volume&&!!activityField('volume_value').value.trim();
  ['coefficient','exponent','unit'].forEach(k=>activityField(k).required=kind==='count');
  const countVolume=kind==='count'&&activityField('mode').value==='concentration';
  $('#activity-count-volume').hidden=!countVolume;
  ['count_volume_value','count_volume_unit'].forEach(k=>activityField(k).disabled=!countVolume);
  activityField('count_volume_unit').required=countVolume&&!!activityField('count_volume_value').value.trim();
  $('#activity-count-estimate').textContent=kind==='count'?countEstimate(activityReadCount()):'';
}
function closeActivity(){
  if(busy)return false;
  if(activityDraft?.dirty&&!confirm('操作还未保存。放弃本次填写？'))return false;
  $('#activity-dialog').close();activityDraft=null;return true;
}
function openActivity(containerId,kind='observe'){
  if(busy||frozen||!canLeave())return;
  const containers=displayContainers().filter(c=>c.status==='active');
  if(!containers.length){toast('请先新增培养容器',true);return;}
  const targetId=displayMemberLocation(state,containerId||currentId,'').id;
  const c=containers.find(c=>c.id===targetId)||containers.find(c=>Object.values(c.wells).some(memberActive))||containers[0];
  if(c.id===currentId&&selected.size&&![...selected].some(k=>memberActive(c.wells[k]))){toast('请先选择在培养的瓶 / 皿或孔位；已结束成员不能追加操作。',true);return;}
  dirty=false;activityDraft={revision:state.revision,dirty:false};
  const d=$('#activity-dialog');d.classList.add('work-dialog');
  d.innerHTML=`<form id="activity-form"><div class="dialog-head"><div><span class="eyebrow">CULTURE ACTIVITY</span><h2>记录操作</h2></div><button type="button" class="icon-button" data-activity-cancel aria-label="关闭">×</button></div><div class="two"><label>培养容器<select data-activity="id">${containers.map(x=>`<option value="${esc(x.id)}" ${x.id===c.id?'selected':''}>${esc(x.name)} · ${esc(groupTypeLabel(x))}</option>`).join('')}</select></label><label>操作类型<select data-activity="kind">${Object.entries(activityKinds).map(([value,name])=>`<option value="${value}" ${value===kind?'selected':''}>${name}</option>`).join('')}</select></label></div><div class="activity-selection-heading"><strong>培养单元</strong><div><button type="button" class="text-button" id="activity-select-all">选择全部在培养成员</button><button type="button" class="text-button" id="activity-select-none">取消选择</button></div></div><div id="activity-wells" class="activity-wells"></div><p id="activity-group-note" class="group-count-note muted" hidden>默认选择全组在培养成员，可取消后改选部分瓶 / 皿。计数、总数和本次操作体积按每瓶 / 皿填写；保存后各成员独立记录，不合计为全组总量。</p><label>实际发生时间（北京时间）<input data-activity="occurred_at" type="datetime-local" required value="${esc(localMinute())}" max="${esc(localMinute())}"></label><p class="muted">录入时间将在保存时自动记录。</p><div data-activity-section="treatment"><label>处理名称<input data-activity="treatment" maxlength="200" placeholder="如：抗体处理 / 药物刺激"></label><label>浓度 / 剂量（可选）<input data-activity="concentration" placeholder="数值与单位"></label></div><section data-activity-section="end_treatment"><h3>选择要结束的处理</h3><p class="muted">仅列出所选培养单元共同进行中的处理。</p><div id="activity-end-options"></div></section><div data-activity-section="volume"><div class="two"><label>本次操作体积（可选）<input data-activity="volume_value" inputmode="decimal" placeholder="填写数值"></label><label>体积单位${activityUnitMarkup('volume_unit')}</label></div><p class="muted">操作在此留档；配方变化请在培养信息中更新。</p></div><section data-activity-section="count"><label>计数方式<select data-activity="mode"><option value="concentration" selected>细胞浓度</option><option value="total">细胞总数</option></select></label><div class="activity-number"><label>数值 / 系数<input data-activity="coefficient" inputmode="decimal" placeholder="测量值"></label><span>× 10</span><label>指数<input data-activity="exponent" type="number" step="1" value="0" list="activity-exponents"></label></div><datalist id="activity-exponents">${[0,3,4,5,6,7,8,9].map(n=>`<option value="${n}"></option>`).join('')}</datalist><label>计数单位${activityUnitMarkup('unit')}</label><div id="activity-count-volume" class="two"><label>大致培养基体积（可选）<input data-activity="count_volume_value" inputmode="decimal" placeholder="填写数值"></label><label>体积单位${activityUnitMarkup('count_volume_unit')}</label></div><p id="activity-count-estimate" class="muted" aria-live="polite"></p><p class="muted">计数时间使用上方实际发生时间。保存后更新所选培养单元的当前计数，原始记录保留。混合培养计数针对整个孔。</p></section><label>操作详情 / 观察结果<textarea data-activity="details" rows="3" placeholder="如实记录本次操作或观察"></textarea></label><p id="activity-error" class="work-form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="text-button" id="activity-transfer">传代 / 开展实验 ↗</button><button type="button" class="button secondary" data-activity-cancel>取消</button><button type="submit" class="button primary">保存操作</button></div></form>`;
  const preferred=c.id===currentId?[...selected].filter(k=>memberActive(c.wells[k])):[];
  activityRenderWells(preferred.length?preferred:undefined);activitySync();
  d.querySelectorAll('[data-activity-cancel]').forEach(b=>b.onclick=closeActivity);
  d.oncancel=e=>{e.preventDefault();closeActivity();};
  d.querySelector('form').addEventListener('input',()=>{activityDraft.dirty=true;activitySync();});
  d.querySelector('form').addEventListener('change',e=>{
    activityDraft.dirty=true;
    if(e.target===activityField('id'))activityRenderWells();
    if(e.target.matches('[data-activity-well]'))activityEndOptions();
    if(e.target===activityField('mode')){activityField('unit').value='';$('#activity-unit-suggestions').hidden=true;activityField('unit').setAttribute('aria-expanded','false');}
    activitySync();
  });
  for(const [id,checked] of [['activity-select-all',true],['activity-select-none',false]])$('#'+id).onclick=()=>{d.querySelectorAll('[data-activity-well]').forEach(x=>x.checked=checked);activityDraft.dirty=true;activityEndOptions();activitySync();};
  ['unit','volume_unit','count_volume_unit'].forEach(key=>attachHistoryAutocomplete(activityField(key),$('#activity-'+key+'-suggestions'),()=>countUnitHistory(key==='unit'?activityField('mode').value+'_units':'volume_units',Object.values(activityContainer().wells)),{label:'单位',filter:filterTreatments}));
  $('#activity-transfer').onclick=()=>{const id=activityField('id').value,keys=activityWells();if(!keys.length){toast('请先选择已填写的培养单元',true);return;}if(!closeActivity())return;currentId=id;selected=new Set(keys);view='today';statusFilter='active';search='';if(typeof experimentFilter!=='undefined')experimentFilter='';frozen=null;render();openTransfer();};
  $('#activity-form').onsubmit=saveActivity;d.showModal();
}
async function saveActivity(event){
  event.preventDefault();if(busy||!activityDraft)return;
  const d=$('#activity-dialog'),kind=activityField('kind').value,volume=['medium_change','topup','sample'].includes(kind);
  const payload={id:activityField('id').value,wells:activityWells(),kind,occurred_at:activityField('occurred_at').value,details:activityField('details').value.trim(),volume_value:volume?activityField('volume_value').value.trim():'',volume_unit:volume?activityField('volume_unit').value.trim():'',treatment:kind==='treatment'?activityField('treatment').value.trim():'',concentration:kind==='treatment'?activityField('concentration').value.trim():'',treatment_ids:kind==='end_treatment'?[...d.querySelectorAll('[data-activity-treatment]:checked')].map(x=>x.value):[]};
  const fail=message=>{const el=$('#activity-error');el.textContent=message;el.hidden=false;};
  if(!payload.wells.length){fail('请选择至少一个已填写的培养单元。');return;}
  if(!payload.occurred_at){fail('请填写实际发生时间。');return;}
  if(kind==='end_treatment'&&!payload.treatment_ids.length){fail('请选择要结束的处理。');return;}
  if(kind==='treatment'&&!payload.treatment){fail('请填写处理名称。');return;}
  if((['observe','note'].includes(kind)||volume&&!payload.volume_value)&&!payload.details){fail('请填写操作详情或观察结果。');return;}
  const decimal=/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
  if(volume&&payload.volume_value&&(!decimal.test(payload.volume_value)||!payload.volume_unit)){fail('请填写有效的操作体积及单位。');return;}
  if(kind==='count'){
    payload.cell_count=activityReadCount();const c=payload.cell_count;
    if(!decimal.test(c.coefficient)||!/^[-+]?\d+$/.test(c.exponent)||!c.unit){fail('请填写有效的计数、整数指数及单位。');return;}
    if(c.volume_value&&(!decimal.test(c.volume_value)||!c.volume_unit)){fail('请填写有效的培养基体积及单位。');return;}
  }
  busy=true;$('#activity-error').hidden=true;const controls=[...d.querySelectorAll('button,input,select,textarea')],disabled=controls.map(x=>x.disabled);controls.forEach(x=>x.disabled=true);
  try{const result=await api('/api/command',{action:'activity',payload,revision:activityDraft.revision});state=result.state;dirty=false;const currentGroup=displayContainers().find(c=>c.id===currentId);selected=new Set(groupType(currentGroup?.type)?groupDefaultSelection(currentGroup):[]);activityDraft=null;d.close();render();toast('操作已保存');}
  catch(error){fail(error.message);}finally{busy=false;controls.forEach((x,i)=>x.disabled=disabled[i]);renderUndoControl();}
}
async function openJournal(containerId,{preserveOriginal=false}={}){
  if(containerId&&!preserveOriginal)containerId=displayMemberLocation(state,containerId,'').id;
  const containers=displayContainers(),original=preserveOriginal?(state.containers||[]).find(c=>c.id===containerId):null;
  if(original&&!containers.some(c=>c.id===original.id))containers.push(original);
  const d=$('#journal-dialog');d.classList.add('work-dialog');
  d.innerHTML=`<div class="dialog-head"><div><span class="eyebrow">ACTIVITY JOURNAL</span><h2>操作日志</h2></div><button type="button" class="icon-button" id="journal-close" aria-label="关闭">×</button></div><label>培养容器<select id="journal-container"><option value="">全部容器</option>${containers.map(c=>`<option value="${esc(c.id)}" ${c.id===containerId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><p class="muted">展示最近 200 条记录 · 时间均为北京时间</p><a class="button secondary" href="/api/activities.csv">导出今日日志 CSV</a><div id="journal-entries" aria-live="polite"></div>`;
  $('#journal-close').onclick=()=>{journalRequest++;d.close();};d.oncancel=()=>{journalRequest++;};
  async function refresh(){const request=++journalRequest;$('#journal-entries').innerHTML='<p class="muted">正在读取日志…</p>';try{const id=$('#journal-container').value,rows=await api('/api/activities'+(id?'?container='+encodeURIComponent(id):''));if(request===journalRequest&&d.open)$('#journal-entries').innerHTML=journalMarkup(rows);}catch(error){if(request===journalRequest&&d.open)$('#journal-entries').innerHTML=`<p class="work-form-error">${esc(error.message)}</p>`;}}
  $('#journal-container').onchange=refresh;d.showModal();await refresh();
}
function renderUndoControl(){const b=$('#undo-last');if(!b)return;b.disabled=busy||!boot.undo||!!frozen;b.title=boot.undo?'撤销：'+boot.undo.title:'暂无可撤销的记录修改';b.onclick=openUndo;}
function openUndo(){
  if(busy||frozen||!boot.undo||!canLeave())return;
  const candidate=boot.undo,revision=state.revision,d=$('#undo-dialog');
  d.innerHTML=`<form id="undo-form"><div class="dialog-head"><h2>撤销上次修改</h2><button type="button" class="icon-button" data-undo-cancel aria-label="关闭">×</button></div><div class="undo-preview"><strong>${esc(candidate.title)}</strong><p>${esc(workTime(candidate.at))}</p><p>${esc((candidate.containers||[]).map(c=>c.name||c.id).join(' · '))}</p><p>${esc(candidate.summary||'')}</p></div><p class="muted">撤销这次记录修改，历史快照与日志保留。</p><p id="undo-error" class="work-form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary" data-undo-cancel>取消</button><button type="submit" class="button danger">撤销这次修改</button></div></form>`;
  d.querySelectorAll('[data-undo-cancel]').forEach(b=>b.onclick=()=>{if(!busy)d.close();});d.oncancel=e=>{if(busy)e.preventDefault();};
  $('#undo-form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;d.querySelectorAll('button').forEach(b=>b.disabled=true);try{const result=await api('/api/command',{action:'undo',payload:{target_event_id:candidate.event_id},revision});state=result.state;dirty=false;selected.clear();if(view==='events')events=await api('/api/events');d.close();render();toast('已撤销这次修改，日志与快照保留');}catch(error){$('#undo-error').textContent=error.message;$('#undo-error').hidden=false;}finally{busy=false;d.querySelectorAll('button').forEach(b=>b.disabled=false);renderUndoControl();}};
  d.showModal();
}
