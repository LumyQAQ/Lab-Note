'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let boot, state, view = 'home', currentId = null, selected = new Set(), statusFilter = 'active', search = '', frozen = null, dirty = false, busy = false;
let experimentFilter='';
let snapshots = [], events = [], historyDate = '';
let plateInteraction={id:null,mode:'select'};
const fieldSpecs = [
  ['cell','细胞名称','text','如：PBMC、Jurkat'], ['kind','细胞类型','select',['细胞系','原代细胞']],
  ['batch','批次 / 供者编号','text','用编号区分不同批次'], ['day0','Day 0 日期','date',''],
  ['anchor','Day 0 依据','select',['传代','复苏','激活扩增']], ['treatment','特殊处理','textarea','如实记录已完成的处理'],
  ['concentration','浓度 / 剂量','text','填写数值和单位'], ['treated_at','处理时间（北京时间）','datetime-local',''],
  ['notes','观察 / 备注','textarea','状态、换液、计划等'], ['experiment','关联实验编号','text','如：EXP-20261115-01']
];
const actionNames = {create:'新增容器', wells:'更新培养记录', clear:'清空孔位', status:'变更培养状态', member_status:'变更成员状态', rename:'修改容器信息', confirm:'核对当日培养',transfer:'传代 / 开展实验',merge_groups:'合并培养组显示',unmerge_groups:'取消显示合并'};

function toast(text, error = false) {
  $('#toast').textContent = text; $('#toast').className = 'toast' + (error ? ' error' : ''); $('#toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 4000);
}
async function requestJson(path, body) {
  const options = body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-Lab-Token':boot.token}, body:JSON.stringify(body)};
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '操作失败');
    error.status = response.status;
    error.conflict = result.conflict;
    throw error;
  }
  return result;
}

const uncertainCommands = new Map();
async function submitCommand(body) {
  const key = JSON.stringify(body);
  const requestId = body.client_request_id || uncertainCommands.get(key) || crypto.randomUUID();
  const submission = {...body, client_request_id:requestId};
  let transportRetried = false;
  // Keep the same request ID after a lost response, including a later manual retry.
  uncertainCommands.set(key, requestId);
  for (;;) {
    try {
      const result = await requestJson('/api/command', submission);
      uncertainCommands.delete(key);
      return result;
    } catch (error) {
      if (!error.status || error.status >= 500) {
        if (!transportRetried) {
          transportRetried = true;
          continue;
        }
        let status, fresh;
        try {
          status = await requestJson('/api/command-status?request_id='+encodeURIComponent(requestId));
          if (status.committed) fresh = await requestJson('/api/state');
        } catch { /* Keep the request ID while the local service is unreachable. */ }
        if (fresh) {
          uncertainCommands.delete(key);
          const {cell_names, treatments, medium_history, count_history} = fresh;
          return {...fresh, histories:{cell_names, treatments, medium_history, count_history}};
        }
        if (status?.undone) {
          uncertainCommands.delete(key);
          throw new Error('刚才的提交已被撤销。请刷新后核对当前记录。');
        }
        throw new Error('未能核实保存结果。连接恢复后可在当前页面重新提交相同内容，已保存的操作只会记录一次。');
      }
      const conflict = error.conflict;
      if (error.status === 409 && conflict?.level === 'unrelated' &&
          Number.isInteger(conflict.current_revision) && conflict.current_revision > submission.revision &&
          confirm('另一窗口更新了其他记录。本次涉及的记录没有变化。同步并保存当前填写的内容？')) {
        // Submit the exact version the server checked. A newer change must be diagnosed again.
        submission.revision = conflict.current_revision;
        continue;
      }
      uncertainCommands.delete(key);
      if (error.status === 409 && conflict?.level === 'scope_changed') {
        const changed = [...conflict.changed_containers, ...conflict.changed_records].join('、');
        error.message = '本次涉及的记录已在另一窗口更新' + (changed ? '（'+changed+'）' : '') + '。请刷新核对后再保存。';
      }
      throw error;
    }
  }
}

