'use strict';
/* Create blank notebook drafts populated only from the selected plate's saved layout. */
window.PlateToday = (() => {
  function options() {
    return Object.entries(boot.lab_schema?.modules || {}).flatMap(([type,module]) =>
      Object.entries(module.variants).filter(([,variant]) => variant.plate_today_kind)
        .map(([variant,definition]) => ({type,variant,kind:definition.plate_today_kind,
          label:module.label+' · '+definition.label})));
  }
  function records(c) {
    return (state.lab_records || []).filter(record => record.status!=='cancelled' &&
      record.plate_context?.container_id===c.id).sort((a,b)=>b.record_date.localeCompare(a.record_date));
  }
  function markup(c) {
    return `<section class="plate-today"><button type="button" class="button secondary" id="plate-today-open">创建今日实验</button>
      <small class="muted">将本板已保存的实验布局带入草稿，其余内容留空。</small>
      ${records(c).map(record=>`<button type="button" class="text-button" data-plate-record="${esc(record.id)}">${esc(record.title)} · ${esc(record.record_date)}</button>`).join('')}</section>`;
  }
  function bind(c) {
    const button=$('#plate-today-open');
    if(button)button.onclick=()=>open(c);
    document.querySelectorAll('[data-plate-record]').forEach(button=>button.onclick=()=>{
      if(!busy && canLeave())openLabRecord(button.dataset.plateRecord);
    });
  }
  function open(c) {
    if(busy || modalOpen() || frozen || c.status!=='active')return;
    if(dirty)return toast('请先保存或取消当前孔位修改，再创建今日实验。',true);
    const dialog=$('#plate-today-dialog'), day=boot.today, revision=state.revision;
    dialog.innerHTML=`<div class="dialog-head"><h2 id="plate-today-title">创建今日实验</h2><button type="button" class="icon-button" data-close aria-label="关闭">×</button></div>
      <p>${esc(c.name)} · ${esc(day)}</p><form><label>实验类型<select name="kind" required><option value="">请选择实验类型</option>${options().map(option=>`<option value="${esc(option.kind)}">${esc(option.label)}</option>`).join('')}</select></label>
      <p class="muted">草稿只带入已保存的孔位、分组和实际填写值，实验方法与结果待填写。</p>
      <p class="work-form-error" role="alert" data-error hidden></p><div class="dialog-actions"><button type="button" class="button secondary" data-close>取消</button><button type="submit" class="button primary" id="plate-today-save">创建实验草稿</button></div></form>`;
    const form=dialog.querySelector('form'), kind=form.elements.kind, error=form.querySelector('[data-error]');
    let saving=false;
    dialog.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>{if(!saving)dialog.close();});
    dialog.oncancel=event=>{if(saving)event.preventDefault();};
    form.onsubmit=async event=>{
      event.preventDefault();
      if(busy || saving || !kind.value || !form.reportValidity())return;
      const option=options().find(option=>option.kind===kind.value);
      saving=busy=true;
      form.querySelectorAll('select,button').forEach(input=>input.disabled=true);
      try {
        const result=await api('/api/command',{action:'plate_experiment_today',payload:{id:c.id,kind:kind.value,date:day},revision});
        state=result.state;
        const record=records(c).find(record=>record.record_date===day && record.type===option.type && record.variant===option.variant);
        if(!record)throw Error('未能识别对应实验记录，请刷新后核对。');
        dirty=false;dialog.close();busy=saving=false;render();openLabRecord(record.id);
        toast('已打开实验草稿 · '+record.title);
      } catch(cause) {
        error.textContent=(cause.message || '无法确认是否保存。')+' 请关闭并刷新工作台后核对记录。';error.hidden=false;
      } finally {
        busy=saving=false;dialog.querySelectorAll('[data-close]').forEach(button=>button.disabled=false);
        if(typeof renderUndoControl==='function')renderUndoControl();
      }
    };
    dialog.showModal();kind.focus();
  }
  return {markup,bind};
})();
