'use strict';
const pasteTables={luci:{assay:['samples','raw_plate']},flow:{assay:['samples','results']},pcr:{qpcr:['samples']}};
const pasteAliases={sample:['样本','样本号','样本ID','Sample ID','sample name'],plate:['板','板号','板名','Plate ID','Plate Name'],well:['孔','孔号','孔位','板孔','well position','position'],tube:['tube','管号'],raw_value:['值','发光值','读数','lum','rlu','value'],value:['值','读数','lum','rlu','结果','result'],ct:['Cq','Ct值','Cq值'],unit:['单位','units'],target:['基因','gene','target name'],replicate:['复孔','重复','rep'],technical_replicate:['技术重复','重复','replicate'],population:['门','群体','gate'],metric:['指标','statistic'],events:['事件数','event count'],file:['文件','filename'],analysis_file:['分析文件名']};
function parseExcelTSV(input){
  if(typeof input!=='string'||input.length>1500000)throw Error('单次最多粘贴 1.5 MB。');
  const text=input.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'),rows=[];let row=[],v='',quote=false,ended=false;
  const put=()=>{row.push(v.trim());v='';ended=false;if(row.length>160)throw Error('列数超过 160。');};
  const line=()=>{put();if(row.some(x=>x!==''))rows.push(row);row=[];if(rows.length>2001)throw Error('单次最多 2000 行数据。');};
  for(let i=0;i<text.length;i++){const c=text[i];
    if(quote){if(c==='"'&&text[i+1]==='"'){v+='"';i++;}else if(c==='"'){quote=false;ended=true;}else v+=c;continue;}
    if(c==='\t'){put();continue;}if(c==='\n'){line();continue;}
    if(ended){if(c===' ')continue;throw Error('有无法解析的 Excel 引号。');}
    if(c==='"'&&!v){quote=true;continue;}v+=c;
  }
  if(quote)throw Error('有未闭合的 Excel 引号。');line();if(rows.length<2)throw Error('请复制包含表头及至少一行结果的区域。');
  const [headers,...data]=rows;if(data.some(r=>r.length>headers.length))throw Error('有数据行超出表头列数，请检查区域。');return {headers,data};
}
function pasteSpec(record,table){
  const editable={luci:{samples:['raw_value','unit','notes'],raw_plate:['value','unit','annotation']},flow:{samples:['events','file','notes'],results:['value','unit','analysis_file','notes']},pcr:{samples:['ct','melt','normalized','file','notes']}};
  const measure=editable[record.type]?.[table.key]||[],keys=['sample','plate','well','tube','target','replicate','technical_replicate','population','metric'];
  return {cols:table.columns.filter(c=>keys.includes(c.key)||measure.includes(c.key)),measure};
}
const pasteNorm=s=>String(s??'').trim().toLowerCase().replace(/[\s_（）()／/\-]+/g,'');
const pasteWell=s=>{const m=/^([a-z]{1,2})0*([1-9]\d{0,2})$/i.exec(String(s||'').trim());return m?m[1].toUpperCase()+m[2]:'';};
function initialPasteMapping(headers,cols){
  return headers.map(h=>{const n=pasteNorm(h);const choices=cols.filter(c=>[c.key,c.label,...(pasteAliases[c.key]||[]),...(c.key==='tube'?pasteAliases.well:[])].some(s=>pasteNorm(s)===n));return choices.length===1?choices[0].key:'';});
}
function pasteMappingPreferences(workspace,record,table,headers,cols){
  const names=headers.map(pasteNorm);
  const defaults=initialPasteMapping(headers,cols);
  const key=workspace?'labnote.paste-map.v1:'+JSON.stringify([workspace,record.type,record.variant,table.key,[...names].sort()]):null;
  // Reordered columns must retain their meaning. Indistinguishable headers use the default each time.
  const unique=new Set(names.filter((name,i)=>name&&names.indexOf(name)===i&&names.lastIndexOf(name)===i));
  // Every paste starts with its recognized unit and identity columns. Ignoring one is a per-paste decision.
  const guards=['unit','sample','plate','well','tube','target','replicate','technical_replicate','population','metric'];
  const protectedFields=new Set(defaults.filter(field=>guards.includes(field)));
  const reusable=(i,field)=>unique.has(names[i])&&!protectedFields.has(defaults[i])&&!protectedFields.has(field);
  function reset(){try{if(key)window.localStorage.removeItem(key);}catch{}}
  function read(){
    try{
      if(!key)return defaults;
      const saved=new Map(JSON.parse(window.localStorage.getItem(key)));
      return names.map((name,i)=>{
        const field=saved.get(name);
        return reusable(i,field)&&(field===''||cols.some(c=>c.key===field))?field:defaults[i];
      });
    }catch{return defaults;}
  }
  function remember(mapping){
    if(!key)return;
    const changes=names.flatMap((name,i)=>reusable(i,mapping[i])&&mapping[i]!==defaults[i]?[[name,mapping[i]]]:[]);
    if(!changes.length){reset();return;}
    try{window.localStorage.setItem(key,JSON.stringify(changes));}catch{}
  }
  return {defaults,read,remember,reset};
}
function buildPastePlan(record,table,input,mapping,mode,plateFallback,append){
  const spec=pasteSpec(record,table),defs=Object.fromEntries(spec.cols.map(c=>[c.key,c])),keys=mapping.filter(Boolean),wk=defs.well?'well':'tube';
  if(keys.length!==new Set(keys).size)throw Error('有两列映射到同一字段，请保留一列。');
  if(!spec.measure.some(k=>keys.includes(k)&&!['unit','notes','annotation','file','analysis_file'].includes(k)))throw Error('至少映射一个结果值字段。');
  if(mode==='sample'&&!keys.includes('sample'))throw Error('按样本号匹配须映射样本编号。');
  if(mode==='position'&&(!keys.includes(wk)||(!keys.includes('plate')&&!plateFallback)))throw Error('须映射孔位，并映射板号或明确填写本次板号。');
  const original=record.tables[table.key]||[],baseRows=record.tables.samples||[],details=['target','replicate','technical_replicate','population','metric'];
  const derived=row=>{
    if(record.type!=='flow'||table.key!=='results'||!row.sample)return row;
    const ms=baseRows.filter(x=>x.sample===row.sample);return ms.length===1?{...row,plate:row.plate||ms[0].plate||'',well:row.well||pasteWell(ms[0].tube)}:row;
  };
  const pos=(r)=>[r.plate||plateFallback,pasteWell(r[wk])];
  const out=input.data.map((cells,index)=>{
    const src=Object.fromEntries(mapping.flatMap((k,i)=>k&&cells[i]!==undefined&&cells[i]!==''?[[k,cells[i]]]:[])),ident=mode==='sample'?src.sample:pos(src);
    const result={index,src,key:mode==='sample'?src.sample:(pos(src).join(' / ')),status:'跳过',changes:[]};
    const reject=msg=>({...result,msg});
    if(mode==='sample'?!ident:!ident.every(Boolean))return reject('缺少有效匹配键');
    if(record.type==='flow'&&table.key==='results'){
      const [plate,well]=pos(src);
      if(plate&&well){
        const owners=baseRows.filter(r=>(r.plate||plateFallback)===plate&&pasteWell(r.tube)===well);
        if(owners.length>1)return reject('样本表同一板孔有多个样本');
        if(owners.length){
          if(src.sample&&src.sample!==owners[0].sample)return reject('板孔与样本表的样本号冲突');
          if(!src.sample)src.sample=owners[0].sample;
        }
      }
      if(src.sample&&(plate||well)){
        const registered=baseRows.filter(r=>r.sample===src.sample);
        const agrees=r=>(!plate||!r.plate||r.plate===plate)&&(!well||!pasteWell(r.tube)||pasteWell(r.tube)===well);
        if(registered.length&&!registered.some(agrees))return reject('板孔与样本表登记不一致');
      }
    }
    if(src[wk]&&wk==='well'&&!pasteWell(src[wk]))return reject('孔位格式无效');
    for(const [k,v] of Object.entries(src)){const c=defs[k];if(!c||v.length>5000)return reject('字段无效或过长');
      if(c.type==='number'&&(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)||!Number.isFinite(Number(v))||(c.min!==undefined&&Number(v)<c.min)||(c.integer&&!Number.isInteger(Number(v)))))return reject(c.label+'数值无效');
    }
    if(!spec.measure.some(k=>src[k]&&!['unit','notes','annotation','file','analysis_file'].includes(k)))return reject('没有可写入的读数');
    let candidates=original.map((r,i)=>({r:derived(r),i})).filter(({r})=>mode==='sample'?r.sample===src.sample:pos(r)[0]===ident[0]&&pos(r)[1]===ident[1]);
    // Additional supplied identifiers may disambiguate repeated samples; never
    // substitute a different gene, well, population or metric.
    const compatible=({r})=>['sample','plate',wk,...details].every(k=>!r[k]||!src[k]||(k===wk&&pasteWell(r[k])?pasteWell(r[k])===pasteWell(src[k]):r[k]===src[k]));
    const before=candidates.length;candidates=candidates.filter(compatible);
    if(candidates.length>1)return reject('对应多行；补充孔位、靶标、重复号或检测指标');
    if(before&&!candidates.length&&!append)return reject('同一匹配键的其他标识不一致');
    if(!candidates.length&&!append)return reject('未匹配（未启用新增）');
    const dest=candidates[0],row=dest?original[dest.i]:{};
    const merged={...dest?.r,...src},[newPlate,newWell]=pos(merged);
    // Filling a matched row's missing plate or well can collide just like appending a new row.
    if(newPlate&&newWell&&(!dest||!dest.r.plate||!dest.r[wk])){
      const occupied=original.map(derived).filter((r,i)=>i!==dest?.i&&pos(r)[0]===newPlate&&pos(r)[1]===newWell);
      if(occupied.some(r=>merged.sample&&r.sample&&r.sample!==merged.sample))return reject('此板孔已属于其他样本');
      if(occupied.length&&!(record.type==='flow'&&table.key==='results'))return reject('该板孔已有记录，请核对样本或靶标');
    }
    if(!dest&&mode==='position'&&original.some(r=>!r.plate&&!plateFallback&&pasteWell(r[wk])===ident[1]))return reject('已存在同孔号但未标板号的行，请先核对板号');
    if(row.unit&&src.unit&&row.unit!==src.unit)return reject('单位冲突：'+row.unit+' / '+src.unit);
    const patch={};
    for(const k of keys)if(src[k]&&(spec.measure.includes(k)||!row[k]))patch[k]=src[k];
    if(src.sample&&!row.sample)patch.sample=src.sample;
    if(mode==='position'&&!row.plate)patch.plate=ident[0];
    if(!dest&&table.columns.some(c=>c.required&&!patch[c.key]))return reject('新增行缺少必要的样本号或孔位');
    if(patch[wk]&&pasteWell(patch[wk]))patch[wk]=pasteWell(patch[wk]);
    result.changes=Object.entries(patch).filter(([k,v])=>v!==(row[k]||'')).map(([k,v])=>[defs[k]?.label||k,row[k]||'',v]);
    result.patch=patch;result.rowIndex=dest?.i;
    result.identity=dest?'row:'+dest.i:JSON.stringify([mode,ident,...['sample','plate',wk,...details].map(k=>k===wk?pasteWell(src[k])||src[k]||'':src[k]||'')]);
    result.status=!dest?'新增':result.changes.length?'更新':'相同';return result;
  });
  const seen=new Map();for(const x of out)if(x.identity)seen.set(x.identity,(seen.get(x.identity)||0)+1);
  for(const x of out)if(seen.get(x.identity)>1){x.status='跳过';x.msg='粘贴区域重复指向同一行';}
  const incomingPositions=new Map();
  for(const x of out.filter(v=>v.status==='新增'||v.status==='更新')){
    const r={...(x.rowIndex===undefined?{}:derived(original[x.rowIndex])),...x.patch};const pk=pos(r);
    if(!pk.every(Boolean))continue;const key=JSON.stringify(pk);
    const same=incomingPositions.get(key)||[];same.push([x,r]);incomingPositions.set(key,same);
  }
  for(const same of incomingPositions.values())if(same.length>1&&(
    !(record.type==='flow'&&table.key==='results')||new Set(same.map(([,r])=>r.sample).filter(Boolean)).size>1)){
    for(const [x] of same){x.status='跳过';x.msg='多条粘贴结果占用同一板孔，请核对';}
  }
  if(original.length+out.filter(x=>x.status==='新增').length>2000)throw Error('应用后将超过每表 2000 行。');
  return out;
}
function bindPasteButtons(editor){
  const r=editor.record,keys=pasteTables[r.type]?.[r.variant]||[];
  const form=$('#lab-record-form');
  // A multi-column paste in a cell uses the same reviewed import as the toolbar.
  // Ordinary single-value paste and IME editing keep their native behavior.
  if(keys.length&&!form.dataset.excelPasteBound){
    form.dataset.excelPasteBound='true';
    form.addEventListener('paste',event=>{
      const field=event.target.closest?.('input[data-lab-column],textarea[data-lab-column]'),k=field?.closest('[data-lab-table]')?.dataset.labTable;
      if(!keys.includes(k)||editor!==labEditor||field.readOnly||field.disabled)return;
      const text=event.clipboardData?.getData('text/plain')||'';
      if(!text.includes('\t'))return;
      event.preventDefault();labCollectEditor();openResultPaste(editor,k,field,text);
    });
  }
  for(const k of keys){const add=form.querySelector(`[data-lab-add-row="${k}"]`);if(!add||form.querySelector(`[data-paste-table="${k}"]`))continue;
    const b=document.createElement('button');b.type='button';b.className='button secondary';b.dataset.pasteTable=k;b.textContent='从 Excel 粘贴结果';add.before(b);b.onclick=()=>{labCollectEditor();openResultPaste(editor,k,b);};
  }
}
function openResultPaste(editor,k,trigger=document.activeElement,pasted=''){
  const r=editor.record,table=labVariant(r).tables.find(t=>t.key===k),spec=pasteSpec(r,table),box=$('#result-paste-dialog');let input=null,plan=null;
  const dm=window.DialogManager,returnPoint=dm?.capture(trigger,$('#lab-editor-scroll'));
  box.innerHTML=`<div class="dialog-head"><h2>从 Excel 粘贴 · ${esc(table.label)}</h2><button type="button" class="icon-button" data-close aria-label="关闭">×</button></div><label>复制表头和数据行<textarea data-text rows="6" placeholder="在此粘贴 Excel 单元格区域"></textarea></label><button type="button" class="button secondary" data-read>识别表头</button><div data-options></div><p data-err role="alert"></p><div data-preview></div><div class="dialog-actions"><button type="button" class="button secondary" data-return>取消</button><button type="button" class="button primary" data-apply disabled>确认写入当前表单</button></div>`;
  const q=s=>box.querySelector(s),options=q('[data-options]'),preview=q('[data-preview]'),apply=q('[data-apply]'),err=q('[data-err]');
  function invalidate(){plan=null;apply.disabled=true;apply.textContent='确认写入当前表单';preview.replaceChildren();err.textContent='';}
  q('[data-text]').oninput=()=>{input=null;options.replaceChildren();invalidate();};
  const cancel=()=>!q('[data-text]').value.trim()||confirm('放弃尚未写入表单的粘贴内容？');
  q('[data-close]').onclick=q('[data-return]').onclick=()=>{if(cancel())box.close();};box.oncancel=e=>{if(!cancel())e.preventDefault();};
  q('[data-read]').onclick=()=>{invalidate();try{
    input=parseExcelTSV(q('[data-text]').value);
    const prefs=pasteMappingPreferences(boot.data_dir,r,table,input.headers,spec.cols),map=prefs.read();
    options.innerHTML=`<h3>列对应</h3><div class="lab-editor-grid">${input.headers.map((h,i)=>`<label>${esc(h)}<select data-map="${i}"><option value="">忽略此列</option>${spec.cols.map(c=>`<option value="${c.key}" ${map[i]===c.key?'selected':''}>${esc(c.label)}</option>`).join('')}</select></label>`).join('')}</div><button type="button" class="text-button" data-reset-map>重置默认映射</button><div class="two"><label>匹配依据<select data-mode>${spec.cols.some(c=>c.key==='sample')?'<option value="sample">样本号</option>':''}<option value="position" ${prefs.defaults.includes('plate')||!prefs.defaults.includes('sample')?'selected':''}>板号＋孔位</option></select></label><label>未标板号的行归属板号（可选）<input data-fallback placeholder="只在确认这些行都属于同一板时填写"></label></div><label class="inline-check"><input type="checkbox" data-append>允许为未匹配结果新增行</label><button type="button" class="button secondary" data-build>预览逐行差异</button>`;
    const selects=[...options.querySelectorAll('[data-map]')];
    options.oninput=options.onchange=invalidate;
    q('[data-reset-map]').onclick=()=>{
      prefs.reset();
      selects.forEach((el,i)=>{el.value=prefs.defaults[i];});
      invalidate();
    };
    q('[data-build]').onclick=()=>{invalidate();try{
      const mapping=selects.map(el=>el.value);
      plan=buildPastePlan(r,table,input,mapping,q('[data-mode]').value,q('[data-fallback]').value.trim(),q('[data-append]').checked);
      prefs.remember(mapping);
      const n=s=>plan.filter(x=>x.status===s).length;
      const valid=n('新增')+n('更新'),skipped=n('跳过');
      preview.innerHTML=`<p><strong>更新 ${n('更新')} · 新增 ${n('新增')} · 相同 ${n('相同')} · 跳过 ${skipped}</strong>。筛选只改变显示；确认将写入全部 ${valid} 条有效变更。空白不覆盖原值，确认后仍须保存实验。</p><div class="paste-filters" role="group" aria-label="预览行筛选"><button type="button" class="button secondary" data-paste-filter="all">全部（${plan.length}）</button><button type="button" class="button secondary" data-paste-filter="skipped" ${skipped?'':'disabled'}>仅看跳过（${skipped}）</button></div><div class="table-wrap paste-preview"><table><thead><tr><th>行</th><th>匹配键</th><th>状态</th><th>原值 → 新值 / 跳过原因</th></tr></thead><tbody></tbody></table></div>`;
      const filters=[...preview.querySelectorAll('[data-paste-filter]')];
      function show(filter){
        for(const btn of filters)btn.setAttribute('aria-pressed',String(btn.dataset.pasteFilter===filter));
        const rows=filter==='skipped'?plan.filter(x=>x.status==='跳过'):plan;
        preview.querySelector('tbody').innerHTML=rows.map(x=>`<tr data-paste-status="${x.status}"><td>${x.index+2}</td><td>${esc(x.key||'—')}</td><td>${x.status}</td><td>${x.msg?esc(x.msg):x.changes.map(([l,a,b])=>esc(l+'：'+(a||'空')+' → '+b)).join('<br>')||'无变化'}</td></tr>`).join('');
      }
      for(const btn of filters)btn.onclick=()=>show(btn.dataset.pasteFilter);
      show(skipped?'skipped':'all');apply.textContent='写入 '+valid+' 条有效变更到表单';apply.disabled=!valid;

    }catch(e){err.textContent=e.message;}};
  }catch(e){err.textContent=e.message;}};
  apply.onclick=()=>{if(!plan||apply.disabled||editor!==labEditor)return;
    labApplyPastePlan(k,plan);
    box.close();toast('已写入当前表单；保存实验记录后生效。');
  };
  if(pasted){q('[data-text]').value=pasted;q('[data-read]').onclick();}
  if(dm)dm.open(box,returnPoint);else box.showModal();
}