async function api(path, body) {
  const result = path === '/api/command' ? await submitCommand(body) : await requestJson(path, body);
  if(path==='/api/command'&&boot){
    if(result.state)boot.state=result.state;
    if(Object.prototype.hasOwnProperty.call(result,'undo'))boot.undo=result.undo;
    if(result.workday)boot.workday=result.workday;
    if(result.medium_recipes)boot.medium_recipes=result.medium_recipes;
    if(result.histories)Object.assign(boot,result.histories);
  }
  return result;
}
async function load() {
  applyBoot(await api('/api/state'));
}
function applyBoot(result) {
  boot = result; state = boot.state;
  $('#today-date').innerHTML = `${esc(boot.today.replaceAll('-',' / '))}<small>北京时间 · Asia/Shanghai</small>`;
  $('#connection').hidden = true;
}
function canLeave() { return !dirty || confirm('编辑内容还未保存。放弃这些修改并继续？'); }
function dayOf(well, day = boot.today) {
  if (!well.cell || !well.day0) return null;
  return Math.round((Date.parse(day + 'T00:00:00+08:00') - Date.parse(well.day0 + 'T00:00:00+08:00')) / 86400000);
}
function wellDayLabel(well){return (well.components?'实验 Day ':'Day ')+(frozen?well.day:dayOf(well));}
function componentSummary(well,recordDate=frozen?.date||boot.today){
  const parts=well.components||[well];
  return `<div class="component-records">${parts.map(p=>`<div><strong>${esc(p.cell)}</strong> · ${esc(p.kind)}<p class="muted">${esc(p.role||'')} ${p.amount?' · '+esc(p.amount):''}${p.aliquot_id?'<br>混合来源整份：'+esc(p.aliquot_role||'混合样本')+' · '+esc(p.aliquot_amount||'未填写加入量')+'（非单组分量）':''}<br>批次：${esc(p.batch||'—')} · Day ${dayOf(p,recordDate)}<br>${esc(p.anchor)}：${esc(p.day0)}${p.origin?'<br>来源：'+esc(p.origin.pool_id?'整体收集：'+(p.origin.sources||[]).map(s=>(s.name||s.id)+' / '+s.well).join('、'):(p.origin.name||p.origin.id||'来源')+' / '+(p.origin.well||'')):''}</p></div>`).join('')}</div>${well.experiment_started_at?`<p class="muted">实验开始：${esc(well.experiment_started_at.replace('T',' '))}</p>`:''}`;
}
function modalOpen(){return Boolean(document.querySelector('dialog[open]'));}
function activeContainers() { return displayContainers().filter(c => c.status === 'active'); }
function wellList(container) { return Object.values(container.wells).filter(w => (container.status==='archived'||frozen)?!!w.cell:memberActive(w)); }
function activeState() { return frozen ? frozen.state : state; }
function current() { return displayContainers(activeState()).find(c => c.id === currentId); }
function bindCultureChecks(root){root.querySelectorAll('[data-check-culture]').forEach(button=>button.onclick=()=>confirmCultureToday(button.dataset.checkCulture));}
async function confirmCultureToday(id,reason){
  if(busy||frozen)return;
  if(dirty){toast('请先保存当前修改，再确认今日核对。',true);return;}
  if(reason!==undefined&&!['no_operation','experiment'].includes(reason)){toast('请选择有效的今日核对原因。',true);return;}
  const container=displayContainers().find(c=>c.id===id);
  if(!container||container.status!=='active'||!Object.values(container.wells||{}).some(memberActive)){toast('只能核对已填写细胞的在培养容器。',true);return;}
  const payload={id};if(reason!==undefined)payload.reason=reason;
  busy=true;
  document.querySelectorAll('[data-check-culture],[data-home-action],[data-home-medium]').forEach(button=>button.disabled=true);
  try{const result=await api('/api/command',{action:'check',payload,revision:state.revision});state=result.state;busy=false;render();toast('该培养记录已核对，已排到待核对记录之后，仍可继续编辑。');}
  catch(error){toast(error.message,true);busy=false;render();}
  finally{busy=false;renderUndoControl();}
}
function shortTime(value) { return value.slice(0,16).replace('T',' '); }
function typeBadge(c) { return `<span class="pill">${esc(groupTypeLabel(c))}</span>`; }
function emptyGraphic() { return `<div class="empty-plate" aria-hidden="true">${'<i></i>'.repeat(24)}</div>`; }
function todayStats() {
  const active = activeContainers(), count = active.reduce((n,c) => n + wellList(c).length, 0);
  const cells = new Set(active.flatMap(c => wellList(c).flatMap(w => (w.components||[w]).map(p=>p.cell))));
  const checked = active.filter(c => c.checked_date === boot.today).length;
  return `<div class="stats"><div class="stat"><b>${active.length.toString().padStart(2,'0')}</b><span>培养容器</span><small>${count} 个已填写培养单元</small></div><div class="stat"><b>${cells.size.toString().padStart(2,'0')}</b><span>细胞种类</span><small>按细胞名称汇总</small></div><div class="stat"><b>${checked.toString().padStart(2,'0')}<span> / ${active.length}</span></b><span>今日已核对</span><small>每天 22:00 保存当日快照</small></div></div>`;
}
async function switchView(next) {
  if (!canLeave()) return;
  dirty = false; frozen = null; selected.clear(); experimentFilter='';view = next;
  if(['home','today','work'].includes(next)){statusFilter='active';homeStatus='active';}
  if(next==='labs'){labModuleFilter='all';labStatusFilter='unfinished';labSearch='';}
  try {
    await load();
    if(view==='today'){const c=displayContainers().find(c=>c.id===currentId);if(groupType(c?.type))selected=new Set(groupDefaultSelection(c));}
    if (view === 'history') snapshots = await api('/api/snapshots');
    if (view === 'events') events = await api('/api/events');
    render();
    if (next === 'backup' && view === next) loadStorageStats();
  } catch (error) { toast(error.message, true); }
}
function render() {
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderUndoControl();
  if(view==='home')renderHome();
  else if(view==='cryo')renderCryoWorkspace();
  else if(view==='work')renderWorkday();
  else if(view==='labs')renderExperiments();
  else if(view==='drugs')renderDrugs();
  else if (view === 'today') renderToday();
  else if (view === 'history') renderHistory();
  else if (view === 'events') renderEvents();
  else renderBackup();
}
function openHomeTarget(id,keys){
  if(busy||!canLeave())return;
  const original=state.containers.find(c=>c.id===id),location=displayMemberLocation(state,id,keys?.[0]??Object.keys(original?.wells||{})[0]);
  const c=displayContainers().find(c=>c.id===location.id);if(!c)return toast('记录已变化，请刷新后重试。',true);
  const mapped=original&&c.display_group?(keys??groupDefaultSelection(original)).map(key=>displayMemberLocation(state,id,key).key):keys;
  dirty=false;frozen=null;view='today';experimentFilter='';statusFilter=c.status;search='';currentId=c.id;
  selected=new Set((mapped??(groupType(c.type)?groupDefaultSelection(c):[])).filter(k=>Object.prototype.hasOwnProperty.call(c.wells,k)));render();
}
function openHomeExperiment(id){
  if(busy||!canLeave())return;
  const matches=displayContainers().filter(c=>Object.values(c.wells).some(w=>w.cell&&w.experiment===id));
  if(!matches.length)return toast('该实验当前没有关联培养记录。',true);
  const first=matches.find(c=>c.status==='active'&&Object.values(c.wells).some(w=>memberActive(w)&&w.experiment===id))||matches[0];
  dirty=false;frozen=null;view='today';experimentFilter=id;statusFilter='all';search='';currentId=first.id;
  selected=new Set(experimentSelection(first,id));render();
}
function experimentSelection(c,id){
  const keys=Object.keys(c?.wells||{}).filter(k=>c.wells[k].cell&&c.wells[k].experiment===id);
  const active=c?.status==='active'?keys.filter(k=>memberActive(c.wells[k])):[];return active.length?active:keys;
}
function renderToday() {
  $('#content').innerHTML = `<div class="today-top-compact">${todayStats()}<div class="section-head"><div><h2>今天的培养</h2><span class="muted">22:00 自动留档 · 实际操作发生后填写；未核对记录保留标记。<button class="text-button" id="go-history">历史日记 ↗</button></span></div><div class="actions"><button class="button secondary" id="merge-cultures">手动合并培养组</button><button class="button secondary" id="save-snapshot">保存快照</button><button class="button secondary" id="confirm-day" ${!activeContainers().length?'disabled':''}>✓ 全部核对并保存快照</button><button class="button primary" id="add-container">＋ 新增容器</button></div></div></div>${experimentFilter?`<div class="notice">关联实验：${esc(experimentFilter)} · 已定位相关容器和孔位<button class="text-button" id="clear-experiment-filter">显示全部培养</button></div>`:''}<div id="cultures"></div>`;
  if($('#clear-experiment-filter'))$('#clear-experiment-filter').onclick=()=>{if(!canLeave())return;dirty=false;experimentFilter='';selected.clear();renderToday();};
  $('#add-container').onclick = showCreate;
  $('#merge-cultures').onclick = () => openManualGroup();
  $('#go-history').onclick = () => switchView('history');
  $('#save-snapshot').onclick = () => saveSnapshot(false);
  $('#confirm-day').onclick = () => saveSnapshot(true);
  renderCultures();
}
function filterCulturesList(all) {
  return sortCulturesByCheck(all.filter(c => (!experimentFilter||Object.values(c.wells).some(w=>w.cell&&w.experiment===experimentFilter)) && (statusFilter === 'all' || c.status === statusFilter) && [c.name,c.id,...Object.values(c.display_members||{}).flatMap(m=>[m.container_name,m.container_id]),...wellList(c).map(w => w.cell)].join(' ').toLowerCase().includes(search.toLowerCase())));
}
function containerCardsMarkup(list) {
  return list.map(c => {
    const wells = wellList(c), days = [...new Set(wells.map(wellDayLabel))];
    return `<div class="container-card-wrap"><button class="container-card ${c.id===currentId?'selected':''}" data-container="${esc(c.id)}"><div class="card-top">${typeBadge(c)}<span class="pill ${c.checked_date===(frozen?.date||boot.today)?'green':'amber'}">${c.status==='archived'?'已结束':c.checked_date===(frozen?.date||boot.today)?'已核对':'待核对'}</span></div><h3>${esc(c.name)}</h3><p class="cell-names">${esc([...new Set(wells.map(w => w.cell))].join(' · ') || '尚未填写细胞')}</p><p>${days.length?days.join(' / '):'Day —'} · ${wells.length}/${Object.keys(c.wells).length} ${boot.layouts[c.type]?'孔':'个培养单元'}</p>${groupQuantity(c)>1?`<p class="group-status-summary">${groupCounts(c).active} 在培养 · ${groupCounts(c).ended} 已结束${groupCounts(c).empty?' · '+groupCounts(c).empty+' 待填写':''}</p>`:''}<p>${esc(c.location||'未填写位置')}</p></button>${frozen?'':cultureCheckMarkup(c)}</div>`;
  }).join('') || '<div class="no-match">没有符合条件的容器</div>';
}
function renderCultures() {
  const all = displayContainers(activeState());
  if (!all.length) {
    if (frozen) {
      $('#cultures').innerHTML = '<div class="panel"><h3>这份快照中没有培养容器</h3><p class="muted">历史记录为只读。要新增容器，请返回“当前培养”。</p></div>';
      return;
    }
    $('#cultures').innerHTML = `<div class="empty-state">${emptyGraphic()}<h2>从第一个培养容器开始</h2><p>添加培养瓶或孔板，记录细胞和起始日期。<br>孔位可以多选，特殊处理一次填写、同时保存。</p><button class="button primary" id="first-container">＋ 添加我的第一个容器</button><div class="footer-note">尚未录入任何实验数据 · 本地数据库保存</div></div>`;
    $('#first-container').onclick = showCreate; return;
  }
  const list = filterCulturesList(all);
  if (!list.some(c => c.id === currentId)) { currentId = list[0]?.id; selected=new Set(experimentFilter?experimentSelection(list[0],experimentFilter):(groupType(list[0]?.type)?groupDefaultSelection(list[0]):[])); }
  $('#cultures').innerHTML = `<div class="cultures-layout"><div class="container-list"><div class="list-top"><span id="container-list-count">容器 / ${list.length}</span><select aria-label="培养状态筛选" id="status-filter"><option value="active">在培养</option><option value="archived">已结束</option><option value="all">全部</option></select></div><input class="search" id="search" aria-label="搜索容器或细胞" placeholder="搜索容器、编号或细胞…" value="${esc(search)}"><div class="mobile-container-bar"><label>当前容器<select id="mobile-container-select" ${list.length ? '' : 'disabled'} aria-label="快速切换容器">${list.map(c=>`<option value="${esc(c.id)}" ${c.id===currentId?'selected':''}>${esc(c.name)} · ${esc(groupTypeLabel(c))}</option>`).join('')}</select></label></div><div id="container-cards">${containerCardsMarkup(list)}</div></div><div id="detail"></div></div>`;
  const bindContainerCards = () => {
    document.querySelectorAll('#container-cards [data-container]').forEach(b => b.onclick = () => { if (!canLeave())return;dirty=false;currentId=b.dataset.container;const c=current();selected=new Set(experimentFilter?experimentSelection(c,experimentFilter):(groupType(c.type)?groupDefaultSelection(c):[]));renderCultures(); });
    bindCultureChecks($('#container-cards'));
  };
  const syncMobileSelect = nextList => {
    const sel = $('#mobile-container-select');
    if (!sel) return;
    sel.innerHTML = nextList.map(c=>`<option value="${esc(c.id)}" ${c.id===currentId?'selected':''}>${esc(c.name)} · ${esc(groupTypeLabel(c))}</option>`).join('');
    sel.value = currentId || '';
    sel.disabled = !nextList.length;
  };
  const applySearch = nextValue => {
    if (!searchInput.isConnected || nextValue === search) return;
    const prevSearch = search;
    search = nextValue;
    const nextList = filterCulturesList(all);
    const switching = !nextList.some(c => c.id === currentId);
    if (switching && !canLeave()) {
      search = $('#search').value = prevSearch;
      return;
    }
    if (switching) {
      dirty = false;
      currentId = nextList[0]?.id;
      selected = new Set(experimentFilter?experimentSelection(nextList[0],experimentFilter):(groupType(nextList[0]?.type)?groupDefaultSelection(nextList[0]):[]));
    }
    const count = $('#container-list-count');
    if (count) count.textContent = '容器 / ' + nextList.length;
    const cards = $('#container-cards');
    if (cards) { cards.innerHTML = containerCardsMarkup(nextList); bindContainerCards(); }
    syncMobileSelect(nextList);
    if (switching) renderDetail();
  };
  $('#status-filter').value = statusFilter;
  $('#status-filter').onchange = e => { if (!canLeave()) {e.target.value=statusFilter;return;} dirty=false;statusFilter=e.target.value;renderCultures(); };
  if ($('#mobile-container-select')) $('#mobile-container-select').onchange = e => {
    if (!canLeave()) { e.target.value = currentId || ''; return; }
    dirty = false; currentId = e.target.value;
    const c = current(); selected = new Set(experimentFilter?experimentSelection(c,experimentFilter):(groupType(c.type)?groupDefaultSelection(c):[]));
    renderCultures();
  };
  let searchTimer = null, composingSearch = false;
  const searchInput = $('#search');
  searchInput.addEventListener?.('compositionstart', () => { clearTimeout(searchTimer); composingSearch = true; });
  searchInput.addEventListener?.('compositionend', e => { composingSearch = false; applySearch(e.target.value); });
  searchInput.oninput = e => {
    if (composingSearch || e.isComposing) return;
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => applySearch(val), 150);
  };
  searchInput.onchange = e => { clearTimeout(searchTimer); if (!composingSearch) applySearch(e.target.value); };
  bindContainerCards();
  renderDetail();
}
function plateMarkup(c, readonly) {
  const dims = boot.layouts[c.type];
  if (!dims) {
    if(groupType(c.type)&&groupQuantity(c)>1){
      const counts=groupCounts(c);
      return `<section class="culture-group" aria-label="瓶皿成员选择"><div class="culture-group-summary"><strong>${esc(groupTypeLabel(c))}</strong><p>${counts.active} 在培养 · ${counts.ended} 已结束${counts.empty?' · '+counts.empty+' 待填写':''}</p>${groupDifferenceSummary(c)?`<p class="muted">${esc(groupDifferenceSummary(c))}</p>`:''}</div><div class="group-member-chips">${Object.entries(c.wells).map(([key,w])=>`<button type="button" class="group-member ${selected.has(key)?'selected':''} ${w.member_status==='archived'||c.status==='archived'?'ended':''}" data-well="${esc(key)}" aria-pressed="${selected.has(key)}"><strong>${esc(groupMemberLabel(c,key))}</strong><span>${esc(w.cell||'待填写')}</span><small>${w.member_status==='archived'||c.status==='archived'?'已结束':w.cell?esc(wellDayLabel(w)):'空成员'}</small>${c.display_group?`<small class="display-member-context">${esc(c.display_members[key].location||'未填写位置')}<br>批次 ${esc(w.batch||'未填写')} · Day 0 ${esc(w.day0||'未填写')}<br>${esc(mediumSummary(w.medium)||'培养基未填写')}${w.cell_count?'<br>'+esc(countSummary(w.cell_count)):''}</small>`:''}${w.treatment?`<small>${esc(w.treatment)}</small>`:''}</button>`).join('')}</div></section>`;
    }
    const key = Object.keys(c.wells)[0], w = c.wells[key];
    return `<button class="flask ${selected.has(key)?'selected':''}" data-well="${esc(key)}" aria-pressed="${selected.has(key)}"><span class="flask-type">${esc(c.type)}</span><h3>${esc(w.cell || '点击填写细胞')}</h3><p class="muted">${w.cell?`${wellDayLabel(w)} · ${esc(w.anchor)} ${esc(w.day0)}`:'设置细胞名称、培养起始日期和处理记录'}</p><p>${esc(w.treatment||'暂无处理记录')}</p></button>`;
  }
  const [rows,cols] = dims;
  let markup = `<div class="plate-scroll"><div class="plate-grid ${cols>=8?'dense':''}" style="grid-template-columns:20px repeat(${cols},minmax(0,1fr))"><span></span>`;
  for(let col=1;col<=cols;col++) markup += `<button class="axis" data-col="${col}" aria-label="选择第 ${col} 列">${col}</button>`;
  for(let row=0;row<rows;row++) {
    const letter = String.fromCharCode(65+row);
    markup += `<button class="axis" data-row="${letter}" aria-label="选择 ${letter} 行">${letter}</button>`;
    for(let col=1;col<=cols;col++) {
      const key = letter+col, w = c.wells[key], day = frozen?w.day:dayOf(w);
      const hash = [...(w.cell+w.treatment)].reduce((n,ch)=>(n+ch.charCodeAt(0))%4,0);
      const palette = [['#e6eee0','#c9d9bd'],['#e1ebed','#bed3d8'],['#f3ead8','#e1cfa9'],['#ece5ed','#d6c4d8']][hash];
      const group = wellGroupFor(c,key);
      const hoverText = [key, w.cell || '空孔', group && '培养组：'+group.name, w.cell && day != null && 'Day '+day].filter(Boolean).join(' · ');
      const title = [hoverText, w.treatment].filter(Boolean).join('\n');
      markup += `<button class="well ${w.cell?'filled':''} ${selected.has(key)?'selected':''}" style="--well-bg:${palette[0]};--well-border:${palette[1]}" data-well="${key}" ${group?`data-well-group-color="${wellGroupColorIndex(group)}"`:''} data-well-hover="${esc(hoverText)}" aria-label="${esc(hoverText)}" aria-pressed="${selected.has(key)}" title="${esc(title)}"><strong>${key}</strong><small>${esc(w.cell||'空')}</small></button>`;
    }
  }
  return markup+'</div></div>';
}
function renderDetail() {
  const c = current();
  if (!c) { $('#detail').innerHTML = ''; return; }
  selected=new Set([...selected].filter(key=>Object.prototype.hasOwnProperty.call(c.wells,key)));
  const readonly = !!frozen || c.status === 'archived';
  if(!readonly&&typeof wellGroupSelection==='function')selected=wellGroupSelection(c,selected);
  const grouped=groupType(c.type)&&groupQuantity(c)>1;
  if(plateInteraction.id!==c.id||readonly)plateInteraction={id:c.id,mode:'select'};
  $('#detail').innerHTML = `<article class="detail"><div class="detail-head"><div><span class="eyebrow">${esc(c.id)}</span><h2>${esc(c.name)}</h2><p>${esc(c.location||'未填写位置')} · ${esc(groupTypeLabel(c))}${boot.layouts[c.type]?' · '+boot.layouts[c.type].join(' 行 × ')+' 列':''}</p>${!frozen?'<div class="detail-utility-links"><button class="text-button" id="container-journal">操作日志</button></div>':''}</div><div class="detail-actions">${!frozen?`${cultureCheckMarkup(c)}<button class="button primary" id="transfer-container" ${c.status!=='active'||!wellList(c).length?'disabled':''}>传代 / 开展实验</button><button class="button secondary" id="container-activity" ${c.status!=='active'?'disabled':''}>＋ 追加操作</button><details class="detail-more-menu"><summary class="button secondary">更多 ▾</summary><div class="detail-more-list"><button class="text-button" id="container-lineage">流转记录</button><button class="text-button" id="rename-container">${c.display_group?'编辑分组':'编辑信息'}</button>${c.display_group?'<button class="text-button" id="unmerge-container">取消显示合并</button>':''}<button class="text-button" id="archive-container">${c.status==='active'?'结束培养':'恢复培养'}</button></div></details>`:'<span class="pill amber">历史只读</span>'}</div></div>${!readonly?`<div class="culture-quick-actions"><span class="muted">常用操作</span>${typeof quickMediumButtons==='function'?quickMediumButtons(c):''}<button type="button" class="button secondary" id="quick-replate" ${!wellList(c).length?'disabled':''}>传代 / 移孔 / 扩孔</button></div>`:''}<div class="detail-body"><div class="plate-area"><div class="plate-top"><span>${grouped?'选择瓶 / 皿成员':readonly?'查看孔位记录':plateInteraction.mode==='select'?'点击或拖动 · 框选多个孔':'拖动所选孔组 · '+(plateInteraction.mode==='copy'?'复制':'移动')}</span><span>${wellList(c).length} / ${Object.keys(c.wells).length} 已填写</span></div>${wellGroupToolsMarkup(c,readonly)}${boot.layouts[c.type]?'<div class="plate-hover-readout" id="plate-hover-readout" aria-live="polite">悬停或聚焦孔位查看详情</div>':''}${plateMarkup(c,readonly)}<div class="selection-tools"><button id="select-all">${grouped?readonly?'选择全部历史成员':'选择全部在培养 / 待填写成员':'全选'}</button><button id="select-filled">选择已填写</button><button id="deselect">取消选择</button>${grouped&&!frozen?`<button type="button" id="end-group-members" ${![...selected].some(k=>memberActive(c.wells[k]))||readonly?'disabled':''}>结束所选瓶 / 皿</button><button type="button" id="restore-group-members" ${![...selected].some(k=>c.wells[k].cell&&(c.status==='archived'||c.wells[k].member_status==='archived'))?'disabled':''}>恢复所选瓶 / 皿</button>`:''}${!readonly&&boot.layouts[c.type]?`<span class="plate-mode-switch" role="group" aria-label="孔板鼠标操作模式">${[['select','框选'],['copy','孔位复制'],['move','孔位移动']].map(([mode,label])=>`<button type="button" data-plate-mode="${mode}" class="${plateInteraction.mode===mode?'active':''}" aria-pressed="${plateInteraction.mode===mode}">${label}</button>`).join('')}</span><button id="relocate-wells">跨孔板复制 / 移动 ↗</button>`:''}</div>${wellGroupDirectoryMarkup(c,readonly)}<div class="legend"><span><i></i>已填写</span><span><i class="empty"></i>空孔</span><span><i class="selected"></i>选中</span></div><p class="plate-help" id="inline-placement-hint" aria-live="polite">${grouped?'默认选中全组在培养成员，可取消选择后单独选择几瓶。已结束成员保留只读记录，可恢复后继续填写。':readonly?'点击一个或多个孔，查看当时的细胞与处理记录。':'按住鼠标从一个孔拖到另一个孔，可框选整片区域。点击行号或列号可批量选择；勾选的字段才会写入。'}</p></div><aside class="inspector" id="inspector"></aside></div></article>`;
  if (!frozen) {
    $('#archive-container').onclick = async () => { if(!canLeave())return;if(!confirm(c.status==='active'?'结束此容器的培养？记录和历史仍会保留。':'恢复此容器？原 Day 0 保留；若已重新复苏或传代，请随后更新起始日期。'))return;await command('status',{id:c.id,status:c.status==='active'?'archived':'active'}); };
    $('#rename-container').onclick = openContainerEditor;
    if(c.display_group)$('#unmerge-container').onclick=()=>unmergeManualGroup(c.id);
    $('#transfer-container').onclick = openTransfer;
    if($('#quick-replate'))$('#quick-replate').onclick=()=>openTransfer();
    if(typeof bindQuickMediumButtons==='function')bindQuickMediumButtons($('#detail'));
    $('#container-lineage').onclick = () => openContainerTransfers(c.id);
    $('#container-activity').onclick=()=>openActivity(c.id);
    if(grouped){
      $('#end-group-members').onclick=async()=>{if(!canLeave())return;const keys=[...selected].filter(k=>memberActive(c.wells[k]));if(keys.length&&confirm('结束所选 '+keys.map(k=>groupMemberLabel(c,k)).join('、')+' 的培养？记录与历史保留。'))await command('member_status',{id:c.id,wells:keys,status:'archived'});};
      $('#restore-group-members').onclick=async()=>{if(!canLeave())return;const keys=[...selected].filter(k=>c.wells[k].cell&&(c.status==='archived'||c.wells[k].member_status==='archived'));if(keys.length&&confirm('恢复所选 '+keys.map(k=>groupMemberLabel(c,k)).join('、')+'？原 Day 0 与记录保留。'))await command('member_status',{id:c.id,wells:keys,status:'active'});};
    }
    $('#container-journal').onclick=()=>openJournal(c.id);
  }
  function selectKeys(keys, toggle = false) {
    if (busy||!canLeave()) return; dirty=false;
    if(!readonly&&typeof wellGroupSelection==='function')keys=[...wellGroupSelection(c,keys)];
    const remove = toggle && keys.every(k => selected.has(k));
    keys.forEach(k => remove?selected.delete(k):selected.add(k)); renderDetail();
  }
  if(boot.layouts[c.type]){
    const root=$('#detail .plate-grid');
    let selectionBase=null;
    const changeSelection=(next,preview)=>{
      if(!readonly&&typeof wellGroupSelectionChange==='function')next=wellGroupSelectionChange(c,selectionBase||selected,next);
      selected=next;root.querySelectorAll('[data-well]').forEach(b=>{b.classList.toggle('selected',selected.has(b.dataset.well));b.setAttribute('aria-pressed',selected.has(b.dataset.well));});
      if(typeof refreshWellGroupControls==='function')refreshWellGroupControls(c);
      if(!preview){selectionBase=null;renderInspector(c,readonly);}
    };
    const canStart=()=>{if(busy||!canLeave())return false;dirty=false;selectionBase=new Set(selected);return true;};
    if(!readonly&&plateInteraction.mode!=='select')bindInlineRelocation(root,{container:c,mode:plateInteraction.mode,getSelected:()=>selected,canStart,onSelectionChange:next=>changeSelection(next,false)});
    else bindWellSelection(root,{touchRange:true,getSelected:()=>selected,canStart,onChange:changeSelection});
    const readout=$('#plate-hover-readout');
    if(readout){
      const defaultReadout=()=>selected.size?`当前已选 ${selected.size} 孔（悬停或聚焦孔位查看详情）`:'悬停或聚焦孔位查看详情';
      readout.textContent=defaultReadout();
      const showWell=e=>{const btn=e.target?.closest?.('[data-well-hover]');if(btn)readout.textContent=btn.dataset.wellHover;};
      root.addEventListener?.('mouseover',showWell);
      root.addEventListener?.('focusin',showWell);
      root.addEventListener?.('mouseleave',()=>{readout.textContent=root.querySelector('[data-well-hover]:focus')?.dataset.wellHover || defaultReadout();});
      root.addEventListener?.('focusout',e=>{if(!root.contains(e.relatedTarget))readout.textContent=defaultReadout();});
    }
  }else document.querySelectorAll('#detail [data-well]').forEach(b => b.onclick = () => selectKeys([b.dataset.well],true));
  document.querySelectorAll('[data-row]').forEach(b => b.onclick = () => selectKeys(Object.keys(c.wells).filter(k=>k.startsWith(b.dataset.row)),true));
  document.querySelectorAll('[data-col]').forEach(b => b.onclick = () => selectKeys(Object.keys(c.wells).filter(k=>k.slice(1)===b.dataset.col),true));
  $('#select-all').onclick = () => {if(!grouped)return selectKeys(Object.keys(c.wells));if(busy||!canLeave())return;dirty=false;selected=new Set(groupDefaultSelection(c));renderDetail();};
  $('#select-filled').onclick = () => selectKeys(Object.keys(c.wells).filter(k=>readonly?c.wells[k].cell:memberActive(c.wells[k])));
  $('#deselect').onclick = () => {if(busy||!canLeave())return;dirty=false;selected.clear();renderDetail();};
  if($('#relocate-wells'))$('#relocate-wells').onclick=openRelocation;
  document.querySelectorAll('[data-plate-mode]').forEach(b=>b.onclick=()=>{if(busy||!canLeave())return;dirty=false;plateInteraction={id:c.id,mode:b.dataset.plateMode};renderDetail();});
  if(typeof bindWellGroupControls==='function')bindWellGroupControls(c,readonly,selectKeys);
  bindCultureChecks($('#detail'));
  renderInspector(c, readonly);
}
function renderInspector(c, readonly) {
  if (!selected.size) { $('#inspector').innerHTML = '<span class="eyebrow">WELL DETAILS</span><h3 style="margin-top:12px">选择一个培养单元</h3><p class="muted">点击左侧孔位，查看或编辑细胞、培养天数和特殊处理。</p>';return; }
  const keys = [...selected], wells = keys.map(k=>c.wells[k]);
  readonly=readonly||wells.some(w=>w.member_status==='archived');
  const hasComponents=wells.some(w=>w.components);
  const lineage=[...new Map(wells.flatMap(w=>[[w.maintenance_id,w.pool_id?'合并收集 / 扩孔凭据':'移孔换液凭据'],[w.lineage_correction_id,'来源更正凭据'],[w.lineage_id,'原始来源凭据'],[w.placement_id,'孔位修正凭据']]).filter(([id])=>id)).entries()].map(([id,label])=>`<button type="button" class="text-button" data-lineage="${esc(id)}">${label} ↗</button>`).join('');
  const composition=wells.map((w,i)=>w.components?'<h3>'+esc(keys[i])+' · 细胞组成</h3>'+componentSummary(w):'').join('');
  const title = `<span class="eyebrow">${readonly?'CULTURE RECORD':'BATCH EDIT'}</span><h3 style="margin-top:10px">${readonly?'查看记录':'编辑所选'} <span class="muted">/ ${keys.length}</span></h3><div class="selection-summary">${keys.map(k=>esc(groupMemberLabel(c,k))).join(' · ')}</div>${lineage}${typeof lineageLinksMarkup==='function'?lineageLinksMarkup(c,keys,activeState()):''}${typeof openLineageCorrection==='function'&&!readonly&&wells.every(w=>w.cell)?'<button type="button" class="text-button" id="correct-lineage">补充 / 更正来源关联</button>':''}${wells.map((w,i)=>w.seeding?'<div class="seeding-member"><small>'+esc(groupMemberLabel(c,keys[i]))+'</small>'+seedingDetailsMarkup(w.seeding)+'</div>':'').join('')}${linkedLabRecordsMarkup(c.id,keys)}${composition}${c.status==='active'?activeTreatmentMarkup(wells.map((w,i)=>({...w,key:groupMemberLabel(c,keys[i])})).filter(memberActive)):''}`;
  if (readonly) {
    $('#inspector').innerHTML = title + (wells.some(w=>w.member_status==='archived')?'<p class="group-readonly-note">所选包含已结束成员，当前仅查看记录。选择在培养成员可编辑；也可恢复所选已结束成员。</p>':'') + wells.map((w,i)=>`<div class="field"><strong>${esc(groupMemberLabel(c,keys[i]))} · ${esc(w.cell||'空孔')}</strong>${w.cell?`<p class="muted">${wellDayLabel(w)} · ${esc(w.kind)}<br>${esc(w.anchor)}：${esc(w.day0)}<br>批次：${esc(w.batch||'—')}<br>处理：${esc(w.treatment||'未填写')}<br>浓度：${esc(w.concentration||'—')}<br>时间：${esc(w.treated_at||'—')}<br>备注：${esc(w.notes||'—')}<br>实验：${esc(w.experiment||'—')}</p>${mediumDetailsMarkup(w.medium)}${countDetailsMarkup(w.cell_count)}`:''}</div>`).join('');bindLineageButtons($('#inspector'));bindLabRecordLinks($('#inspector'));return;
  }
  const allEmpty = !c.display_group&&wells.every(w=>!w.cell);
  const sharedDefaults=!c.display_group&&(boot.layouts[c.type]||groupType(c.type))&&!hasComponents?(c.well_defaults||{}):{};
  const treatmentDefault = !c.display_group&&(boot.layouts[c.type]||groupType(c.type)) ? c.default_treated_at || '' : '';
  $('#inspector').innerHTML = title + `<p class="muted">只应用勾选字段。未勾选的原有内容保持不变。<button type="button" class="text-button" id="reset-day">重新计时</button>${Object.keys(sharedDefaults).length?'<button type="button" class="text-button" id="reuse-plate-defaults">沿用首组信息</button>':''}</p>${allEmpty&&Object.keys(sharedDefaults).length?'<p class="muted">已带入本容器首组的细胞类型、批次及 Day 0，可按需要修改。</p>':''}<form id="well-form" novalidate><div class="fields">${fieldSpecs.map(([key,label,type,hint])=>{
    if(hasComponents&&['cell','kind','batch','day0','anchor'].includes(key))return '';
    const values = [...new Set(wells.map(w=>w[key]))], mixed = values.length>1;
    let value = mixed?'':values[0];
    const syncTime = key==='treated_at' && !!treatmentDefault;
    const syncMeta=allEmpty&&Object.prototype.hasOwnProperty.call(sharedDefaults,key);
    const enabled = (allEmpty && ['cell','kind','day0','anchor'].includes(key)) || syncTime || syncMeta;
    if(syncTime)value=treatmentDefault;
    if(allEmpty && key==='kind')value='细胞系';if(allEmpty && key==='anchor')value='传代';if(allEmpty && key==='day0')value=boot.today;
    if(allEmpty && key==='cell' && groupType(c.type))value=Object.values(c.wells).find(w=>w.cell)?.cell||c.name;
    if(syncMeta)value=sharedDefaults[key];
    let input;
    if(type==='select')input=`<select id="field-${key}" data-field="${key}" aria-label="${label}"><option value="">${mixed?'多个不同值':'请选择'}</option>${hint.map(v=>`<option ${value===v?'selected':''}>${v}</option>`).join('')}</select>`;
    else if(type==='textarea')input=`<textarea id="field-${key}" data-field="${key}" maxlength="5000" aria-label="${label}" placeholder="${mixed?'多个不同值':hint}">${esc(value)}</textarea>`;
    else input=`<input id="field-${key}" data-field="${key}" aria-label="${label}" type="${type}" maxlength="5000" ${type==='date'?`max="${boot.today}"`:''} value="${esc(value)}" placeholder="${mixed?'多个不同值':hint}">`;
    if(key==='concentration')input=unitChoice(input,unitPresets.concentration,label,true);
    if(key==='cell')input=`<div class="cell-autocomplete">${input.replace('aria-label=', 'autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cell-name-suggestions" aria-label=')}<div id="cell-name-suggestions" class="cell-name-suggestions" role="listbox" aria-label="历史细胞名称" hidden></div></div>`;
    if(key==='treatment')input=`<div class="cell-autocomplete">${input.replace('aria-label=', 'autocomplete="off" aria-autocomplete="list" aria-expanded="false" aria-controls="treatment-suggestions" aria-label=')}<div id="treatment-suggestions" class="cell-name-suggestions" role="listbox" aria-label="历史特殊处理" hidden></div></div>`;
    return `<div class="field ${enabled?'enabled':''}" data-field-wrap="${key}"><div class="field-title"><label><input type="checkbox" data-apply="${key}" ${enabled?'checked':''}>${label}</label></div>${input}${syncTime?'<small class="muted">已带入本容器最近保存的处理时间，可修改或取消勾选。</small>':''}</div>`;
  }).join('')}</div>${mediumEditorMarkup(wells,(boot.layouts[c.type]||groupType(c.type))?c.medium_defaults:null)}${groupType(c.type)?'<p class="group-count-note muted">以下计数与培养基体积均按每瓶 / 皿填写。多选保存会将同一测量值分别写入所选成员；各成员独立保留记录，数值不会作为全组总量。</p>':''}${countEditorMarkup(wells)}<button type="submit" class="button primary">保存到 ${keys.length} 个培养单元</button><button type="button" class="button danger" id="clear-wells">清空所选内容</button></form>`;
  bindLineageButtons($('#inspector'));bindLabRecordLinks($('#inspector'));
  $('#reset-day').hidden=hasComponents;
  bindMediumEditor(wells,(boot.layouts[c.type]||groupType(c.type))?c.medium_defaults:null);
  bindCountEditor(wells);
  if($('#correct-lineage')&&typeof openLineageCorrection==='function')$('#correct-lineage').onclick=openLineageCorrection;
  document.querySelectorAll('[data-apply]').forEach(box => box.onchange=()=>{dirty=true;box.closest('.field').classList.toggle('enabled',box.checked);});
  function enable(key) {const box=$(`[data-apply="${key}"]`);box.checked=true;box.closest('.field').classList.add('enabled');}
  document.querySelectorAll('[data-field]').forEach(input=>input.oninput=()=>{dirty=true;enable(input.dataset.field);if(input.dataset.field==='kind'&&input.value){$('#field-anchor').value=input.value==='原代细胞'?'激活扩增':'传代';enable('anchor');}});
  if(!hasComponents)attachCellNameAutocomplete($('#field-cell'),$('#cell-name-suggestions'),()=>cellNameHistory(state,boot.cell_names||[]));
  attachHistoryAutocomplete($('#field-treatment'),$('#treatment-suggestions'),()=>treatmentHistory(state,boot.treatments||[]),{label:'处理',filter:filterTreatments});
  if($('#reuse-plate-defaults'))$('#reuse-plate-defaults').onclick=()=>{for(const [key,value] of Object.entries(sharedDefaults)){$('#field-'+key).value=value;enable(key);}dirty=true;toast('已带入本容器首组的类型、批次和 Day 0 信息，可修改后保存。');};
  $('#reset-day').onclick=()=>{dirty=true;$('#field-day0').value=boot.today;enable('day0');enable('anchor');$('#field-anchor').value=$('#field-kind').value==='原代细胞'?'激活扩增':'传代';$('#field-day0').focus();if(wells.some(w=>w.cell_count))markCountForClear();toast('已将 Day 0 设为今天；如有旧计数，将在保存时移出当前记录，历史保留。请核对后保存。');};
  $('#well-form').onsubmit = async e=>{
    e.preventDefault();const patch={};document.querySelectorAll('[data-apply]:checked').forEach(box=>{patch[box.dataset.apply]=$(`[data-field="${box.dataset.apply}"]`).value;});
    const mediumPatch=collectMediumPatch();if(Object.keys(mediumPatch).length)patch.medium=mediumPatch;
    const countPatch=collectCountPatch();if(countPatch!==null)patch.cell_count=countPatch;
    if(!Object.keys(patch).length)return toast('请勾选需要修改的字段',true);
    await command('wells',{id:c.id,wells:keys,patch});
  };
  $('#clear-wells').onclick=async()=>{if(confirm(`清空 ${keys.join('、')} 的当前内容？操作历史和已保存快照仍会保留。`))await command('clear',{id:c.id,wells:keys});};
}
async function command(action,payload={}) {
  if(busy)return;busy=true;
  try {
    const result=await api('/api/command',{action,payload,revision:state.revision});
    state=result.state;
    if(action==='member_status')selected=new Set(groupDefaultSelection(displayContainers().find(c=>c.id===payload.id)));
    if(action==='wells'&&payload.patch?.cell?.trim())boot.cell_names=cellNameHistory(state,[payload.patch.cell,...(boot.cell_names||[])]);
    if(action==='wells'&&payload.patch?.treatment?.trim())boot.treatments=treatmentHistory(state,[payload.patch.treatment,...(boot.treatments||[])]);
    if(action==='wells'&&payload.patch?.cell_count&&!payload.patch.cell_count.clear){const count=payload.patch.cell_count;boot.count_history||={};for(const [key,value] of [[count.mode+'_units',count.unit],['volume_units',count.volume_unit]])if(value)boot.count_history[key]=[...new Set([value,...(boot.count_history[key]||[])])];}
    if(currentId===payload.id && ((['wells','clear'].includes(action) && boot.layouts[current()?.type]) || action==='rename'))selected.clear();
    dirty=false;render();toast('已保存到本地数据库');return true;
  }
  catch(error){toast(error.message,true);return false;}
  finally{busy=false;if(typeof renderUndoControl==='function')renderUndoControl();}
}
function showCreate() {
  if(frozen)return toast('历史快照为只读，请返回当前培养后添加容器。',true);
  if(!canLeave())return;dirty=false;
  $('#create-form').reset();bindCreateRecipe();$('#container-type').innerHTML=boot.types.map(t=>`<option>${t}</option>`).join('');$('#container-type').value='24孔板';syncCreateQuantity();$('#container-type').onchange=syncCreateQuantity;$('#create-dialog').showModal();
}
function syncCreateQuantity(){
  const enabled=groupType($('#container-type').value),input=$('#container-quantity');input.disabled=!enabled;if(!enabled)input.value='1';
  input.closest('.group-quantity-field').hidden=!enabled;
  $('#create-quantity-help').textContent=enabled?'1–100 瓶 / 皿；同组显示，每个成员独立留档。':'孔板按一块记录。';
}
function openContainerEditor(){
  if(busy||!canLeave())return;const c=current();if(!c||frozen)return;
  if(c.display_group)return openManualGroup(c.id);
  const revision=state.revision;dirty=false;
  $('#edit-container-dialog').innerHTML=`<form id="edit-container-form"><div class="dialog-head"><h2>编辑容器信息</h2><button type="button" class="icon-button" id="close-editor" aria-label="关闭编辑容器">×</button></div><label>容器名称<input id="edit-name" value="${esc(c.name)}" required maxlength="120"></label><label>容器 / 孔板种类<select id="edit-type">${boot.types.map(t=>`<option ${t===c.type?'selected':''}>${t}</option>`).join('')}</select></label><label class="group-quantity-field">瓶 / 皿数量<input id="edit-quantity" type="number" min="1" max="100" step="1" required value="${groupQuantity(c)}" ${groupType(c.type)?'':'disabled'}></label><label>存放位置<input id="edit-location" value="${esc(c.location)}"></label><p class="muted" id="resize-summary">同名孔位保留原记录；新增孔位为空。若缩小后不能容纳已填写孔位，将阻止保存。</p><div class="dialog-actions"><button type="button" class="button secondary" id="cancel-editor">取消</button><button type="submit" class="button primary">保存信息</button></div></form>`;
  $('#close-editor').onclick=$('#cancel-editor').onclick=()=>{if(!busy)$('#edit-container-dialog').close();};
  $('#edit-container-dialog').oncancel=e=>{if(busy)e.preventDefault();};
  function previewResize(){
    const type=$('#edit-type').value,input=$('#edit-quantity'),grouped=groupType(type);input.disabled=!grouped;if(!grouped)input.value='1';
    input.closest('.group-quantity-field').hidden=!grouped;
    const quantity=grouped?Number(input.value):1,next=grouped?groupKeys(type,quantity):vesselKeys(type),old=Object.entries(c.wells);
    const lost=groupType(c.type)&&grouped?old.slice(next.length).filter(([,w])=>w.cell):old.filter(([key,w])=>w.cell&&!next.includes(key));
    $('#resize-summary').textContent=lost.length?'无法移除已有记录的成员：'+lost.map(([key])=>groupMemberLabel(c,key)).join('、')+'。结束成员会保留历史，不能直接删减已有记录。':'将保留原有成员记录；新增成员为空。保存后共 '+next.length+' 个培养单元。';
  }
  $('#edit-type').onchange=previewResize;$('#edit-quantity').oninput=previewResize;previewResize();
  $('#edit-container-form').onsubmit=async e=>{
    e.preventDefault();if(busy)return;busy=true;
    const payload={id:c.id,name:$('#edit-name').value,type:$('#edit-type').value,quantity:groupType($('#edit-type').value)?Number($('#edit-quantity').value):1,location:$('#edit-location').value};
    try{const result=await api('/api/command',{action:'rename',payload,revision});state=result.state;selected=new Set(groupType(current()?.type)?groupDefaultSelection(current()):[]);$('#edit-container-dialog').close();render();toast('容器信息已更新，已有孔位记录保留。');}catch(error){toast(error.message,true);}finally{busy=false;if(typeof renderUndoControl==='function')renderUndoControl();}
  };
  $('#edit-container-dialog').showModal();
}
async function saveSnapshot(verify) {
  if(dirty)return toast('请先保存孔位编辑，再生成快照。',true);
  if(busy)return;
  if(verify && !confirm('确认已核对今天所有在培养容器的细胞状态和处理记录？将标记已核对，并保存新的当日快照。'))return;
  if(verify && !await command('confirm'))return;
  busy=true;
  try{const snap=await api('/api/snapshot',{revision:state.revision});await load();render();toast(`${snap.date} ${snap.verified?'已核对':'未核对'}快照及数据库备份已保存`);}
  catch(error){toast(error.message,true);}finally{busy=false;if(typeof renderUndoControl==='function')renderUndoControl();}
}
function openArchivedCulture(id,keys){
  if(busy||!canLeave())return;
  const entry=archivedCultureEntries().find(e=>e.container.id===id);
  if(!entry)return toast('该培养已恢复或记录已变化，请刷新历史页。',true);
  const c=entry.container,selectedKeys=entry.keys.filter(k=>!keys||keys.includes(k)),dialog=$('#archive-culture-dialog');
  const filled=selectedKeys.filter(k=>c.wells[k]?.cell);
  dialog.innerHTML=`<div class="dialog-head"><div><span class="eyebrow">CULTURE ARCHIVE</span><h2>${esc(c.name)}</h2><p>${esc(c.type)} · 原编号 ${esc(c.id)}</p></div><button type="button" class="icon-button" id="close-archive-culture" aria-label="关闭历史培养">×</button></div><p class="muted">已结束培养 · 只读。以下为保留的原孔记录，历次变更可查看日志与流转凭据。</p>${filled.map(key=>{const w=c.wells[key];return `<details class="panel" open><summary><strong>${esc(groupMemberLabel(c,key))} · ${esc(w.cell)}</strong></summary>${occupiedWellDetails(w)}<p>处理时间：${esc(w.treated_at||'未记录')}<br>备注：${esc(w.notes||'未记录')}<br>实验：${esc(w.experiment||'未记录')}</p>${w.components?.map(p=>`<section><h4>组分：${esc(p.cell)}</h4>${occupiedWellDetails(p)}</section>`).join('')||''}</details>`;}).join('')||'<p class="notice">当前孔位没有细胞内容；如已清空，请查看操作日志或流转凭据。</p>'}<div class="dialog-actions"><button type="button" class="button secondary" id="archive-culture-journal">操作日志</button><button type="button" class="button secondary" id="archive-culture-transfers">流转记录</button><button type="button" class="button primary" id="archive-culture-done">关闭</button></div>`;
  $('#close-archive-culture').onclick=$('#archive-culture-done').onclick=()=>dialog.close();
  $('#archive-culture-journal').onclick=()=>{dialog.close();openJournal(id,{preserveOriginal:true});};
  $('#archive-culture-transfers').onclick=()=>{dialog.close();openContainerTransfers(id);};
  dialog.showModal();
}
function renderHistory() {
  if(frozen){
    $('#content').innerHTML=`<div class="section-head"><div><h2>${esc(frozen.date)} · 培养日记</h2><span class="muted">${shortTime(frozen.at)} 保存 · ${frozen.source==='auto'?'22:00 自动任务':'手动保存'}</span></div><div class="actions"><button id="back-history" class="button secondary">← 全部日记</button><a class="button secondary" href="/api/diary.html?snapshot=${frozen.id}">导出日记</a><a class="button secondary" href="/api/export.csv?snapshot=${frozen.id}">导出 CSV</a></div></div><div class="history-banner">历史快照 · ${frozen.verified?'当日已核对':'未核对，仅反映保存时已录入的状态'}。培养天数和处理记录已冻结，不能在此修改；后续撤销请查看操作记录。</div><div id="cultures"></div>`;
    $('#back-history').onclick=()=>{frozen=null;selected.clear();renderHistory();};renderCultures();const records=frozen.state.lab_records||[];if(records.length){$('#content').insertAdjacentHTML('beforeend',`<section class="panel"><h3>本快照中的实验记录</h3>${records.map(labRecordButton).join('')}</section>`);bindLabRecordLinks($('#content'));}return;
  }
  const list=snapshots.filter(s=>!historyDate||s.date===historyDate);
  $('#content').innerHTML=`<div class="section-head"><div><h2>历史日记</h2><span class="muted">每个日期可以保留多个版本，旧记录始终可查。</span></div><div class="actions"><input id="history-date" class="history-date" type="date" aria-label="按日期筛选快照" value="${historyDate}"><button id="all-dates" class="button secondary">全部日期</button></div></div><div class="notice">快照保存的是当时已录入的状态。没有快照的日期不会被推断为“无变化”；未核对记录请结合原始实验记录使用。</div>${list.length?`<div class="table-wrap"><table><thead><tr><th>记录日期</th><th>保存时间</th><th>来源</th><th>核对状态</th><th></th></tr></thead><tbody>${list.map(s=>`<tr><td><strong>${s.date}</strong></td><td>${shortTime(s.at).slice(11)}<small>北京时间</small></td><td>${s.source==='auto'?'22:00 自动留档':'手动保存'}</td><td><span class="pill ${s.verified?'green':'amber'}">${s.verified?'已核对':'未核对'}</span></td><td><button class="button secondary" data-snapshot="${s.id}">打开日记 ↗</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty-state">${emptyGraphic()}<h2>${snapshots.length?'这一天没有快照':'第一篇日记，等你写下'}</h2><p>在当前培养页保存快照，或完成今日核对。服务运行时每天 22:00 也会自动保存。</p></div>`}`;
  $('#history-date').onchange=e=>{historyDate=e.target.value;renderHistory();};$('#all-dates').onclick=()=>{historyDate='';renderHistory();};
  document.querySelectorAll('[data-snapshot]').forEach(b=>b.onclick=async()=>{try{frozen=await api('/api/snapshots/'+b.dataset.snapshot);currentId=null;selected.clear();statusFilter='all';search='';renderHistory();}catch(error){toast(error.message,true);}});
  $('#content').insertAdjacentHTML('beforeend',archivedCulturesMarkup());
  bindArchivedCultureLinks($('#content'));
}
function renderEvents() {
  $('#content').innerHTML=`<div class="section-head"><div><h2>操作记录</h2><span class="muted">保留每次保存的时间与改动。页面展示最近 200 条，完整历史包含在备份中。</span></div><button id="refresh-events" class="button secondary">刷新记录</button></div>${events.length?`<div class="table-wrap"><table><thead><tr><th>保存时间</th><th>操作</th><th>容器 / 孔位</th><th>保存内容</th></tr></thead><tbody>${events.map(e=>{
    const p=e.payload,c=state.containers.find(c=>c.id===p.id);const revoked=e.undone?'<span class="pill amber">已撤销</span>':'';if(e.action.startsWith('cryo_')||['activity','check','undo','lab_record_save','merge_groups','unmerge_groups','finish_sampling','well_group_save','well_group_remove'].includes(e.action)||p.group_context){const item=e.entry;return `<tr><td>${esc(shortTime(item.occurred_at))}<small>录入 ${esc(shortTime(e.at))}</small></td><td class="event-action">${esc(item.title)} ${revoked}</td><td>${esc(item.containers.map(c=>c.name).join(' · '))}<small>${esc(item.wells.join('、'))}</small></td><td class="wrap">${esc(item.summary)}${item.record_id?`<br><button type="button" class="text-button" data-lab-record="${esc(item.record_id)}">打开实验记录</button>`:''}</td></tr>`;}if(e.action==='transfer'||e.action==='relocate')return `<tr><td>${shortTime(e.at)}<small>#${e.id}</small></td><td class="event-action">${transferModes[p.mode]} ${revoked}</td><td>${e.action==='relocate'?esc(p.source_id+' → '+p.target_id):p.sources.length+' 个来源 → '+p.targets.length+' 组去向'}</td><td><button class="button secondary" data-lineage="${esc(p.transfer_id)}">查看流转凭据</button></td></tr>`;let details=p.patch?Object.entries(p.patch).map(([k,v])=>k==='medium'?'培养基：'+mediumPatchSummary(v):k==='cell_count'?countSummary(v):(fieldSpecs.find(f=>f[0]===k)?.[1]||k)+'：'+(v||'（清空）')).join('\n'):p.name|| (e.action==='confirm'?'用户确认当日所有在培养容器':p.status==='archived'?'结束培养':p.status==='active'?'恢复培养':e.action==='clear'?'清空选中孔位的当前内容':'');
    return `<tr><td>${shortTime(e.at)}<small>#${e.id}</small></td><td class="event-action">${actionNames[e.action]||esc(e.action)} ${revoked}</td><td>${esc(c?.name||p.name||'全部在培养容器')}<small>${esc(p.id||'')}${p.wells?' · '+esc(p.wells.join(', ')):''}</small></td><td class="wrap">${esc(details)}</td></tr>`;
  }).join('')}</tbody></table></div>`:'<div class="panel"><p class="muted">还没有保存操作。添加培养容器后，操作历史会自动记录在这里。</p></div>'}`;
  $('#refresh-events').onclick=()=>switchView('events');
  bindLineageButtons($('#content'));bindLabRecordLinks($('#content'));
}
function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
const releaseHome = 'https://lumyqaq.github.io/Lab-Note/';
const dismissedUpdateKey = 'lab-note-dismissed-update';
let updateInfo = null, checkingUpdate = false, updateRequest = 0;
let dismissedUpdate = '';
try { dismissedUpdate = localStorage.getItem(dismissedUpdateKey) || ''; } catch {}
let storageStats = null, statsRequest = 0;

