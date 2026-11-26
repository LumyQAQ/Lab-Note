'use strict';

const cryoUi = {
  tab: 'map',
  boxId: '',
  selectedSlots: new Set(),
  query: '',
  kindFilter: '',
  cellFilter: '',
  treatmentFilter: '',
  batchStageFilter: 'all',
  mode: null, // null | {type:'place', lotId, picks:[{box_id,slot}]} | {type:'move', from:[{box_id,slot,batch_id}], picks:[{box_id,slot}]}
};

const CRYO_DEVICE_LABELS = {ln2: '液氮罐', minus80: '-80°C 冰箱', custom: '自定义设备'};
const CRYO_SUPERSCRIPTS = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻','+':'⁺'};

function cryoStorage() {
  const s = state?.cryo_storage;
  return {devices: s?.devices || [], racks: s?.racks || [], boxes: s?.boxes || []};
}
function cryoSlotKeys(box) {
  if (!box) return [];
  const rows = Number(box.rows) || 0, cols = Number(box.cols) || 0;
  if (box.numbering === 'numeric') return Array.from({length: rows * cols}, (_, i) => String(i + 1));
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(String.fromCharCode(65 + r) + (c + 1));
  return out;
}
function cryoBoxLabel(box) {
  const cs = cryoStorage();
  const dev = cs.devices.find(d => d.id === box.device_id);
  const rack = box.rack_id ? cs.racks.find(r => r.id === box.rack_id) : null;
  return [dev?.name || '未知设备', rack?.name, box.name].filter(Boolean).join(' / ');
}
function cryoBatchRemaining(lot) {
  return lot.vials - (state.frozen_withdrawals || []).filter(w => w.lot_id === lot.id).reduce((n, w) => n + w.vials, 0);
}
function cryoBatchPlacedSlots(lotId) {
  const cs = cryoStorage(), out = [];
  for (const box of cs.boxes) {
    const keys = cryoSlotKeys(box);
    for (const k of keys) {
      const entry = box.slots?.[k];
      if (entry && entry.batch_id === lotId) out.push({box, slot: k, entry});
    }
  }
  return out;
}
function cryoBatchUnplaced(lot) {
  return Math.max(0, cryoBatchRemaining(lot) - cryoBatchPlacedSlots(lot.id).length);
}
function cryoFormatCount(lot) {
  const c = lot?.per_vial_count;
  if (c && c.coefficient) {
    const sup = String(c.exponent ?? '').replace(/[0-9+-]/g, ch => CRYO_SUPERSCRIPTS[ch] || ch);
    return `${c.coefficient} × 10${sup} ${c.unit || 'cells'}`;
  }
  return lot?.per_vial || '';
}
function cryoNormCell(lot) { return String(lot?.name || '').trim().toLowerCase(); }
function cryoNormTreatments(lot) {
  return [...new Set((lot?.special_treatments || []).map(t => String(t || '').trim().toLowerCase()).filter(Boolean))].sort();
}
function cryoDonorCompatible(a, b) {
  const da = String(a?.donor || '').trim().toLowerCase(), db = String(b?.donor || '').trim().toLowerCase();
  return !da || !db || da === db;
}
function cryoRelationTier(anchor, other) {
  if (!cryoNormCell(anchor) || cryoNormCell(anchor) !== cryoNormCell(other)) return null;
  if (!cryoDonorCompatible(anchor, other)) return null;
  const txA = cryoNormTreatments(anchor).join('\x00'), txB = cryoNormTreatments(other).join('\x00');
  if (txA === txB && String(anchor.at || '').slice(0, 10) === String(other.at || '').slice(0, 10)) return 'strong';
  if (txA === txB) return 'weak';
  return 'weaker';
}
function cryoRelatedGroups(lotId) {
  const lots = state?.frozen_batches || [];
  const anchor = lots.find(b => b.id === lotId);
  const groups = {strong: [], weak: [], weaker: []};
  if (!anchor) return groups;
  for (const other of lots) {
    const tier = other.id === anchor.id ? 'strong' : cryoRelationTier(anchor, other);
    if (!tier) continue;
    groups[tier].push({lot: other, remaining: cryoBatchRemaining(other), placed: cryoBatchPlacedSlots(other.id)});
  }
  for (const key of ['strong', 'weak', 'weaker']) {
    groups[key].sort((a, b) => (a.lot.id === anchor.id ? -1 : b.lot.id === anchor.id ? 1 : (b.lot.at || '').localeCompare(a.lot.at || '')));
  }
  return groups;
}
function cryoContaminationMap() {
  const lots = state?.frozen_batches || [];
  const byId = new Map(lots.map(b => [b.id, b]));
  const events = (state?.frozen_withdrawals || []).filter(w => w.contamination && typeof w.contamination === 'object');
  const map = new Map(lots.map(b => [b.id, {level: 'none', hits: 0, events: []}]));
  for (const w of events) {
    const src = byId.get(w.lot_id);
    if (!src) continue;
    const srcCell = cryoNormCell(src), srcAt = src.at || '';
    for (const b of lots) {
      const isStrong = b.id === src.id || cryoRelationTier(src, b) === 'strong';
      const isLaterSame = !!srcCell && cryoNormCell(b) === srcCell && cryoDonorCompatible(src, b) && (b.at || '') > srcAt;
      if (!isStrong && !isLaterSame) continue;
      const info = map.get(b.id);
      info.hits += 1;
      info.events.push({
        withdrawalId: w.id, sourceLotId: src.id, sourceName: src.name, sourceAt: srcAt,
        contamination: w.contamination, reason: isStrong ? '同批次 / 强相关复苏污染' : '冻存时间靠后的同类型细胞风险'
      });
    }
  }
  for (const info of map.values()) {
    if (info.hits >= 2) info.level = 'red';
    else if (info.hits === 1) info.level = 'yellow';
  }
  return map;
}
function cryoGradientSummary() {
  const todayMs = Date.parse((boot?.today || localMinute().slice(0, 10)) + 'T00:00:00Z');
  const items = [];
  for (const lot of state?.frozen_batches || []) {
    const unplaced = cryoBatchUnplaced(lot);
    if (lot.storage_stage === 'gradient' && unplaced > 0) {
      const entered = (lot.gradient_entered_at || lot.at || '').slice(0, 10);
      const days = entered ? Math.max(0, Math.round((todayMs - Date.parse(entered + 'T00:00:00Z')) / 86400000)) : 0;
      items.push({lot, unplaced, days});
    }
  }
  items.sort((a, b) => (b.lot.at || '').localeCompare(a.lot.at || ''));
  return {batches: items, totalVials: items.reduce((s, x) => s + x.unplaced, 0)};
}
const CRYO_TONE_COUNT = 8;
function cryoLotToneKey(lot) {
  if (!lot) return '';
  const res = [...new Set((lot.resistance_tags || []).map(x => String(x || '').trim().toLowerCase()).filter(Boolean))].sort().join('\x1f');
  const tx = cryoNormTreatments(lot).join('\x1f');
  const cnt = lot.per_vial_count?.coefficient
    ? `${lot.per_vial_count.coefficient}e${lot.per_vial_count.exponent}${lot.per_vial_count.unit || 'cells'}`
    : String(lot.per_vial || '').trim().toLowerCase();
  return [
    cryoNormCell(lot),
    cryoBatchKind(lot).toLowerCase(),
    tx,
    res,
    String(lot.at || '').slice(0, 10),
    String(lot.passage || '').trim().toLowerCase(),
    String(lot.donor || '').trim().toLowerCase(),
    String(lot.suggested_vessel || '').trim().toLowerCase(),
    cnt,
    String(lot.notes || '').trim().toLowerCase()
  ].join('|');
}
function cryoToneMapForLots(lots) {
  const map = new Map();
  const ordered = [...(lots || [])].sort((a, b) =>
    (a.recorded_at || a.at || '').localeCompare(b.recorded_at || b.at || '') || (a.id || '').localeCompare(b.id || '')
  );
  let idx = 0;
  for (const lot of ordered) {
    const key = cryoLotToneKey(lot);
    if (!map.has(key)) map.set(key, (idx++) % CRYO_TONE_COUNT);
  }
  return map;
}
function cryoHistoryCells() {
  const seen = new Map();
  const add = v => {
    const t = String(v || '').trim();
    if (!t) return;
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  };
  for (const lot of state?.frozen_batches || []) add(lot.name);
  for (const c of state?.containers || []) {
    for (const w of Object.values(c.wells || {})) {
      if ((w.components && w.components.length > 1) || w.assay_contents) continue;
      add(w.cell);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
function cryoHistoryKinds() {
  const seen = new Map();
  const add = v => { const t = String(v || '').trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); };
  add('细胞系'); add('原代细胞');
  for (const lot of state?.frozen_batches || []) add(cryoBatchKind(lot));
  return [...seen.values()];
}
function cryoHistoryTreatments() {
  const seen = new Map();
  const add = v => { const t = String(v || '').trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); };
  for (const lot of state?.frozen_batches || []) for (const tx of lot.special_treatments || []) add(tx);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
function cryoTreatmentRowHtml(val, listId) {
  return `<div class="cryo-tx-row" data-tx-row><input type="text" name="special_treatment_item" aria-label="特殊处理" maxlength="80" list="${esc(listId)}" value="${esc(val)}" placeholder="填写一项已记录的处理"><button type="button" class="cryo-tx-remove" data-tx-remove aria-label="移除此项">×</button></div>`;
}
function cryoTreatmentRowsMarkup(values = [], listId = 'cryo-tx-list') {
  const items = Array.isArray(values) && values.length ? values : [''];
  const history = cryoHistoryTreatments();
  return `<div class="cryo-tx-field" data-tx-group data-tx-list-id="${esc(listId)}">
    <span class="cryo-tx-field-label">特殊处理 / 修饰标注（可选，每行填写一项）</span>
    <div class="cryo-tx-list" data-tx-list>${items.map(v => cryoTreatmentRowHtml(v, listId)).join('')}</div>
    <button type="button" class="text-button cryo-tx-add" data-tx-add>＋ 添加一项特殊处理</button>
    <datalist id="${esc(listId)}">${history.map(tx => `<option value="${esc(tx)}">`).join('')}</datalist>
  </div>`;
}
function cryoBindTreatmentRows(root) {
  root.querySelectorAll('[data-tx-group]').forEach(group => {
    const list = group.querySelector('[data-tx-list]');
    const listId = group.dataset.txListId || 'cryo-tx-list';
    list.onclick = event => {
      const remove = event.target.closest('[data-tx-remove]');
      if (remove) {
        remove.closest('[data-tx-row]').remove();
        list.dispatchEvent(new Event('input', {bubbles: true}));
      }
    };
    const addBtn = group.querySelector('[data-tx-add]');
    if (addBtn) addBtn.onclick = () => {
      list.insertAdjacentHTML('beforeend', cryoTreatmentRowHtml('', listId));
      [...list.querySelectorAll('input[name="special_treatment_item"]')].at(-1)?.focus?.();
    };
  });
}
function cryoReadTreatmentRows(root) {
  const inputs = [...root.querySelectorAll('input[name="special_treatment_item"]')];
  if (!inputs.length) {
    const single = root.querySelector('[name="special_treatments"]');
    return single ? cryoParseTreatmentsInput(single.value) : [];
  }
  const out = [], seen = new Set();
  for (const inp of inputs) {
    for (const part of cryoParseTreatmentsInput(inp.value)) {
      const key = part.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(part); }
    }
  }
  return out;
}
function cryoHistoryResistance() {
  const seen = new Set(), out = [];
  const add = raw => {
    const t = String(raw || '').trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  };
  for (const b of state?.frozen_batches || []) (b.resistance_tags || []).forEach(add);
  return out;
}
function cryoResistanceMarkup(selected = []) {
  const selNorm = new Set((selected || []).map(x => String(x || '').trim().toLowerCase()).filter(Boolean));
  const options = cryoHistoryResistance();
  for (const raw of selected || []) {
    const t = String(raw || '').trim();
    if (t && !options.some(o => o.toLowerCase() === t.toLowerCase())) options.push(t);
  }
  return `<div class="cryo-res-field" data-res-group>
    <span class="cryo-tx-field-label">抗性标签（可选，点击选择或自定义添加）</span>
    <div class="cryo-res-pills" data-res-pills>
      ${options.map(tag => `<button type="button" class="cryo-res-pill" data-res-pill="${esc(tag)}" aria-pressed="${selNorm.has(tag.toLowerCase())}">${esc(tag)}</button>`).join('')}
    </div>
    <div class="cryo-res-custom">
      <input type="text" data-res-input aria-label="抗性标签" maxlength="60" placeholder="填写已记录的抗性标签">
      <button type="button" class="button secondary" data-res-add>＋ 添加</button>
    </div>
  </div>`;
}
function cryoBindResistance(root, onChange = null) {
  root.querySelectorAll('[data-res-group]').forEach(group => {
    const pillsWrap = group.querySelector('[data-res-pills]');
    const input = group.querySelector('[data-res-input]');
    const addBtn = group.querySelector('[data-res-add]');
    const bindPill = btn => {
      btn.onclick = () => {
        btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        onChange?.();
      };
    };
    pillsWrap.querySelectorAll('[data-res-pill]').forEach(bindPill);
    const addCustom = () => {
      const parts = cryoParseTreatmentsInput(input?.value || '');
      if (!parts.length) return;
      for (const part of parts) {
        const key = part.toLowerCase();
        let existing = [...pillsWrap.querySelectorAll('[data-res-pill]')].find(b => b.dataset.resPill.toLowerCase() === key);
        if (existing) {
          existing.setAttribute('aria-pressed', 'true');
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cryo-res-pill';
          btn.dataset.resPill = part;
          btn.setAttribute('aria-pressed', 'true');
          btn.textContent = part;
          bindPill(btn);
          pillsWrap.appendChild(btn);
        }
      }
      input.value = '';
      onChange?.();
    };
    if (addBtn) addBtn.onclick = addCustom;
    if (input) input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } };
  });
}
function cryoReadResistance(root) {
  const out = [], seen = new Set();
  const push = raw => {
    const t = String(raw || '').trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  };
  root.querySelectorAll('[data-res-pill][aria-pressed="true"]').forEach(b => push(b.dataset.resPill));
  root.querySelectorAll('[data-res-input]').forEach(inp => cryoParseTreatmentsInput(inp.value).forEach(push));
  return out;
}
function cryoLinkedExperiments(lot) {
  const records = state?.lab_records || [];
  if (!lot || !records.length) return [];
  const explicit = new Map((lot.experiment_refs || []).map(ref => [ref.id, ref]));
  const lineageWells = new Set((lot.sources || []).map(s => `${s.id}|${s.well}`));
  for (const w of (state?.frozen_withdrawals || [])) {
    if (w.lot_id === lot.id && w.destination?.container_id && w.destination?.well) {
      lineageWells.add(`${w.destination.container_id}|${w.destination.well}`);
    }
  }
  const hits = [];
  for (const rec of records) {
    const ref = explicit.get(rec.id);
    if (ref) {
      hits.push({rec, reason: ref.version ? `登记时 v${ref.version}` : '登记时关联', priority: 0});
    } else if (labObservedSources(rec).some(s => lineageWells.has(`${s.container_id}|${s.well}`))) {
      hits.push({rec, reason: '关联同一培养单元', priority: 1});
    }
  }
  hits.sort((a, b) => a.priority - b.priority || (b.rec.record_date || '').localeCompare(a.rec.record_date || ''));
  return hits;
}
function cryoSuggestedVesselMarkup(selectedValue = '') {
  const types = boot?.types || ['T25', 'T75', 'T175', '培养皿', '6孔板', '12孔板', '24孔板', '48孔板', '96孔板'];
  const isCustom = !!selectedValue && !types.includes(selectedValue);
  return `<label>复苏容器备注（可选）<select name="suggested_vessel_select">
    <option value="">不限 / 未指定</option>
    ${types.map(t => `<option value="${esc(t)}" ${selectedValue === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
    <option value="__custom__" ${isCustom ? 'selected' : ''}>其他（自定义填写）</option>
  </select></label>
  <label data-custom-vessel ${isCustom ? '' : 'hidden'}>自定义铺板容器说明<input name="suggested_vessel_custom" maxlength="120" value="${esc(isCustom ? selectedValue : '')}" placeholder="填写容器说明"></label>`;
}
function cryoReadSuggestedVessel(form) {
  const sel = form.elements.namedItem('suggested_vessel_select')?.value || '';
  if (sel === '__custom__') return (form.elements.namedItem('suggested_vessel_custom')?.value || '').trim();
  return sel;
}
function cryoBindSuggestedVessel(form) {
  const sel = form.elements.namedItem('suggested_vessel_select'), wrap = form.querySelector('[data-custom-vessel]');
  if (sel && wrap) sel.onchange = () => { wrap.hidden = sel.value !== '__custom__'; };
}
function cryoSciCountMarkup(countObj, legacyText = '') {
  return `<div class="cryo-sci-row">
    <label>每管细胞数（科学计数法，可选）<input name="count_coeff" inputmode="decimal" value="${esc(countObj?.coefficient || '')}" placeholder="如 5"></label>
    <span class="cryo-sci-x">× 10^</span>
    <label>指数<input name="count_exp" inputmode="numeric" value="${esc(countObj?.exponent ?? (countObj?.coefficient ? '6' : ''))}" placeholder="6"></label>
    <label>单位${unitChoice(`<input name="count_unit" maxlength="100" value="${esc(countObj?.unit || 'cells')}" placeholder="cells">`, ['cells', 'cells/vial', '个/管'], '每管计数单位')}</label>
  </div>${!countObj?.coefficient && legacyText ? `<p class="muted">原纯文本记录：${esc(legacyText)}</p>` : ''}`;
}
function cryoSourceMarkup() {
  const options = (state.containers || []).flatMap(c => Object.entries(c.wells || {})
    .filter(([, well]) => well.cell)
    .map(([key, well]) => `<option value="${esc(JSON.stringify({id: c.id, well: key}))}">${esc([c.name, key, well.cell].join(' / '))}</option>`));
  return options.length ? `<label>关联培养来源（可选）<select name="cryo_source">
    <option value="">未关联</option>${options.join('')}</select></label>` : '';
}

function cryoLinkedBatches(id, well) {
  return (state.frozen_batches || []).filter(lot => (lot.sources || []).some(s => s.id === id && s.well === well));
}

function openCryoLinkedLots(id, well) {
  const dialog = cryoDialog(), lots = cryoLinkedBatches(id, well);
  if (!lots.length) return toast('该培养单元没有关联的冻存批次。');
  dialog.innerHTML = `<div class="dialog-head"><h2>关联冻存批次</h2><button type="button" data-cryo-close aria-label="关闭">×</button></div>
    ${lots.map(lot => `<section class="panel"><strong>${esc(lot.name)}</strong>
    <p>${esc(lot.at.replace('T', ' '))} · 剩余 ${cryoBatchRemaining(lot)} 管 · ${esc(lot.location || '未定位')}</p>
    ${cryoBatchRemaining(lot) > 0 ? `<button type="button" class="button danger" data-linked-discard="${esc(lot.id)}">登记污染弃置</button>` : ''}</section>`).join('')}`;
  dialog.querySelector('[data-cryo-close]').onclick = () => dialog.close();
  dialog.querySelectorAll('[data-linked-discard]').forEach(button => button.onclick = () => {
    const lot = lots.find(item => item.id === button.dataset.linkedDiscard);
    dialog.close();
    openCryoRemovalDialog(lot, [], {contaminationDefault: true, defaultReason: '关联培养记录污染'});
  });
  if (!dialog.open) dialog.showModal();
}

function cryoReadSciCount(form) {
  const coeff = (form.elements.namedItem('count_coeff')?.value || '').trim();
  const exp = (form.elements.namedItem('count_exp')?.value || '').trim();
  const unit = (form.elements.namedItem('count_unit')?.value || '').trim() || 'cells';
  if (!coeff && !exp) return null;
  return {coefficient: coeff, exponent: exp, unit};
}
function cryoParseTreatmentsInput(str) {
  return String(str || '').split(/[,，、;；\n]/).map(s => s.trim()).filter(Boolean);
}

// --- Filtering & Bidirectional Facets ---

function cryoBatchKind(lot) {
  if (lot?.cell_kind) return lot.cell_kind;
  const kinds = [...new Set((lot?.sources || []).map(s => s.snapshot?.kind).filter(Boolean))];
  return kinds.length === 1 ? kinds[0] : '';
}
// WT and missing treatment annotations share a search facet only.
function cryoTreatmentFacets(lot) {
  const items = (lot.special_treatments || []).map(t => String(t || '').trim()).filter(Boolean);
  const facets = new Map();
  for (const text of items.length ? items : ['']) {
    const key = !text || text === '无特殊处理' ? 'wt' : text.toLowerCase();
    facets.set(key, key === 'wt' ? 'WT / 未填或无特殊处理' : text);
  }
  return facets;
}
function cryoBatchSearchHaystack(lot) {
  const placed = cryoBatchPlacedSlots(lot.id).map(p => `${cryoBoxLabel(p.box)} ${p.slot} ${p.entry.vial_label || ''}`).join(' ');
  const txText = [...(lot.special_treatments || []), ...cryoTreatmentFacets(lot).keys()].join(' ');
  return [
    lot.name, cryoBatchKind(lot), txText, (lot.resistance_tags || []).join(' '),
    lot.passage, lot.donor, lot.suggested_vessel, lot.labels, lot.location, lot.notes, lot.id, placed,
    (lot.sources || []).map(src => [src.name, src.well].join(' ')).join(' ')
  ].join(' ').toLowerCase();
}
function cryoMatchesQueryAndKind(lot) {
  if (cryoUi.kindFilter && cryoBatchKind(lot).toLowerCase() !== cryoUi.kindFilter.toLowerCase()) return false;
  if (cryoUi.query && !cryoBatchSearchHaystack(lot).includes(cryoUi.query.toLowerCase())) return false;
  return true;
}
function cryoMatchesTreatment(lot, txFilter) {
  if (!txFilter) return true;
  return cryoTreatmentFacets(lot).has(txFilter === '__none__' ? 'wt' : txFilter);
}
function cryoMatchesCell(lot, cellFilter) {
  if (!cellFilter) return true;
  return cryoNormCell(lot) === cellFilter;
}
function cryoMatchesAllFilters(lot) {
  return cryoMatchesQueryAndKind(lot) && cryoMatchesCell(lot, cryoUi.cellFilter) && cryoMatchesTreatment(lot, cryoUi.treatmentFilter);
}
function cryoHasActiveFilter() {
  return !!(cryoUi.query || cryoUi.kindFilter || cryoUi.cellFilter || cryoUi.treatmentFilter);
}
function cryoFacetOptions() {
  const lots = state?.frozen_batches || [];
  // Cells available given current query + kind + treatmentFilter
  const cellMap = new Map();
  for (const lot of lots) {
    if (!cryoMatchesQueryAndKind(lot) || !cryoMatchesTreatment(lot, cryoUi.treatmentFilter)) continue;
    const key = cryoNormCell(lot);
    if (!key) continue;
    const prev = cellMap.get(key) || {key, label: lot.name.trim(), remaining: 0, batches: 0};
    prev.remaining += cryoBatchRemaining(lot);
    prev.batches += 1;
    cellMap.set(key, prev);
  }
  // Treatments available given current query + kind + cellFilter
  const txMap = new Map();
  for (const lot of lots) {
    if (!cryoMatchesQueryAndKind(lot) || !cryoMatchesCell(lot, cryoUi.cellFilter)) continue;
    const rem = cryoBatchRemaining(lot);
    for (const [key, label] of cryoTreatmentFacets(lot)) {
      const prev = txMap.get(key) || {key, label, remaining: 0, batches: 0};
      prev.remaining += rem;
      prev.batches += 1;
      txMap.set(key, prev);
    }
  }
  const cells = [...cellMap.values()].sort((a, b) => b.remaining - a.remaining || a.label.localeCompare(b.label, 'zh-Hans-CN'));
  const treatments = [...txMap.values()].sort((a, b) => b.remaining - a.remaining || a.label.localeCompare(b.label, 'zh-Hans-CN'));
  return {cells, treatments};
}

// --- Main Workspace Rendering ---

function cryoEnsureSelectedBox() {
  const cs = cryoStorage();
  if (!cs.boxes.length) { cryoUi.boxId = ''; return null; }
  const found = cs.boxes.find(b => b.id === cryoUi.boxId);
  if (found) return found;
  cryoUi.boxId = cs.boxes[0].id;
  cryoUi.selectedSlots.clear();
  return cs.boxes[0];
}
function cryoJumpToSlot(boxId, slotKey) {
  cryoUi.tab = 'map';
  cryoUi.boxId = boxId;
  cryoUi.selectedSlots = new Set(slotKey ? [slotKey] : []);
  renderCryoBody();
  document.querySelector(`.cryo-slot[data-cryo-slot="${CSS.escape(slotKey)}"]`)?.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
}

function renderCryoWorkspace() {
  const root = $('#content');
  if (!root) return;
  root.innerHTML = `<section class="cryo-page">
    <div id="cryo-top"></div>
    <section class="cryo-filter-panel" aria-label="冻存细胞双向联动检索">
      <div class="cryo-filter-top">
        <input id="cryo-search" type="search" value="${esc(cryoUi.query)}" placeholder="搜索细胞名称、抗性标签、特殊处理、代次、供者或格位">
        <div class="cryo-kind-tabs" id="cryo-kind-tabs" role="group" aria-label="按细胞类型筛选">
        </div>
        <button type="button" class="text-button" id="cryo-clear-filters" ${cryoHasActiveFilter() ? '' : 'hidden'}>清除筛选</button>
      </div>
      <div id="cryo-facets-wrap"></div>
    </section>
    <div id="cryo-body"></div>
  </section>`;

  const search = $('#cryo-search');
  search.oninput = () => {
    cryoUi.query = search.value.trim();
    renderCryoDynamic();
  };
  $('#cryo-clear-filters').onclick = () => {
    cryoUi.query = ''; cryoUi.kindFilter = ''; cryoUi.cellFilter = ''; cryoUi.treatmentFilter = '';
    search.value = '';
    renderCryoDynamic();
  };
  renderCryoDynamic();
}

function bindCryoKindTabs() {
  const wrap = $('#cryo-kind-tabs');
  if (!wrap) return;
  const kindOptions = cryoHistoryKinds();
  wrap.innerHTML = [['', '全部'], ...kindOptions.map(k => [k, k])].map(([v, l]) =>
    `<button type="button" data-cryo-kind="${esc(v)}" aria-pressed="${cryoUi.kindFilter === v}">${esc(l)}</button>`).join('');
  wrap.querySelectorAll('[data-cryo-kind]').forEach(btn => btn.onclick = () => {
    cryoUi.kindFilter = btn.dataset.cryoKind;
    renderCryoDynamic();
  });
}

function renderCryoDynamic() {
  bindCryoKindTabs();
  renderCryoTop();
  renderCryoFacets();
  renderCryoBody();
  const clearBtn = $('#cryo-clear-filters');
  if (clearBtn) clearBtn.hidden = !cryoHasActiveFilter();
}

function renderCryoTop() {
  const top = $('#cryo-top');
  if (!top) return;
  const lots = state?.frozen_batches || [];
  const totalRem = lots.reduce((n, l) => n + cryoBatchRemaining(l), 0);
  const placedCount = cryoStorage().boxes.reduce((n, b) => n + Object.keys(b.slots || {}).length, 0);
  const grad = cryoGradientSummary();
  const unassignedCount = Math.max(0, totalRem - placedCount - grad.totalVials);
  const gradPreview = grad.batches.slice(0, 3).map(x => `${x.lot.name}${x.lot.special_treatments?.length ? ' (' + x.lot.special_treatments.join('/') + ')' : ''} ×${x.unplaced}`).join(' · ');

  top.innerHTML = `<div class="cryo-header">
    <div>
      <h2>冻存库与记录</h2>
      <div class="cryo-summary-stats">${lots.length} 批 · 账面剩余 ${totalRem} 管（冻存盒 ${placedCount} 管 · 暂存盒 ${grad.totalVials} 管${unassignedCount ? ` · 未定位 ${unassignedCount} 管` : ''}）</div>
    </div>
    <div class="cryo-header-actions">
      <button type="button" class="button secondary" id="cryo-add-stock">＋ 登记已有冻存</button>
      <button type="button" class="button primary" id="cryo-add-setup">＋ 新建设备 / 冻存盒</button>
    </div>
  </div>
  <button type="button" class="cryo-gradient-card ${grad.totalVials > 0 ? 'is-occupied' : 'is-idle'}" id="cryo-gradient-status" aria-haspopup="dialog">
    <div class="cryo-gradient-main">
      <span class="cryo-gradient-dot" aria-hidden="true"></span>
      <div>
        <div class="cryo-gradient-title">暂存盒状态：${grad.totalVials > 0 ? `冻存细胞中（共 ${grad.totalVials} 管 · ${grad.batches.length} 批）` : '空闲中'}</div>
        <div class="cryo-gradient-sub">${grad.totalVials > 0 ? esc(gradPreview + (grad.batches.length > 3 ? ' 等' : '')) : '当前没有暂存记录。'}</div>
      </div>
    </div>
    <span class="cryo-gradient-cta">${grad.totalVials > 0 ? '查看内容 / 转入库位 →' : '查看详情'}</span>
  </button>`;

  $('#cryo-add-stock').onclick = () => openCryoStockDialog([]);
  $('#cryo-add-setup').onclick = () => openCryoSetupDialog();
  $('#cryo-gradient-status').onclick = () => openCryoGradientDialog();
}

function renderCryoFacets() {
  const wrap = $('#cryo-facets-wrap');
  if (!wrap) return;
  const {cells, treatments} = cryoFacetOptions();
  const active = cryoHasActiveFilter();
  const risks = cryoContaminationMap();
  const matchedLots = active ? (state?.frozen_batches || []).filter(cryoMatchesAllFilters) : [];
  const matchedRem = matchedLots.reduce((n, l) => n + cryoBatchRemaining(l), 0);

  wrap.innerHTML = `<div class="cryo-facets">
    <div class="cryo-facet-group">
      <div class="cryo-facet-head"><span>按细胞种类 / 细胞系${cryoUi.treatmentFilter ? '（已按特殊处理联动）' : ''}</span>${cryoUi.cellFilter ? '<button type="button" class="text-button" data-clear-facet="cell">不限</button>' : ''}</div>
      <div class="cryo-facet-chips">${cells.map(c => `<button type="button" class="cryo-facet-chip" data-facet-cell="${esc(c.key)}" aria-pressed="${cryoUi.cellFilter === c.key}">${esc(c.label)}<small>${c.remaining}支</small></button>`).join('') || '<span class="muted">暂无冻存细胞</span>'}</div>
    </div>
    <div class="cryo-facet-group">
      <div class="cryo-facet-head"><span>按特殊处理${cryoUi.cellFilter ? '（已按所选细胞联动）' : ''}</span>${cryoUi.treatmentFilter ? '<button type="button" class="text-button" data-clear-facet="tx">不限</button>' : ''}</div>
      <div class="cryo-facet-chips">${treatments.map(t => `<button type="button" class="cryo-facet-chip" data-facet-tx="${esc(t.key)}" aria-pressed="${cryoUi.treatmentFilter === t.key}">${esc(t.label)}<small>${t.remaining}支</small></button>`).join('') || '<span class="muted">暂无特殊处理标签</span>'}</div>
    </div>
  </div>
  ${active ? `<div class="cryo-hit-strip">
    <div><strong>命中 ${matchedLots.length} 批 · 剩余 ${matchedRem} 支</strong>${matchedLots.length ? '（点击下方库位直接定位格位）' : ''}</div>
    <div class="cryo-hit-list">${matchedLots.flatMap(lot => {
      const rem = cryoBatchRemaining(lot), placed = cryoBatchPlacedSlots(lot.id), risk = risks.get(lot.id) || {level: 'none'};
      const riskCls = risk.level === 'red' ? 'risk-red' : risk.level === 'yellow' ? 'risk-yellow' : '';
      const txText = lot.special_treatments?.length ? ` · ${lot.special_treatments.join('/')}` : '';
      if (placed.length) {
        const byBox = new Map();
        for (const p of placed) {
          if (!byBox.has(p.box.id)) byBox.set(p.box.id, {box: p.box, slots: []});
          byBox.get(p.box.id).slots.push(p.slot);
        }
        return [...byBox.values()].map(g => `<button type="button" class="cryo-hit-pill ${riskCls}" data-jump-box="${esc(g.box.id)}" data-jump-slot="${esc(g.slots[0])}"><strong>${esc(lot.name)}${esc(txText)}</strong><span>${esc(cryoBoxLabel(g.box))} · ${esc(g.slots.join('、'))}（${g.slots.length}支）</span></button>`);
      }
      const locLabel = lot.storage_stage === 'gradient' && rem > 0 ? '暂存盒' : (lot.location || '未定位');
      return [`<button type="button" class="cryo-hit-pill ${riskCls}" data-jump-batch="${esc(lot.id)}"><strong>${esc(lot.name)}${esc(txText)}</strong><span>${esc(locLabel)}（剩 ${rem} 支）</span></button>`];
    }).join('') || '<span class="muted">没有符合当前条件的冻存批次。</span>'}</div>
  </div>` : ''}`;

  wrap.querySelectorAll('[data-facet-cell]').forEach(b => b.onclick = () => {
    cryoUi.cellFilter = cryoUi.cellFilter === b.dataset.facetCell ? '' : b.dataset.facetCell;
    renderCryoDynamic();
  });
  wrap.querySelectorAll('[data-facet-tx]').forEach(b => b.onclick = () => {
    cryoUi.treatmentFilter = cryoUi.treatmentFilter === b.dataset.facetTx ? '' : b.dataset.facetTx;
    renderCryoDynamic();
  });
  wrap.querySelectorAll('[data-clear-facet]').forEach(b => b.onclick = () => {
    if (b.dataset.clearFacet === 'cell') cryoUi.cellFilter = '';
    else cryoUi.treatmentFilter = '';
    renderCryoDynamic();
  });
  wrap.querySelectorAll('[data-jump-box]').forEach(b => b.onclick = () => cryoJumpToSlot(b.dataset.jumpBox, b.dataset.jumpSlot));
  wrap.querySelectorAll('[data-jump-batch]').forEach(b => b.onclick = () => {
    cryoUi.tab = 'batches';
    renderCryoBody();
    const el = document.querySelector(`[data-batch-card="${CSS.escape(b.dataset.jumpBatch)}"]`);
    if (el) { el.open = true; el.scrollIntoView?.({block: 'nearest'}); }
  });
}

function renderCryoBody() {
  const body = $('#cryo-body');
  if (!body) return;
  const cs = cryoStorage();
  const modeBanner = cryoModeBannerMarkup();
  const tabBar = `<div class="cryo-view-tabs">
    <div class="cryo-kind-tabs" role="tablist" aria-label="冻存视图切换">
      <button type="button" data-cryo-tab="map" aria-pressed="${cryoUi.tab === 'map'}">库位地图（${cs.boxes.length} 盒）</button>
      <button type="button" data-cryo-tab="batches" aria-pressed="${cryoUi.tab === 'batches'}">全部冻存批次（${(state?.frozen_batches || []).length}）</button>
    </div>
    ${cryoUi.tab === 'batches' ? `<div class="actions" aria-label="按状态筛选">${[['all','全部'],['gradient','暂存盒中'],['stored','已入盒'],['unassigned','未定位'],['empty','已取空']].map(([k,l])=>`<button type="button" class="text-button" data-stage-filter="${k}" ${cryoUi.batchStageFilter===k?'style="font-weight:700"':''}>${l}</button>`).join('')}</div>` : ''}
  </div>`;

  body.innerHTML = tabBar + modeBanner + (cryoUi.tab === 'map' ? cryoMapMarkup() : cryoBatchesMarkup());

  body.querySelectorAll('[data-cryo-tab]').forEach(b => b.onclick = () => {
    cryoUi.tab = b.dataset.cryoTab;
    renderCryoBody();
  });
  body.querySelectorAll('[data-stage-filter]').forEach(b => b.onclick = () => {
    cryoUi.batchStageFilter = b.dataset.stageFilter;
    renderCryoBody();
  });
  bindCryoModeBanner(body);
  if (cryoUi.tab === 'map') bindCryoMap(body);
  else bindCryoBatches(body);
}

function cryoDraftFromLot(lot) {
  const todayStr = boot?.today || localMinute().slice(0, 10);
  return {
    name: lot?.name || '',
    cell_kind: cryoBatchKind(lot),
    special_treatments: [...(lot?.special_treatments || [])],
    resistance_tags: [...(lot?.resistance_tags || [])],
    at: (lot?.at || '').slice(0, 10) || todayStr,
    passage: lot?.passage || '',
    donor: lot?.donor || '',
    suggested_vessel: lot?.suggested_vessel || '',
    per_vial_count: lot?.per_vial_count ? {...lot.per_vial_count} : null,
    per_vial_legacy: !lot?.per_vial_count && lot?.per_vial ? lot.per_vial : '',
    labels: '',
    day0: lot?.day0 || '',
    notes: lot?.notes || ''
  };
}

function cryoSyncCopyDraft(root = document) {
  const m = cryoUi.mode;
  if (!m || m.type !== 'copy') return;
  const form = root.querySelector('#cryo-copy-form');
  if (!form) return;
  const v = n => (form.elements.namedItem(n)?.value || '').trim();
  m.copySource = !!form.querySelector('[name=copy_source]:checked');
  const sci = cryoReadSciCount(form);
  m.draft = {
    name: v('name'),
    cell_kind: v('cell_kind'),
    special_treatments: cryoReadTreatmentRows(form),
    resistance_tags: cryoReadResistance(form),
    at: v('at'),
    passage: v('passage'),
    donor: v('donor'),
    suggested_vessel: cryoReadSuggestedVessel(form),
    per_vial_count: sci,
    per_vial_legacy: sci ? '' : (m.draft?.per_vial_legacy || ''),
    labels: v('labels'),
    day0: v('day0'),
    notes: v('notes')
  };
}

function startCryoCopyMode(lot, sourceLabel = '') {
  if (!lot) return;
  if (!cryoStorage().boxes.length) {
    toast('请先创建至少一个冻存盒，再复制到空位。', true);
    openCryoSetupDialog();
    return;
  }
  cryoUi.tab = 'map';
  cryoUi.mode = {
    type: 'copy',
    sourceLotId: lot.id,
    sourceLabel: sourceLabel || lot.location || lot.name,
    sourceAtFull: lot.at || '',
    picks: [],
    copySource: Boolean(lot.sources?.length || lot.experiment_refs?.length),
    draft: cryoDraftFromLot(lot)
  };
  renderCryoBody();
}

async function cryoSubmitCopyForm(keepCopying = false) {
  const m = cryoUi.mode;
  if (!m || m.type !== 'copy' || busy) return;
  cryoSyncCopyDraft(document);
  const errEl = document.querySelector('#cryo-copy-error');
  const showErr = msg => {
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    else toast(msg, true);
  };
  if (!m.picks.length) return showErr('请先在左侧冻存盒中点选至少 1 个目标空位。');
  const d = m.draft || {};
  if (!d.name) return showErr('请填写细胞名称 / 细胞系。');
  const atVal = d.at === (m.sourceAtFull || '').slice(0, 10) && (m.sourceAtFull || '').length >= 16
    ? m.sourceAtFull : d.at;
  const payload = {
    name: d.name,
    ...(m.copySource ? {source_lot_id: m.sourceLotId} : {}),
    cell_kind: d.cell_kind,
    special_treatments: d.special_treatments || [],
    resistance_tags: d.resistance_tags || [],
    at: atVal,
    vials: m.picks.length,
    passage: d.passage,
    donor: d.donor,
    suggested_vessel: d.suggested_vessel,
    per_vial_count: d.per_vial_count,
    ...(!d.per_vial_count && d.per_vial_legacy ? {per_vial: d.per_vial_legacy} : {}),
    labels: d.labels,
    day0: d.day0,
    notes: d.notes,
    storage_stage: 'stored',
    placements: m.picks.map(p => ({box_id: p.box_id, slot: p.slot}))
  };
  busy = true;
  try {
    const res = await api('/api/command', {action: 'cryo_stock_create', revision: state.revision, payload});
    state = res.state;
    const count = m.picks.length;
    if (keepCopying) {
      m.picks = [];
      m.draft.labels = '';
      renderCryoDynamic();
      toast(`已复制写入 ${count} 格，可继续修改代次/日期并点选下一组空位。`);
    } else {
      const last = m.picks.at(-1);
      cryoUi.mode = null;
      if (last) cryoUi.boxId = last.box_id;
      cryoUi.selectedSlots.clear();
      renderCryoDynamic();
      toast(`已复制写入 ${count} 格；点击任意单格可查看或微调。`);
    }
  } catch (err) {
    showErr(err.message);
  } finally {
    busy = false;
    if (typeof renderUndoControl === 'function') renderUndoControl();
  }
}

function cryoModeBannerMarkup() {
  const m = cryoUi.mode;
  if (!m) return '';
  if (m.type === 'place') {
    const lot = (state?.frozen_batches || []).find(b => b.id === m.lotId);
    if (!lot) { cryoUi.mode = null; return ''; }
    const maxN = cryoBatchUnplaced(lot);
    return `<div class="cryo-mode-banner" role="status">
      <div><strong>入盒落位模式</strong>：正在为 <strong>${esc(lot.name)}</strong> 分配格位（待落位 ${maxN} 管，已选 <strong>${m.picks.length}</strong> 个空位；可切换左侧其他层/盒跨盒选取）</div>
      <div class="actions">
        <button type="button" class="button secondary" id="cryo-mode-cancel">取消</button>
        <button type="button" class="button primary" id="cryo-mode-confirm" ${!m.picks.length ? 'disabled' : ''}>确认放入已选 ${m.picks.length} 格</button>
      </div>
    </div>`;
  }
  if (m.type === 'move') {
    const need = m.from.length;
    return `<div class="cryo-mode-banner" role="status">
      <div><strong>移位模式</strong>：请点选 <strong>${need}</strong> 个目标空位（已选 ${m.picks.length}/${need}，可切换左侧其他盒）</div>
      <div class="actions">
        <button type="button" class="button secondary" id="cryo-mode-cancel">取消</button>
        <button type="button" class="button primary" id="cryo-mode-confirm" ${m.picks.length !== need ? 'disabled' : ''}>确认移入目标格位</button>
      </div>
    </div>`;
  }
  if (m.type === 'copy') {
    const label = m.draft?.name || '选中细胞';
    return `<div class="cryo-mode-banner" role="status">
      <div><strong>复制格位模式</strong>：已载入 <strong>${esc(label)}</strong>（来自 ${esc(m.sourceLabel || '')}）；请在左侧点选 1 个或多个空位（已选 <strong>${m.picks.length}</strong> 格，可切换其他层/盒），右侧可直接修改代次、日期后再写入</div>
      <div class="actions">
        <button type="button" class="button secondary" id="cryo-mode-cancel">取消</button>
        <button type="button" class="button primary" id="cryo-mode-confirm" ${!m.picks.length ? 'disabled' : ''}>确认复制到已选 ${m.picks.length} 格</button>
      </div>
    </div>`;
  }
  return '';
}
function bindCryoModeBanner(root) {
  const cancel = root.querySelector('#cryo-mode-cancel');
  if (cancel) cancel.onclick = () => { cryoUi.mode = null; renderCryoBody(); };
  const confirmBtn = root.querySelector('#cryo-mode-confirm');
  if (!confirmBtn) return;
  confirmBtn.onclick = async () => {
    const m = cryoUi.mode;
    if (!m || busy) return;
    if (m.type === 'copy') {
      await cryoSubmitCopyForm(false);
      return;
    }
    busy = true;
    try {
      if (m.type === 'place') {
        const res = await api('/api/command', {action: 'cryo_place_vials', revision: state.revision, payload: {lot_id: m.lotId, placements: m.picks}});
        state = res.state;
        const last = m.picks.at(-1);
        cryoUi.mode = null;
        if (last) { cryoUi.boxId = last.box_id; cryoUi.selectedSlots = new Set([last.slot]); }
        toast('冻存管已落入库位。');
      } else if (m.type === 'move') {
        const moves = m.from.map((src, idx) => ({from_box_id: src.box_id, from_slot: src.slot, to_box_id: m.picks[idx].box_id, to_slot: m.picks[idx].slot}));
        const res = await api('/api/command', {action: 'cryo_move_slots', revision: state.revision, payload: {moves}});
        state = res.state;
        const last = m.picks.at(-1);
        cryoUi.mode = null;
        if (last) { cryoUi.boxId = last.box_id; cryoUi.selectedSlots = new Set([last.slot]); }
        toast(`已移动 ${moves.length} 管至新格位。`);
      }
      renderCryoDynamic();
    } catch (err) { toast(err.message, true); }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
}

function cryoMapMarkup() {
  const cs = cryoStorage();
  if (!cs.devices.length) {
    return '<div class="panel"><h3>还没有库位</h3><p>新建设备和冻存盒后，即可按格位登记库存。</p></div>';
  }

  const activeBox = cryoEnsureSelectedBox();
  const lotsById = new Map((state?.frozen_batches || []).map(b => [b.id, b]));
  const toneMap = cryoToneMapForLots(state?.frozen_batches || []);
  const risks = cryoContaminationMap();
  const filterOn = cryoHasActiveFilter();
  const matchedIds = new Set(filterOn ? (state?.frozen_batches || []).filter(cryoMatchesAllFilters).map(b => b.id) : []);

  const boxHitCount = box => Object.values(box.slots || {}).filter(e => matchedIds.has(e.batch_id)).length;
  const renderBoxItem = box => {
    const occ = Object.keys(box.slots || {}).length, total = box.rows * box.cols;
    const hits = filterOn ? boxHitCount(box) : 0;
    return `<button type="button" class="cryo-tree-box ${box.id === activeBox.id ? 'active' : ''}" data-select-box="${esc(box.id)}">
      <span>${esc(box.name)}</span>
      <span class="cryo-tree-meta">${hits ? `<span class="cryo-tree-hit">${hits}</span> ` : ''}${occ}/${total}</span>
    </button>`;
  };

  const treeHtml = cs.devices.map(dev => {
    const devRacks = cs.racks.filter(r => r.device_id === dev.id);
    const directBoxes = cs.boxes.filter(b => b.device_id === dev.id && !b.rack_id);
    return `<div class="cryo-tree-device">
      <div class="cryo-tree-device-head">
        <strong>${esc(dev.name)} <small class="muted">${esc(CRYO_DEVICE_LABELS[dev.kind] || '')}</small></strong>
        <span class="cryo-mini-actions">
          <button type="button" title="新增吊/架" data-add-rack="${esc(dev.id)}">＋吊/架</button>
          <button type="button" title="新增冻存盒" data-add-box-dev="${esc(dev.id)}">＋盒</button>
          <button type="button" title="编辑设备" data-edit-device="${esc(dev.id)}">改</button>
        </span>
      </div>
      ${devRacks.map(rack => {
        const rackBoxes = cs.boxes.filter(b => b.rack_id === rack.id).sort((a, b) => (a.layer ?? 999) - (b.layer ?? 999));
        return `<div class="cryo-tree-rack">
          <div class="cryo-tree-rack-head">
            <span>${esc(rack.name)}</span>
            <span class="cryo-mini-actions">
              <button type="button" title="添加一层/盒" data-add-box-rack="${esc(rack.id)}">＋层</button>
              <button type="button" title="编辑吊/架" data-edit-rack="${esc(rack.id)}">改</button>
            </span>
          </div>
          ${rackBoxes.map(renderBoxItem).join('') || '<p class="muted" style="margin:2px 0">暂无层盒</p>'}
        </div>`;
      }).join('')}
      ${directBoxes.map(renderBoxItem).join('')}
    </div>`;
  }).join('');

  if (!activeBox) return `<aside class="cryo-tree">${treeHtml}</aside><p class="panel">请选择设备旁的「＋盒」添加冻存盒。</p>`;
  const keys = cryoSlotKeys(activeBox);
  const cols = activeBox.cols, rows = activeBox.rows, alpha = activeBox.numbering !== 'numeric';
  const dense = cols >= 8;
  const pickSet = new Set((cryoUi.mode?.picks || []).filter(p => p.box_id === activeBox.id).map(p => p.slot));

  const renderSlotBtn = key => {
    const entry = activeBox.slots?.[key];
    const lot = entry ? lotsById.get(entry.batch_id) : null;
    const risk = lot ? (risks.get(lot.id) || {level: 'none', hits: 0}) : {level: 'none', hits: 0};
    const isSel = cryoUi.mode ? pickSet.has(key) : cryoUi.selectedSlots.has(key);
    const isMatch = filterOn && lot && matchedIds.has(lot.id);
    const isDim = filterOn && (!lot || !matchedIds.has(lot.id));
    const cls = [
      'cryo-slot',
      lot ? 'occupied' : 'empty',
      risk.level === 'yellow' ? 'risk-yellow' : risk.level === 'red' ? 'risk-red' : '',
      isSel ? 'is-selected' : '',
      isMatch ? 'is-match' : '',
      isDim ? 'is-dim' : ''
    ].filter(Boolean).join(' ');
    const txShort = lot?.special_treatments?.length ? lot.special_treatments.join('/') : '';
    const resShort = lot?.resistance_tags?.length ? lot.resistance_tags.join(' ') : '';
    const subTag = [resShort, txShort].filter(Boolean).join(' · ');
    const title = lot
      ? `${key} · ${lot.name}${resShort ? ' · 抗性 ' + resShort : ''}${txShort ? ' · ' + txShort : ''}${lot.passage ? ' · ' + lot.passage : ''}${risk.level !== 'none' ? ` · 污染预警(${risk.hits}次)` : ''}`
      : `${key} · 空位`;
    return `<button type="button" class="${cls}" data-cryo-slot="${esc(key)}" ${lot ? `data-batch-tone="${toneMap.get(cryoLotToneKey(lot)) ?? 0}"` : ''} aria-pressed="${isSel}" title="${esc(title)}">
      ${risk.level === 'red' ? '<span class="cryo-risk-badge" aria-label="红色污染高危">⛔</span>' : risk.level === 'yellow' ? '<span class="cryo-risk-badge" aria-label="黄色污染预警">⚠</span>' : ''}
      <span class="cryo-slot-key">${esc(key)}</span>
      ${lot ? `<span class="cryo-slot-cell">${esc(lot.name)}</span>${subTag ? `<span class="cryo-slot-tx">${esc(subTag)}</span>` : ''}` : '<span class="cryo-slot-tx">空</span>'}
    </button>`;
  };

  let gridInner = '';
  if (alpha) {
    gridInner += `<span class="cryo-axis"></span>` + Array.from({length: cols}, (_, c) => `<span class="cryo-axis">${c + 1}</span>`).join('');
    for (let r = 0; r < rows; r++) {
      gridInner += `<span class="cryo-axis">${String.fromCharCode(65 + r)}</span>`;
      gridInner += keys.slice(r * cols, (r + 1) * cols).map(renderSlotBtn).join('');
    }
  } else {
    gridInner = keys.map(renderSlotBtn).join('');
  }
  const gridCols = alpha ? `20px repeat(${cols}, minmax(0, 1fr))` : `repeat(${cols}, minmax(0, 1fr))`;

  return `<div class="cryo-layout">
    <aside class="cryo-tree" aria-label="冻存设备与冻存盒目录">${treeHtml}</aside>
    <div class="cryo-workspace">
      <section class="cryo-box-panel">
        <div class="cryo-box-head">
          <div>
            <h3>${esc(cryoBoxLabel(activeBox))}</h3>
            <p class="muted" style="margin:2px 0 0">${rows}×${cols} · ${alpha ? 'A1 行列坐标' : '1–N 顺序编号'} · 已占 ${Object.keys(activeBox.slots || {}).length}/${rows * cols} 格</p>
          </div>
          <div class="actions">
            <button type="button" class="text-button" id="cryo-clear-slots" ${!cryoUi.selectedSlots.size || cryoUi.mode ? 'hidden' : ''}>取消选格</button>
            <button type="button" class="text-button" data-edit-box="${esc(activeBox.id)}">编辑此盒</button>
          </div>
        </div>
        <div class="cryo-box-scroll">
          <div class="cryo-box-grid ${dense ? 'dense' : ''}" style="grid-template-columns:${gridCols}" data-cryo-grid="${esc(activeBox.id)}">${gridInner}</div>
        </div>
        <div class="cryo-legend">
          <span><i></i>空位</span>
          <span><i class="occ"></i>已存细胞</span>
          <span><i class="yel"></i>⚠ 污染预警（1次）</span>
          <span><i class="red"></i>⛔ 污染高危（≥2次）</span>
        </div>
      </section>
      <aside class="cryo-inspector" id="cryo-inspector">${cryoInspectorMarkup(activeBox, lotsById, risks)}</aside>
    </div>
  </div>`;
}

function cryoInspectorMarkup(box, lotsById, risks) {
  if (cryoUi.mode) {
    if (cryoUi.mode.type === 'copy') {
      const m = cryoUi.mode;
      const d = m.draft || {};
      const original = lotsById.get(m.sourceLotId);
      const cells = cryoHistoryCells(), kinds = cryoHistoryKinds();
      const todayStr = boot?.today || localMinute().slice(0, 10);
      const boxesById = new Map(cryoStorage().boxes.map(b => [b.id, b]));
      const grouped = new Map();
      for (const p of m.picks) {
        if (!grouped.has(p.box_id)) grouped.set(p.box_id, []);
        grouped.get(p.box_id).push(p.slot);
      }
      const picksSummary = [...grouped.entries()].map(([bid, slots]) => {
        const bx = boxesById.get(bid);
        return `<span class="cryo-slot-chip">${esc(bx ? bx.name : bid)} · ${esc(slots.join('、'))}</span>`;
      }).join('');
      return `<h3>复制到空位（已选 ${m.picks.length} 格）</h3>
        <p class="muted" style="margin:0 0 8px">已复制来自 <strong>${esc(m.sourceLabel || '')}</strong> 的信息；可直接原样写入，也可先微调代次、冻存日期等字段，复制后仍可单格单独修改。</p>
        <div class="cryo-copy-picks">
          ${m.picks.length ? `<strong>目标格位：</strong>${picksSummary}` : '<span class="muted">请在左侧冻存盒网格中点击 1 个或多个空位（支持切换其他层/盒跨盒多选）。</span>'}
        </div>
        <form id="cryo-copy-form" novalidate>
          <div class="two">
            <label>细胞名称 / 细胞系<input name="name" required maxlength="200" list="cryo-copy-cells" value="${esc(d.name || '')}"></label>
            <label>细胞类型（可选）<input name="cell_kind" maxlength="80" list="cryo-copy-kinds" value="${esc(d.cell_kind || '')}" placeholder="输入或选择类型"></label>
          </div>
          <datalist id="cryo-copy-cells">${cells.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
          <datalist id="cryo-copy-kinds">${kinds.map(k => `<option value="${esc(k)}">`).join('')}</datalist>
          ${cryoTreatmentRowsMarkup(d.special_treatments || [], 'cryo-copy-tx-list')}
          ${cryoResistanceMarkup(d.resistance_tags || [])}
          <div class="two">
            <label>细胞冻存日期<input name="at" type="date" required value="${esc(d.at || todayStr)}" max="${esc(todayStr)}"></label>
            <label>细胞代次（可选）<input name="passage" maxlength="60" value="${esc(d.passage || '')}" placeholder="如 P5"></label>
          </div>
          <div class="two">
            <label>细胞供者来源（可选）<input name="donor" maxlength="200" value="${esc(d.donor || '')}"></label>
            <div>${cryoSuggestedVesselMarkup(d.suggested_vessel || '')}</div>
          </div>
          ${original?.sources?.length || original?.experiment_refs?.length ? `<label class="inline-check"><input type="checkbox" name="copy_source" ${m.copySource ? 'checked' : ''}>沿用原批次登记的来源与实验关联</label>` : ''}
          ${cryoSciCountMarkup(d.per_vial_count, d.per_vial_legacy || '')}
          <details style="margin:8px 0" ${d.labels || d.day0 || d.notes ? 'open' : ''}>
            <summary class="muted" style="cursor:pointer">管号、原代激活日与备注（可选）</summary>
            <div class="two" style="margin-top:6px">
              <label>冻存管编号（逐管逗号分开）<input name="labels" maxlength="1000" value="${esc(d.labels || '')}"></label>
              <label>原代原激活日<input name="day0" type="date" value="${esc(d.day0 || '')}"></label>
            </div>
            <label>备注<textarea name="notes" maxlength="5000">${esc(d.notes || '')}</textarea></label>
          </details>
          <p role="alert" class="lab-error" id="cryo-copy-error" hidden></p>
          <div class="actions" style="margin-top:8px">
            <button type="submit" class="button primary" id="cryo-copy-submit" ${!m.picks.length ? 'disabled' : ''}>确认复制到已选 ${m.picks.length} 格</button>
            <button type="button" class="button secondary" id="cryo-copy-and-continue" ${!m.picks.length ? 'disabled' : ''}>复制并继续选下一组</button>
            <button type="button" class="text-button" id="cryo-copy-cancel">取消</button>
          </div>
        </form>`;
    }
    return `<p class="muted">当前正在${cryoUi.mode.type === 'place' ? '选择入盒空位' : '选择移位目标空位'}。点击左侧网格中的空位即可增减，也可以切换其他盒。</p>`;
  }
  const sel = [...cryoUi.selectedSlots].filter(k => cryoSlotKeys(box).includes(k));
  if (!sel.length) {
    return `<h3>格位详情</h3><p class="muted">点击左侧任意<strong>空位</strong>可登记已有冻存或放入暂存盒中的细胞；点击<strong>已占格位</strong>可查看完整细胞信息、关联库存余量、移位、取出或复苏。</p>`;
  }
  const occupied = sel.filter(k => box.slots?.[k]);
  const empty = sel.filter(k => !box.slots?.[k]);

  if (!occupied.length) {
    const unplacedLots = (state?.frozen_batches || []).filter(l => cryoBatchUnplaced(l) > 0);
    const cells = cryoHistoryCells(), kinds = cryoHistoryKinds();
    const todayStr = boot?.today || localMinute().slice(0, 10);
    return `<h3>直接填入 ${esc(box.name)} · ${esc(empty.join('、'))}（${empty.length} 管）</h3>
      <p class="muted" style="margin:0 0 8px">可选择多个空位，一次登记同一批库存。选择培养来源后可查看该培养单元的关联实验。</p>
      <form id="cryo-inline-stock-form" novalidate>
        <div class="two">
          <label>细胞名称 / 细胞系<input name="name" required maxlength="200" list="cryo-inline-cells" ></label>
          <label>细胞类型（可选）<input name="cell_kind" maxlength="80" list="cryo-inline-kinds" placeholder="输入或选择类型"></label>
        </div>
        <datalist id="cryo-inline-cells">${cells.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <datalist id="cryo-inline-kinds">${kinds.map(k => `<option value="${esc(k)}">`).join('')}</datalist>
        ${cryoTreatmentRowsMarkup([], 'cryo-inline-tx-list')}
        ${cryoResistanceMarkup([])}
        <div class="two">
          <label>细胞冻存日期<input name="at" type="date" required value="${esc(todayStr)}" max="${esc(todayStr)}"></label>
          <label>细胞代次（可选）<input name="passage" maxlength="60" placeholder="如 P5"></label>
        </div>
        <div class="two">
          <label>细胞供者来源（可选）<input name="donor" maxlength="200" ></label>
          <div>${cryoSuggestedVesselMarkup('')}</div>
        </div>
        ${cryoSourceMarkup()}
        ${cryoSciCountMarkup(null)}
        <details style="margin:8px 0">
          <summary class="muted" style="cursor:pointer">管号、原代激活日与备注（可选）</summary>
          <div class="two" style="margin-top:6px">
            <label>冻存管编号（逐管逗号分开）<input name="labels" maxlength="1000"></label>
            <label>原代原激活日<input name="day0" type="date"></label>
          </div>
          <label>备注<textarea name="notes" maxlength="5000"></textarea></label>
        </details>
        <p role="alert" class="lab-error" id="cryo-inline-error" hidden></p>
        <div class="actions" style="margin-top:8px">
          <button type="submit" class="button primary">保存到选中 ${empty.length} 格</button>
          <button type="button" class="text-button" id="cryo-fill-empty-new">打开完整弹窗填写</button>
        </div>
      </form>
      ${unplacedLots.length ? `<details class="panel" style="margin-top:12px">
        <summary style="cursor:pointer;font-size:12px;font-weight:600">或将暂存盒 / 待落位批次放入这 ${empty.length} 格（${unplacedLots.length} 批）</summary>
        <label style="margin-top:8px">选择待落位批次
          <select id="cryo-quick-place-lot">
            <option value="">请选择批次</option>
            ${unplacedLots.map(l => `<option value="${esc(l.id)}">${esc(l.name)}${l.special_treatments?.length ? ' · ' + esc(l.special_treatments.join('/')) : ''}（待落位 ${cryoBatchUnplaced(l)} 管${l.storage_stage === 'gradient' ? ' · 暂存盒中' : ''}）</option>`).join('')}
          </select>
        </label>
        <button type="button" class="button secondary" id="cryo-quick-place-go" style="margin-top:8px">放入选中格位</button>
      </details>` : ''}`;
  }

  const entries = occupied.map(k => ({slot: k, entry: box.slots[k], lot: lotsById.get(box.slots[k].batch_id)})).filter(x => x.lot);
  const first = entries[0], lot = first.lot;
  const sameBatch = entries.every(x => x.lot.id === lot.id);
  const risk = risks.get(lot.id) || {level: 'none', hits: 0, events: []};
  const rem = cryoBatchRemaining(lot), related = cryoRelatedGroups(lot.id);

  const riskHtml = risk.level !== 'none' ? `<div class="cryo-alert-box risk-${risk.level}">
    <strong>${risk.level === 'red' ? `⛔ 污染高危标记（关联 ${risk.hits} 次污染）` : '⚠ 污染预警标记（关联 1 次污染）'}</strong>
    <div>${risk.events.map(ev => `${esc(ev.reason)}：${esc(ev.sourceName)}（${esc((ev.sourceAt || '').slice(0, 10))}）${ev.contamination.kind ? ' · ' + esc(ev.contamination.kind) : ''}${ev.contamination.notes ? ' · ' + esc(ev.contamination.notes) : ''}`).join('<br>')}</div>
  </div>` : '';

  const tierRow = (title, items) => {
    const total = items.reduce((n, x) => n + x.remaining, 0);
    return `<div class="cryo-related-tier">
      <div class="cryo-related-tier-head"><span>${title}</span><span>还剩 ${total} 支（${items.length} 批）</span></div>
      ${items.length ? `<ul>${items.map(x => {
        const p = x.placed[0];
        const r = risks.get(x.lot.id) || {level: 'none'};
        const badge = r.level === 'red' ? ' ⛔' : r.level === 'yellow' ? ' ⚠' : '';
        const tx = x.lot.special_treatments?.length ? ` · ${x.lot.special_treatments.join('/')}` : '';
        const jump = p ? `<button type="button" class="text-button" data-jump-box="${esc(p.box.id)}" data-jump-slot="${esc(p.slot)}">${esc(cryoBoxLabel(p.box))} ${esc(p.slot)}</button>` : `<span>${esc(x.lot.storage_stage === 'gradient' ? '暂存盒' : (x.lot.location || '未定位'))}</span>`;
        return `<li><span><strong>${esc(x.lot.name)}${esc(tx)}</strong>${badge} · ${esc((x.lot.at || '').slice(0, 10))} · 剩 ${x.remaining} 支</span>${jump}</li>`;
      }).join('')}</ul>` : '<p class="muted" style="margin:4px 0 0">暂无其他关联批次</p>'}
    </div>`;
  };

  return `<h3>${esc(lot.name)}${lot.cell_kind ? ` <small class="muted">${esc(lot.cell_kind)}</small>` : ''}</h3>
    <p class="muted" style="margin-bottom:6px">${esc(cryoBoxLabel(box))} · 格位 ${esc(occupied.join('、'))}${first.entry.vial_label ? ' · 管号 ' + esc(first.entry.vial_label) : ''}</p>
    ${(lot.special_treatments || []).length || (lot.resistance_tags || []).length ? `<div>${(lot.resistance_tags || []).map(tag => `<span class="cryo-res-badge">抗性 ${esc(tag)}</span>`).join('')}${(lot.special_treatments || []).map(tx => `<span class="cryo-tx-badge">${esc(tx)}</span>`).join('')}</div>` : ''}
    ${riskHtml}
    ${!sameBatch ? '<p class="muted">当前多选了不同批次的格位；移位可批量执行，取出/复苏请只选同一批次。</p>' : ''}
    <div class="cryo-meta-grid">
      <div class="cryo-meta-item"><small>冻存时间</small><strong>${esc((lot.at || '').replace('T', ' '))}</strong></div>
      <div class="cryo-meta-item"><small>本批余量</small><strong>剩 ${rem} / ${lot.vials} 管</strong></div>
      <div class="cryo-meta-item"><small>细胞代次</small><strong>${esc(lot.passage || '未记录')}</strong></div>
      <div class="cryo-meta-item"><small>供者来源</small><strong>${esc(lot.donor || '未记录')}</strong></div>
      <div class="cryo-meta-item"><small>管内细胞数</small><strong>${esc(cryoFormatCount(lot) || '未记录')}</strong></div>
      <div class="cryo-meta-item"><small>复苏容器备注</small><strong>${esc(lot.suggested_vessel || '未记录')}</strong></div>
    </div>
    ${lot.notes ? `<p class="muted">备注：${esc(lot.notes)}</p>` : ''}
    <div class="actions" style="margin:10px 0">
      <button type="button" class="button primary" id="cryo-slot-thaw" ${!sameBatch || !rem ? 'disabled' : ''}>登记取出复苏（${occupied.length} 管）</button>
      <button type="button" class="button secondary" id="cryo-slot-take" ${!sameBatch || !rem ? 'disabled' : ''}>仅取出</button>
      <button type="button" class="button secondary" id="cryo-slot-copy" ${!sameBatch ? 'disabled' : ''}>复制到空位</button>
      <button type="button" class="button secondary" id="cryo-slot-move">移位</button>
      <button type="button" class="button danger" id="cryo-slot-discard" ${!sameBatch || !rem ? 'disabled' : ''}>弃置 / 污染放弃</button>
      <button type="button" class="text-button" id="cryo-slot-edit" ${!sameBatch ? 'disabled' : ''}>编辑信息</button>
    </div>
    ${lot.sources?.length ? `<p class="muted">来源：${lot.sources.map(s => `${esc(s.name + ' / ' + s.well)} ${typeof lineageUnitButton === 'function' ? lineageUnitButton(s.id, s.well) : ''}`).join('；')}</p>` : ''}
    ${(() => {
      const exps = cryoLinkedExperiments(lot);
      if (!exps.length) return '';
      return `<section class="cryo-linked-exps"><h4>关联实验（${exps.length}）</h4><div class="cryo-linked-exp-list">${exps.map(item => `<div class="cryo-linked-exp-item"><span><strong>${esc(item.rec.title || item.rec.id)}</strong> <small class="muted">${esc(item.rec.record_date || '')} · ${esc(item.reason)}</small></span><button type="button" class="text-button" data-lab-record="${esc(item.rec.id)}">打开实验</button></div>`).join('')}</div></section>`;
    })()}
    <section class="cryo-related-panel">
      <h4>关联细胞库存余量</h4>
      ${tierRow('强相关（同日同组）', related.strong)}
      ${tierRow('弱相关（同细胞同处理 · 不同日）', related.weak)}
      ${tierRow('更弱相关（同细胞 · 其他处理）', related.weaker)}
    </section>`;
}

function bindCryoMap(root) {
  root.querySelectorAll('[data-select-box]').forEach(b => b.onclick = () => {
    cryoSyncCopyDraft(root);
    cryoUi.boxId = b.dataset.selectBox;
    if (!cryoUi.mode) cryoUi.selectedSlots.clear();
    renderCryoBody();
  });
  root.querySelectorAll('[data-add-rack]').forEach(b => b.onclick = () => openCryoManageDialog('rack', null, {device_id: b.dataset.addRack}));
  root.querySelectorAll('[data-add-box-dev]').forEach(b => b.onclick = () => openCryoManageDialog('box', null, {device_id: b.dataset.addBoxDev, rack_id: ''}));
  root.querySelectorAll('[data-add-box-rack]').forEach(b => b.onclick = () => {
    const rack = cryoStorage().racks.find(r => r.id === b.dataset.addBoxRack);
    if (rack) openCryoManageDialog('box', null, {device_id: rack.device_id, rack_id: rack.id});
  });
  root.querySelectorAll('[data-edit-device]').forEach(b => b.onclick = () => {
    const dev = cryoStorage().devices.find(d => d.id === b.dataset.editDevice);
    if (dev) openCryoManageDialog('device', dev);
  });
  root.querySelectorAll('[data-edit-rack]').forEach(b => b.onclick = () => {
    const rack = cryoStorage().racks.find(r => r.id === b.dataset.editRack);
    if (rack) openCryoManageDialog('rack', rack);
  });
  root.querySelectorAll('[data-edit-box]').forEach(b => b.onclick = () => {
    const box = cryoStorage().boxes.find(x => x.id === b.dataset.editBox);
    if (box) openCryoManageDialog('box', box);
  });

  const activeBox = cryoEnsureSelectedBox();
  if (!activeBox) return;

  const clearBtn = root.querySelector('#cryo-clear-slots');
  if (clearBtn) clearBtn.onclick = () => { cryoUi.selectedSlots.clear(); renderCryoBody(); };

  root.querySelectorAll('[data-cryo-slot]').forEach(btn => btn.onclick = e => {
    const key = btn.dataset.cryoSlot;
    const occupied = !!activeBox.slots?.[key];
    if (cryoUi.mode) {
      if (occupied) return toast('请选择空的格位。', true);
      const m = cryoUi.mode;
      if (m.type === 'copy') cryoSyncCopyDraft(root);
      const idx = m.picks.findIndex(p => p.box_id === activeBox.id && p.slot === key);
      if (idx >= 0) m.picks.splice(idx, 1);
      else {
        if (m.type !== 'copy') {
          const limit = m.type === 'place' ? cryoBatchUnplaced((state.frozen_batches || []).find(b => b.id === m.lotId)) : m.from.length;
          if (m.picks.length >= limit) return toast(`最多选择 ${limit} 个目标空位。`, true);
        }
        m.picks.push({box_id: activeBox.id, slot: key});
      }
      renderCryoBody();
      return;
    }
    const currentSel = [...cryoUi.selectedSlots];
    const hasOcc = currentSel.some(k => activeBox.slots?.[k]);
    const hasEmpty = currentSel.some(k => !activeBox.slots?.[k]);
    if (occupied) {
      if (hasEmpty || (!e.shiftKey && !cryoUi.selectedSlots.has(key) && currentSel.length > 0 && activeBox.slots?.[currentSel[0]]?.batch_id !== activeBox.slots[key].batch_id)) {
        cryoUi.selectedSlots = new Set([key]);
      } else if (cryoUi.selectedSlots.has(key)) {
        cryoUi.selectedSlots.delete(key);
      } else {
        cryoUi.selectedSlots.add(key);
      }
    } else {
      if (hasOcc) cryoUi.selectedSlots = new Set([key]);
      else if (cryoUi.selectedSlots.has(key)) cryoUi.selectedSlots.delete(key);
      else cryoUi.selectedSlots.add(key);
    }
    renderCryoBody();
  });

  const copyForm = root.querySelector('#cryo-copy-form');
  if (copyForm) {
    cryoBindSuggestedVessel(copyForm);
    cryoBindTreatmentRows(copyForm);
    cryoBindResistance(copyForm, () => cryoSyncCopyDraft(root));
    copyForm.addEventListener('input', () => cryoSyncCopyDraft(root));
    copyForm.addEventListener('change', () => cryoSyncCopyDraft(root));
    copyForm.onsubmit = async e => {
      e.preventDefault();
      await cryoSubmitCopyForm(false);
    };
    const contBtn = copyForm.querySelector('#cryo-copy-and-continue');
    if (contBtn) contBtn.onclick = async () => { await cryoSubmitCopyForm(true); };
    const cancelCopy = copyForm.querySelector('#cryo-copy-cancel');
    if (cancelCopy) cancelCopy.onclick = () => { cryoUi.mode = null; renderCryoBody(); };
  }

  const inlineForm = root.querySelector('#cryo-inline-stock-form');
  if (inlineForm) {
    cryoBindSuggestedVessel(inlineForm);
    cryoBindTreatmentRows(inlineForm);
    cryoBindResistance(inlineForm);
    inlineForm.onsubmit = async e => {
      e.preventDefault();
      if (busy) return;
      const slots = [...cryoUi.selectedSlots].filter(k => !activeBox.slots?.[k]);
      const errEl = inlineForm.querySelector('#cryo-inline-error');
      const v = n => (inlineForm.elements.namedItem(n)?.value || '').trim();
      if (!slots.length) { errEl.textContent = '请先在左侧选择至少一个空位。'; errEl.hidden = false; return; }
      const payload = {
        name: v('name'), cell_kind: v('cell_kind'),
        special_treatments: cryoReadTreatmentRows(inlineForm),
        resistance_tags: cryoReadResistance(inlineForm),
        at: v('at'), vials: slots.length, passage: v('passage'), donor: v('donor'),
        suggested_vessel: cryoReadSuggestedVessel(inlineForm), per_vial_count: cryoReadSciCount(inlineForm),
        labels: v('labels'), day0: v('day0'), notes: v('notes'),
        source: JSON.parse(v('cryo_source') || 'null'),
        storage_stage: 'stored', placements: slots.map(slot => ({box_id: activeBox.id, slot}))
      };
      busy = true;
      try {
        const res = await api('/api/command', {action: 'cryo_stock_create', revision: state.revision, payload});
        state = res.state;
        cryoUi.selectedSlots.clear();
        renderCryoDynamic();
        toast(`已直接写入 ${slots.length} 格（${slots.join('、')}）。`);
      } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
      finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
    };
  }
  const fillNew = root.querySelector('#cryo-fill-empty-new');
  if (fillNew) fillNew.onclick = () => openCryoStockDialog([...cryoUi.selectedSlots].map(slot => ({box_id: activeBox.id, slot})));

  const quickPlace = root.querySelector('#cryo-quick-place-go');
  if (quickPlace) quickPlace.onclick = async () => {
    const lotId = root.querySelector('#cryo-quick-place-lot')?.value;
    if (!lotId || busy) return toast('请先选择待落位批次。', true);
    const placements = [...cryoUi.selectedSlots].map(slot => ({box_id: activeBox.id, slot}));
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_place_vials', revision: state.revision, payload: {lot_id: lotId, placements}});
      state = res.state;
      cryoUi.selectedSlots.clear();
      renderCryoDynamic();
      toast(`已将 ${placements.length} 管放入库位。`);
    } catch (err) { toast(err.message, true); }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };

  const occupiedSel = [...cryoUi.selectedSlots].filter(k => activeBox.slots?.[k]);
  const firstEntry = occupiedSel.length ? activeBox.slots[occupiedSel[0]] : null;
  const firstLot = firstEntry ? (state.frozen_batches || []).find(b => b.id === firstEntry.batch_id) : null;

  const thawBtn = root.querySelector('#cryo-slot-thaw');
  if (thawBtn && firstLot) thawBtn.onclick = () => openCryoRemovalDialog(firstLot, occupiedSel.map(slot => ({box_id: activeBox.id, slot})), {mode: 'thaw'});
  const takeBtn = root.querySelector('#cryo-slot-take');
  if (takeBtn && firstLot) takeBtn.onclick = () => openCryoRemovalDialog(firstLot, occupiedSel.map(slot => ({box_id: activeBox.id, slot})), {mode: 'take'});
  const copyBtn = root.querySelector('#cryo-slot-copy');
  if (copyBtn && firstLot) copyBtn.onclick = () => startCryoCopyMode(firstLot, `${cryoBoxLabel(activeBox)} · ${occupiedSel[0]}`);
  const moveBtn = root.querySelector('#cryo-slot-move');
  if (moveBtn && occupiedSel.length) moveBtn.onclick = () => {
    cryoUi.mode = {type: 'move', from: occupiedSel.map(slot => ({box_id: activeBox.id, slot, batch_id: activeBox.slots[slot].batch_id})), picks: []};
    renderCryoBody();
  };
  const discardBtn = root.querySelector('#cryo-slot-discard');
  if (discardBtn && firstLot) discardBtn.onclick = () => openCryoRemovalDialog(firstLot, occupiedSel.map(slot => ({box_id: activeBox.id, slot})));
  const editBtn = root.querySelector('#cryo-slot-edit');
  if (editBtn && firstLot) editBtn.onclick = () => openCryoBatchEditDialog(firstLot, {
    box: activeBox, slots: occupiedSel, slot: occupiedSel[0], entry: occupiedSel.length === 1 ? firstEntry : null
  });

  root.querySelectorAll('[data-jump-box]').forEach(b => b.onclick = () => cryoJumpToSlot(b.dataset.jumpBox, b.dataset.jumpSlot));
  if (typeof bindLineageButtons === 'function') bindLineageButtons(root);
  if (typeof bindLabRecordLinks === 'function') bindLabRecordLinks(root);
}

function cryoBatchesMarkup() {
  const risks = cryoContaminationMap();
  const rows = [...(state?.frozen_batches || [])]
    .sort((a, b) => (b.at || '').localeCompare(a.at || '') || (b.recorded_at || '').localeCompare(a.recorded_at || ''))
    .filter(cryoMatchesAllFilters)
    .filter(lot => {
      const rem = cryoBatchRemaining(lot), unp = cryoBatchUnplaced(lot), placed = cryoBatchPlacedSlots(lot.id).length;
      if (cryoUi.batchStageFilter === 'gradient') return lot.storage_stage === 'gradient' && unp > 0;
      if (cryoUi.batchStageFilter === 'stored') return placed > 0 && rem > 0;
      if (cryoUi.batchStageFilter === 'unassigned') return lot.storage_stage !== 'gradient' && unp > 0;
      if (cryoUi.batchStageFilter === 'empty') return rem === 0;
      return true;
    });

  if (!rows.length) {
    return '<p class="panel muted">暂无匹配的冻存批次。可在右上角「登记已有冻存」，或选择空格位直接录入。</p>';
  }
  return rows.map(f => {
    const rem = cryoBatchRemaining(f), placed = cryoBatchPlacedSlots(f.id), unp = cryoBatchUnplaced(f);
    const risk = risks.get(f.id) || {level: 'none', hits: 0, events: []};
    const riskCls = risk.level === 'red' ? 'risk-red' : risk.level === 'yellow' ? 'risk-yellow' : '';
    const related = cryoRelatedGroups(f.id);
    const strongRem = related.strong.reduce((n, x) => n + x.remaining, 0);
    const weakRem = related.weak.reduce((n, x) => n + x.remaining, 0);
    const weakerRem = related.weaker.reduce((n, x) => n + x.remaining, 0);
    return `<details class="panel cryo-batch-card ${riskCls}" data-batch-card="${esc(f.id)}">
      <summary>
        ${risk.level === 'red' ? '⛔ ' : risk.level === 'yellow' ? '⚠ ' : ''}
        <strong>${esc(f.name)}</strong>${f.resistance_tags?.length ? ' · 抗性 ' + esc(f.resistance_tags.join('/')) : ''}${f.special_treatments?.length ? ' · ' + esc(f.special_treatments.join('/')) : ''}${f.passage ? ' · ' + esc(f.passage) : ''} · ${f.vials} 管 · ${esc((f.at || '').replace('T', ' '))} · ${esc(f.location || '位置未记录')} · 剩余 ${rem} 管
      </summary>
      ${risk.level !== 'none' ? `<div class="cryo-alert-box risk-${risk.level}"><strong>${risk.level === 'red' ? `⛔ 污染高危（关联 ${risk.hits} 次污染）` : '⚠ 污染预警（关联 1 次污染）'}</strong>：${risk.events.map(ev => esc(ev.reason + ' - ' + ev.sourceName + ' ' + (ev.sourceAt || '').slice(0, 10))).join('；')}</div>` : ''}
      <div class="cryo-meta-grid">
        <div class="cryo-meta-item"><small>细胞类型 / 抗性 / 特殊处理</small><strong>${esc([cryoBatchKind(f) || '未分类', ...(f.resistance_tags || []).map(t => '抗性 ' + t), ...(f.special_treatments || [])].join(' · '))}</strong></div>
        <div class="cryo-meta-item"><small>代次 / 供者来源</small><strong>${esc([f.passage || '未填代次', f.donor || '未填供者'].join(' · '))}</strong></div>
        <div class="cryo-meta-item"><small>管内细胞数</small><strong>${esc(cryoFormatCount(f) || '未记录')}</strong></div>
        <div class="cryo-meta-item"><small>复苏容器备注</small><strong>${esc(f.suggested_vessel || '未记录')}</strong></div>
      </div>
      <p class="muted">关联余量：强相关（同日同组）<strong>${strongRem} 支</strong> · 弱相关（同处理不同日）<strong>${weakRem} 支</strong> · 更弱相关（同细胞其他处理）<strong>${weakerRem} 支</strong></p>
      <div class="actions" style="margin:8px 0">
        ${placed.map(p => `<button type="button" class="cryo-slot-chip" data-jump-box="${esc(p.box.id)}" data-jump-slot="${esc(p.slot)}">${esc(cryoBoxLabel(p.box))} · ${esc(p.slot)}${p.entry.vial_label ? ' (' + esc(p.entry.vial_label) + ')' : ''}</button>`).join('')}
        ${unp > 0 ? `<button type="button" class="button secondary" data-place-lot="${esc(f.id)}">为剩余 ${unp} 管入盒落位</button>` : ''}
        ${unp > 0 && f.storage_stage !== 'gradient' ? `<button type="button" class="button secondary" data-stage-gradient="${esc(f.id)}">设为暂存盒中（${unp} 管）</button>` : ''}
        ${unp > 0 && f.storage_stage === 'gradient' ? `<button type="button" class="text-button" data-stage-unassigned="${esc(f.id)}">移出暂存盒</button>` : ''}
        <button type="button" class="text-button" data-copy-lot="${esc(f.id)}">复制到空位</button>
        <button type="button" class="text-button" data-edit-lot="${esc(f.id)}">编辑冻存信息</button>
      </div>
      ${rem > 0 ? `<button type="button" class="button secondary" data-withdraw-lot="${esc(f.id)}">登记取出</button>` : ''}
      ${(state.frozen_withdrawals || []).filter(w => w.lot_id === f.id).map(w => `<p>${esc(w.at.replace('T', ' '))} · ${w.discarded ? '弃置' : w.mode === 'thaw' ? '取出复苏' : '取出'} ${esc(w.vials)} 管
        ${w.notes ? ' · ' + esc(w.notes) : ''} <button type="button" class="text-button" data-flag-withdrawal="${esc(w.id)}">${w.contamination ? '查看 / 修改污染标记' : '标记污染'}</button></p>`).join('')}
      <p>冻存管编号：${esc(f.labels || '未记录')}</p>
      ${f.sources?.length ? `<p>来源：${esc(f.sources.map(src => [src.name, src.well].join(' / ')).join('、'))}</p>${f.sources.map(s => `<p>${esc(s.name + ' / ' + s.well)}${s.group_name ? ' · ' + esc(s.group_name) : ''} · Day 0 ${esc(s.snapshot?.day0 || '未记录')}　${typeof lineageUnitButton === 'function' ? lineageUnitButton(s.id, s.well) : ''}</p>`).join('')}` : '<p class="muted">直接盘点录入的历史冻存库存</p>'}
      ${f.transfer_id ? `<button type="button" class="text-button" data-lineage="${esc(f.transfer_id)}">查看同次培养流转</button>` : ''}
      ${(() => {
        const exps = cryoLinkedExperiments(f);
        if (!exps.length) return '';
        return `<div class="cryo-linked-exps" style="margin:6px 0;padding-top:6px"><small class="muted">关联实验（${exps.length}）：</small><div class="actions" style="margin-top:4px">${exps.map(item => `<button type="button" class="text-button" data-lab-record="${esc(item.rec.id)}">${esc(item.rec.title || item.rec.id)} · ${esc(item.reason)}</button>`).join('')}</div></div>`;
      })()}
      <p>${esc(f.notes || '')} <small class="muted">${esc(f.id)}</small></p>
    </details>`;
  }).join('');
}

function bindCryoBatches(root) {
  root.querySelectorAll('[data-jump-box]').forEach(b => b.onclick = () => cryoJumpToSlot(b.dataset.jumpBox, b.dataset.jumpSlot));
  root.querySelectorAll('[data-place-lot]').forEach(b => b.onclick = () => startCryoPlaceMode(b.dataset.placeLot));
  root.querySelectorAll('[data-stage-gradient],[data-stage-unassigned]').forEach(b => b.onclick = async () => {
    if (busy) return;
    const toGrad = b.hasAttribute('data-stage-gradient');
    const lotId = b.dataset.stageGradient || b.dataset.stageUnassigned;
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_batch_update', revision: state.revision, payload: {lot_id: lotId, storage_stage: toGrad ? 'gradient' : 'unassigned'}});
      state = res.state;
      renderCryoDynamic();
      toast(toGrad ? '已标记为暂存盒暂存状态。' : '已移出暂存盒状态。');
    } catch (err) { toast(err.message, true); }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  });
  root.querySelectorAll('[data-copy-lot]').forEach(b => b.onclick = () => {
    const lot = (state.frozen_batches || []).find(x => x.id === b.dataset.copyLot);
    if (lot) startCryoCopyMode(lot, lot.location || lot.name);
  });
  root.querySelectorAll('[data-edit-lot]').forEach(b => b.onclick = () => {
    const lot = (state.frozen_batches || []).find(x => x.id === b.dataset.editLot);
    if (lot) openCryoBatchEditDialog(lot);
  });
  if (typeof bindLineageButtons === 'function') bindLineageButtons(root);
  if (typeof bindLabRecordLinks === 'function') bindLabRecordLinks(root);
  root.querySelectorAll('[data-withdraw-lot]').forEach(b => b.onclick = () => {
    const lot = (state.frozen_batches || []).find(x => x.id === b.dataset.withdrawLot);
    if (lot) openCryoRemovalDialog(lot, [], {mode: 'take'});
  });
  root.querySelectorAll('[data-flag-withdrawal]').forEach(b => b.onclick = () => openCryoContaminationDialog(b.dataset.flagWithdrawal));
}

function startCryoPlaceMode(lotId) {
  if (!cryoStorage().boxes.length) {
    toast('请先创建至少一个冻存盒，再将冻存管落入格位。', true);
    openCryoSetupDialog();
    return;
  }
  cryoUi.tab = 'map';
  cryoUi.mode = {type: 'place', lotId, picks: []};
  renderCryoBody();
}

// --- Modal Dialogs (#cryo-dialog) ---

function cryoDialog() { return $('#cryo-dialog'); }

function openCryoGradientDialog() {
  const dialog = cryoDialog();
  if (!dialog) return;
  const grad = cryoGradientSummary();
  const unassignedUnplaced = (state?.frozen_batches || [])
    .filter(lot => lot.storage_stage !== 'gradient' && cryoBatchUnplaced(lot) > 0)
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  dialog.innerHTML = `<div class="dialog-head">
      <div><span class="eyebrow">GRADIENT FREEZER</span><h2>暂存盒状态 · ${grad.totalVials > 0 ? `冻存细胞中（${grad.totalVials} 管）` : '空闲中'}</h2></div>
      <button type="button" class="icon-button" data-cryo-close aria-label="关闭">×</button>
    </div>
    ${grad.batches.length ? grad.batches.map(({lot, unplaced, days}) => `<div class="panel" style="margin:10px 0">
      <div class="section-head" style="margin:0 0 6px">
        <strong>${esc(lot.name)}${lot.special_treatments?.length ? ' · ' + esc(lot.special_treatments.join('/')) : ''}${lot.passage ? ' · ' + esc(lot.passage) : ''}</strong>
        <span class="state-badge is-pending">待入盒 ${unplaced} 管 · 已放 ${days === 0 ? '当天' : days + ' 天'}</span>
      </div>
      <p class="muted" style="margin:0 0 8px">冻存时间：${esc((lot.at || '').replace('T', ' '))}${lot.donor ? ' · 供者：' + esc(lot.donor) : ''}${cryoFormatCount(lot) ? ' · ' + esc(cryoFormatCount(lot)) : ''}${lot.suggested_vessel ? ' · 容器备注：' + esc(lot.suggested_vessel) : ''}</p>
      <div class="actions">
        <button type="button" class="button primary" data-grad-place="${esc(lot.id)}">转入固定库位</button>
        <button type="button" class="button danger" data-grad-discard="${esc(lot.id)}">培养污染 · 放弃入库</button>
        <button type="button" class="button secondary" data-grad-thaw="${esc(lot.id)}">登记取出复苏</button>
        <button type="button" class="button secondary" data-grad-take="${esc(lot.id)}">直接取出</button>
        <button type="button" class="text-button" data-grad-release="${esc(lot.id)}">移出暂存盒（改为未定位）</button>
      </div>
    </div>`).join('') : '<p class="panel muted">当前暂存盒空闲，没有待转入液氮罐或固定冻存盒的细胞。</p>'}
    ${unassignedUnplaced.length ? `<section class="panel" style="margin:12px 0">
      <h4 style="margin:0 0 8px">未定位的已有冻存批次（可直接标为暂存盒暂存或直接入盒）</h4>
      ${unassignedUnplaced.map(lot => {
        const unp = cryoBatchUnplaced(lot);
        return `<div class="section-head" style="margin:6px 0;padding-top:6px;border-top:1px solid var(--line)">
          <div><strong>${esc(lot.name)}</strong>${lot.special_treatments?.length ? ' · ' + esc(lot.special_treatments.join('/')) : ''}<small class="muted" style="display:block">${esc((lot.at || '').replace('T', ' '))} · 未落位 ${unp} 管</small></div>
          <div class="actions">
            <button type="button" class="button secondary" data-grad-stage-in="${esc(lot.id)}">放入暂存盒</button>
            <button type="button" class="text-button" data-grad-place="${esc(lot.id)}">直接入库位</button>
          </div>
        </div>`;
      }).join('')}
    </section>` : ''}
    <div class="dialog-actions"><button type="button" class="button secondary" data-cryo-close>关闭</button></div>`;
  dialog.querySelectorAll('[data-cryo-close]').forEach(b => b.onclick = () => dialog.close());
  dialog.querySelectorAll('[data-grad-place]').forEach(b => b.onclick = () => { dialog.close(); startCryoPlaceMode(b.dataset.gradPlace); });
  dialog.querySelectorAll('[data-grad-stage-in]').forEach(b => b.onclick = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_batch_update', revision: state.revision, payload: {lot_id: b.dataset.gradStageIn, storage_stage: 'gradient'}});
      state = res.state;
      dialog.close();
      renderCryoDynamic();
      openCryoGradientDialog();
      toast('已设为暂存盒暂存状态。');
    } catch (err) { toast(err.message, true); }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  });
  dialog.querySelectorAll('[data-grad-discard]').forEach(b => b.onclick = () => {
    const lot = (state.frozen_batches || []).find(x => x.id === b.dataset.gradDiscard);
    dialog.close();
    if (lot) openCryoRemovalDialog(lot, [], {contaminationDefault: true, defaultReason: ''});
  });
  dialog.querySelectorAll('[data-grad-thaw],[data-grad-take]').forEach(b => b.onclick = () => {
    const lot = (state.frozen_batches || []).find(x => x.id === (b.dataset.gradThaw || b.dataset.gradTake));
    dialog.close();
    if (lot) openCryoRemovalDialog(lot, [], {mode: b.hasAttribute('data-grad-thaw') ? 'thaw' : 'take'});
  });
  dialog.querySelectorAll('[data-grad-release]').forEach(b => b.onclick = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_batch_update', revision: state.revision, payload: {lot_id: b.dataset.gradRelease, storage_stage: 'unassigned'}});
      state = res.state;
      dialog.close();
      renderCryoDynamic();
      toast('已从暂存盒状态移出，仍可在「全部冻存批次」中后续入盒。');
    } catch (err) { toast(err.message, true); }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  });
  dialog.showModal();
}

function openCryoSetupDialog() {
  const dialog = cryoDialog();
  if (!dialog) return;
  const p = {device_name: '', device_kind: 'custom', use_rack: false, rack_name: '', box_count: 1,
    rows: 1, cols: 1, numbering: 'alpha', box_prefix: '冻存盒', box_suffix: ''};
  dialog.innerHTML = `<form id="cryo-setup-form" novalidate>
    <div class="dialog-head"><div><span class="eyebrow">CRYO TOPOLOGY</span><h2>新建冻存设备与冻存盒</h2></div><button type="button" class="icon-button" data-cryo-close aria-label="关闭">×</button></div>
    <div class="two">
      <label>设备名称<input name="device_name" required maxlength="120" value="${esc(p.device_name)}" placeholder="如 液氮罐 1 / -80°C 冰箱 A"></label>
      <label>设备类型<select name="device_kind">${Object.entries(CRYO_DEVICE_LABELS).map(([k, l]) => `<option value="${k}" ${p.device_kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label>设备位置（可选）<input name="device_location" maxlength="300" placeholder="填写设备位置"></label>
    <label class="inline-check" style="margin:10px 0"><input type="checkbox" name="use_rack" ${p.use_rack ? 'checked' : ''}>按吊 / 架分层组织</label>
    <div data-rack-fields ${p.use_rack ? '' : 'hidden'}>
      <label>吊 / 架名称<input name="rack_name" maxlength="120" value="${esc(p.rack_name)}" placeholder="如 1 号吊 / A 架"></label>
    </div>
    <div class="two">
      <label>本次创建盒数 / 层数（1–50）<input name="box_count" type="number" min="1" max="50" step="1" required value="${p.box_count}"></label>
      <label>坐标编号方式<select name="numbering"><option value="alpha" ${p.numbering === 'alpha' ? 'selected' : ''}>行列字母（A1–E5 / A1–I9）</option><option value="numeric" ${p.numbering === 'numeric' ? 'selected' : ''}>顺序数字（1–25 / 1–81）</option></select></label>
    </div>
    <div class="two">
      <label>每盒行数（1–12）<input name="rows" type="number" min="1" max="12" step="1" required value="${p.rows}"></label>
      <label>每盒列数（1–12）<input name="cols" type="number" min="1" max="12" step="1" required value="${p.cols}"></label>
    </div>
    <div class="two">
      <label>盒名前缀<input name="box_prefix" maxlength="80" value="${esc(p.box_prefix)}"></label>
      <label>盒名后缀（可选）<input name="box_suffix" maxlength="40" value="${esc(p.box_suffix)}"></label>
    </div>
    <p role="alert" class="lab-error" id="cryo-form-error" hidden></p>
    <div class="dialog-actions"><button type="button" class="button secondary" data-cryo-close>取消</button><button type="submit" class="button primary">创建库位</button></div>
  </form>`;

  const form = dialog.querySelector('form'), rackFields = dialog.querySelector('[data-rack-fields]');
  form.elements.namedItem('use_rack').onchange = e => {
    rackFields.hidden = !e.target.checked;
  };
  dialog.querySelectorAll('[data-cryo-close]').forEach(b => b.onclick = () => dialog.close());
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const v = n => (form.elements.namedItem(n)?.value || '').trim();
    const payload = {
      device_name: v('device_name'), device_kind: v('device_kind'), device_location: v('device_location'),
      use_rack: form.elements.namedItem('use_rack').checked, rack_name: v('rack_name'),
      box_count: Number(v('box_count')), rows: Number(v('rows')), cols: Number(v('cols')),
      numbering: v('numbering'), box_prefix: v('box_prefix'), box_suffix: v('box_suffix')
    };
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_setup_preset', revision: state.revision, payload});
      state = res.state;
      const newest = state.cryo_storage?.boxes?.at(-payload.box_count);
      if (newest) cryoUi.boxId = newest.id;
      cryoUi.tab = 'map';
      dialog.close();
      renderCryoDynamic();
      toast(`已创建 ${payload.device_name}（${payload.box_count} 盒，${payload.rows}×${payload.cols}）。`);
    } catch (err) {
      const errEl = dialog.querySelector('#cryo-form-error'); errEl.textContent = err.message; errEl.hidden = false;
    } finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  dialog.showModal();
}

function openCryoManageDialog(kind, existing = null, defaults = {}) {
  const dialog = cryoDialog();
  if (!dialog) return;
  const cs = cryoStorage();
  const isEdit = !!existing;
  let body = '';
  if (kind === 'device') {
    body = `<label>设备名称<input name="name" required maxlength="120" value="${esc(existing?.name || '')}"></label>
      <label>设备类型<select name="kind">${Object.entries(CRYO_DEVICE_LABELS).map(([k, l]) => `<option value="${k}" ${(existing?.kind || 'ln2') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>设备位置（可选）<input name="location" maxlength="300" value="${esc(existing?.location || '')}"></label>
      <label>备注<textarea name="notes" maxlength="1000">${esc(existing?.notes || '')}</textarea></label>`;
  } else if (kind === 'rack') {
    const devId = existing?.device_id || defaults.device_id || cs.devices[0]?.id || '';
    body = `<input type="hidden" name="device_id" value="${esc(devId)}">
      <label>吊 / 架名称<input name="name" required maxlength="120" value="${esc(existing?.name || '')}" placeholder="如 2 号吊 / B 架"></label>
      <label>层数（可选，1–50）<input name="layers" type="number" min="1" max="50" step="1" value="${esc(existing?.layers ?? (isEdit ? '' : 6))}"></label>
      ${!isEdit ? `<label class="inline-check" style="margin:8px 0"><input type="checkbox" name="create_boxes" checked>同时按上述层数批量创建同规格层盒</label>
      <div class="two"><label>每盒行数<input name="rows" type="number" min="1" max="12" value="5"></label><label>每盒列数<input name="cols" type="number" min="1" max="12" value="5"></label></div>
      <label>坐标编号方式<select name="numbering"><option value="alpha">行列字母（A1–E5）</option><option value="numeric">顺序数字（1–25）</option></select></label>` : ''}
      <label>备注<textarea name="notes" maxlength="1000">${esc(existing?.notes || '')}</textarea></label>`;
  } else {
    const devId = existing?.device_id || defaults.device_id || cs.devices[0]?.id || '';
    const rackId = existing?.rack_id ?? defaults.rack_id ?? '';
    const lockedShape = isEdit && Object.keys(existing.slots || {}).length > 0;
    const racks = cs.racks.filter(r => r.device_id === devId);
    body = `<input type="hidden" name="device_id" value="${esc(devId)}">
      <label>冻存盒名称<input name="name" required maxlength="120" value="${esc(existing?.name || '')}" placeholder="填写盒名"></label>
      <div class="two">
        <label>所属吊 / 架<select name="rack_id"><option value="">直属设备（不挂吊/架）</option>${racks.map(r => `<option value="${esc(r.id)}" ${r.id === rackId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label>层号（可选）<input name="layer" type="number" min="1" max="50" value="${esc(existing?.layer ?? '')}"></label>
      </div>
      <div class="two">
        <label>行数（1–12）<input name="rows" type="number" min="1" max="12" required value="${existing?.rows || (rackId ? 5 : 9)}" ${lockedShape ? 'disabled' : ''}></label>
        <label>列数（1–12）<input name="cols" type="number" min="1" max="12" required value="${existing?.cols || (rackId ? 5 : 9)}" ${lockedShape ? 'disabled' : ''}></label>
      </div>
      <label>坐标编号方式<select name="numbering" ${lockedShape ? 'disabled' : ''}><option value="alpha" ${(existing?.numbering || 'alpha') === 'alpha' ? 'selected' : ''}>行列字母（A1）</option><option value="numeric" ${existing?.numbering === 'numeric' ? 'selected' : ''}>顺序数字（1–N）</option></select></label>
      ${lockedShape ? '<p class="muted">盒内已有冻存管占用，尺寸与编号方式已锁定（名称与备注可随时修改）。</p>' : ''}
      <label>备注<textarea name="notes" maxlength="1000">${esc(existing?.notes || '')}</textarea></label>`;
  }
  const titles = {device: '冻存设备', rack: '吊 / 架', box: '冻存盒'};
  dialog.innerHTML = `<form id="cryo-manage-form" novalidate>
    <div class="dialog-head"><h2>${isEdit ? '编辑' : '新增'}${titles[kind]}</h2><button type="button" class="icon-button" data-cryo-close aria-label="关闭">×</button></div>
    ${body}
    <p role="alert" class="lab-error" id="cryo-manage-error" hidden></p>
    <div class="dialog-actions">
      ${isEdit ? '<button type="button" class="button danger" id="cryo-manage-delete">删除</button>' : ''}
      <button type="button" class="button secondary" data-cryo-close>取消</button>
      <button type="submit" class="button primary">保存</button>
    </div>
  </form>`;
  dialog.querySelectorAll('[data-cryo-close]').forEach(b => b.onclick = () => dialog.close());
  const form = dialog.querySelector('form'), errEl = dialog.querySelector('#cryo-manage-error');
  const delBtn = dialog.querySelector('#cryo-manage-delete');
  if (delBtn) delBtn.onclick = async () => {
    if (busy) return;
    const msg = kind === 'device' ? `删除设备“${existing.name}”及其下所有空吊/空盒？（可撤销）`
      : kind === 'rack' ? `删除“${existing.name}”及其下所有空盒？（可撤销）`
      : `删除空冻存盒“${existing.name}”？（可撤销）`;
    if (!confirm(msg)) return;
    busy = true;
    try {
      const res = await api('/api/command', {action: `cryo_${kind}_delete`, revision: state.revision, payload: {id: existing.id}});
      state = res.state;
      dialog.close();
      renderCryoDynamic();
      toast('已删除，可随时撤销。');
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const v = n => (form.elements.namedItem(n)?.value || '').trim();
    let payload;
    if (kind === 'device') payload = {...(isEdit ? {id: existing.id} : {}), name: v('name'), kind: v('kind'), location: v('location'), notes: v('notes')};
    else if (kind === 'rack') payload = {
      ...(isEdit ? {id: existing.id} : {}), device_id: v('device_id'), name: v('name'),
      layers: v('layers') ? Number(v('layers')) : null, notes: v('notes'),
      ...(!isEdit && form.elements.namedItem('create_boxes')?.checked ? {create_boxes: true, rows: Number(v('rows')), cols: Number(v('cols')), numbering: v('numbering')} : {})
    };
    else payload = {
      ...(isEdit ? {id: existing.id} : {}), device_id: v('device_id'), rack_id: v('rack_id'), name: v('name'),
      layer: v('layer') ? Number(v('layer')) : null,
      rows: isEdit && Object.keys(existing.slots || {}).length ? existing.rows : Number(v('rows')),
      cols: isEdit && Object.keys(existing.slots || {}).length ? existing.cols : Number(v('cols')),
      numbering: isEdit && Object.keys(existing.slots || {}).length ? (existing.numbering || 'alpha') : v('numbering'),
      notes: v('notes')
    };
    busy = true;
    try {
      const res = await api('/api/command', {action: `cryo_${kind}_save`, revision: state.revision, payload});
      state = res.state;
      dialog.close();
      renderCryoDynamic();
      toast('已保存。');
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  dialog.showModal();
}

function openCryoStockDialog(preselectedSlots = []) {
  const dialog = cryoDialog();
  if (!dialog) return;
  const cells = cryoHistoryCells(), kinds = cryoHistoryKinds();
  const boxes = cryoStorage().boxes;
  const hasSlots = preselectedSlots.length > 0;
  const pickedSlots = new Map(preselectedSlots.map(s => [s.box_id + '|' + s.slot, {box_id: s.box_id, slot: s.slot}]));
  let activeBoxId = preselectedSlots[0]?.box_id || cryoUi.boxId || boxes[0]?.id || '';
  const initialStage = hasSlots ? 'stored' : 'unassigned';
  const boxLabel = hasSlots ? cryoBoxLabel(boxes.find(b => b.id === preselectedSlots[0].box_id) || {}) : '';

  dialog.innerHTML = `<form id="cryo-stock-form" novalidate>
    <div class="dialog-head"><div><span class="eyebrow">CRYO INVENTORY</span><h2>登记已有冻存细胞</h2></div><button type="button" class="icon-button" data-cryo-close aria-label="关闭">×</button></div>
    ${hasSlots ? `<p class="notice" style="margin:0 0 10px">将直接落入：<strong>${esc(boxLabel)} · ${esc(preselectedSlots.map(s => s.slot).join('、'))}</strong>（${preselectedSlots.length} 管）</p>` : ''}
    <div class="two">
      <label>细胞名称 / 细胞系<input name="name" required maxlength="200" list="cryo-cell-list" ></label>
      <label>细胞类型（可选）<input name="cell_kind" maxlength="80" list="cryo-kind-list" placeholder="输入或选择类型"></label>
    </div>
    <datalist id="cryo-cell-list">${cells.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="cryo-kind-list">${kinds.map(k => `<option value="${esc(k)}">`).join('')}</datalist>
    ${cryoTreatmentRowsMarkup([], 'cryo-stock-tx-list')}
    ${cryoResistanceMarkup([])}
    <div class="two">
      <label>细胞冻存时间（北京时间）<input name="at" type="datetime-local" required value="${esc(localMinute())}" max="${esc(localMinute())}"></label>
      <label>冻存管数<input name="vials" type="number" min="1" max="1000" step="1" required value="${hasSlots ? preselectedSlots.length : 1}"></label>
    </div>
    <div class="two">
      <label>细胞代次（可选）<input name="passage" maxlength="60" placeholder="如 P5"></label>
      <label>细胞供者来源（可选）<input name="donor" maxlength="200" ></label>
    </div>
    <div class="two">${cryoSuggestedVesselMarkup('')}</div>
    ${cryoSourceMarkup()}
        ${cryoSciCountMarkup(null)}
    <div class="two">
      <label>冻存管编号（可选，逐管用逗号分开）<input name="labels" maxlength="1000"></label>
      <label>原代细胞原激活日（可选）<input name="day0" type="date"></label>
    </div>
    ${!hasSlots ? `<fieldset class="panel" style="margin:8px 0">
      <legend style="font-size:12px;font-weight:600">存放位置</legend>
      <label class="inline-check"><input type="radio" name="storage_stage" value="stored" ${initialStage === 'stored' ? 'checked' : ''} ${!boxes.length ? 'disabled' : ''}>直接填入冻存盒格位${!boxes.length ? '（请先新建冻存盒）' : ''}</label>
      <label class="inline-check"><input type="radio" name="storage_stage" value="gradient" ${initialStage === 'gradient' ? 'checked' : ''}>登记在暂存盒（待入库位）</label>
      <label class="inline-check"><input type="radio" name="storage_stage" value="unassigned" ${initialStage === 'unassigned' ? 'checked' : ''}>暂不指定格位（仅记入批次记录）</label>
      <div id="cryo-stock-box-picker" ${initialStage === 'stored' ? '' : 'hidden'}></div>
      <label id="cryo-stock-text-loc" hidden style="margin-top:8px">文字位置备注（可选）<input name="location" maxlength="500" placeholder="如 -80°C 临时盒"></label>
    </fieldset>` : ''}
    <label>备注<textarea name="notes" maxlength="5000"></textarea></label>
    <p role="alert" class="lab-error" id="cryo-stock-error" hidden></p>
    <div class="dialog-actions"><button type="button" class="button secondary" data-cryo-close>取消</button><button type="submit" class="button primary">确认入库</button></div>
  </form>`;

  const form = dialog.querySelector('form'), errEl = dialog.querySelector('#cryo-stock-error');
  cryoBindSuggestedVessel(form);
  cryoBindTreatmentRows(form);
  cryoBindResistance(form);
  dialog.querySelectorAll('[data-cryo-close]').forEach(b => b.onclick = () => dialog.close());

  if (!hasSlots) {
    const boxWrap = dialog.querySelector('#cryo-stock-box-picker'), textLoc = dialog.querySelector('#cryo-stock-text-loc');
    const drawMiniPicker = () => {
      if (!boxes.length) return;
      const box = boxes.find(b => b.id === activeBoxId) || boxes[0]; activeBoxId = box.id;
      const keys = cryoSlotKeys(box);
      boxWrap.innerHTML = `<label style="margin-top:8px">选择冻存盒<select id="cryo-stock-box-sel">${boxes.map(b => `<option value="${esc(b.id)}" ${b.id === box.id ? 'selected' : ''}>${esc(cryoBoxLabel(b))}（空 ${b.rows * b.cols - Object.keys(b.slots || {}).length}/${b.rows * b.cols}）</option>`).join('')}</select></label>
        <p class="muted" style="margin:6px 0 4px">点击空位即可选格（已选 ${pickedSlots.size} 格；选格后会自动同步冻存管数）</p>
        <div class="cryo-picker-mini" style="grid-template-columns:repeat(${box.cols},minmax(0,1fr))">${keys.map(k => {
          const full = box.id + '|' + k, occ = !!box.slots?.[k], sel = pickedSlots.has(full);
          return `<button type="button" data-sp-slot="${esc(k)}" class="${sel ? 'selected' : ''}" ${occ ? 'disabled' : ''}>${esc(k)}</button>`;
        }).join('')}</div>`;
      boxWrap.querySelector('#cryo-stock-box-sel').onchange = e => { activeBoxId = e.target.value; drawMiniPicker(); };
      boxWrap.querySelectorAll('[data-sp-slot]').forEach(btn => btn.onclick = () => {
        const k = btn.dataset.spSlot, full = box.id + '|' + k;
        if (pickedSlots.has(full)) pickedSlots.delete(full);
        else pickedSlots.set(full, {box_id: box.id, slot: k});
        if (pickedSlots.size > 0) form.elements.namedItem('vials').value = String(pickedSlots.size);
        drawMiniPicker();
      });
    };
    const syncStage = () => {
      const stage = form.querySelector('[name="storage_stage"]:checked')?.value || 'unassigned';
      boxWrap.hidden = stage !== 'stored';
      textLoc.hidden = stage !== 'unassigned';
      if (stage === 'stored') drawMiniPicker();
    };
    form.querySelectorAll('[name="storage_stage"]').forEach(r => r.onchange = syncStage);
    syncStage();
  }

  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const v = n => (form.elements.namedItem(n)?.value || '').trim();
    const vials = Number(v('vials'));
    const stage = hasSlots ? 'stored' : (form.querySelector('[name="storage_stage"]:checked')?.value || 'unassigned');
    const placements = stage === 'stored' ? [...pickedSlots.values()] : [];
    if (stage === 'stored' && !placements.length) {
      errEl.textContent = '请在上方冻存盒网格中至少点选 1 个空位，或切换为暂存盒 / 未定位。'; errEl.hidden = false; return;
    }
    if (stage === 'stored' && vials < placements.length) {
      errEl.textContent = `冻存管数不能少于已选格位数（${placements.length}）。`; errEl.hidden = false; return;
    }
    const payload = {
      name: v('name'), cell_kind: v('cell_kind'), special_treatments: cryoReadTreatmentRows(form),
      resistance_tags: cryoReadResistance(form),
      at: v('at'), vials, passage: v('passage'), donor: v('donor'),
      suggested_vessel: cryoReadSuggestedVessel(form), per_vial_count: cryoReadSciCount(form),
      labels: v('labels'), day0: v('day0'), notes: v('notes'),
        source: JSON.parse(v('cryo_source') || 'null'),
      storage_stage: stage,
      ...(placements.length ? {placements} : {location: v('location')})
    };
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_stock_create', revision: state.revision, payload});
      state = res.state;
      if (placements.length) cryoUi.boxId = placements[0].box_id;
      cryoUi.selectedSlots.clear();
      dialog.close();
      renderCryoDynamic();
      toast('冻存库存已登记。');
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  dialog.showModal();
}

function openCryoRemovalDialog(lot, preselectedSlots = [], options = {}) {
  const dialog = cryoDialog();
  if (!dialog || !lot) return;
  const rem = cryoBatchRemaining(lot);
  if (rem <= 0) return toast('该批次已无剩余冻存管可弃置。', true);
  const placed = cryoBatchPlacedSlots(lot.id);
  const unplaced = cryoBatchUnplaced(lot);
  const preSet = new Set((preselectedSlots || []).map(s => s.box_id + '|' + s.slot));
  const initVials = preSet.size || 1;
  if (!preSet.size && placed.length && initVials > unplaced) {
    for (let i = 0; i < Math.min(initVials - unplaced, placed.length); i++) preSet.add(placed[i].box.id + '|' + placed[i].slot);
  }
  const mode = options.mode || 'discard';
  const label = {discard: '弃置', take: '取出', thaw: '取出复苏'}[mode];
  const defaultReason = options.defaultReason || '';
  const defaultContam = options.contaminationDefault === true;

  dialog.innerHTML = `<form id="cryo-discard-form" novalidate>
    <div class="dialog-head"><div><h2>登记${label}冻存管</h2></div><button type="button" class="icon-button" data-cryo-close aria-label="关闭">×</button></div>
    <p class="muted">批次：<strong>${esc(lot.name)}${lot.special_treatments?.length ? ' · ' + esc(lot.special_treatments.join('/')) : ''}</strong> · 剩余 ${rem} 管（${lot.storage_stage === 'gradient' && unplaced > 0 ? `暂存盒中 ${unplaced} 管` : `已入盒 ${placed.length} 管`}）</p>
    <div class="two">
      <label>${label}时间（北京时间）<input name="at" type="datetime-local" required value="${esc(localMinute())}" max="${esc(localMinute())}"></label>
      <label>${label}管数<input name="vials" type="number" min="1" max="${rem}" step="1" required value="${initVials}"></label>
    </div>
    ${placed.length ? `<fieldset class="panel" style="margin:8px 0"><legend style="font-size:12px;font-weight:600">选择要${label}并释放的冻存盒格位（${unplaced > 0 ? `另有 ${unplaced} 管未入盒，可少选格位` : '勾选数须等于出库管数'}）</legend><div style="display:flex;flex-wrap:wrap;gap:6px 12px">${placed.map(p => {
      const full = p.box.id + '|' + p.slot;
      return `<label class="inline-check"><input type="checkbox" name="discard_slot" value="${esc(full)}" ${preSet.has(full) ? 'checked' : ''}>${esc(cryoBoxLabel(p.box))} · <strong>${esc(p.slot)}</strong></label>`;
    }).join('')}</div></fieldset>` : ''}
    <label>原因（可选）<input name="reason" maxlength="500" value="${esc(defaultReason)}"></label>
    <label class="inline-check" ${mode !== 'discard' ? 'hidden' : ''}><input type="checkbox" name="is_contamination" ${defaultContam ? 'checked' : ''}>同时记录污染标记</label>
    <div data-contam-extra ${defaultContam ? '' : 'hidden'}>
      <label>污染类型（可选）<input name="contamination_kind" maxlength="80"></label>
    </div>
    <label>补充备注（可选）<textarea name="notes" maxlength="500"></textarea></label>
    <p role="alert" class="lab-error" id="cryo-discard-error" hidden></p>
    <div class="dialog-actions"><button type="button" class="button secondary" data-cryo-close>取消</button><button type="submit" class="button ${mode === 'discard' ? 'danger' : 'primary'}">确认${label}</button></div>
  </form>`;

  const form = dialog.querySelector('form'), errEl = dialog.querySelector('#cryo-discard-error');
  const contamBox = form.elements.namedItem('is_contamination'), contamExtra = dialog.querySelector('[data-contam-extra]');
  contamBox.onchange = () => { contamExtra.hidden = !contamBox.checked; };
  dialog.querySelectorAll('[data-cryo-close]').forEach(b => b.onclick = () => dialog.close());
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const v = n => (form.elements.namedItem(n)?.value || '').trim();
    const chosenSlots = placed.length ? [...form.querySelectorAll('[name="discard_slot"]:checked')].map(i => {
      const [box_id, slot] = i.value.split('|'); return {box_id, slot};
    }) : undefined;
    busy = true;
    try {
      const res = await api('/api/command', {
        action: mode === 'discard' ? 'cryo_discard_vials' : 'cryo_withdraw_vials', revision: state.revision,
        payload: {
          lot_id: lot.id, at: v('at'), vials: Number(v('vials')), mode,
          ...(chosenSlots !== undefined ? {slots: chosenSlots} : {}),
          reason: v('reason'), is_contamination: contamBox.checked,
          contamination_kind: contamBox.checked ? v('contamination_kind') : '',
          notes: v('notes')
        }
      });
      state = res.state;
      cryoUi.selectedSlots.clear();
      dialog.close();
      render();
      toast(`已登记${label}并更新库存。`);
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  dialog.showModal();
}

function openCryoBatchEditDialog(lot, slotContext = null) {
  const dialog = cryoDialog();
  if (!dialog) return;
  const unplaced = cryoBatchUnplaced(lot), kinds = cryoHistoryKinds();
  const selSlots = slotContext?.slots?.length ? slotContext.slots : (slotContext?.slot ? [slotContext.slot] : []);
  const canSplit = Boolean(slotContext?.box && selSlots.length && selSlots.length < lot.vials);
  const singleSlot = selSlots.length === 1 ? selSlots[0] : '';
  dialog.innerHTML = `<form id="cryo-edit-form" novalidate>
    <div class="dialog-head"><div><span class="eyebrow">EDIT FROZEN LOT</span><h2>编辑冻存信息</h2></div><button type="button" class="icon-button" data-cryo-close aria-label="关闭">×</button></div>
    ${canSplit ? `<fieldset class="cryo-edit-scope">
      <legend>修改范围</legend>
      <label class="inline-check"><input type="radio" name="edit_scope" value="split" checked>仅修改当前选中格位（${esc(selSlots.join('、'))}，共 ${selSlots.length} 管）— 拆出独立记录，不影响同批其余 ${lot.vials - selSlots.length} 管</label>
      <label class="inline-check"><input type="radio" name="edit_scope" value="batch">同步修改整批全部 ${lot.vials} 管</label>
    </fieldset>` : ''}
    <div class="two">
      <label>细胞名称 / 细胞系<input name="name" required maxlength="200" value="${esc(lot.name)}"></label>
      <label>细胞类型（可选）<input name="cell_kind" maxlength="80" list="cryo-edit-kinds" value="${esc(cryoBatchKind(lot))}" placeholder="输入或选择类型"></label>
    </div>
    <datalist id="cryo-edit-kinds">${kinds.map(k => `<option value="${esc(k)}">`).join('')}</datalist>
    ${cryoTreatmentRowsMarkup(lot.special_treatments || [], 'cryo-edit-tx-list')}
    ${cryoResistanceMarkup(lot.resistance_tags || [])}
    <div class="two">
      <label>冻存时间<input name="at" type="datetime-local" required value="${esc((lot.at || '').slice(0, 16))}" max="${esc(localMinute())}"></label>
      <label>细胞代次<input name="passage" maxlength="60" value="${esc(lot.passage || '')}"></label>
    </div>
    <div class="two">
      <label>细胞供者来源<input name="donor" maxlength="200" value="${esc(lot.donor || '')}"></label>
      <label>原代细胞原激活日<input name="day0" type="date" value="${esc(lot.day0 || '')}"></label>
    </div>
    <div class="two">${cryoSuggestedVesselMarkup(lot.suggested_vessel || '')}</div>
    ${cryoSciCountMarkup(lot.per_vial_count, lot.per_vial)}
    ${singleSlot && slotContext?.entry ? `<label>当前格位 ${esc(singleSlot)} 的单管编号（可选）<input name="slot_vial_label" maxlength="120" value="${esc(slotContext.entry?.vial_label || '')}"></label>` : ''}
    <label>批次管号文本（可选）<input name="labels" maxlength="1000" value="${esc(lot.labels || '')}"></label>
    ${unplaced > 0 ? `<label data-unplaced-stage ${canSplit ? 'hidden' : ''}>未落位 ${unplaced} 管的暂存状态<select name="storage_stage"><option value="gradient" ${lot.storage_stage === 'gradient' ? 'selected' : ''}>在暂存盒中</option><option value="unassigned" ${lot.storage_stage !== 'gradient' ? 'selected' : ''}>未定位（不在暂存盒）</option></select></label>` : ''}
    <label>备注<textarea name="notes" maxlength="5000">${esc(lot.notes || '')}</textarea></label>
    <p role="alert" class="lab-error" id="cryo-edit-error" hidden></p>
    <div class="dialog-actions"><button type="button" class="button secondary" data-cryo-close>取消</button><button type="submit" class="button primary">保存修改</button></div>
  </form>`;
  const form = dialog.querySelector('form'), errEl = dialog.querySelector('#cryo-edit-error');
  cryoBindSuggestedVessel(form);
  cryoBindTreatmentRows(form);
  cryoBindResistance(form);
  if (canSplit) {
    const stageWrap = form.querySelector('[data-unplaced-stage]');
    form.querySelectorAll('input[name="edit_scope"]').forEach(r => r.onchange = () => {
      if (stageWrap) stageWrap.hidden = form.querySelector('input[name="edit_scope"]:checked')?.value === 'split';
    });
  }
  dialog.querySelectorAll('[data-cryo-close]').forEach(b => b.onclick = () => dialog.close());
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const v = n => (form.elements.namedItem(n)?.value || '').trim();
    const isSplit = canSplit && form.querySelector('input[name="edit_scope"]:checked')?.value === 'split';
    const count = cryoReadSciCount(form);
    const payload = {
      lot_id: lot.id, name: v('name'), cell_kind: v('cell_kind'),
      special_treatments: cryoReadTreatmentRows(form),
      resistance_tags: cryoReadResistance(form),
      at: v('at'), passage: v('passage'), donor: v('donor'), day0: v('day0'),
      suggested_vessel: cryoReadSuggestedVessel(form), per_vial_count: count,
      ...(!count && !lot.per_vial_count && lot.per_vial ? {per_vial: lot.per_vial} : {}),
      labels: v('labels'), notes: v('notes'),
      ...(isSplit ? {split_slots: selSlots.map(slot => ({box_id: slotContext.box.id, slot}))} : {}),
      ...(!isSplit && unplaced > 0 ? {storage_stage: v('storage_stage')} : {}),
      ...(singleSlot && slotContext?.entry ? {slot_update: {box_id: slotContext.box.id, slot: singleSlot, vial_label: v('slot_vial_label')}} : {})
    };
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_batch_update', revision: state.revision, payload});
      state = res.state;
      dialog.close();
      renderCryoDynamic();
      toast(isSplit ? `已拆出 ${selSlots.join('、')} 并更新信息。` : '冻存信息已更新。');
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  dialog.showModal();
}

function openCryoContaminationDialog(withdrawalId) {
  const dialog = cryoDialog();
  if (!dialog) return;
  const entry = (state?.frozen_withdrawals || []).find(w => w.id === withdrawalId);
  if (!entry) return toast('找不到对应的取出 / 复苏记录。', true);
  const lot = (state?.frozen_batches || []).find(b => b.id === entry.lot_id);
  const existing = entry.contamination;

  dialog.innerHTML = `<form id="cryo-contam-form" novalidate>
    <div class="dialog-head"><div><span class="eyebrow">CONTAMINATION ALERT</span><h2>${existing ? '修改 / 撤销污染标记' : '标记复苏后细胞污染'}</h2></div><button type="button" class="icon-button" data-cryo-close aria-label="关闭">×</button></div>
    <p class="muted">批次：<strong>${esc(lot?.name || entry.lot_id)}</strong> · 取出/复苏时间 ${esc((entry.at || '').replace('T', ' '))}（${entry.vials} 管）</p>
    <p class="muted">标记后将自动对强相关同批次及冻存时间靠后的同类型细胞打标：1 次标黄，2 次及以上标红。</p>
    <div class="two">
      <label>发现污染时间（北京时间）<input name="at" type="datetime-local" required value="${esc(existing?.at || localMinute())}" max="${esc(localMinute())}"></label>
      <label>污染类型（可选）<input name="kind" maxlength="80" list="cryo-contam-kinds" value="${esc(existing?.kind || '')}" placeholder="如 细菌 / 真菌 / 支原体"></label>
    </div>
    <datalist id="cryo-contam-kinds"><option value="细菌"><option value="真菌"><option value="支原体"><option value="黑胶虫 / 不明污染"></datalist>
    <label>污染现象与处理备注（可选）<textarea name="notes" maxlength="1000">${esc(existing?.notes || '')}</textarea></label>
    <p role="alert" class="lab-error" id="cryo-contam-error" hidden></p>
    <div class="dialog-actions">
      ${existing ? '<button type="button" class="button danger" id="cryo-contam-clear">撤销污染标记</button>' : ''}
      <button type="button" class="button secondary" data-cryo-close>取消</button>
      <button type="submit" class="button primary">${existing ? '保存更新' : '确认标记污染'}</button>
    </div>
  </form>`;

  const form = dialog.querySelector('form'), errEl = dialog.querySelector('#cryo-contam-error');
  dialog.querySelectorAll('[data-cryo-close]').forEach(b => b.onclick = () => dialog.close());
  const clearBtn = dialog.querySelector('#cryo-contam-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await api('/api/command', {action: 'cryo_mark_contamination', revision: state.revision, payload: {withdrawal_id: withdrawalId, clear: true}});
      state = res.state;
      dialog.close();
      render();
      toast('已撤销污染标记，相关冻存库位预警已自动重算。');
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const v = n => (form.elements.namedItem(n)?.value || '').trim();
    busy = true;
    try {
      const res = await api('/api/command', {
        action: 'cryo_mark_contamination', revision: state.revision,
        payload: {withdrawal_id: withdrawalId, at: v('at'), kind: v('kind'), notes: v('notes')}
      });
      state = res.state;
      dialog.close();
      render();
      toast('已标记复苏后污染，相关冻存格位已按次数更新黄/红预警。');
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { busy = false; if (typeof renderUndoControl === 'function') renderUndoControl(); }
  };
  dialog.showModal();
}
