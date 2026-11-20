'use strict';
function countDefaults(value){
  return {mode:value?.mode==='total'?'total':'concentration',coefficient:value?.coefficient??'',exponent:value?.exponent??'0',unit:value?.unit??'',volume_value:value?.volume_value??'',volume_unit:value?.volume_unit??'',measured_at:value?.measured_at??''};
}
function countUnitHistory(kind,wells=[]){
  const common={concentration_units:['cells/mL','cells/μL','个/mL','个/μL'],total_units:['cells','个'],volume_units:['mL','μL','L']};
  const values=[],seen=new Set();
  const add=value=>{if(typeof value!=='string'||!value.trim())return;const text=value.trim();if(!seen.has(text)){seen.add(text);values.push(text);}};
  (boot.count_history?.[kind]||[]).forEach(add);
  [...(state.containers||[]).flatMap(c=>Object.values(c.wells)),...wells].forEach(w=>{
    if(kind==='total_units'&&w.seeding)add(w.seeding.unit);
    const value=w.cell_count;if(!value)return;
    if(kind==='volume_units')add(value.volume_unit);else if(kind===value.mode+'_units')add(value.unit);
  });
  common[kind].forEach(add);return values;
}
function countAutocompleteMarkup(key,value){
  return `<div class="cell-autocomplete"><input id="count-${key}" data-count-field="${key}" type="text" value="${esc(value)}" placeholder="输入或选择单位" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="count-${key}-suggestions"><div id="count-${key}-suggestions" class="cell-name-suggestions" role="listbox" aria-label="单位选项" hidden></div></div>`;
}
function countEditorMarkup(wells){
  const records=wells.map(w=>w.cell_count?countDefaults(w.cell_count):null),mixed=new Set(records.map(value=>JSON.stringify(value))).size>1;
  const value=countDefaults(mixed?null:records[0]);if(!value.measured_at)value.measured_at=localMinute();
  return `<section id="count-editor" class="count-editor" aria-labelledby="count-heading">
    <h3 id="count-heading">细胞计数</h3>
    <label class="count-apply"><input type="checkbox" data-count-apply>保存此计数到所选培养单元</label>
    <div class="actions"><button type="button" class="text-button" data-count-new>新记一次</button>${records.some(Boolean)?'<button type="button" class="text-button" data-count-clear>清除当前计数</button>':''}</div>
    <p class="count-help" data-count-clear-note hidden>保存后移除当前计数，既有操作历史和快照保留。点击“新记一次”可重新录入。</p>
    <p class="count-help">填写本次测量结果；保存整条计数记录。未勾选时保留各孔原记录。</p>
    ${wells.some(w=>w.components)?'<p class="count-help">混合培养的计数针对整个孔，不分别代表每种细胞的数量。</p>':''}
    ${mixed?'<p class="count-mixed">所选孔计数不同或部分未记录；勾选后统一替换。</p>':''}
    <label>记录方式<select data-count-field="mode"><option value="concentration" ${value.mode==='concentration'?'selected':''}>细胞浓度</option><option value="total" ${value.mode==='total'?'selected':''}>细胞总数</option></select></label>
    <div class="count-number"><label>数值 / 系数<input data-count-field="coefficient" type="text" inputmode="decimal" pattern="(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)" value="${esc(value.coefficient)}" placeholder="未记录"></label><span class="count-times" aria-hidden="true">× 10</span><label>指数<input data-count-field="exponent" type="number" step="1" list="count-exponents" value="${esc(value.exponent)}" aria-label="10 的指数，可直接输入"></label></div>
    <datalist id="count-exponents">${[0,3,4,5,6,7,8,9].map(n=>`<option value="${n}"></option>`).join('')}</datalist>
    <p class="count-help">直接填写普通数值时，指数保留 0。</p>
    <label>计数单位${countAutocompleteMarkup('unit',value.unit)}</label>
    <div data-count-volume ${value.mode==='total'?'hidden':''}><div class="count-pair"><label>大致培养基体积（可选）<input data-count-field="volume_value" type="text" inputmode="decimal" pattern="(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)" value="${esc(value.volume_value)}" placeholder="未记录"></label><label>体积单位${countAutocompleteMarkup('volume_unit',value.volume_unit)}</label></div></div>
    <p data-count-estimate class="count-estimate" aria-live="polite" hidden></p>
    <label>计数时间（北京时间）<input data-count-field="measured_at" type="datetime-local" value="${esc(value.measured_at)}"></label>
  </section>`;
}
function countReadEditor(root){
  const value=Object.fromEntries(['mode','coefficient','exponent','unit','volume_value','volume_unit','measured_at'].map(key=>[key,root.querySelector(`[data-count-field="${key}"]`).value.trim()]));
  if(value.mode==='total'){value.volume_value='';value.volume_unit='';}return value;
}
function countEstimate(value){
  if(!value||value.mode!=='concentration')return '';
  const perML={'cells/mL':1,'个/mL':1,'cells/μL':1000,'个/μL':1000,'cells/uL':1000,'cells/µL':1000,'个/uL':1000,'个/µL':1000};
  const volumeML={mL:1,'μL':0.001,uL:0.001,'µL':0.001,L:1000};
  const decimal=/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
  if(!decimal.test(value.coefficient)||!decimal.test(value.volume_value)||!/^[-+]?\d+$/.test(value.exponent)||!Object.hasOwn(perML,value.unit)||!Object.hasOwn(volumeML,value.volume_unit))return '';
  const total=Number(value.coefficient)*10**Number(value.exponent)*perML[value.unit]*Number(value.volume_value)*volumeML[value.volume_unit];
  if(!Number.isFinite(total)||(total===0&&Number(value.coefficient)>0&&Number(value.volume_value)>0))return '';
  const [coefficient,exponent]=total.toExponential(3).split('e');
  return `按大致体积估算≈ ${Number(coefficient)} × 10^${Number(exponent)} ${value.unit.startsWith('个')?'个':'cells'}`;
}
function bindCountEditor(wells){
  const root=$('#count-editor');if(!root)return;
  const box=root.querySelector('[data-count-apply]'),field=key=>root.querySelector(`[data-count-field="${key}"]`);
  function sync(){
    const value=countReadEditor(root),volume=value.mode==='concentration';
    const clearing=box.checked&&root.dataset.countClear==='true';
    root.querySelector('[data-count-clear-note]').hidden=!clearing;
    root.classList.toggle('enabled',box.checked);root.querySelector('[data-count-volume]').hidden=!volume;
    ['coefficient','exponent','unit','measured_at'].forEach(key=>{field(key).required=box.checked&&!clearing;});
    ['coefficient','volume_value'].forEach(key=>{if(box.checked)field(key).setAttribute('pattern','(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)');else field(key).removeAttribute('pattern');});
    field('exponent').step=box.checked?'1':'any';
    field('volume_unit').required=box.checked&&volume&&value.volume_value!=='';
    const estimate=countEstimate(value),output=root.querySelector('[data-count-estimate]');output.textContent=estimate;output.hidden=!estimate;
    // Hidden volume fields must not block total-count saves with stale input.
    field('volume_value').disabled=!volume;field('volume_unit').disabled=!volume;
    root.querySelectorAll('[data-count-field]').forEach(input=>{input.disabled=clearing||(['volume_value','volume_unit'].includes(input.dataset.countField)&&!volume);});
    if(clearing)output.hidden=true;
  }
  box.addEventListener('change',()=>{dirty=true;sync();});
  root.querySelectorAll('[data-count-field]').forEach(input=>input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{
    root.dataset.countClear='';
    if(input===field('mode')){field('unit').value='';root.querySelector('#count-unit-suggestions').hidden=true;field('unit').setAttribute('aria-expanded','false');}
    box.checked=true;dirty=true;sync();
  }));
  ['unit','volume_unit'].forEach(key=>attachHistoryAutocomplete(field(key),root.querySelector(`#count-${key}-suggestions`),()=>countUnitHistory(key==='unit'?field('mode').value+'_units':'volume_units',wells),{label:'单位',filter:filterTreatments}));
  root.querySelector('[data-count-new]').onclick=()=>{root.dataset.countClear='';field('coefficient').value='';field('volume_value').value='';field('measured_at').value=localMinute();box.checked=true;dirty=true;sync();field('coefficient').focus();};
  const clear=root.querySelector('[data-count-clear]');if(clear)clear.onclick=markCountForClear;
  sync();
}
function markCountForClear(){
  const root=$('#count-editor');if(!root)return;
  root.dataset.countClear='true';const box=root.querySelector('[data-count-apply]');box.checked=true;
  box.dispatchEvent(new box.ownerDocument.defaultView.Event('change',{bubbles:true}));
}
function collectCountPatch(){
  const root=$('#count-editor');return root?.querySelector('[data-count-apply]').checked?(root.dataset.countClear==='true'?{clear:true}:countReadEditor(root)):null;
}
function countSummary(value){
  if(!value||value.coefficient===''||value.coefficient==null)return '细胞计数未记录';
  const v=countDefaults(value),number=`${v.coefficient} × 10^${v.exponent}${v.unit?' '+v.unit:''}`;
  const volume=v.mode==='concentration'&&v.volume_value!==''?` · 大致体积 ${v.volume_value}${v.volume_unit?' '+v.volume_unit:''}`:'';
  return `${v.mode==='total'?'细胞总数':'细胞浓度'} ${number}${volume}${v.measured_at?' · 计数时间 '+v.measured_at.replace('T',' '):''}`;
}
function countDetailsMarkup(value){
  const estimate=countEstimate(value);
  return `<section class="count-details"><h4>细胞计数</h4><p>${esc(countSummary(value))}</p>${estimate?`<p class="count-estimate">${esc(estimate)}</p>`:''}</section>`;
}