function officialReleaseLink(raw) {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password && url.protocol === 'https:' &&
        ((url.host === 'github.com' && url.pathname.startsWith('/LumyQAQ/Lab-Note/releases')) ||
         (url.host === 'lumyqaq.github.io' && url.pathname.startsWith('/Lab-Note/')))) return url.href;
  } catch {}
  return releaseHome;
}

function renderUpdateBanner() {
  const banner = $('#update-banner');
  const available = updateInfo?.has_update && updateInfo.latest_version && updateInfo.latest_version !== dismissedUpdate;
  banner.hidden = !available;
  if (!available) return;
  const href = officialReleaseLink(updateInfo.download_url || updateInfo.release_url);
  banner.innerHTML = `<div class="update-banner-main"><strong>发现新版本 v${esc(updateInfo.latest_version)}</strong>
    <span>（当前 v${esc(updateInfo.current_version)}）${updateInfo.notes ? ' · ' + esc(updateInfo.notes) : ''}</span></div>
    <div class="actions"><a class="button primary" href="${esc(href)}" target="_blank" rel="noopener">查看更新并下载</a>
    <button type="button" class="text-button" id="dismiss-update-banner">暂不提示</button></div>`;
  $('#dismiss-update-banner').onclick = () => {
    dismissedUpdate = updateInfo.latest_version;
    try { localStorage.setItem(dismissedUpdateKey, dismissedUpdate); } catch {}
    banner.hidden = true;
  };
}

