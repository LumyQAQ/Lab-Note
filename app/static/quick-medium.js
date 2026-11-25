'use strict';

let quickMediumDraft=null;

function quickMediumButtons(c){
  if(!c||frozen||c.status!=='active')return '';
  const disabled=busy||!Object.values(c.wells||{}).some(memberActive);
  return `<span class="quick-medium-buttons">${[['full','换液'],['half','半换液']].map(([kind,label])=>`<button type="button" class="button secondary quick-medium-button" data-quick-medium="${kind}" data-container-id="${esc(c.id)}" ${disabled?'disabled':''}>${label}</button>`).join('')}</span>`;
}

function bindQuickMediumButtons(root){
  root.querySelectorAll('[data-quick-medium]').forEach(button=>button.onclick=()=>openQuickMedium(button.dataset.containerId,button.dataset.quickMedium));
}

function closeQuickMedium(){
  if(busy)return false;
  $('#quick-medium-dialog').close();
  if(quickMediumDraft)dirty=false;
  quickMediumDraft=null;
  return true;
}

function openQuickMedium(id,kind='full',scope='selection'){
  if(busy||frozen)return;
  const dialog=$('#quick-medium-dialog');
  if(dialog.open)return;
  if(dirty){toast('请先保存当前修改，再记录换液。',true);return;}
  const source=activeState(),targetId=displayMemberLocation(source,id||currentId,'').id;
  const container=displayContainers(source).find(c=>c.id===targetId);
  if(!container||container.status!=='active'){toast('请选择在培养的容器。',true);return;}
  if(!['full','half'].includes(kind))return;
  const sameCurrent=scope!=='all'&&container.id===currentId;
  if(sameCurrent&&!selected.size&&boot.layouts[container.type]){toast('请选择需要换液的孔。',true);return;}
  const requested=sameCurrent&&selected.size?[...selected]:Object.keys(container.wells);
  const keys=requested.filter(key=>memberActive(container.wells[key]));
  if(!keys.length){toast('请选择需要换液的在培养孔位或瓶 / 皿。',true);return;}
  const wells=keys.map(key=>container.wells[key]),label=kind==='half'?'半换液':'换液',now=localMinute();
  quickMediumDraft={id:container.id,wells:keys,kind,fromPlateSelection:!!(sameCurrent&&boot.layouts[container.type]),revision:state.revision};
  dialog.classList.add('quick-medium-dialog');
  dialog.innerHTML=`<form id="quick-medium-form" novalidate>
    <div class="dialog-head"><div><span class="eyebrow">CULTURE MEDIUM</span><h2>${label}</h2></div><button type="button" class="icon-button" data-quick-medium-cancel aria-label="关闭">×</button></div>
    <section class="quick-medium-scope" aria-label="本次换液范围"><strong>${esc(container.name)}</strong><p>${keys.length} 个培养单元 · ${esc(groupTypeLabel(container))}</p><ul>${keys.map(key=>`<li data-quick-medium-well="${esc(key)}">${esc(groupMemberLabel(container,key))}</li>`).join('')}</ul></section>
    <label for="quick-medium-time">实际发生时间（北京时间）<input id="quick-medium-time" data-quick-medium-field="occurred_at" type="datetime-local" required value="${esc(now)}" max="${esc(now)}"></label>
    <p class="quick-medium-keep" id="quick-medium-keep">培养基保持不变（各孔保留原配方）</p>
    <label class="inline-check quick-medium-toggle"><input type="checkbox" data-quick-medium-edit aria-controls="quick-medium-recipe"><span>修改培养基成分</span></label>
    <fieldset id="quick-medium-recipe" class="quick-medium-recipe" hidden disabled>${mediumEditorMarkup(wells,null,false,'quick-')}</fieldset>
    <label class="inline-check quick-medium-toggle"><input type="checkbox" data-quick-medium-check checked><span>保存后同时确认${container.display_group?'所选容器':'本容器'}今日核对</span></label>
    <details class="quick-medium-options"><summary>补充体积 / 备注（可选）</summary><div class="two"><label for="quick-medium-volume">本次换入体积（每孔 / 瓶 / 皿）<input id="quick-medium-volume" data-quick-medium-field="volume_value" inputmode="decimal" placeholder="未记录"></label><label for="quick-medium-volume-unit">体积单位${unitChoice(`<input id="quick-medium-volume-unit" data-quick-medium-field="volume_unit" value="mL" placeholder="填写单位">`,unitPresets.volume,'换入体积单位')}</label></div><label for="quick-medium-details">操作备注<textarea id="quick-medium-details" data-quick-medium-field="details" rows="2" placeholder="记录本次操作的补充信息"></textarea></label></details>
    <p id="quick-medium-error" class="work-form-error" role="alert" hidden></p>
    <div class="dialog-actions"><button type="button" class="button secondary" data-quick-medium-cancel>取消</button><button type="submit" class="button primary">确认${label}</button></div>
  </form>`;
  bindMediumEditor(wells,null,dialog.querySelector('#quick-medium-editor'),'quick-');
  dialog.querySelectorAll('[data-quick-medium-cancel]').forEach(button=>button.onclick=closeQuickMedium);
  dialog.oncancel=event=>{event.preventDefault();closeQuickMedium();};
  const form=dialog.querySelector('form');
  form.addEventListener('input',()=>{dirty=true;});
  form.addEventListener('change',()=>{dirty=true;});
  dialog.querySelector('[data-quick-medium-edit]').addEventListener('change',event=>{
    const editing=event.target.checked,recipe=dialog.querySelector('#quick-medium-recipe');
    recipe.hidden=!editing;recipe.disabled=!editing;
    dialog.querySelector('#quick-medium-keep').hidden=editing;
  });
  form.onsubmit=saveQuickMedium;
  dialog.showModal();
}

