'use strict';
let relocationDraft=null;
let inlineRelocationActive=false;
function bindInlineRelocation(root,{container,mode,getSelected,canStart,onSelectionChange}){
  let drag=null,suppressClick=false;
  const nodes=()=>[...root.querySelectorAll('[data-well]')];
  const buttonFrom=target=>{const b=target?.closest?.('[data-well]');return b&&root.contains(b)?b:null;};
  const targetAt=e=>nodes().find(b=>{const r=b.getBoundingClientRect();return e.clientX>=r.left&&e.clientX<=r.left+r.width&&e.clientY>=r.top&&e.clientY<=r.top+r.height;})?.dataset.well;
  const hint=()=>$('#inline-placement-hint');
  const defaultHint=()=>`已选择孔位${mode==='copy'?'复制':'移动'}：从任一已选孔拖到目标孔，松开即保存；单击仍可调整选择。`;
  function clearPreview(){nodes().forEach(b=>{b.classList.remove('drop-preview','drop-conflict');});if(hint())hint().textContent=defaultHint();}
  function plan(target){return planRelocation({source:container,target:container,sourceDims:boot.layouts[container.type],targetDims:boot.layouts[container.type],wells:drag.wells,anchor:drag.anchor,targetAnchor:target,mode});}
  function release(e){if(root.hasPointerCapture(e.pointerId))root.releasePointerCapture(e.pointerId);}
  root.onpointerdown=e=>{
    if(e.button!==0||e.pointerType==='touch')return;
    const b=buttonFrom(e.target);if(!b)return;
    suppressClick=false;if(!canStart()){suppressClick=true;return;}
    e.preventDefault();b.focus();
    drag={anchor:b.dataset.well,wells:[...getSelected()],x:e.clientX,y:e.clientY,id:e.pointerId,revision:state.revision,moved:false};
    inlineRelocationActive=true;root.setPointerCapture(e.pointerId);
  };
  root.onpointermove=e=>{
    if(!drag||e.pointerId!==drag.id)return;
    if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;
    drag.moved=true;e.preventDefault();clearPreview();
    if(!drag.wells.includes(drag.anchor)){if(hint())hint().textContent='请从已选中的孔开始拖动。';return;}
    const target=targetAt(e);
    if(!target){if(hint())hint().textContent='拖到目标孔内再松开；在孔板外松开会取消。';return;}
    const result=plan(target),destinations=new Set(result.pairs.filter(p=>p.to).map(p=>p.to));
    nodes().forEach(b=>{if(destinations.has(b.dataset.well))b.classList.add(result.errors.length?'drop-conflict':'drop-preview');});
    if(hint())hint().textContent=result.errors.length?result.errors.join(' '):`${mode==='copy'?'复制':'移动'} ${result.pairs.filter(p=>p.occupied).length} 条记录：${result.pairs.filter(p=>p.occupied).map(p=>p.from+' → '+p.to).join('；')}。松开即保存。`;
  };
  root.onpointerup=async e=>{
    if(!drag||e.pointerId!==drag.id)return;
    const pending=drag,target=targetAt(e);
    const result=pending.moved&&pending.wells.includes(pending.anchor)&&target?plan(target):null;
    drag=null;inlineRelocationActive=false;suppressClick=true;release(e);clearPreview();
    if(!pending.moved){const next=new Set(getSelected());next.has(pending.anchor)?next.delete(pending.anchor):next.add(pending.anchor);onSelectionChange(next);return;}
    if(!pending.wells.includes(pending.anchor))return toast('请从已选中的孔开始拖动。',true);
    if(!result)return;
    if(result.errors.length)return toast(result.errors.join(' '),true);
    if(busy||currentId!==container.id||state.revision!==pending.revision)return toast('当前记录已变化，请重新拖动。',true);
    busy=true;
    try{
      const response=await api('/api/command',{action:'relocate',revision:pending.revision,payload:{mode,source_id:container.id,wells:pending.wells,anchor:pending.anchor,target_id:container.id,target_anchor:target}});
      state=response.state;dirty=false;if(currentId===container.id)selected.clear();
      render();toast(mode==='copy'?'所选孔组已复制，原孔记录保留。':'所选孔组已移动，原位置已清空。');
    }catch(error){toast(error.message,true);}finally{busy=false;if(typeof renderUndoControl==='function')renderUndoControl();}
  };
  function cancel(e){if(!drag||e.pointerId!==drag.id)return;drag=null;inlineRelocationActive=false;suppressClick=true;release(e);clearPreview();}
  root.onpointercancel=cancel;
  root.onlostpointercapture=e=>{if(drag&&e.pointerId===drag.id){drag=null;inlineRelocationActive=false;suppressClick=true;clearPreview();}};
  root.onkeydown=e=>{if(e.key==='Escape'&&drag){e.preventDefault();cancel({pointerId:drag.id});}};
  root.onclick=e=>{
    if(suppressClick){suppressClick=false;e.preventDefault();return;}
    const b=buttonFrom(e.target);if(!b||!canStart())return;
    const next=new Set(getSelected()),key=b.dataset.well;next.has(key)?next.delete(key):next.add(key);onSelectionChange(next);
  };
  clearPreview();
}
function relocationCoordinate(key){const m=/^([A-Z])(\d+)$/.exec(key);return m?[m[1].charCodeAt(0)-65,+m[2]-1]:null;}
function planRelocation({source,target,sourceDims,targetDims,wells,anchor,targetAnchor,mode}){
  const pairs=[],errors=[],conflicts=[],a=relocationCoordinate(anchor),b=relocationCoordinate(targetAnchor);
  if(!['copy','move'].includes(mode)||!a||!b||!wells.includes(anchor)||!sourceDims||!targetDims)return {pairs,errors:['请选择操作方式、来源锚点和目标孔。'],conflicts};
  const selectedKeys=new Set(wells),outside=[];
  for(const from of wells){
    const p=relocationCoordinate(from);
    if(!p||p[0]<0||p[0]>=sourceDims[0]||p[1]<0||p[1]>=sourceDims[1]){errors.push('来源孔位无效：'+from);continue;}
    const row=p[0]+b[0]-a[0],col=p[1]+b[1]-a[1],inBounds=row>=0&&row<targetDims[0]&&col>=0&&col<targetDims[1];
    const to=inBounds?String.fromCharCode(65+row)+(col+1):null,occupied=!!source.wells[from]?.cell;
    pairs.push({from,to,occupied});
    if(!inBounds){outside.push(from);continue;}
    if(occupied&&target.wells[to]?.cell&&!(mode==='move'&&source.id===target.id&&selectedKeys.has(to)))conflicts.push(to);
  }
  if(outside.length)errors.push('整组超出目标孔板边界，对应来源孔：'+outside.join('、'));
  if(conflicts.length)errors.push('目标孔已有记录：'+conflicts.join('、')+'。请选择空位。');
  if(!pairs.some(p=>p.occupied))errors.push('所选孔位没有可复制或移动的记录。');
  if(source.id===target.id&&anchor===targetAnchor)errors.push('请选择与来源不同的目标位置。');
  return {pairs,errors,conflicts};
}
function openRelocation(){
  if(busy||frozen||!canLeave())return;
  const source=current(),wells=[...selected];
  if(!source||source.status!=='active'||!boot.layouts[source.type])return toast('请选择正在培养的孔板。',true);
  if(!wells.some(k=>source.wells[k]?.cell))return toast('请先选择至少一个有记录的孔位。',true);
  dirty=false;
  relocationDraft={revision:state.revision,sourceId:source.id,wells,anchor:wells[0],targetId:source.id,targetAnchor:null,hover:null,mode:null,dragging:false,saving:false,error:'',containers:structuredClone(state.containers.filter(c=>c.status==='active'&&boot.layouts[c.type]))};
  renderRelocation();$('#relocation-dialog').showModal();
}
function relocationPlate(id){return relocationDraft.containers.find(c=>c.id===id);}
function relocationPlan(targetAnchor=relocationDraft.targetAnchor){
  const d=relocationDraft,source=relocationPlate(d.sourceId),target=relocationPlate(d.targetId);
  return planRelocation({source,target,sourceDims:boot.layouts[source.type],targetDims:boot.layouts[target.type],wells:d.wells,anchor:d.anchor,targetAnchor,mode:d.mode});
}
function relocationGrid(c,side){
  const d=relocationDraft,[rows,cols]=boot.layouts[c.type];
  return `<div class="relocation-grid" data-relocation-grid="${side}" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${Array.from({length:rows*cols},(_,i)=>{
    const key=String.fromCharCode(65+Math.floor(i/cols))+(i%cols+1),chosen=side==='source'&&d.wells.includes(key),cell=c.wells[key]?.cell;
    return `<button type="button" class="relocation-well ${chosen?'selected':''} ${cell?'occupied':''} ${chosen&&key===d.anchor?'anchor':''}" data-relocation-well="${key}" ${side==='source'?`draggable="${chosen&&!!d.mode}" ${chosen?'':'disabled'} aria-pressed="${chosen&&key===d.anchor}"`:''} title="${esc(key+' · '+(cell||'空孔'))}" aria-label="${esc((side==='source'?'来源':'目标')+' '+key+'，'+(cell||'空孔'))}"><strong>${key}</strong><small>${esc(cell||'空孔')}</small></button>`;
  }).join('')}</div>`;
}
function renderRelocation(){
  const d=relocationDraft,dialog=$('#relocation-dialog'),source=relocationPlate(d.sourceId),target=relocationPlate(d.targetId);
  dialog.classList.add('transfer-dialog');
  dialog.innerHTML=`<div class="dialog-head"><div><span class="eyebrow">WELL PLACEMENT</span><h2>复制 / 移动所选孔位</h2></div><button type="button" class="icon-button" id="close-relocation" aria-label="关闭孔位复制移动窗口">×</button></div>
    <div class="actions" aria-label="选择操作方式">${[['copy','复制'],['move','移动']].map(([mode,label])=>`<button type="button" class="button ${d.mode===mode?'primary':'secondary'}" data-relocation-mode="${mode}" aria-pressed="${d.mode===mode}">${label}</button>`).join('')}</div>
    <p class="muted">先选复制或移动，再从左侧任一选中孔拖到右侧目标孔，整组相对位置保持不变。也可点击左侧锚点，再点击右侧目标孔。</p>
    <div class="two relocation-plates"><section class="panel"><h3>来源 · ${esc(source.name)}</h3><p class="muted">${esc(source.type)} · 已选 ${d.wells.length} 孔 · <span id="relocation-anchor-label">锚点 ${esc(d.anchor)}</span></p>${relocationGrid(source,'source')}</section>
    <section class="panel"><label>目标孔板<select id="relocation-target">${d.containers.map(c=>`<option value="${esc(c.id)}" ${c.id===d.targetId?'selected':''}>${esc(c.name+' · '+c.type+(c.id===d.sourceId?'（同一孔板）':''))}</option>`).join('')}</select></label>${relocationGrid(target,'target')}</section></div>
    <section class="relocation-review" id="relocation-review" aria-live="polite"></section><p id="relocation-error" role="alert"></p>
    <div class="dialog-actions"><button type="button" class="button secondary" id="cancel-relocation">取消</button><button type="button" class="button primary" id="commit-relocation" disabled>确认复制 / 移动</button></div>`;
  const close=()=>{if(!d.saving&&!busy){dialog.close();relocationDraft=null;}};
  $('#close-relocation').onclick=$('#cancel-relocation').onclick=close;
  dialog.oncancel=e=>{if(d.saving||busy)e.preventDefault();else relocationDraft=null;};
  dialog.querySelectorAll('[data-relocation-mode]').forEach(button=>button.onclick=()=>{
    if(d.saving)return;d.mode=button.dataset.relocationMode;d.error='';renderRelocation();
  });
  $('#relocation-target').onchange=e=>{if(d.saving)return;d.targetId=e.target.value;d.targetAnchor=null;d.hover=null;d.error='';renderRelocation();};
  const sourceGrid=dialog.querySelector('[data-relocation-grid="source"]'),targetGrid=dialog.querySelector('[data-relocation-grid="target"]');
  sourceGrid.querySelectorAll('[data-relocation-well]').forEach(button=>{
    const key=button.dataset.relocationWell;
    button.onclick=()=>{if(d.saving||!d.wells.includes(key))return;d.anchor=key;d.targetAnchor=null;d.error='';updateRelocationPreview();};
    button.ondragstart=e=>{
      if(d.saving||!d.mode||!d.wells.includes(key)){e.preventDefault();return;}
      d.anchor=key;d.targetAnchor=null;d.hover=null;d.dragging=true;d.error='';
      e.dataTransfer.effectAllowed=d.mode==='copy'?'copy':'move';e.dataTransfer.setData('text/plain',key);updateRelocationPreview();
    };
    button.ondragend=()=>{d.dragging=false;d.hover=null;updateRelocationPreview();};
  });
  targetGrid.querySelectorAll('[data-relocation-well]').forEach(button=>{
    const key=button.dataset.relocationWell;
    button.onclick=()=>{if(d.saving)return;if(!d.mode){d.error='请先选择复制或移动。';updateRelocationPreview();return;}d.targetAnchor=key;d.error='';updateRelocationPreview();};
    button.ondragover=e=>{if(!d.dragging||d.saving)return;e.preventDefault();e.dataTransfer.dropEffect=d.mode==='copy'?'copy':'move';if(d.hover!==key){d.hover=key;updateRelocationPreview();}};
    button.ondrop=e=>{if(!d.dragging||d.saving)return;e.preventDefault();d.targetAnchor=key;d.hover=null;d.dragging=false;updateRelocationPreview();};
  });
  targetGrid.ondragleave=e=>{if(!targetGrid.contains(e.relatedTarget)){d.hover=null;updateRelocationPreview();}};
  $('#commit-relocation').onclick=commitRelocation;updateRelocationPreview();
}
function updateRelocationPreview(){
  const d=relocationDraft;if(!d)return;
  const targetAnchor=d.hover||d.targetAnchor,plan=targetAnchor&&d.mode?relocationPlan(targetAnchor):null;
  const destination=new Set(plan?.pairs.filter(p=>p.to).map(p=>p.to)||[]),conflicts=new Set(plan?.conflicts||[]),label=d.mode==='move'?'移动':'复制';
  const dialog=$('#relocation-dialog');
  dialog.querySelectorAll('[data-relocation-grid="source"] [data-relocation-well]').forEach(button=>{const active=button.dataset.relocationWell===d.anchor;button.classList.toggle('anchor',active);button.setAttribute('aria-pressed',String(active));});
  $('#relocation-anchor-label').textContent='锚点 '+d.anchor;
  dialog.querySelectorAll('[data-relocation-grid="target"] [data-relocation-well]').forEach(button=>{const key=button.dataset.relocationWell;button.classList.toggle('preview',destination.has(key));button.classList.toggle('conflict',conflicts.has(key));button.setAttribute('aria-pressed',String(destination.has(key)));});
  const source=relocationPlate(d.sourceId),target=relocationPlate(d.targetId);
  $('#relocation-review').innerHTML=plan?`<h3>${label}预览 · ${plan.pairs.filter(p=>p.occupied).length} 条记录</h3><p>${esc(source.name)} → ${esc(target.name)}</p><p>${plan.pairs.map(p=>`${esc(p.from)} → ${esc(p.to||'超出边界')}${p.occupied?'':'（空孔，跳过）'}`).join('； ')}</p><p class="muted">${d.mode==='move'?'确认后清空有记录的来源孔。':'确认后保留来源孔。'} 原有身份、培养时间和处理信息完整保留。</p>`:'<p class="muted">选择操作方式和目标孔后，这里会显示整组去向。确认前不会修改记录。</p>';
  $('#relocation-error').textContent=[d.error,...(plan?.errors||[])].filter(Boolean).join(' ');
  const commit=$('#commit-relocation');commit.textContent=d.saving?'正在保存…':d.mode?'确认'+label:'确认复制 / 移动';commit.disabled=d.saving||!d.targetAnchor||!plan||!!plan.errors.length;
}
async function commitRelocation(){
  const d=relocationDraft;if(!d||busy||d.saving||!d.targetAnchor||relocationPlan().errors.length)return;
  d.saving=true;busy=true;d.error='';updateRelocationPreview();
  $('#relocation-dialog').querySelectorAll('button,select').forEach(control=>control.disabled=true);
  try{
    const result=await api('/api/command',{action:'relocate',revision:d.revision,payload:{mode:d.mode,source_id:d.sourceId,wells:d.wells,anchor:d.anchor,target_id:d.targetId,target_anchor:d.targetAnchor}});
    state=result.state;dirty=false;selected.clear();currentId=d.targetId;$('#relocation-dialog').close();relocationDraft=null;render();toast(d.mode==='move'?'所选孔位已移动。':'所选孔位已复制。');
  }catch(error){d.error=error.message;d.saving=false;renderRelocation();}finally{busy=false;if(typeof renderUndoControl==='function')renderUndoControl();}
}
if(typeof module!=='undefined')module.exports={planRelocation};