async function runUpdateCheck(force = false) {
  if (!force && (checkingUpdate || updateInfo)) return;
  const request = ++updateRequest;
  checkingUpdate = true;
  renderVersionCard();
  try {
    const info = await api(force ? '/api/update-check?force=1' : '/api/update-check');
    if (request !== updateRequest) return;
    updateInfo = info;
    if (force && info.has_update && info.latest_version === dismissedUpdate) {
      dismissedUpdate = '';
      try { localStorage.removeItem(dismissedUpdateKey); } catch {}
    }
  } catch {
    if (request !== updateRequest) return;
    updateInfo = {status:'offline'};
  } finally {
    if (request === updateRequest) {
      checkingUpdate = false;
      renderUpdateBanner();
      renderVersionCard();
    }
  }
}

function renderVersionCard() {
  const card = $('#version-card');
  if (!card || view !== 'backup') return;
  const current = boot.app_version || updateInfo?.current_version;
  const latest = updateInfo?.latest_version;
  let status = '向 GitHub Releases 查询适用于本机的公开版本。';
  if (updateInfo?.status === 'offline') status = '暂时无法检查更新，可稍后重试。';
  else if (updateInfo?.has_update) status = `发现新版本 v${latest}。${updateInfo.notes || ''}`;
  else if (latest) status = `已检查，当前没有可用更新。最新公开版本为 v${latest}。`;
  const href = officialReleaseLink(updateInfo?.download_url || boot.download_url);
  card.innerHTML = `<h3>程序版本与更新${current ? ' · v' + esc(current) : ''}</h3>
    <p class="muted" role="status">${esc(status)}</p><div class="actions">
    <button id="check-updates-btn" type="button" class="button secondary" ${checkingUpdate ? 'disabled' : ''}>${checkingUpdate ? '正在检查…' : '检查 GitHub 更新'}</button>
    <a class="button ${updateInfo?.has_update ? 'primary' : 'secondary'}" href="${esc(href)}" target="_blank" rel="noopener">${updateInfo?.has_update ? '下载 v' + esc(latest) : '打开版本下载页'}</a>
    ${updateInfo?.release_url && updateInfo.release_url !== href ? `<a class="text-button" href="${esc(officialReleaseLink(updateInfo.release_url))}" target="_blank" rel="noopener">GitHub 更新日志</a>` : ''}</div>`;
  $('#check-updates-btn').onclick = () => runUpdateCheck(true);
}

