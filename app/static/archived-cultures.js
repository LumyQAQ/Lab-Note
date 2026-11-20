'use strict';

// Read the original records, including roots hidden by a manual display group.
// A cleared archived plate still has a row: its journal and transfer receipts
// are the evidence for its former contents, not an invented current cell record.
function archivedCultureEntries(source=state) {
  const owners=new Map();
  for(const group of source?.display_groups||[])for(const id of group.container_ids||[])if(!owners.has(id))owners.set(id,group.name||group.id);
  return (source?.containers||[]).flatMap(container=>{
    const keys=Object.keys(container.wells||{}).filter(key=>container.status==='archived'||container.wells[key].member_status==='archived');
    return container.status==='archived'||keys.length?[{container,keys,group:owners.get(container.id)||''}]:[];
  });
}
function archivedCulturesMarkup(source=state) {
  const entries=archivedCultureEntries(source);
  return `<section class="archived-cultures panel" id="archived-cultures" aria-labelledby="archived-cultures-heading"><div class="archived-cultures-heading"><div><h3 id="archived-cultures-heading">已结束培养</h3><p class="muted">包括刚结束、尚未保存快照的培养，以及显示组内已结束的原始成员。查看记录、日志或流转凭据可追溯原培养。</p></div><span class="pill">${entries.length} 个原始容器</span></div><label class="archived-cultures-search">搜索已结束培养<input type="search" data-archive-search placeholder="名称、原编号、细胞、孔位或显示组…" autocomplete="off"></label><p class="muted archived-cultures-results" data-archive-results aria-live="polite">显示 ${entries.length} 个原始容器</p><div class="archived-cultures-list">${entries.map(({container:c,keys,group})=>{
    const records=keys.map(key=>({key,well:c.wells[key]})),filled=records.filter(({well})=>well.cell);
    const names=[...new Set(filled.flatMap(({well})=>(well.components?.length?well.components:[well]).map(part=>part.cell)).filter(Boolean))];
    const search=[c.id,c.name,c.type,group,...records.flatMap(({key,well})=>[key,well.cell,well.experiment,well.batch,...(well.components||[]).map(part=>part.cell)])].filter(Boolean).join(' ').toLocaleLowerCase();
    return `<article class="archived-culture" data-archive-row="${esc(c.id)}" data-archive-text="${esc(search)}"><div class="archived-culture-title"><div><h4>${esc(c.name||c.id)}</h4><p class="muted">${esc(c.type)} · 原编号 ${esc(c.id)}${group?'<br>显示组：'+esc(group):''}</p></div><span class="pill">${c.status==='archived'?'已结束培养':'部分成员已结束'}</span></div>${filled.length?`<p>保留的培养记录：${esc(names.join(' · '))}</p><p class="muted">${esc(filled.map(({key})=>groupMemberLabel(c,key)+'（'+key+'）').join('、'))}</p>`:'<p class="muted">当前孔位没有细胞内容；如已清空，请查看操作日志或流转凭据。</p>'}<div class="archived-culture-actions"><button type="button" class="button secondary" data-archive-open="${esc(c.id)}" data-archive-keys="${esc(JSON.stringify(keys))}">查看记录</button><button type="button" class="text-button" data-archive-journal="${esc(c.id)}">操作日志</button><button type="button" class="text-button" data-archive-transfers="${esc(c.id)}">流转记录</button></div></article>`;
  }).join('')}</div><p class="muted" data-archive-no-match hidden>没有符合搜索条件的已结束培养。</p>${entries.length?'':'<p class="muted">暂无已结束培养。结束后的记录会保留在这里。</p>'}</section>`;
}
function bindArchivedCultureLinks(root) {
  const section=root.matches?.('.archived-cultures')?root:root.querySelector('.archived-cultures');
  if(!section)return;
  const search=section.querySelector('[data-archive-search]'),rows=[...section.querySelectorAll('[data-archive-row]')];
  search.oninput=()=>{
    const query=search.value.trim().toLocaleLowerCase();let count=0;
    for(const row of rows){row.hidden=!row.dataset.archiveText.includes(query);if(!row.hidden)count++;}
    section.querySelector('[data-archive-results]').textContent=`显示 ${count} / ${rows.length} 个原始容器`;
    section.querySelector('[data-archive-no-match]').hidden=!query||count>0;
  };
  section.querySelectorAll('[data-archive-open]').forEach(button=>button.onclick=()=>openArchivedCulture(button.dataset.archiveOpen,JSON.parse(button.dataset.archiveKeys)));
  section.querySelectorAll('[data-archive-journal]').forEach(button=>button.onclick=()=>openJournal(button.dataset.archiveJournal,{preserveOriginal:true}));
  section.querySelectorAll('[data-archive-transfers]').forEach(button=>button.onclick=()=>openContainerTransfers(button.dataset.archiveTransfers));
}