function seedingSummary(value){
  if(!value)return '';
  return `${value.addition?'本次加入':'铺入'}：${value.coefficient} × 10^${value.exponent} ${value.unit} / ${value.per||'培养单元'}${value.at?' · 操作时间 '+value.at.replace('T',' '):''}`;
}
function seedingDetailsMarkup(value){return value?`<section class="count-details seeding-details"><h4>铺入细胞记录</h4><p>${esc(seedingSummary(value))}</p></section>`:'';}
function transferSeedingUnit(c){return !c?'培养单元':boot.layouts[c.type]?'孔':dishType(c.type)?'皿':'瓶';}
function transferSeedingSummary(t,c){return t.seedingEnabled?seedingSummary({...t.seeding,per:transferSeedingUnit(c),addition:!!t.append}):'铺入细胞数未记录';}
function targetSeedingPayload(t){
  if(!t.seedingEnabled)return {};
  const value=t.seeding||{},coefficient=(value.coefficient||'').trim(),exponent=(value.exponent||'').trim(),unit=(value.unit||'').trim();
  if(!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(coefficient)||!Number.isFinite(Number(coefficient)))throw new Error('铺入细胞数须为非负有限数值');
  if(!/^[+-]?\d+$/.test(exponent)||exponent.length>12)throw new Error('铺入数量的指数须为整数');
  if(!unit)throw new Error('请填写铺入数量单位');
  return {seeding:{coefficient,exponent,unit}};
}
function transferSeedingMarkup(t,c,index){
  const v=t.seeding||{coefficient:'',exponent:'0',unit:'cells'},per=transferSeedingUnit(c);
  return `<section class="transfer-seeding"><label class="inline-check"><input type="checkbox" data-target-seeding-enable="${index}" ${t.seedingEnabled?'checked':''}>记录铺入细胞数（可选）</label><div data-seeding-editor="${index}" ${t.seedingEnabled?'':'hidden'}><p class="muted">本次铺入细胞总数 · 每${per}。应用到本组全部所选培养单元；数量不同可分为不同去向组。</p><div class="seeding-number"><label>数值 / 系数<input data-seeding-field="coefficient" inputmode="decimal" value="${esc(v.coefficient)}" placeholder="未记录" maxlength="80"></label><span aria-hidden="true">× 10</span><label>指数<input data-seeding-field="exponent" type="number" step="1" list="seeding-exponents-${index}" value="${esc(v.exponent)}" aria-label="铺入数量10的指数"></label><label>单位<div class="cell-autocomplete"><input id="seeding-unit-${index}" data-seeding-field="unit" value="${esc(v.unit)}" maxlength="100" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="seeding-unit-${index}-suggestions"><div id="seeding-unit-${index}-suggestions" class="cell-name-suggestions" role="listbox" hidden></div></div></label><span>/ ${per}</span></div><datalist id="seeding-exponents-${index}">${[0,3,4,5,6,7,8,9].map(n=>`<option value="${n}"></option>`).join('')}</datalist><p class="muted">普通整数可直接填写，指数保留 0。${transferDraft.mode==='mix'?'此处填写本组所有来源合计的本次加入量，不含目标原有细胞。':''}</p></div></section>`;
}
function bindTransferSeeding(){
  document.querySelectorAll('[data-target-seeding-enable]').forEach(box=>{
    const index=+box.dataset.targetSeedingEnable,t=transferDraft.targets[index],root=$(`[data-seeding-editor="${index}"]`);
    const edit=action=>{try{assertTransferTargetEditable(index);action();invalidateTransfer();}catch(error){toast(error.message,true);renderTransfer();}};
    box.onchange=()=>edit(()=>{t.seedingEnabled=box.checked;if(t.seedingEnabled)t.seeding||={coefficient:'',exponent:'0',unit:'cells'};renderTransfer();});
    root.querySelectorAll('[data-seeding-field]').forEach(input=>input.oninput=()=>edit(()=>{t.seeding||={coefficient:'',exponent:'0',unit:'cells'};t.seeding[input.dataset.seedingField]=input.value;}));
    attachHistoryAutocomplete(root.querySelector('[data-seeding-field="unit"]'),root.querySelector(`#seeding-unit-${index}-suggestions`),()=>countUnitHistory('total_units'),{label:'数量单位',filter:filterTreatments});
  });
}