function renderStorageUsage() {
  const element = $('#storage-usage');
  if (!element || view !== 'backup') return;
  if (!storageStats) { element.textContent = '正在读取数据库占用…'; return; }
  const stats = storageStats;
  element.innerHTML = `当前数据库占用 <strong>${formatBytes(stats.db_bytes)}</strong>。共 ${esc(stats.total_events)} 条操作记录，其中 ${esc(stats.compressed_events)} 条已压缩。共 ${esc(stats.total_snapshots)} 份快照，其中 ${esc(stats.compressed_snapshots)} 份已压缩。`;
}

async function loadStorageStats() {
  const request = ++statsRequest;
  try {
    const result = await api('/api/storage-stats');
    if (request !== statsRequest || view !== 'backup') return;
    storageStats = result;
    renderStorageUsage();
  } catch {
    if (request !== statsRequest || view !== 'backup') return;
    const element = $('#storage-usage');
    if (element) element.textContent = '暂时无法读取数据库占用。';
  }
}

function renderBackup() {
  $('#content').innerHTML=`<div class="backup-layout"><div class="section-head"><div><h2>数据与备份</h2><span class="muted">记录保存在本机数据库中。</span></div></div><div class="panel"><span class="eyebrow">LOCAL STORAGE</span><h3>你的实验记录，保存在这里</h3><code>${esc(boot.data_dir)}/culture.sqlite3</code><p class="muted">包含当前培养、每次操作前后的状态和全部历史快照。新建或修改点击保存后立即写入；还没有点击保存的表单内容不在备份中。</p><p class="muted" id="storage-usage"></p><p class="muted">最近独立备份：${esc(boot.last_backup||'尚无备份')}</p><div class="actions"><button id="download-backup" class="button primary">↓ 创建并下载完整备份</button><button id="compact-storage" type="button" class="button secondary">无损压缩历史记录</button></div><p class="muted">压缩前会创建并校验完整备份。压缩后仍可还原快照、查询历史和撤销操作。</p><p class="muted" style="margin-top:15px">下载 ZIP 内含数据库、完整 JSON 和恢复说明。每次保存快照也会在 data/backups 中自动备份并校验完整性。建议定期把 ZIP 另存到外置硬盘。</p></div><div class="panel" id="version-card"></div><div class="panel"><span class="eyebrow">EXPORT & HANDOFF</span><h3>带进你的实验记录</h3><p class="muted">日记导出为可用浏览器打开和打印的 HTML；CSV 可用 Excel 继续整理。导出内容包含容器编号、日期、孔位和关联实验编号。历史版本请从“历史日记”打开后导出。</p><div class="actions"><a href="/api/diary.html" class="button secondary">导出当前日记</a><a href="/api/export.csv" class="button secondary">导出当前 CSV</a></div></div><div class="panel"><span class="eyebrow">DAILY ROUTINE</span><h3>每天 22:00，留下一份当日记录</h3><p class="muted">本地服务运行时，每天北京时间 22:00 自动保存快照与备份。若当天 22:00 后重新启动，会补存当天状态并记录实际保存时间。电脑关机或服务未运行的日期不会补造记录。</p><p class="muted">自动留档不会替你确认实验事实。在“当前培养”核对并保存后，当天会多一份已核对版本。</p></div></div>`;
  renderStorageUsage();
  renderVersionCard();
  $('#compact-storage').onclick=async event=>{
    if (busy) return;
    const button = event.currentTarget;
    busy = true;
    button.disabled = true;
    button.textContent = '正在备份并压缩…';
    try {
      const result = await api('/api/compact', {});
      ++statsRequest;
      storageStats = result.stats;
      boot.last_backup = result.last_backup;
      if (view === 'backup') renderBackup();
      toast(`历史压缩完成，数据库由 ${formatBytes(result.before_bytes)} 变为 ${formatBytes(result.after_bytes)}。`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = '无损压缩历史记录';
      renderUndoControl();
    }
  };
  $('#download-backup').onclick=async()=>{if(busy)return;busy=true;try{const result=await api('/api/backup',{});const a=document.createElement('a');a.href=result.url;a.download='';a.click();await load();if(view==='backup'){renderBackup();loadStorageStats();}toast('完整备份已生成，下载已开始');}catch(error){toast(error.message,true);}finally{busy=false;if(typeof renderUndoControl==='function')renderUndoControl();}};
}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view));
$('#close-create').onclick=$('#cancel-create').onclick=()=>$('#create-dialog').close();
$('#create-form').onsubmit=async e=>{
  e.preventDefault();const form=new FormData(e.target);
  const payload=Object.fromEntries(form);
  if($('#create-recipe-base').value && !$('#create-recipe').value)return toast('请选择该基础培养基的配方，或清空基础培养基。',true);
  if($('#create-recipe').value!==''){
    payload.medium=collectMediumPatch($('#create-medium-editor'));
    if(!payload.medium.base)return toast('请填写基础培养基名称',true);
  }
  const ok=await command('create',payload);
  if(ok){$('#create-dialog').close();view='today';experimentFilter='';currentId=state.containers.at(-1).id;statusFilter='active';search='';selected=new Set(Object.keys(current().wells));render();}
};
window.addEventListener('beforeunload',e=>{if(dirty||$('#cryo-dialog').open||$('#manual-group-dialog').open||$('#well-group-dialog')?.open||$('#transfer-dialog').open||$('#transfer-system-dialog').open||$('#transfer-review-dialog').open||$('#occupied-target-dialog').open||$('#relocation-dialog').open||$('#activity-dialog').open||$('#quick-medium-dialog').open||$('#lab-record-dialog').open){e.preventDefault();e.returnValue='';}});
async function start(){try{await load();render();setTimeout(() => runUpdateCheck(false), 1500);}catch(error){$('#connection').hidden=false;$('#connection').textContent='未连接到本机工作台。请重新启动实验日记并刷新页面。';}}
start();
function editingOrBusy() {
  return dirty || busy || modalOpen() || inlineRelocationActive
    || Boolean(document.activeElement?.closest('form'))
    || (view === 'cryo' && typeof cryoFormEditing === 'function' && cryoFormEditing());
}
let refreshPending = false;
async function refreshCurrentView() {
  if (refreshPending || editingOrBusy() || frozen) return;
  refreshPending = true;
  const oldBoot=boot, oldRevision=state?.revision, oldDate=boot?.today, oldView=view, oldId=currentId;
  const stillCurrent = () => !editingOrBusy() && !frozen && boot===oldBoot
    && state?.revision===oldRevision && view===oldView && currentId===oldId;
  try {
    const result=await api('/api/state');
    if (!stillCurrent()) return;
    const nextSnapshots=oldView==='history'?await api('/api/snapshots'):null;
    const nextEvents=oldView==='events'?await api('/api/events'):null;
    if (!stillCurrent()) return;
    const backupChanged=oldView==='backup' && oldBoot?.last_backup!==result.last_backup;
    applyBoot(result);
    if(nextSnapshots)snapshots=nextSnapshots;
    if(nextEvents)events=nextEvents;
    if(oldRevision!==state.revision||oldDate!==boot.today||nextSnapshots||nextEvents||backupChanged||oldView==='home'||oldView==='work')render();
    if (oldView==='backup' && (backupChanged || oldRevision!==state.revision)) loadStorageStats();
  } catch (error) {
    if (!stillCurrent()) return;
    $('#connection').hidden=false;
    $('#connection').textContent='与本机工作台的连接已中断。请检查工作台，尚未保存的编辑仍在本页。';
  } finally {
    refreshPending = false;
  }
}
setInterval(refreshCurrentView, 30000);
