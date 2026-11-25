'use strict';
function mediumDefaults(medium){
  const source=medium||{};
  return {base:source.base??'',fbs:source.fbs??'',hs:source.hs??'',ps:source.ps||'unknown',triple:source.triple||'unknown',cytokines:source.cytokines||[],extra:source.extra||'unknown',additives:source.additives||[]};
}
function mediumCommon(wells,key){
  const values=wells.map(w=>mediumDefaults(w.medium)[key]);
  const mixed=values.some(value=>JSON.stringify(value)!==JSON.stringify(values[0]));
  return {mixed,value:mixed?mediumDefaults()[key]:(values[0]??mediumDefaults()[key])};
}
function mediumNameHistory(kind,wells=[]){
  const names=[],seen=new Set();
  const add=value=>{if(typeof value!=='string'||!value.trim())return;const text=value.trim(),key=text.toLowerCase();if(!seen.has(key)){seen.add(key);names.push(text);}};
  (boot.medium_history?.[kind]||[]).forEach(add);
  const saved=(state.containers||[]).flatMap(c=>Object.values(c.wells));
  [...saved,...wells].forEach(w=>{const medium=w.medium||{};if(kind==='bases')add(medium.base);else(medium[kind]||[]).forEach(row=>add(row.name));});
  return names;
}
function additiveHistory(wells){
  const history=boot.medium_history;
  if(Array.isArray(history?.additive_entries))return history.additive_entries;
  // Older server responses contain names only. Recover observed doses where available.
  const entries=new Map(),known=new Set();
  const recipes=[...(boot.medium_recipes||[]),...wells.map(w=>w.medium)];
  for(const c of state.containers||[])recipes.push(c.medium_defaults,...Object.values(c.wells).map(w=>w.medium));
  for(const recipe of recipes)for(const row of recipe?.additives||[]){
    if(!row.name)continue;
    const name=row.name.toLowerCase();
    known.add(name);
    entries.set(JSON.stringify([name,row.concentration,row.unit]),row);
  }
  const missing=(history?.additives||[]).filter(name=>!known.has(name.toLowerCase()));
  return [...entries.values(),...missing.map(name=>({name,concentration:'',unit:''}))];
}
function mediumAutocompleteInput(id,attributes,value){
  return `<div class="cell-autocomplete"><input id="${id}" ${attributes} value="${esc(value)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-suggestions"><div id="${id}-suggestions" class="cell-name-suggestions" role="listbox" hidden></div></div>`;
}
function mediumRowsMarkup(key,rows,namespace=''){
  return rows.map((row,index)=>`<div class="medium-row" data-medium-row>
    <label class="medium-name-label">名称${mediumAutocompleteInput(`${namespace}medium-${key}-${index}`,'data-medium-part="name" placeholder="输入名称或选择历史记录"',row.name)}</label>
    <div class="medium-dose"><label>浓度<input data-medium-part="concentration" type="number" min="0" step="any" inputmode="decimal" placeholder="未记录" value="${esc(row.concentration)}"></label><label>单位${unitChoice(`<input data-medium-part="unit" type="text" placeholder="填写单位" value="${esc(row.unit)}">`,unitPresets.concentration,'浓度单位')}</label></div>
    <button type="button" class="text-button medium-remove" data-medium-remove="${key}" data-medium-index="${index}" aria-label="移除第 ${index+1} 项">移除</button>
  </div>`).join('')||'<p class="medium-empty">尚未填写名称与浓度。</p>';
}
function recipeLabel(recipe){
  return mediumDisplayParts(recipe)
    .filter(([label,value])=>value!=='未记录'&&(label!=='额外成分'||recipe.additives?.length))
    .map(([label,value])=>label==='基础培养基'?value:label+' '+value).join(' · ');
}
function recipeOptions(recipes){
  return recipes.map((recipe,index)=>`<option value="${index}">${esc(recipeLabel(recipe))}</option>`).join('');
}
function bindCreateRecipe(){
  const select=$('#create-recipe'),panel=$('#create-recipe-details'),body=$('#create-recipe-fields');
  const recipes=boot.medium_recipes||[];
  select.innerHTML=`<option value="">暂不指定</option>${recipeOptions(recipes)}<option value="custom">填写新配方…</option>`;
  select.value='';
  const render=()=>{
    const active=select.value!=='';
    panel.hidden=!active;
    panel.open=select.value==='custom';
    body.replaceChildren();
    if(!active)return;
    const medium=select.value==='custom'?mediumDefaults():recipes[Number(select.value)];
    body.innerHTML=mediumEditorMarkup([{medium}],null,false,'create-');
    const editor=body.querySelector('.medium-editor');
    bindMediumEditor([{medium}],null,editor,'create-');
    for(const box of editor.querySelectorAll('[data-medium-apply]')){
      box.checked=true;
      box.disabled=true;
      box.closest('.medium-field').classList.add('enabled');
    }
  };
  select.onchange=render;
  render();
}
function mediumEditorMarkup(wells,defaults=null,force=false,namespace=''){
  const hasDefaults=!!defaults&&Object.keys(defaults).length>0;
  const defaulted=hasDefaults&&(force||wells.every(w=>!w.medium));
  if(defaulted)wells=wells.map(w=>({...w,medium:defaults}));
  const field=(key,label,control)=>{const {mixed,value}=mediumCommon(wells,key);return `<div class="medium-field" data-medium-section="${key}"><label class="medium-apply"><input type="checkbox" data-medium-apply="${key}">${label}</label>${mixed?'<small class="medium-mixed">多个值 · 勾选后统一替换</small>':''}${control(value)}</div>`;};
  const choice=(key,value)=>`<select id="medium-${key}" data-medium-field="${key}" aria-label="${{ps:'双抗',triple:'三抗',extra:'额外添加'}[key]}">${[['unknown','未记录'],['yes','是'],['no','否']].map(([v,label])=>`<option value="${v}" ${v===value?'selected':''}>${label}</option>`).join('')}</select>`;
  const list=(key,label)=>field(key,label,rows=>`<p class="medium-list-note">${mediumCommon(wells,key).mixed?'所选孔的列表不同；编辑或勾选后，以下整组内容会替换所选孔的列表。':'勾选后保存整组列表；未勾选时保留各孔原记录。'}</p><div data-medium-list="${key}">${mediumRowsMarkup(key,rows)}</div><button type="button" class="text-button medium-add" data-medium-add="${key}">＋ 添加${key==='cytokines'?'细胞因子':'额外成分'}</button>`);
  const markup=`<section id="medium-editor" class="medium-editor" data-medium-defaulted="${defaulted}" aria-labelledby="medium-heading"><h3 id="medium-heading">培养基组成</h3><p class="medium-help">${defaulted?'已带入本容器默认配方并勾选，可逐项修改；点击保存后才写入。细胞计数不沿用。':'仅保存勾选的项目。已有配方保持原值，空白及“未记录”表示尚未记录。'}</p>${namespace!=='create-'&&boot.medium_recipes?.length?`<label class="recipe-picker">选用完整配方<select data-medium-preset><option value="">选择已保存的完全培养基…</option>${recipeOptions(boot.medium_recipes)}</select></label>`:''}${hasDefaults?'<button type="button" class="text-button" data-medium-reuse>沿用本容器默认配方</button>':''}
    ${field('base','基础培养基',value=>mediumAutocompleteInput('medium-base','data-medium-field="base" aria-label="基础培养基" placeholder="输入名称或选择历史记录"',value))}
    <div class="medium-pair">${['fbs','hs'].map(key=>field(key,(key==='fbs'?'FBS 胎牛血清':'HS 马血清')+'（%）',value=>`<input id="medium-${key}" data-medium-field="${key}" aria-label="${key.toUpperCase()} 百分比" type="number" min="0" max="100" step="any" inputmode="decimal" placeholder="未记录" value="${esc(value)}">`)).join('')}</div>
    <div class="medium-pair">${field('ps','双抗 P/S',value=>choice('ps',value))}${field('triple','三抗',value=>choice('triple',value))}</div>
    ${list('cytokines','细胞因子')}
    ${field('extra','额外添加',value=>choice('extra',value))}
    <p class="medium-extra-note">“否”表示无额外添加；将此项改为“否”或“未记录”并保存，会清除所选孔的额外成分列表。</p>
    <div data-medium-extra-content ${mediumCommon(wells,'extra').value==='yes'?'':'hidden'}>${list('additives','额外成分')}</div>
  </section>`;
  return namespace?markup.replace(/\b(id|aria-controls|aria-labelledby)="([^"]+)"/g,(_,attr,value)=>`${attr}="${namespace}${value}"`):markup;
}
function mediumReadRows(root,key){
  return [...root.querySelectorAll(`[data-medium-list="${key}"] [data-medium-row]`)].map(row=>Object.fromEntries(['name','concentration','unit'].map(part=>[part,row.querySelector(`[data-medium-part="${part}"]`).value.trim()])));
}
function bindMediumEditor(wells,defaults=null,root=$('#medium-editor'),namespace=''){
  if(!root)return;
  if(root.dataset.mediumDefaulted==='true')root.querySelectorAll('[data-medium-apply]').forEach(box=>{box.checked=true;box.closest('.medium-field').classList.add('enabled');});
  const reuse=root.querySelector('[data-medium-reuse]');
  if(reuse)reuse.onclick=()=>{const id=root.id;root.outerHTML=mediumEditorMarkup(wells,defaults,true,namespace);bindMediumEditor(wells,defaults,document.getElementById(id),namespace);dirty=true;};
  const markDirty=()=>{if(namespace!=='create-')dirty=true;};
  const apply=key=>root.querySelector(`[data-medium-apply="${key}"]`);
  const enable=key=>{apply(key).checked=true;root.querySelector(`[data-medium-section="${key}"]`).classList.add('enabled');markDirty();};
  const extra=root.querySelector('[data-medium-field="extra"]');
  let implicitClear=false,previousAdditiveApply=false;
  function syncExtra(){
    if(apply('extra').checked&&extra.value!=='yes'){
      if(!implicitClear){previousAdditiveApply=!!apply('additives').checked;implicitClear=true;}
      enable('additives');
    }else if(implicitClear){
      apply('additives').checked=previousAdditiveApply;
      root.querySelector('[data-medium-section="additives"]').classList.toggle('enabled',previousAdditiveApply);
      implicitClear=false;
    }
    root.querySelector('[data-medium-extra-content]').hidden=extra.value!=='yes'&&(implicitClear||!apply('additives').checked);
  }
  function bindRows(key){
    root.querySelectorAll(`[data-medium-list="${key}"] [data-medium-part]`).forEach(input=>input.addEventListener('input',()=>{
      enable(key);if(key==='additives'){extra.value='yes';enable('extra');syncExtra();}
    }));
    root.querySelectorAll(`[data-medium-list="${key}"] [data-medium-part="name"]`).forEach(input=>{
      const list=root.querySelector('#'+input.id+'-suggestions');
      if(key==='cytokines'){
        attachHistoryAutocomplete(input,list,()=>mediumNameHistory(key,wells),{label:'细胞因子',filter:filterTreatments});
        return;
      }
      const row=input.closest('[data-medium-row]');
      attachHistoryAutocomplete(input,list,()=>additiveHistory(wells),{
        label:'额外成分',optionValue:item=>item.name,
        optionLabel:item=>[item.name,item.concentration||'浓度未记录',item.unit].filter(Boolean).join(' '),
        filter:(items,query)=>items.filter(item=>item.name.toLowerCase().includes(query.trim().toLowerCase())),
        onSelect:item=>{
          row.querySelector('[data-medium-part="concentration"]').value=item.concentration??'';
          row.querySelector('[data-medium-part="unit"]').value=item.unit??'';
        }
      });
    });
    root.querySelectorAll(`[data-medium-remove="${key}"]`).forEach(button=>button.onclick=()=>{
      const rows=mediumReadRows(root,key);rows.splice(Number(button.dataset.mediumIndex),1);renderRows(key,rows);enable(key);
    });
  }
  function renderRows(key,rows){root.querySelector(`[data-medium-list="${key}"]`).innerHTML=mediumRowsMarkup(key,rows,namespace);bindRows(key);}
  function focusAdditive(append=false){
    const list=root.querySelector('[data-medium-list="additives"]');
    const rows=mediumReadRows(root,'additives');
    const blank=rows.findIndex(row=>!row.name&&!row.concentration&&!row.unit);
    let index=blank<0?0:blank;
    if(!rows.length||(append&&blank<0)){
      index=rows.length;
      renderRows('additives',[...rows,{name:'',concentration:'',unit:''}]);
    }
    list.querySelectorAll('[data-medium-part="name"]')[index].focus();
  }
  const picker=root.querySelector('[data-medium-preset]');
  if(picker){
    const recipes=boot.medium_recipes;
    picker.onchange=()=>{
      if(picker.value==='')return;
      const recipe=mediumDefaults(recipes[Number(picker.value)]);
      for(const field of root.querySelectorAll('[data-medium-field]'))field.value=recipe[field.dataset.mediumField];
      for(const key of ['cytokines','additives'])renderRows(key,recipe[key]);
      for(const key of Object.keys(recipe))enable(key);
      root.querySelectorAll('.medium-mixed').forEach(note=>note.remove());
      root.querySelector('[data-medium-extra-content]').hidden=recipe.extra!=='yes';
      implicitClear=false;
      picker.value='';
    };
  }
  root.querySelectorAll('[data-medium-apply]').forEach(box=>box.addEventListener('change',()=>{
    markDirty();box.closest('.medium-field').classList.toggle('enabled',box.checked);if(box.dataset.mediumApply==='extra'){
      syncExtra();if(box.checked&&extra.value==='yes')focusAdditive();
    }
  }));
  root.querySelectorAll('[data-medium-field]').forEach(input=>input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{
    enable(input.dataset.mediumField);
    if(input===extra){syncExtra();if(extra.value==='yes')focusAdditive();}
  }));
  const base=root.querySelector('[data-medium-field="base"]');
  attachHistoryAutocomplete(base,root.querySelector('#'+base.id+'-suggestions'),()=>mediumNameHistory('bases',wells),{label:'基础培养基',filter:filterTreatments});
  ['cytokines','additives'].forEach(key=>{
    bindRows(key);
    root.querySelector(`[data-medium-add="${key}"]`).onclick=()=>{
      if(key==='additives'){
        extra.value='yes';enable('extra');syncExtra();focusAdditive(true);return;
      }
      const rows=mediumReadRows(root,key);rows.push({name:'',concentration:'',unit:''});renderRows(key,rows);enable(key);
      root.querySelector(`[data-medium-list="${key}"] [data-medium-row]:last-child [data-medium-part="name"]`)?.focus();
    };
  });
}
function collectMediumPatch(root=$('#medium-editor')){
  const patch={};if(!root)return patch;
  root.querySelectorAll('[data-medium-apply]').forEach(box=>{
    if(!box.checked)return;
    const key=box.dataset.mediumApply;
    patch[key]=['cytokines','additives'].includes(key)?mediumReadRows(root,key).filter(row=>Object.values(row).some(Boolean)):root.querySelector(`[data-medium-field="${key}"]`).value.trim();
  });
  if(root.querySelector('[data-medium-apply="extra"]').checked&&root.querySelector('[data-medium-field="extra"]').value!=='yes')patch.additives=[];
  return patch;
}
function mediumDisplayParts(medium){
  const m=mediumDefaults(medium),choice=value=>value==='yes'?'是':value==='no'?'否':'未记录';
  const percent=value=>value===''?'未记录':value+'%';
  const rows=values=>values.length?values.map(row=>`${row.name||'名称未记录'}（${row.concentration!==''&&row.concentration!=null?row.concentration+(row.unit?' '+row.unit:' · 单位未记录'):'浓度未记录'+(row.unit?'；单位 '+row.unit:'')}）`).join('；'):'未记录';
  return [['基础培养基',m.base||'未记录'],['FBS',percent(m.fbs)],['HS',percent(m.hs)],['双抗',choice(m.ps)],['三抗',choice(m.triple)],['细胞因子',rows(m.cytokines)],['额外添加',choice(m.extra)],['额外成分',m.extra==='no'?'无额外添加':rows(m.additives)]];
}
function mediumSummary(medium){return mediumDisplayParts(medium).map(([label,value])=>label+' '+value).join(' · ');}
function mediumDetailsMarkup(medium){return `<section class="medium-details"><h4>培养基组成</h4><dl>${mediumDisplayParts(medium).map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section>`;}

function mediumPatchSummary(value){const labels={base:"基础培养基",fbs:"FBS",hs:"HS",ps:"双抗",triple:"三抗",cytokines:"细胞因子",extra:"额外添加",additives:"额外成分"};const selected=new Set(Object.keys(value).map(k=>labels[k]));return mediumDisplayParts(value).filter(([label])=>selected.has(label)).map(([label,v])=>label+" "+v).join(" · ");}
