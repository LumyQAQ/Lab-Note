'use strict';

// The homepage has its own display filters; opening a record is owned by app.js.
let homeMode = 'containers', homeStatus = 'active';
function homeSavedDensity() {
  try { return window.localStorage?.getItem('lab-culture.home-density') === 'detailed' ? 'detailed' : 'compact'; }
  catch { return 'compact'; }
}
let homeDensity = homeSavedDensity();
function setHomeDensity(density) {
  if(!['compact','detailed'].includes(density))return;
  homeDensity=density;
  try { window.localStorage?.setItem('lab-culture.home-density',density); } catch {}
  renderHome();
}
function homeOccupied(c, includeEnded=false) { return Object.entries(c.wells || {}).filter(([,w]) => (includeEnded||c.status==='archived')?!!w.cell:memberActive(w)); }
function homeActiveSummary(c,source=state) {
  if(c.status!=='active'||!groupType(c.type))return c;
  const originals=c.display_group?(source.containers||[]).filter(item=>c.container_ids.includes(item.id)&&item.status==='active'):[];
  const ids=new Set(originals.map(item=>item.id));
  const wells=Object.fromEntries(Object.entries(c.wells||{}).filter(([key,w])=>w.member_status!=='archived'&&(!c.display_group||ids.has(c.display_members[key]?.container_id))));
  const summary={...c,wells,quantity:Object.keys(wells).length};
  if(c.display_group&&originals.length){
    const types=[...new Set(originals.map(item=>item.type))];
    summary.type=types.length===1?types[0]:'培养组';summary.primary_type=originals[0].type;
    summary.container_ids=originals.map(item=>item.id);summary.location=[...new Set(originals.map(item=>item.location||'未填写位置'))].join(' · ');
  }
  return summary;
}
function homeMemberActive(m) { return m.container.status==='active'&&memberActive(m.well); }
function homeCellNames(wells) {
  return [...new Set(wells.flatMap(w => (w.components?.length ? w.components : [w]).map(p => p.cell)).filter(Boolean))];
}
function homeDay(w) {
  const day = dayOf(w);
  return day === null ? 'Day 未填写' : `${w.components ? '实验 Day' : 'Day'} ${day}`;
}
function homeTreatmentCount(wells) { return wells.reduce((n,w) => n + (w.active_treatments || []).length, 0); }
function homeExperimentGroups(containers) {
  const groups = new Map();
  containers.forEach(c => homeOccupied(c,true).forEach(([key,w]) => {
    const id = w.experiment;
    if (!id || !id.trim()) return;
    if (!groups.has(id)) groups.set(id, {id, members:[]});
    groups.get(id).members.push({container:c, key, well:w});
  }));
  return [...groups.values()];
}
function homePlateMarkup(c,compact=false) {
  const dims = boot.layouts[c.type];
  if (!dims) {
    if(compact){
      const dish=dishType(c.primary_type||c.type),filled=homeOccupied(c).length>0;
      const shape=dish?'<ellipse cx="90" cy="47" rx="57" ry="20"/><path d="M33 47v20c0 11 26 20 57 20s57-9 57-20V47"/><ellipse class="home-vessel-medium" cx="90" cy="61" rx="49" ry="14"/>':'<path d="M111 20l18 13-9 15v35a9 9 0 0 1-9 9H51a9 9 0 0 1-9-9V55a10 10 0 0 1 5-9l53-27z"/><path class="home-vessel-medium" d="M49 65h64v18a3 3 0 0 1-3 3H52a3 3 0 0 1-3-3z"/><path d="M114 14l22 16-7 10-22-16z"/>';
      return `<div class="home-vessel home-vessel-compact"><button type="button" class="home-vessel-unit ${filled?'filled':''}" data-home-vessel="${esc(c.id)}" aria-label="打开 ${esc(c.name)} ${esc(groupTypeLabel(c))} 全组记录"><svg viewBox="0 0 180 110" role="img" aria-label="${esc(groupTypeLabel(c))}">${shape}</svg><span class="home-vessel-brief"><strong>${filled||c.status!=='active'?'打开培养记录 ↗':'填写细胞记录 ↗'}</strong><small class="home-vessel-count">${esc(groupTypeLabel(c))}${groupQuantity(c)>1?' · '+groupCounts(c).active+'/'+groupQuantity(c)+' 在培养':''}</small></span></button></div>`;
    }
    const wells=homeOccupied(c).map(([,w])=>w),days=[...new Set(wells.map(homeDay))];
    return `<div class="home-vessel"><button type="button" class="home-vessel-unit ${wells.length?'filled':''}" data-home-vessel="${esc(c.id)}" aria-label="打开 ${esc(c.name)} ${esc(groupTypeLabel(c))} 全组记录"><span>${esc(groupTypeLabel(c))}</span><strong>${esc(homeCellNames(wells).join(' · ') || '尚未填写细胞')}</strong><small>${esc(days.join(' / ') || '点击填写培养记录')} ↗</small></button></div>`;
  }
  const [rows,cols] = dims;
  let html = `<div class="home-mini-plate ${cols>=8?'dense':''}" style="--home-cols:${cols}" aria-label="${esc(c.name)}：${rows} 行 ${cols} 列孔板"><span></span>`;
  for (let col=1;col<=cols;col++) html += `<span class="home-axis">${col}</span>`;
  for (let row=0;row<rows;row++) {
    const letter = String.fromCharCode(65+row);
    html += `<span class="home-axis">${letter}</span>`;
    for(let col=1;col<=cols;col++) {
      const key=letter+col, w=c.wells[key] || {};
      const title=`${key} · ${homeCellNames([w]).join(' · ') || '空孔'}${w.cell?' · '+homeDay(w):''}`;
      html += `<button type="button" class="home-mini-well ${w.cell?'filled':''}" data-home-container="${esc(c.id)}" data-home-well="${key}" title="${esc(title)}" aria-label="${esc(title)}"><span>${key}</span></button>`;
    }
  }
  return html + '</div>';
}
function homeActionEnabled(c) {
  return c?.status==='active'&&homeOccupied(c).length>0&&!(typeof busy!=='undefined'&&busy)&&!(typeof frozen!=='undefined'&&frozen);
}
function homeActionsMarkup(c) {
  const disabled=!homeActionEnabled(c),checked=c.checked_date===boot.today;
  return `<div class="home-card-actions" role="group" aria-label="${esc(c.name)} 今日操作">${[['topup','补液','记录补液并核对'],['medium','换液','记录换液或半换液并核对'],['no_operation','未操作','未操作，确认今日核对'],['experiment','实验','打开传代 / 开展实验操作面板']].map(([action,label,title])=>`<button type="button" data-home-action="${action}" data-home-container-id="${esc(c.id)}" title="${esc(title)}" aria-label="${esc(c.name)}：${esc(title)}" ${action==='medium'?'aria-expanded="false"':''} ${disabled||(checked&&action==='no_operation')?'disabled':''}>${label}</button>`).join('')}</div><div class="home-medium-options" data-home-medium-options="${esc(c.id)}" hidden>${[['full','换液'],['half','半换液']].map(([kind,label])=>`<button type="button" data-home-medium="${kind}" data-home-container-id="${esc(c.id)}" ${disabled?'disabled':''}>${label}</button>`).join('')}</div>`;
}
function openHomeCellOperation(id){
  const c=displayContainers().find(c=>c.id===id);
  if(!homeActionEnabled(c)||busy||frozen)return;
  if(dirty){toast('请先保存当前修改，再开展实验。',true);return;}
  if(typeof modalOpen==='function'&&modalOpen())return;
  openHomeTarget(c.id,homeOccupied(c).map(([key])=>key));
  openTransfer();
  if(!transferDraft)return;
  transferDraft.homeReview={id:c.id,name:c.name};transferDraft.confirmHomeReview=true;
  switchTransferMode('assay');view='home';render();
}
function bindHomeActions(root) {
  root.querySelectorAll('[data-home-action]').forEach(button=>button.onclick=()=>{
    const c=displayContainers().find(c=>c.id===button.dataset.homeContainerId);
    if(!homeActionEnabled(c))return;
    if(button.dataset.homeAction==='topup')return openQuickMedium(c.id,'topup','all');
    if(button.dataset.homeAction==='experiment')return openHomeCellOperation(c.id);
    if(button.dataset.homeAction==='no_operation')return confirmCultureToday(c.id,'no_operation');
    if(typeof dirty!=='undefined'&&dirty){toast('请先保存当前修改，再记录换液。',true);return;}
    const panel=button.closest('.home-container').querySelector('[data-home-medium-options]'),open=panel.hidden;
    root.querySelectorAll('[data-home-medium-options]').forEach(item=>item.hidden=true);
    root.querySelectorAll('[data-home-action="medium"]').forEach(item=>item.setAttribute('aria-expanded','false'));
    panel.hidden=!open;button.setAttribute('aria-expanded',String(open));
  });
  root.querySelectorAll('[data-home-medium]').forEach(button=>button.onclick=()=>{
    const c=displayContainers().find(c=>c.id===button.dataset.homeContainerId);
    if(!homeActionEnabled(c))return;
    openQuickMedium(c.id,button.dataset.homeMedium,'all');
  });
}
function homeContainerMarkup(c) {
  const original=c;
  c=homeActiveSummary(c);
  const occupied = homeOccupied(c), wells = occupied.map(([,w]) => w);
  const checked = c.checked_date === boot.today, active = c.status === 'active';
  const compact=homeDensity==='compact';
  const heading=`<header><div>${compact?'':`<span class="home-type">${esc(groupTypeLabel(c))}</span>`}<h3><button type="button" class="home-name" data-home-open="${esc(c.id)}" aria-label="打开 ${esc(c.name)} 的培养记录">${esc(c.name)}</button></h3></div><span class="home-status ${active&&checked?'checked':''}">${!active?'已结束':checked?'今日已核对':'今日待核对'}</span></header>`;
  if(compact){
    const cells=homeCellNames(wells),days=[...new Set(wells.map(homeDay))];
    const bases=[...new Set(wells.map(w=>w.medium?.base).filter(Boolean))];
    if(!bases.length&&c.medium_defaults?.base)bases.push(c.medium_defaults.base);
    const scope=boot.layouts[c.type]?`${occupied.length}/${Object.keys(c.wells||{}).length} 孔`:(groupQuantity(c)>1?`${groupCounts(c).active}/${groupQuantity(c)} 在培养`:'');
    const secondary=[c.location||'未填写位置',bases.slice(0,2).join(' / '),scope].filter(Boolean).join(' · ');
    const compactMeta=`<div class="home-compact-meta"><p class="home-compact-primary"><span class="home-compact-type">${esc(groupTypeLabel(c))}</span><strong>${esc(cells.join(' · ')||'尚未填写细胞')}</strong>${days.length?`<span class="home-compact-day">${esc(days.slice(0,2).join(' / '))}</span>`:''}</p><p class="home-compact-secondary">${esc(secondary)}</p></div>`;
    const emptyPlateCta=active&&boot.layouts[c.type]&&!occupied.length?`<button type="button" class="home-empty-cta" data-home-open="${esc(c.id)}">填写细胞记录 ↗</button>`:'';
    return `<article class="home-container home-container-compact">${heading}${compactMeta}${homePlateMarkup(c,true)}${emptyPlateCta}${homeActionsMarkup(c)}</article>`;
  }
  const days = [...new Set(wells.map(homeDay))];
  const descriptions=[...new Set(wells.map(w=>w.treatment).filter(Boolean))];
  const lastOperation=(boot.workday?.timeline||[]).find(e=>!e.undone&&e.is_operation&&(e.container_ids||[]).some(id=>id===c.id||c.container_ids?.includes(id)));
  const latestCount=occupied.filter(([,w])=>w.cell_count).sort((a,b)=>b[1].cell_count.measured_at.localeCompare(a[1].cell_count.measured_at))[0];
  return `<article class="home-container">${heading}<p class="home-location">${esc(c.location || '未填写位置')}</p><p class="home-cells">${esc(homeCellNames(wells).join(' · ') || '尚未填写细胞')}</p><p class="home-days">${esc(days.join(' / ') || 'Day —')}</p>${homePlateMarkup(c)}${groupQuantity(c)>1?`<p class="home-record-note group-status-summary">${groupCounts(c).active} 在培养${c.status==='active'?'':' · '+groupCounts(c).ended+' 已结束'}${groupCounts(c).empty?` · ${groupCounts(c).empty} 待填写`:""}</p>${groupDifferenceSummary(c)?`<p class="home-record-note group-differences">${esc(groupDifferenceSummary(c))}</p>`:""}`:""}${descriptions.length?`<p class="home-record-note">处理说明：${esc(descriptions.join('；'))}</p>`:''}${lastOperation?`<p class="home-record-note">今日最近：${esc(lastOperation.title)} · ${esc(lastOperation.occurred_at.slice(11,16))}</p>`:''}${latestCount?`<p class="home-record-note" title="${esc(countSummary(latestCount[1].cell_count))}">最近计数 / ${esc(groupMemberLabel(original,latestCount[0]))}${groupType(c.type)?"（每瓶 / 皿）":""}：${esc(countSummary(latestCount[1].cell_count))}</p>`:''}<div class="home-card-meta"><span>${occupied.length} / ${Object.keys(c.wells || {}).length} 已填写</span><span>${active?homeTreatmentCount(wells):0} 项持续处理</span></div><button type="button" class="home-open" data-home-open="${esc(c.id)}">${active?'打开培养记录':'查看已结束记录'} <span aria-hidden="true">↗</span></button>${homeActionsMarkup(c)}</article>`;
}
function homeExperimentMarkup(group) {
  const vessels = [...new Map(group.members.map(m => [m.container.id,m.container])).values()];
  const active = vessels.filter(c => group.members.some(m=>m.container.id===c.id&&homeMemberActive(m))).length;
  return `<article class="home-experiment"><div class="home-experiment-head"><div><span class="home-type">关联实验编号</span><h3>${esc(group.id)}</h3></div><span class="home-status ${active?'checked':''}">${active?'相关培养进行中':'相关培养均已结束'}</span></div><p class="home-cells">${esc(homeCellNames(group.members.map(m => m.well)).join(' · '))}</p><p class="home-experiment-count">${vessels.length} 个容器 · ${group.members.length} 个培养单元 <span>${active} 个在培养${homeStatus==='active'?'':' / '+(vessels.length-active)+' 个已结束'}</span></p><div class="home-members">${vessels.map(c => {
    const members=group.members.filter(m => m.container.id === c.id);
    return `<button type="button" data-home-member="${esc(c.id)}" data-home-experiment="${esc(group.id)}"><strong>${esc(c.name)}</strong><span>${esc(members.map(m => groupMemberLabel(c,m.key)).join(' · '))}</span><small>${esc(groupTypeLabel(homeStatus==='active'?homeActiveSummary(c):c))} · ${members.some(homeMemberActive)?'在培养':'已结束'} ↗</small></button>`;
  }).join('')}</div><button type="button" class="home-open" data-home-group="${esc(group.id)}">打开实验相关记录 <span aria-hidden="true">↗</span></button></article>`;
}
function renderHome() {
  const compact=homeDensity==='compact';
  const all = displayContainers(), active = all.filter(c => c.status === 'active');
  const checked = active.filter(c => c.checked_date === boot.today).length, pending = active.length - checked;
  const cells = homeCellNames(active.flatMap(c => homeOccupied(c).map(([,w]) => w)));
  const groups = homeExperimentGroups(all), activeGroups = groups.filter(g => g.members.some(homeMemberActive));
  const containers = sortCulturesByCheck(all.filter(c => homeStatus === 'all' || c.status === homeStatus));
  const visibleGroups = groups.map(g=>homeStatus==='active'?{...g,members:g.members.filter(homeMemberActive)}:g).filter(g => g.members.length&&(homeStatus === 'all' || (homeStatus === 'active' ? g.members.some(homeMemberActive) : g.members.every(m => !homeMemberActive(m)))));
  const list = homeMode === 'containers' ? containers : visibleGroups;
  $('#content').innerHTML = `<section class="home-page ${compact?'home-page-compact':''}"><div class="home-heading"><div>${compact?'':'<span class="eyebrow">CULTURE OVERVIEW</span>'}<h2>培养与实验总览</h2>${compact?'':'<p>查看当前记录，点击容器或孔位继续填写。</p>'}</div><div class="actions"><button type="button" class="button secondary" id="home-merge">手动合并培养组</button><button type="button" class="button secondary" id="home-work">今日工作 ↗</button><button type="button" class="button primary" id="home-create">＋ 新增容器</button></div></div>${compact?'':`<div class="home-summary"><div><strong>${active.length}</strong><span>在培养容器</span></div><div><strong>${cells.length}</strong><span>细胞名称 · 当前培养</span></div><div><strong>${activeGroups.length}</strong><span>有关联培养的实验</span></div><div class="home-check"><div><span>今日核对</span><b>${checked} / ${active.length}</b></div><div class="home-check-track" role="img" aria-label="今日已核对 ${checked} 个容器，待核对 ${pending} 个容器"><i style="width:${active.length?checked/active.length*100:0}%"></i></div><small>${active.length?`${pending} 个容器待核对`:'暂无在培养容器'}</small></div></div>`}<div class="home-toolbar"><div class="home-tabs" role="group" aria-label="总览方式"><button type="button" data-home-mode="containers" aria-pressed="${homeMode==='containers'}">细胞与容器</button><button type="button" data-home-mode="experiments" aria-pressed="${homeMode==='experiments'}">实验分组</button></div><div class="home-toolbar-options"><div class="home-tabs home-density" role="group" aria-label="首页信息密度">${[['compact','精简版'],['detailed','详细版']].map(([density,label])=>`<button type="button" data-home-density="${density}" aria-pressed="${homeDensity===density}">${label}</button>`).join('')}</div><label class="home-filter">显示<select id="home-status" aria-label="首页培养状态筛选"><option value="active" ${homeStatus==='active'?'selected':''}>${homeMode==='experiments'?'有培养进行中':'在培养'}</option><option value="archived" ${homeStatus==='archived'?'selected':''}>${homeMode==='experiments'?'相关培养均已结束':'已结束'}</option><option value="all" ${homeStatus==='all'?'selected':''}>全部</option></select></label></div></div>${compact?'':`<p class="home-caption">${homeMode==='containers'?'同组瓶皿汇总显示，打开后默认选择所有在培养成员；孔板圆点对应真实孔位。':'按已填写的实验编号分组，汇总相关容器与孔位；进行状态来自相关培养单元的状态。'}</p>`}${list.length?`<div class="${homeMode==='containers'?'home-container-grid':'home-experiment-grid'}">${homeMode==='containers'?containers.map(homeContainerMarkup).join(''):visibleGroups.map(homeExperimentMarkup).join('')}</div>`:`<div class="home-empty"><h3>${!all.length?'从第一个培养容器开始':homeMode==='experiments'?'暂无符合条件的实验分组':'暂无符合条件的培养容器'}</h3><p>${!all.length?'新增培养瓶或孔板，填写后即可在首页查看细胞与培养记录。':homeMode==='experiments'?'可在培养记录中填写“关联实验编号”，相关细胞将归入同一实验。':'可以切换显示范围，查看已保存的其他容器。'}</p>${!all.length?'<button type="button" class="button primary" id="home-first">＋ 新增容器</button>':''}</div>`}</section>`;
  if(!compact&&typeof labOverviewMarkup==='function'){$('.home-toolbar').insertAdjacentHTML('beforebegin',labOverviewMarkup());bindLabOverview($('#content'));}
  bindHomeActions($('#content'));
  document.querySelectorAll('[data-home-density]').forEach(button=>button.onclick=()=>setHomeDensity(button.dataset.homeDensity));
  $('#home-create').onclick = showCreate;
  $('#home-merge').onclick = () => openManualGroup();
  if ($('#home-first')) $('#home-first').onclick = showCreate;
  $('#home-work').onclick = () => switchView('work');
  $('#home-status').onchange = e => { homeStatus=e.target.value;renderHome(); };
  document.querySelectorAll('[data-home-mode]').forEach(b => b.onclick = () => { homeMode=b.dataset.homeMode;renderHome(); });
  document.querySelectorAll('[data-home-well]').forEach(b => b.onclick = () => openHomeTarget(b.dataset.homeContainer,[b.dataset.homeWell]));
  document.querySelectorAll('[data-home-vessel]').forEach(b=>b.onclick=()=>{const c=all.find(c=>c.id===b.dataset.homeVessel);openHomeTarget(c.id,groupDefaultSelection(c));});
  document.querySelectorAll('[data-home-open]').forEach(b => b.onclick = () => {
    const c=all.find(c => c.id === b.dataset.homeOpen);
    openHomeTarget(c.id,groupType(c.type)?groupDefaultSelection(c):homeOccupied(c).map(([key]) => key));
  });
  document.querySelectorAll('[data-home-group]').forEach(b => b.onclick = () => openHomeExperiment(b.dataset.homeGroup));
  document.querySelectorAll('[data-home-member]').forEach(b => b.onclick = () => {
    const group=groups.find(g => g.id === b.dataset.homeExperiment);
    const members=group.members.filter(m=>m.container.id===b.dataset.homeMember),active=members.filter(homeMemberActive);
    openHomeTarget(b.dataset.homeMember,(active.length?active:members).map(m=>m.key));
  });
}
