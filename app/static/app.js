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
  document.querySelectorAll('[data-host-only]').forEach(item => { item.hidden = !!boot.mobile_client; });
  if (boot.mobile_client) {
    $('.workspace-tag').textContent = '个人实验室 / 已配对';
    $('#storage-location').textContent = '记录保存在工作台电脑';
    $('#workspace-client').textContent = 'Lab Note · 已配对设备';
  }
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
  if ((next === 'backup' && boot?.mobile_client) || !canLeave()) return;
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
  document.querySelectorAll('[data-mobile-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.mobileView === view);
    if (button.dataset.mobileView === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#mobile-more-btn').classList.toggle('active', !!document.querySelector('#mobile-more-sheet .active'));
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
    const checked = c.checked_date === (frozen?.date || boot.today);
    return `<div class="container-card-wrap"><button class="container-card ${c.id===currentId?'selected':''}" data-container="${esc(c.id)}"><div class="card-top">${typeBadge(c)}<span class="pill ${c.status==='archived'?'':checked?'green is-info':'amber is-pending'}">${c.status==='archived'?'已结束':checked?'已核对':'待核对'}</span></div><h3>${esc(c.name)}</h3><p class="cell-names">${esc([...new Set(wells.map(w => w.cell))].join(' · ') || '尚未填写细胞')}</p><p>${days.length?days.join(' / '):'Day —'} · ${wells.length}/${Object.keys(c.wells).length} ${boot.layouts[c.type]?'孔':'个培养单元'}</p>${groupQuantity(c)>1?`<p class="group-status-summary">${groupCounts(c).active} 在培养 · ${groupCounts(c).ended} 已结束${groupCounts(c).empty?' · '+groupCounts(c).empty+' 待填写':''}</p>`:''}<p>${esc(c.location||'未填写位置')}</p></button>${frozen?'':cultureCheckMarkup(c)}</div>`;
  }).join('') || '<div class="no-match">没有符合条件的容器</div>';
}
function renderCultures() {
  const all = displayContainers(activeState());
  if (!all.length) {
    if (frozen) {
      $('#cultures').innerHTML = '<div class="panel"><h3>这份快照中没有培养容器</h3><p class="muted">历史记录为只读。要新增容器，请返回“当前培养”。</p></div>';
      return;
    }
    $('#cultures').innerHTML = `<div class="empty-state">${emptyGraphic()}<h2>从第一个培养容器开始</h2><p>添加培养瓶或孔板，记录细胞和起始日期。<br>孔位可以多选，特殊处理一次填写、同时保存。</p><button class="button primary" id="first-container">＋ 添加我的第一个容器</button><div class="footer-note">尚未录入任何实验数据 · ${boot.mobile_client?'保存在工作台电脑':'本地数据库保存'}</div></div>`;
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
const plateContentLabels = new Map([
  ['target_medium', '靶细胞＋培养基'], ['target_effector', '靶细胞＋效应细胞'],
  ['medium', '仅培养基'], ['pbs', '仅 PBS'],
  ['transwell', 'Transwell 双室'], ['organoid', '类器官培养 / 共培养'],
]);
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
      const content = plateContentLabels.get(w.assay_contents?.kind);
      const label = plateContentTypes[w.assay_contents?.kind]?.short || content || w.cell || '空';
      const group = wellGroupFor(c,key);
      const hoverText = [key, plateWellDescription(w) || '空孔', group && '培养组：'+group.name, w.cell && day != null && 'Day '+day].filter(Boolean).join(' · ');
      const title = [hoverText, w.treatment].filter(Boolean).join('\n');
      markup += `<button class="well ${w.cell?'filled':''} ${selected.has(key)?'selected':''}" style="--well-bg:${palette[0]};--well-border:${palette[1]}" data-well="${key}" ${w.cell?`data-well-palette="${hash}"`:''} ${content?`data-well-content="${esc(w.assay_contents.kind)}"`:''} ${group?`data-well-group-color="${wellGroupColorIndex(group)}"`:''} data-well-hover="${esc(hoverText)}" aria-label="${esc(hoverText)}" aria-pressed="${selected.has(key)}" title="${esc(title)}"><strong>${key}</strong><small>${esc(label)}</small></button>`;
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
  $('#detail').innerHTML = `<article class="detail"><div class="detail-head"><div><span class="eyebrow">${esc(c.id)}</span><h2>${esc(c.name)}</h2><p>${esc(c.location||'未填写位置')} · ${esc(groupTypeLabel(c))}${boot.layouts[c.type]?' · '+boot.layouts[c.type].join(' 行 × ')+' 列':''}</p>${!frozen?'<div class="detail-utility-links"><button class="text-button" id="container-journal">操作日志</button></div>':''}</div><div class="detail-actions">${!frozen?`${cultureCheckMarkup(c)}<button class="button primary" id="transfer-container" ${c.status!=='active'||!wellList(c).length?'disabled':''}>传代 / 开展实验</button><button class="button secondary" id="container-activity" ${c.status!=='active'?'disabled':''}>＋ 追加操作</button><details class="detail-more-menu"><summary class="button secondary">更多 ▾</summary><div class="detail-more-list"><button class="text-button" id="container-lineage">流转记录</button><button class="text-button" id="rename-container">${c.display_group?'编辑分组':'编辑信息'}</button>${c.display_group?'<button class="text-button" id="unmerge-container">取消显示合并</button>':''}<button class="text-button" id="archive-container">${c.status==='active'?'结束培养':'恢复培养'}</button></div></details>`:'<span class="pill amber">历史只读</span>'}</div></div>${!readonly?`<div class="culture-quick-actions"><span class="muted">常用操作</span>${typeof quickMediumButtons==='function'?quickMediumButtons(c):''}<button type="button" class="button secondary" id="quick-replate" ${!wellList(c).length?'disabled':''}>传代 / 移孔 / 扩孔</button></div>`:''}<div class="detail-body"><div class="plate-area"><div class="plate-top"><span>${grouped?'选择瓶 / 皿成员':readonly?'查看孔位记录':plateInteraction.mode==='select'?'点击或拖动 · 框选多个孔':'拖动所选孔组 · '+(plateInteraction.mode==='copy'?'复制':'移动')}</span><span>${boot.layouts[c.type]?plateContentsSummary(c):wellList(c).length+' / '+Object.keys(c.wells).length+' 已填写'}</span></div>${wellGroupToolsMarkup(c,readonly)}${boot.layouts[c.type]?'<div class="plate-hover-readout" id="plate-hover-readout" aria-live="polite">悬停或聚焦孔位查看详情</div>':''}${plateMarkup(c,readonly)}<div class="selection-tools"><button id="select-all">${grouped?readonly?'选择全部历史成员':'选择全部在培养 / 待填写成员':'全选'}</button><button id="select-filled">选择已填写</button><button id="deselect">取消选择</button>${grouped&&!frozen?`<button type="button" id="end-group-members" ${![...selected].some(k=>memberActive(c.wells[k]))||readonly?'disabled':''}>结束所选瓶 / 皿</button><button type="button" id="restore-group-members" ${![...selected].some(k=>c.wells[k].cell&&(c.status==='archived'||c.wells[k].member_status==='archived'))?'disabled':''}>恢复所选瓶 / 皿</button>`:''}${!readonly&&boot.layouts[c.type]?`<span class="plate-mode-switch" role="group" aria-label="孔板鼠标操作模式">${[['select','框选'],['copy','孔位复制'],['move','孔位移动']].map(([mode,label])=>`<button type="button" data-plate-mode="${mode}" class="${plateInteraction.mode===mode?'active':''}" aria-pressed="${plateInteraction.mode===mode}">${label}</button>`).join('')}</span><button id="relocate-wells">跨孔板复制 / 移动 ↗</button>`:''}</div>${wellGroupDirectoryMarkup(c,readonly)}<div class="legend"><span><i></i>已填写</span><span><i class="empty"></i>空孔</span><span><i class="selected"></i>选中</span></div><p class="plate-help" id="inline-placement-hint" aria-live="polite">${grouped?'默认选中全组在培养成员，可取消选择后单独选择几瓶。已结束成员保留只读记录，可恢复后继续填写。':readonly?'点击一个或多个孔，查看当时的细胞与处理记录。':'按住鼠标从一个孔拖到另一个孔，可框选整片区域。点击行号或列号可批量选择；勾选的字段才会写入。'}</p></div><aside class="inspector" id="inspector">${!readonly&&boot.layouts[c.type]?window.PlateToday?.markup(c)||'':''}<div id="selected-well-inspector"></div></aside></div></article>`;
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
  $('#select-filled').onclick = () => selectKeys(Object.keys(c.wells).filter(k=>plateWellLayout(c.wells[k]) || (readonly?c.wells[k].cell:memberActive(c.wells[k]))));
  $('#deselect').onclick = () => {if(busy||!canLeave())return;dirty=false;selected.clear();renderDetail();};
  if($('#relocate-wells'))$('#relocate-wells').onclick=openRelocation;
  document.querySelectorAll('[data-plate-mode]').forEach(b=>b.onclick=()=>{if(busy||!canLeave())return;dirty=false;plateInteraction={id:c.id,mode:b.dataset.plateMode};renderDetail();});
  if(typeof bindWellGroupControls==='function')bindWellGroupControls(c,readonly,selectKeys);
  bindCultureChecks($('#detail'));
  if(!readonly&&boot.layouts[c.type])window.PlateToday?.bind(c);
  renderInspector(c, readonly);
}
const plateVolumeFields = [
  ['final_volume_ul','final-volume','终体积'],
  ['target_volume_ul','target-volume','靶细胞悬液'],
  ['effector_volume_ul','effector-volume','效应细胞悬液']
];
function plateVolumeMode(layout) {
  if(layout?.final_volume_ul)return 'final';
  return layout?.target_volume_ul || layout?.effector_volume_ul ? 'components' : 'none';
}
function plateLayoutWithTrackedCells(well, contents) {
  const layout={...contents};
  if(!['target_medium','target_effector'].includes(layout.kind))return layout;
  if(!well.components?.length) {
    if(!layout.target_cell && well.cell && well.cell.trim().toUpperCase()!=='PBS')layout.target_cell=well.cell;
  } else if(layout.kind==='target_effector' && (!layout.target_cell || !layout.effector_cell)) {
    Object.assign(layout,documentedPlateRoles(well,layout));
  }
  return layout;
}
function plateCompatibleLayout(well,kind) {
  const old=plateWellLayout(well);
  if(old?.kind===kind)return {...old};
  const layout={kind};
  if(!old || !kind || kind==='empty')return layout;
  const fields=['group'];
  if(['pbs','medium','target_medium','target_effector','organoid'].includes(kind))fields.push('final_volume_ul');
  if(['medium','target_medium','target_effector','organoid'].includes(kind))fields.push('medium');
  if(['target_medium','target_effector'].includes(kind))fields.push('target_cell','target_volume_ul','target_cells_per_well');
  if(['target_effector','organoid'].includes(kind))fields.push('effector_cell','effector_cells_per_well');
  if(kind==='target_effector')fields.push('effector_volume_ul');
  if(kind==='transwell')fields.push('transwell_mode','pore_size_um','matrigel_coating','upper_cell','upper_cells_per_well','upper_medium','upper_volume_ul','lower_cell','lower_cells_per_well','lower_medium','lower_volume_ul');
  if(kind==='organoid')fields.push('organoid_name','organoid_mode','matrix_type','dome_volume_ul','dome_count','et_ratio');
  for(const key of fields)if(old[key])layout[key]=old[key];
  return layout;
}
function plateVolumeDecimal(value) {
  if(value.length>80 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !/[1-9]/.test(value))return null;
  const [whole, digits='']=value.split('.');
  const fraction=digits.replace(/0+$/,'');
  return (whole.replace(/^0+/,'')||'0')+(fraction?'.'+fraction:'');
}
function plateContentsEditorMarkup(c,wells) {
  const common = values => values.every(value => value===values[0]) ? values[0] : null;
  const layouts = wells.map(plateWellLayout);
  const kind = common(layouts.map(layout => layout?.kind));
  const values = wells.map((w,i)=>plateLayoutWithTrackedCells(w,{kind:'target_effector',...layouts[i]}));
  const mode = common(layouts.map(plateVolumeMode)) || 'keep';
  const savedLayouts = Object.values(c.wells).map(plateWellLayout).filter(Boolean);
  const cells = savedLayouts.flatMap(layout=>[layout.target_cell,layout.effector_cell,layout.upper_cell,layout.lower_cell,layout.organoid_name]);
  if(typeof cellNameHistory==='function')cells.push(...cellNameHistory(state,boot.cell_names||[]));
  const media = savedLayouts.flatMap(layout=>[layout.medium,layout.upper_medium,layout.lower_medium]);
  if(typeof mediumNameHistory==='function')media.push(...mediumNameHistory('bases'));
  const suggestions = (id,items)=>`<datalist id="${id}">${[...new Set(items.filter(Boolean))].map(value=>`<option value="${esc(value)}"></option>`).join('')}</datalist>`;
  const fields = [
    ['target_cell','target-cell','靶细胞'],
    ['target_cells_per_well','target-count','每孔实际加入靶细胞数（个，选填）'],
    ['transwell_mode','tw-mode','Transwell 模式（如 迁移 / 侵袭 / 间接共培养）'],
    ['pore_size_um','tw-pore','膜孔径 μm（0.4 / 3.0 / 5.0 / 8.0）'],
    ['matrigel_coating','tw-matrigel','Matrigel 包被条件（选填）'],
    ['upper_cell','tw-upper-cell','上室（Insert）细胞'],
    ['upper_cells_per_well','tw-upper-count','上室细胞数（个/孔，选填）'],
    ['upper_medium','tw-upper-medium','上室培养基'],
    ['upper_volume_ul','tw-upper-vol','上室体积（µL/孔，选填）'],
    ['lower_cell','tw-lower-cell','下室（Well）细胞 / 趋化因子'],
    ['lower_cells_per_well','tw-lower-count','下室细胞数（个/孔，选填）'],
    ['lower_medium','tw-lower-medium','下室培养基 / 趋化条件'],
    ['lower_volume_ul','tw-lower-vol','下室体积（µL/孔，选填）'],
    ['organoid_name','org-name','类器官名称 / 来源 / 代次'],
    ['organoid_mode','org-mode','类器官模式（单培养 / 胶面共培养 / 胶内混埋 / 悬浮共培养）'],
    ['matrix_type','org-matrix','基质胶类型与比例'],
    ['dome_volume_ul','org-dome-vol','每孔基质胶液滴体积（µL/孔，选填）'],
    ['dome_count','org-dome-count','每孔液滴数（选填，如 1 或 3）'],
    ['effector_cell','effector-cell','效应细胞（选填）'],
    ['et_ratio','org-et','效靶比 E:T（选填，如 5:1）'],
    ['effector_cells_per_well','effector-count','每孔实际加入效应细胞数（个，选填）'],
    ['medium','medium','培养基名称（选填）'],
    ['group','group','组名（选填）']
  ];
  function fieldMarkup([key,id,label], volume=false) {
    const value=common(values.map(layout=>layout[key] || ''));
    const isVol = volume || ['upper_volume_ul','lower_volume_ul','dome_volume_ul'].includes(key);
    const list=key.includes('medium')?'plate-known-media':key==='group'?'plate-known-groups':(key.includes('cell')||key==='organoid_name')?'plate-known-cells':'';
    const attrs=key.endsWith('_cells_per_well')?'maxlength="80" inputmode="text"':isVol?'inputmode="decimal" maxlength="80"':`${list?`list="${list}"`:''} maxlength="300"`;
    return `<label data-plate-input="${key}" hidden>${key==='target_cell'?'<span id="plate-target-label">靶细胞</span>':label}${volume?'（µL/孔）':''}<input id="plate-${id}" data-layout-field="${key}" ${attrs} value="${esc(value||'')}" ${value===null?'placeholder="各孔原值不同，未修改时保留"':''}></label>`;
  }
  const options=[['keep','保留各孔原值'],['none','不记录'],['final','每孔终体积'],['components','分别记录两类悬液体积']];
  return `<form id="plate-contents-form" class="plate-contents-editor" novalidate>
    <label for="plate-contents-kind">设置孔内组成</label><select id="plate-contents-kind" aria-describedby="plate-contents-help"><option value="">选择孔内组成</option>${Object.entries(plateContentTypes).map(([value,type])=>`<option value="${value}" ${kind===value?'selected':''}>${type.label}</option>`).join('')}</select>
    <div class="plate-contents-fields">${fields.map(field=>fieldMarkup(field)).join('')}
      <label id="plate-volume-options" hidden>每孔体积（选填）<select id="plate-volume-mode">${options.map(([value,label])=>`<option value="${value}" ${value===mode?'selected':''}>${label}</option>`).join('')}</select></label>
      <div class="plate-volume-fields">${plateVolumeFields.map(field=>fieldMarkup(field,true)).join('')}</div>
    </div>
    ${suggestions('plate-known-cells',cells.filter(name=>name?.trim().toUpperCase()!=='PBS'))}${suggestions('plate-known-media',media)}${suggestions('plate-known-groups',savedLayouts.map(layout=>layout.group))}
    <p id="plate-contents-help" aria-live="polite"></p><button type="submit" class="button secondary" id="save-plate-contents">保存到所选 ${wells.length} 个孔</button></form>`;
}
function bindPlateContentsEditor(c,keys,wells) {
  const form=$('#plate-contents-form');
  if(!form)return;
  const chooser=$('#plate-contents-kind'), help=$('#plate-contents-help'), save=$('#save-plate-contents');
  const volumeMode=$('#plate-volume-mode'), fields=form.querySelectorAll('[data-plate-input]');
  const edited=new Set();
  let chosenMode=volumeMode.value;
  let cultureEdited=false;
  const markCultureEdit=()=>{cultureEdited=true;};
  const cultureForm=$('#well-form');
  cultureForm?.addEventListener('input',markCultureEdit);
  cultureForm?.addEventListener('change',markCultureEdit);
  $('#inspector').querySelectorAll('#reset-day,#reuse-plate-defaults,#well-form button[type=button]').forEach(button=>button.addEventListener('click',markCultureEdit));
  const isLegacy = w => String(w.cell || '').trim().toUpperCase()==='PBS';
  const TW_KEYS = new Set(['transwell_mode','pore_size_um','matrigel_coating','upper_cell','upper_cells_per_well','upper_medium','upper_volume_ul','lower_cell','lower_cells_per_well','lower_medium','lower_volume_ul']);
  const ORG_KEYS = new Set(['organoid_name','organoid_mode','matrix_type','dome_volume_ul','dome_count','et_ratio']);
  const SPECIAL_VOL_KEYS = new Set(['upper_volume_ul','lower_volume_ul','dome_volume_ul']);
  function values() {
    const kind=chooser.value, patch={kind};
    const hasVolumes=!!kind && !['empty','transwell'].includes(kind);
    const savedModes=wells.map(w=>plateVolumeMode(plateCompatibleLayout(w,kind)));
    const commonMode=savedModes.every(mode=>mode===savedModes[0])?savedModes[0]:'keep';
    if(!edited.has('mode'))chosenMode=commonMode;
    const keepOption=volumeMode.querySelector('[value="keep"]');
    keepOption.hidden=keepOption.disabled=commonMode!=='keep' && chosenMode!=='keep';
    const legacyTargetVolumes=kind==='target_medium' && wells.some(w=>w.assay_contents?.target_volume_ul);
    const hasComponents=kind==='target_effector' || legacyTargetVolumes;
    const componentsOption=volumeMode.querySelector('[value="components"]');
    componentsOption.hidden=componentsOption.disabled=!hasComponents;
    componentsOption.textContent=legacyTargetVolumes?'靶细胞悬液体积':'分别记录两类悬液体积';
    volumeMode.value=chosenMode==='components' && !hasComponents?'none':chosenMode;
    $('#plate-target-label').textContent=kind==='target_effector'?'靶细胞（选填）':'靶细胞';
    $('#plate-volume-options').hidden=!hasVolumes;
    const mode=volumeMode.value;
    for(const label of fields) {
      const key=label.dataset.plateInput, input=label.querySelector('input');
      const isStdVol=key.endsWith('_volume_ul') && !SPECIAL_VOL_KEYS.has(key);
      const isAnyVol=key.endsWith('_volume_ul');
      let relevant;
      if(isStdVol)relevant=hasVolumes && (key==='final_volume_ul'?mode==='final':mode==='components' && (key==='target_volume_ul' || kind==='target_effector'));
      else if(TW_KEYS.has(key))relevant=kind==='transwell';
      else if(ORG_KEYS.has(key))relevant=kind==='organoid';
      else relevant=['target_cell','target_cells_per_well'].includes(key) ? ['target_medium','target_effector'].includes(kind)
        : ['effector_cell','effector_cells_per_well'].includes(key) ? ['target_effector','organoid'].includes(kind)
        : key==='medium' ? ['target_medium','target_effector','medium','organoid'].includes(kind)
        : !!kind && kind!=='empty';
      label.hidden=!relevant;
      const value=input.value.trim();
      if(relevant && edited.has(key)) {
        patch[key]=key.endsWith('_cells_per_well') ? plateCellsPerWell(value) ?? value : isAnyVol && value ? plateVolumeDecimal(value) ?? value : value;
      } else if(isStdVol && hasVolumes && edited.has('mode') && mode!=='keep' && !relevant) {
        patch[key]='';
      }
    }
    return patch;
  }
  function preview(w,patch) {
    const layout=plateCompatibleLayout(w,patch.kind);
    for(const [key,value] of Object.entries(patch)) {
      if(value)layout[key]=value;
      else delete layout[key];
    }
    return plateLayoutWithTrackedCells(w,layout);
  }
  function problem(patch) {
    const kind=patch.kind;
    if(!kind)return '选择组成后可批量保存。';
    if(kind==='empty' && !wells.some(plateWellLayout))return '所选孔已为空孔。';
    if(wells.some(w=>{
      const old=plateWellLayout(w);
      return old && old.kind!==kind && (old.effector_sources?.length || old.effector_transfer_id);
    }))return '所选孔已关联效应细胞来源。请撤销原流转，或通过“丢弃”登记实际去向。';
    for(const w of wells) {
      const layout=preview(w,patch), {target_cell,effector_cell}=layout;
      const old=plateWellLayout(w);
      if(old?.effector_sources?.length || old?.effector_transfer_id) {
        if(effector_cell!==old.effector_cell)return '效应细胞已关联来源，请核对该孔的流转凭据。';
      }
      if(['target_medium','target_effector'].includes(kind)) {
        if([layout.target_cells_per_well,layout.effector_cells_per_well].some(v=>v && plateCellsPerWell(v)===null))
          return '每孔加入细胞数须为非负整数，可用科学计数法填写。';
        if(kind==='target_medium'&&!target_cell)return '请填写靶细胞名称。';
        if([target_cell,effector_cell].some(name=>name?.toUpperCase()==='PBS'))return 'PBS 请选“仅 PBS（无细胞）”。';
        if(w.components?.length && !plateCanTransferCells({...w,assay_contents:layout}))return '请核对原共培养记录，明确靶细胞和效应细胞的角色。';
        if(w.cell && !w.components?.length && w.cell!==target_cell)return '填写的靶细胞须与所选孔已有细胞一致。';
      } else if(kind==='transwell') {
        if([layout.upper_cells_per_well,layout.lower_cells_per_well].some(v=>v && plateCellsPerWell(v)===null))
          return '上下室细胞数须为非负整数，可用科学计数法填写。';
        if([layout.upper_volume_ul,layout.lower_volume_ul].some(v=>v && !plateVolumeDecimal(v)))
          return '上下室体积须填写大于 0 的十进制数（µL/孔）。';
        if(w.cell)return '所选孔含有培养记录，请单独选择可设置的孔。';
      } else if(kind==='organoid') {
        if(layout.effector_cells_per_well && plateCellsPerWell(layout.effector_cells_per_well)===null)
          return '效应细胞数须为非负整数，可用科学计数法填写。';
        if(layout.dome_volume_ul && !plateVolumeDecimal(layout.dome_volume_ul))
          return '液滴体积须填写大于 0 的十进制数（µL/孔）。';
        if(w.cell)return '所选孔含有培养记录，请单独选择可设置的孔。';
      } else if(w.cell && !(kind==='empty'&&plateWellLayout(w)) && !(kind==='pbs'&&isLegacy(w)))return '所选孔含有培养记录，请单独选择可设置的孔。';
      if(kind!=='empty' && kind!=='transwell') {
        if(plateVolumeFields.some(([key])=>layout[key] && !plateVolumeDecimal(layout[key])))return '每孔体积须填写大于 0 的十进制数，单位为 µL/孔。';
        if(volumeMode.value==='final' && !layout.final_volume_ul)return '请填写每孔终体积，或选择“不记录”。';
        if(volumeMode.value==='components' && !layout.target_volume_ul && !layout.effector_volume_ul)return '请至少填写一种悬液的每孔体积，或选择“不记录”。';
      }
    }
    return '';
  }
  function refresh() {
    const patch=values(), error=problem(patch);
    save.disabled=!!error;
    if(error)help.textContent=error;
    else if(patch.kind==='empty')help.textContent='移除所选孔的实验组成，已有培养记录将保留。';
    else if(patch.kind==='transwell')help.textContent='保存后，点击上方「创建今日实验」→ 选择 Transwell 即可自动带入上下室分组表生成初始实验记录。';
    else if(patch.kind==='organoid')help.textContent='保存后，点击上方「创建今日实验」→ 选择类器官培养/共培养即可自动带入液滴与 E:T 分组表。';
    else if(patch.kind==='target_effector') {
      const sources=wells.map(w=>plateEffectorSourceNames({...w,assay_contents:preview(w,patch)}));
      help.textContent=sources.some(names=>!names.length)?'可先保存孔内组成，具体来源请在实验记录中填写。':
        wells.length===1?'效应细胞来源 '+sources[0].join('、'):`所选 ${wells.length} 个孔均已关联效应细胞来源。`;
    }
    else help.textContent='仅记录实验布局，无需填写 Day 0。';
  }
  function changed(event) {
    if(event.target===volumeMode) {
      chosenMode=volumeMode.value;
      edited.add('mode');
    }
    if(event.target.dataset.layoutField)edited.add(event.target.dataset.layoutField);
    if(dirty&&form.dataset.edited!=='true')cultureEdited=true;
    form.dataset.edited='true';
    dirty=true;
    refresh();
  }
  form.oninput=form.onchange=changed;
  form.onsubmit=async event=>{
    event.preventDefault();
    if(busy||frozen)return;
    const contents=values(), error=problem(contents);
    if(error)return toast(error,true);
    const legacy=contents.kind==='pbs'&&wells.some(isLegacy);
    const changedLayouts=wells.filter(w=>{
      const previous=plateWellLayout(w);
      if(!previous)return false;
      const next=preview(w,contents);
      return contents.kind==='empty'||Object.keys({...previous,...next}).some(key=>previous[key]!==next[key]);
    }).length;
    const notices=[];
    if(legacy)notices.push('将细胞名误填为 PBS 的旧记录更正为无细胞 PBS 孔。');
    if(changedLayouts)notices.push(`将${contents.kind==='empty'?'清除':'更新'} ${changedLayouts} 个孔的实验组成。已有培养记录将保留。`);
    if(cultureEdited)notices.push('培养表单中未保存的修改将被放弃。');
    if(notices.length&&!confirm(notices.join('\n')+'\n确认保存所选 '+keys.length+' 个孔的组成？'))return;
    if(boot.plate_contents_version!==2)return toast('当前连接尚未加载新版孔内组成，请在新版工作台中保存。',true);
    await command('plate_contents',{id:c.id,wells:keys,...contents,...(legacy?{confirm_legacy:true}:{})});
  };
  refresh();
}
function renderInspector(c, readonly) {
  if (!selected.size) { $('#selected-well-inspector').innerHTML = '<span class="eyebrow">WELL DETAILS</span><h3 style="margin-top:12px">选择一个培养单元</h3><p class="muted">点击左侧孔位，查看或编辑细胞、培养天数和特殊处理。</p>';return; }
  const keys = [...selected], wells = keys.map(k=>c.wells[k]);
  readonly=readonly||wells.some(w=>w.member_status==='archived');
  const hasComponents=wells.some(w=>w.components);
  const layoutEditor=!readonly&&!!boot.layouts[c.type]?plateContentsEditorMarkup(c,wells):'';
  const lineage=[...new Map(wells.flatMap(w=>[[w.maintenance_id,w.pool_id?'合并收集 / 扩孔凭据':'移孔换液凭据'],[w.lineage_correction_id,'来源更正凭据'],[w.lineage_id,'原始来源凭据'],[w.placement_id,'孔位修正凭据']]).filter(([id])=>id)).entries()].map(([id,label])=>`<button type="button" class="text-button" data-lineage="${esc(id)}">${label} ↗</button>`).join('');
  const composition=wells.map((w,i)=>w.components?'<h3>'+esc(keys[i])+' · 细胞组成</h3>'+componentSummary(w):'').join('');
  const title = `<span class="eyebrow">${readonly?'CULTURE RECORD':'BATCH EDIT'}</span><h3 style="margin-top:10px">${readonly?'查看记录':'编辑所选'} <span class="muted">/ ${keys.length}</span></h3><div class="selection-summary">${keys.map(k=>esc(groupMemberLabel(c,k))).join(' · ')}</div>${layoutEditor}${lineage}${typeof lineageLinksMarkup==='function'?lineageLinksMarkup(c,keys,activeState()):''}${typeof openLineageCorrection==='function'&&!readonly&&wells.every(w=>w.cell)?'<button type="button" class="text-button" id="correct-lineage">补充 / 更正来源关联</button>':''}${wells.map((w,i)=>w.seeding?'<div class="seeding-member"><small>'+esc(groupMemberLabel(c,keys[i]))+'</small>'+seedingDetailsMarkup(w.seeding)+'</div>':'').join('')}${linkedLabRecordsMarkup(c.id,keys)}${composition}${c.status==='active'?activeTreatmentMarkup(wells.map((w,i)=>({...w,key:groupMemberLabel(c,keys[i])})).filter(memberActive)):''}`;
  if (readonly) {
    $('#selected-well-inspector').innerHTML = title + (wells.some(w=>w.member_status==='archived')?'<p class="group-readonly-note">所选包含已结束成员，当前仅查看记录。选择在培养成员可编辑；也可恢复所选已结束成员。</p>':'') + wells.map((w,i)=>`<div class="field"><strong>${esc(groupMemberLabel(c,keys[i]))} · ${esc(plateWellDescription(w)||'空孔')}</strong>${w.cell?`<p class="muted">${wellDayLabel(w)} · ${esc(w.kind)}<br>${esc(w.anchor)}：${esc(w.day0)}<br>批次：${esc(w.batch||'—')}<br>处理：${esc(w.treatment||'未填写')}<br>浓度：${esc(w.concentration||'—')}<br>时间：${esc(w.treated_at||'—')}<br>备注：${esc(w.notes||'—')}<br>实验：${esc(w.experiment||'—')}</p>${mediumDetailsMarkup(w.medium)}${countDetailsMarkup(w.cell_count)}`:''}</div>`).join('');bindLineageButtons($('#selected-well-inspector'));bindLabRecordLinks($('#selected-well-inspector'));return;
  }
  if(wells.some(w=>plateWellLayout(w)&&!w.cell)){
    $('#selected-well-inspector').innerHTML=title;
    bindPlateContentsEditor(c,keys,wells);
    bindLineageButtons($('#selected-well-inspector'));bindLabRecordLinks($('#selected-well-inspector'));return;
  }
  const allEmpty = !c.display_group&&wells.every(w=>!w.cell);
  const sharedDefaults=!c.display_group&&(boot.layouts[c.type]||groupType(c.type))&&!hasComponents?(c.well_defaults||{}):{};
  const treatmentDefault = !c.display_group&&(boot.layouts[c.type]||groupType(c.type)) ? c.default_treated_at || '' : '';
  $('#selected-well-inspector').innerHTML = title + `<p class="muted">只应用勾选字段。未勾选的原有内容保持不变。<button type="button" class="text-button" id="reset-day">重新计时</button>${Object.keys(sharedDefaults).length?'<button type="button" class="text-button" id="reuse-plate-defaults">沿用首组信息</button>':''}</p>${allEmpty&&Object.keys(sharedDefaults).length?'<p class="muted">已带入本容器首组的细胞类型、批次及 Day 0，可按需要修改。</p>':''}<form id="well-form" novalidate><div class="fields">${fieldSpecs.map(([key,label,type,hint])=>{
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
  bindLineageButtons($('#selected-well-inspector'));bindLabRecordLinks($('#selected-well-inspector'));
  bindPlateContentsEditor(c,keys,wells);
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
    dirty=false;render();toast(boot.mobile_client ? '已保存到工作台电脑' : '已保存到本地数据库');return true;
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
    const lost=groupType(c.type)&&grouped?old.slice(next.length).filter(([,w])=>w.cell):old.filter(([key,w])=>(w.cell||plateWellLayout(w))&&!next.includes(key));
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
  $('#content').innerHTML=`<div class="section-head"><div><h2>历史日记</h2><span class="muted">每个日期可以保留多个版本，旧记录始终可查。</span></div><div class="actions"><input id="history-date" class="history-date" type="date" aria-label="按日期筛选快照" value="${historyDate}"><button id="all-dates" class="button secondary">全部日期</button></div></div><div class="notice">快照保存的是当时已录入的状态。没有快照的日期不会被推断为“无变化”；未核对记录请结合原始实验记录使用。</div>${list.length?`<div class="table-wrap"><table><thead><tr><th>记录日期</th><th>保存时间</th><th>来源</th><th>核对状态</th><th></th></tr></thead><tbody>${list.map(s=>`<tr><td><strong>${s.date}</strong></td><td>${shortTime(s.at).slice(11)}<small>北京时间</small></td><td>${s.source==='auto'?'22:00 自动留档':'手动保存'}</td><td><span class="pill ${s.verified?'green is-info':'amber is-pending'}">${s.verified?'已核对':'未核对'}</span></td><td><button class="button secondary" data-snapshot="${s.id}">打开日记 ↗</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty-state">${emptyGraphic()}<h2>${snapshots.length?'这一天没有快照':'第一篇日记，等你写下'}</h2><p>在当前培养页保存快照，或完成今日核对。服务运行时每天 22:00 也会自动保存。</p></div>`}`;
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
  const backupDir = boot.backup_dir || `${boot.data_dir}/backups`;
  const isCustomDir = Boolean(boot.is_custom_backup_dir);
  const dirMissing = boot.backup_dir_exists === false && isCustomDir;
  const backupDirControls = boot.mobile_client
    ? '<p class="muted" style="margin:6px 0 0">如需修改或直接打开本地备份目录，请在电脑端操作。</p>'
    : `<div class="actions backup-dir-actions"><button id="open-backup-dir" type="button" class="button secondary">打开当前备份地址</button><button id="edit-backup-dir" type="button" class="button secondary">修改本地备份地址</button>${isCustomDir ? '<button id="reset-backup-dir-quick" type="button" class="text-button">恢复默认目录</button>' : ''}</div><div id="backup-dir-editor" class="backup-dir-editor" hidden><label>本地备份目录路径<div class="backup-dir-input-row"><input id="backup-dir-input" type="text" value="${esc(backupDir)}" placeholder="本地文件夹的完整路径" autocomplete="off" spellcheck="false"><button id="pick-backup-dir" type="button" class="button secondary">选择文件夹…</button></div></label><p class="muted">可指向 云盘同步文件夹、外接硬盘或其他本地文件夹；保存后，新的手动备份与每晚 22:00 自动备份都会写入此处，原目录已有备份不会被删除。</p><div class="actions"><button id="save-backup-dir" type="button" class="button primary">保存备份地址</button>${isCustomDir ? '<button id="reset-backup-dir" type="button" class="button secondary">恢复默认目录</button>' : ''}<button id="cancel-backup-dir" type="button" class="button quiet">取消</button></div></div>`;

  $('#content').innerHTML=`<div class="backup-layout"><div class="section-head"><div><h2>数据与备份</h2><span class="muted">记录保存在本机数据库中。</span></div></div><div class="panel"><span class="eyebrow">LOCAL STORAGE</span><h3>你的实验记录，保存在这里</h3><code>${esc(boot.data_dir)}/culture.sqlite3</code><p class="muted">包含当前培养、每次操作前后的状态和全部历史快照。新建或修改点击保存后立即写入；还没有点击保存的表单内容不在备份中。</p><p class="muted" id="storage-usage"></p><div class="backup-dir-box"><div class="backup-dir-head"><span>本地备份地址</span><span class="state-badges"><span class="state-badge ${isCustomDir ? 'is-saved' : ''}">${isCustomDir ? '自定义' : '默认'}</span>${dirMissing ? '<span class="state-badge is-pending">当前不可访问</span>' : ''}</span></div><code class="backup-dir-path">${esc(backupDir)}</code><p class="muted" style="margin:0 0 10px">最近独立备份：${esc(boot.last_backup||'尚无备份')}</p>${backupDirControls}</div><div class="actions"><button id="download-backup" class="button primary">↓ 创建并下载完整备份</button><button id="compact-storage" type="button" class="button secondary">无损压缩历史记录</button></div><p class="muted">压缩前会创建并校验完整备份。压缩后仍可还原快照、查询历史和撤销操作。</p><p class="muted" style="margin-top:15px">下载 ZIP 内含数据库、完整 JSON 和恢复说明。每次保存快照也会在当前备份地址中自动备份并校验完整性。建议定期把 ZIP 另存到外置硬盘。</p></div><div class="panel" id="word-templates-panel"><span class="eyebrow">RECORD TEMPLATES</span><h3>实验记录 Word 模版管理（标准版 + 自定义建档）</h3><p class="muted">已内置标准六栏目模版及 Transwell / 类器官初始模版；后续从「实验记录」导出 Word 时自动按默认模版排版。也支持上传你自己现有的 <code>.docx</code> 模版建档（自动解析栏目结构，或保留带 <code>{{title}}</code> / <code>{{section:purpose}}</code> 占位符的原版样式精准套打）。</p><div id="word-tpl-list" class="word-tpl-list"><p class="muted">正在加载模版列表…</p></div><form id="word-tpl-upload-form" class="word-tpl-upload" novalidate><div class="two"><label>模版名称（选填，留空取文件名）<input id="word-tpl-name" type="text" maxlength="80" placeholder="如 课题组正式六栏目模版 / 医院记录表"></label><label>上传自备 Word 模版（.docx）<input id="word-tpl-file" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required></label></div><label class="inline-check" style="margin-bottom:10px"><input id="word-tpl-default" type="checkbox" checked>建档后设为默认 Word 导出模版</label><div class="actions"><button id="word-tpl-submit" type="submit" class="button primary">上传并建档模版</button></div></form></div><div class="panel" id="version-card"></div><div class="panel"><span class="eyebrow">EXPORT & HANDOFF</span><h3>带进你的实验记录</h3><p class="muted">日记导出为可用浏览器打开和打印的 HTML；CSV 可用 Excel 继续整理。导出内容包含容器编号、日期、孔位和关联实验编号。历史版本请从“历史日记”打开后导出。</p><div class="actions"><a href="/api/diary.html" class="button secondary">导出当前日记</a><a href="/api/export.csv" class="button secondary">导出当前 CSV</a></div></div><div class="panel"><span class="eyebrow">DAILY ROUTINE</span><h3>每天 22:00，留下一份当日记录</h3><p class="muted">本地服务运行时，每天北京时间 22:00 自动保存快照与备份。若当天 22:00 后重新启动，会补存当天状态并记录实际保存时间。电脑关机或服务未运行的日期不会补造记录。</p><p class="muted">自动留档不会替你确认实验事实。在“当前培养”核对并保存后，当天会多一份已核对版本。</p></div></div>`;
  const renderWordTemplates = async () => {
    const listEl = $('#word-tpl-list');
    if (!listEl) return;
    try {
      const data = await api('/api/word-templates');
      const items = data.templates || [];
      listEl.innerHTML = items.map(t => `<div class="word-tpl-item" data-tpl-id="${esc(t.id)}">
        <div>
          <strong>${esc(t.name)}</strong>
          <span class="state-badges" style="margin-left:6px">
            ${t.is_default ? '<span class="state-badge is-saved">当前默认导出</span>' : ''}
            <span class="state-badge">${t.builtin ? '内置标准' : (t.mode === 'placeholder' ? '占位符套打' : '结构解析')}</span>
          </span>
          <p>${esc(t.description || t.scope || '')}${!t.builtin && t.sections?.length ? ` · 栏目：${esc(t.sections.map(s => s.title).join(' / '))}` : ''}</p>
        </div>
        <div class="actions">
          <a class="button secondary" href="/api/word-templates/${encodeURIComponent(t.id)}/download">下载 .docx</a>
          ${!t.is_default ? `<button type="button" class="button secondary" data-tpl-set-default="${esc(t.id)}">设为默认</button>` : ''}
          ${!t.builtin ? `<button type="button" class="text-button" data-tpl-del="${esc(t.id)}">删除</button>` : ''}
        </div>
      </div>`).join('') || '<p class="muted">暂无模版</p>';
      listEl.querySelectorAll('[data-tpl-set-default]').forEach(btn => btn.onclick = async () => {
        try {
          await api('/api/word-templates/default', {template_id: btn.dataset.tplSetDefault});
          await renderWordTemplates();
          toast('已切换默认 Word 导出模版');
        } catch (err) { toast(err.message, true); }
      });
      listEl.querySelectorAll('[data-tpl-del]').forEach(btn => btn.onclick = async () => {
        if (!confirm('确认删除该自定义模版？（不会影响已导出的历史 Word 文档）')) return;
        try {
          await api('/api/word-templates/delete', {template_id: btn.dataset.tplDel});
          await renderWordTemplates();
          toast('自定义模版已删除');
        } catch (err) { toast(err.message, true); }
      });
    } catch (err) {
      listEl.innerHTML = `<p class="muted">加载模版失败：${esc(err.message)}</p>`;
    }
  };
  renderWordTemplates();
  const tplUploadForm = $('#word-tpl-upload-form');
  if (tplUploadForm) tplUploadForm.onsubmit = async e => {
    e.preventDefault();
    const fileInput = $('#word-tpl-file');
    const file = fileInput?.files?.[0];
    if (!file) { toast('请先选择一份 .docx 模版文件', true); return; }
    if (!/\.docx$/i.test(file.name) || file.size > 10 * 1024 * 1024) { toast('请选择不超过 10 MiB 的 .docx 文件', true); return; }
    const submitBtn = $('#word-tpl-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '正在解析建档…'; }
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      const res = await api('/api/word-templates/import', {
        name: ($('#word-tpl-name')?.value || '').trim(),
        filename: file.name,
        content_base64: b64,
        set_as_default: Boolean($('#word-tpl-default')?.checked),
      });
      if ($('#word-tpl-name')) $('#word-tpl-name').value = '';
      if (fileInput) fileInput.value = '';
      await renderWordTemplates();
      toast(`模版「${res.template.name}」已建档（${res.template.mode === 'placeholder' ? '占位符套打模式' : `识别 ${res.template.sections.length} 个栏目`}）`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '上传并建档模版'; }
    }
  };
  const openDirBtn = $('#open-backup-dir');
  if (openDirBtn) openDirBtn.onclick = async () => {
    openDirBtn.disabled = true;
    try {
      const res = await api('/api/backup-dir/open', {});
      toast(`已打开备份目录：${res.opened}`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      openDirBtn.disabled = false;
    }
  };
  const editor = $('#backup-dir-editor');
  const dirInput = $('#backup-dir-input');
  const editDirBtn = $('#edit-backup-dir');
  if (editDirBtn && editor) editDirBtn.onclick = () => {
    editor.hidden = !editor.hidden;
    if (!editor.hidden && dirInput) {
      dirInput.value = boot.backup_dir || `${boot.data_dir}/backups`;
      dirInput.focus();
      dirInput.select();
    }
  };
  const cancelDirBtn = $('#cancel-backup-dir');
  if (cancelDirBtn && editor) cancelDirBtn.onclick = () => { editor.hidden = true; };
  const pickDirBtn = $('#pick-backup-dir');
  if (pickDirBtn && dirInput) pickDirBtn.onclick = async () => {
    pickDirBtn.disabled = true;
    const prev = pickDirBtn.textContent;
    pickDirBtn.textContent = '请在系统窗口选择…';
    try {
      const res = await api('/api/backup-dir/pick', {});
      if (!res.cancelled && res.path) {
        dirInput.value = res.path;
        dirInput.focus();
        toast('已选择文件夹，点击“保存备份地址”即可生效');
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      pickDirBtn.disabled = false;
      pickDirBtn.textContent = prev;
    }
  };
  const applyBackupDir = async (payload, okMsg) => {
    if (busy) return;
    busy = true;
    try {
      const res = await api('/api/backup-dir', payload);
      Object.assign(boot, res);
      renderBackup();
      toast(okMsg);
    } catch (error) {
      toast(error.message, true);
    } finally {
      busy = false;
      if (typeof renderUndoControl === 'function') renderUndoControl();
    }
  };
  const saveDirBtn = $('#save-backup-dir');
  if (saveDirBtn && dirInput) saveDirBtn.onclick = () => {
    const val = dirInput.value.trim();
    if (!val) { toast('请输入或选择一个有效的备份目录路径', true); dirInput.focus(); return; }
    applyBackupDir({path: val}, `本地备份地址已更新为：${val}`);
  };
  if (dirInput) dirInput.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); saveDirBtn?.click(); }
    else if (e.key === 'Escape' && editor) { editor.hidden = true; }
  };
  const bindReset = btn => {
    if (!btn) return;
    btn.onclick = () => applyBackupDir({reset: true}, '已恢复默认本地备份目录');
  };
  bindReset($('#reset-backup-dir'));
  bindReset($('#reset-backup-dir-quick'));
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
const moreButton = $('#mobile-more-btn');
const moreSheet = $('#mobile-more-sheet');
function setMoreOpen(open, restoreFocus = true) {
  const wasOpen = !moreSheet.hidden;
  moreSheet.hidden = !open;
  $('#mobile-more-backdrop').hidden = !open;
  moreButton.setAttribute('aria-expanded', String(open));
  if (open) $('#mobile-more-close').focus();
  else if (wasOpen && restoreFocus) moreButton.focus();
}
moreButton.onclick = () => setMoreOpen(moreSheet.hidden);
$('#mobile-more-close').onclick = $('#mobile-more-backdrop').onclick = () => setMoreOpen(false);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !moreSheet.hidden) setMoreOpen(false);
});
matchMedia('(max-width: 680px)').addEventListener('change', () => setMoreOpen(false, false));
document.querySelectorAll('[data-view], [data-mobile-view]').forEach(button => {
  button.onclick = () => { setMoreOpen(false); switchView(button.dataset.view || button.dataset.mobileView); };
});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', {scope: '/'}).catch(() => {});
}
window.addEventListener('offline', () => {
  $('#connection').hidden = false;
  $('#connection').textContent = '网络已断开。页面中的编辑仍保留，请在重新连接工作台后保存。';
});
window.addEventListener('online', () => {
  if (editingOrBusy() || frozen) {
    $('#connection').textContent = '网络已恢复。当前页面已保留，可继续操作。';
    return;
  }
  $('#connection').textContent = '网络已恢复，正在连接工作台。';
  refreshCurrentView();
});
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
async function start(){try{await load();render();if (!boot.mobile_client) setTimeout(() => runUpdateCheck(false), 1500);}catch(error){$('#connection').hidden=false;$('#connection').textContent='未连接到工作台。请检查网络和运行 Lab Note 的电脑，然后刷新页面。';}}
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
    $('#connection').textContent='与工作台的连接已中断。请检查网络和工作台，尚未保存的编辑仍在本页。';
  } finally {
    refreshPending = false;
  }
}
setInterval(refreshCurrentView, 30000);