async function saveQuickMedium(event){
  event.preventDefault();
  if(busy||!quickMediumDraft)return;
  const dialog=$('#quick-medium-dialog'),draft=quickMediumDraft;
  const value=key=>dialog.querySelector(`[data-quick-medium-field="${key}"]`).value.trim();
  const fail=message=>{const error=dialog.querySelector('#quick-medium-error');error.textContent=message;error.hidden=false;};
  const occurredAt=value('occurred_at'),volume=value('volume_value'),unit=value('volume_unit'),details=value('details');
  if(!occurredAt||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(occurredAt)||!Number.isFinite(Date.parse(occurredAt))){fail('请填写有效的实际发生时间。');return;}
  if(occurredAt>localMinute()){fail('实际发生时间不能晚于现在。');return;}
  if(volume&&(!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(volume)||!Number.isFinite(Number(volume))||Number(volume)<=0||!unit)){fail('请填写大于 0 的本次换入体积及单位，或留空。');return;}
  const payload={id:draft.id,wells:[...draft.wells],kind:'medium_change',exchange_kind:draft.kind,occurred_at:occurredAt,confirm_checked:dialog.querySelector('[data-quick-medium-check]').checked};
  if(volume){payload.volume_value=volume;payload.volume_unit=unit;}
  if(details)payload.details=details;
  if(dialog.querySelector('[data-quick-medium-edit]').checked){
    const patch=collectMediumPatch(dialog.querySelector('#quick-medium-editor'));
    if(Object.keys(patch).length)payload.medium_patch=patch;
  }
  busy=true;dialog.querySelector('#quick-medium-error').hidden=true;
  const controls=[...dialog.querySelectorAll('button,input,select,textarea')],disabled=controls.map(control=>control.disabled);
  controls.forEach(control=>control.disabled=true);
  try{
    const result=await api('/api/command',{action:'activity',payload,revision:draft.revision});
    state=result.state;
    if(draft.fromPlateSelection&&currentId===draft.id)selected.clear();
    dirty=false;quickMediumDraft=null;dialog.close();busy=false;render();
    toast((draft.kind==='half'?'已记录半换液':'已记录换液')+(payload.confirm_checked?'，并确认今日核对':''));
  }catch(error){fail(error.message);}
  finally{busy=false;controls.forEach((control,index)=>control.disabled=disabled[index]);renderUndoControl();}
}
