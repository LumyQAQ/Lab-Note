'use strict';
function bindPhaseThreeEditor(editor){
  const r=editor.record;if(!r.id||!boot.word_format)return;
  const form=$('#lab-record-form');
  const host=form.querySelector('[data-lab-word-editions]')||document.createElement('section');
  host.classList.add('panel','word-editions');
  host.setAttribute('aria-label','Word 草稿与归档');
  if(!host.parentNode)form.querySelector('.dialog-head').after(host);
  const toolsSlot=form.querySelector('[data-lab-word-tools]');
  if(toolsSlot){
    const jump=document.createElement('button');
    jump.type='button';jump.className='text-button';jump.textContent='Word 草稿与归档';
    jump.setAttribute('aria-controls',host.id);
    jump.onclick=()=>{
      host.scrollIntoView({block:'start'});
      host.querySelector('[data-word-download]').focus({preventScroll:true});
    };
    toolsSlot.replaceChildren(jump);
  }
  const cfg=boot.word_format,stamp=r.updated_at;
  const prefKey='labnote.word-layout.'+cfg.id+':'+(boot.data_dir||'local');
  const defaults=cfg.sections.map(({key,title})=>({key,title}));
  let tplCatalog=null, selectedTemplateId='';
  const savedLayout=()=>{try{const x=JSON.parse(localStorage.getItem(prefKey));return Array.isArray(x)&&x.length&&x.length<=defaults.length&&new Set(x.map(a=>a.key)).size===x.length&&x.every(a=>a&&defaults.some(s=>s.key===a.key)&&typeof a.title==='string'&&a.title.trim()&&a.title.length<=60)?x:null;}catch{return null;}};
  // Older database entries contain only a document digest. A label is known
  // only on a browser that saw the layout used to generate that exact digest.
  const formatKey=id=>prefKey+'.edition.'+id;
  const knownFormats=new Map();
  function editionFormat(id){
    if(knownFormats.has(id))return knownFormats.get(id);
    try{return localStorage.getItem(formatKey(id))||'栏目格式未登记';}
    catch{return '栏目格式未登记';}
  }
  function rememberFormat(id,format,tplName){
    const standard=!format||format.length===defaults.length&&format.every((part,i)=>part.key===defaults[i].key&&part.title===defaults[i].title);
    const label=tplName && standard ? tplName : standard?(defaults.length===6?'六栏目标准版':cfg.name):'自选 '+format.length+' 栏';
    knownFormats.set(id,label);
    try{localStorage.setItem(formatKey(id),label);}catch{}
  }
  async function loadTemplates(){
    try{
      tplCatalog=await api('/api/word-templates');
      if(!selectedTemplateId)selectedTemplateId=tplCatalog.default_template_id||'';
      if(labEditor===editor && host.isConnected)draw();
    }catch(_){}
  }
  function draw(){
    const source=editor.context?.state||state;
    const all=(source.word_editions||[]).filter(a=>a.record_id===r.id);
    const current=all.filter(a=>a.record_updated_at===stamp&&a.version===r.version);
    const ordered=[...current,...all.filter(a=>!current.includes(a))];
    const tpls=tplCatalog?.templates||[];
    const activeTpl=tpls.find(t=>t.id===selectedTemplateId)||tpls.find(t=>t.is_default)||tpls[0];
    const tplPicker=tpls.length
      ? `<label class="word-tpl-select">导出模版<select data-word-tpl-select>${tpls.map(t=>`<option value="${esc(t.id)}" ${t.id===(activeTpl?.id||'')?'selected':''}>${esc(t.name)}${t.is_default?'（默认）':''}</option>`).join('')}</select></label>`
      : '';
    const actions=`<button type="button" class="button secondary" data-word-download>按模版生成 Word</button><button type="button" class="text-button" data-word-format>调整本次栏目</button>${activeTpl?`<a class="text-button" href="/api/word-templates/${encodeURIComponent(activeTpl.id)}/download">下载空白模版</a>`:''}`;
    const formatState=`${editor.readonly?'快照':'当前'} v${r.version} ${current.length?'已出稿 · '+current.length+' 份':'未出稿'}`;
    const headerState=form.querySelector('[data-lab-word-state]');
    if(headerState){
      headerState.className='state-badge '+(current.length?'is-info':'is-pending');
      headerState.textContent=formatState;
    }
    host.innerHTML=`<h3>Word 草稿与归档</h3><div class="state-badges"><span class="state-badge ${current.length?'is-info':'is-pending'}">${esc(formatState)}</span>${activeTpl?`<span class="state-badge">${esc(activeTpl.mode==='placeholder'?'占位符套打':'自动排版')}</span>`:''}</div>
      <p class="muted">${activeTpl?esc(activeTpl.description||activeTpl.name):(savedLayout()?'本浏览器的自选格式':esc(cfg.name))}。草稿使用已保存的内容。可在电脑端「数据与备份」上传自备 .docx 模版建档；请检查文档后自行归档。</p>
      ${tplPicker}
      <div class="actions">${actions}</div>
      ${ordered.length?`<ul class="word-edition-list">${ordered.map(a=>{
        const thisVersion=current.includes(a),stateText=a.archived_at?'已由本人确认归档':'待本人归档';
        return `<li data-word-edition="${esc(a.id)}"><span class="state-badge ${a.archived_at?'is-saved':'is-pending'}">v${esc(a.version)}（${esc(editionFormat(a.id))}）${stateText}</span><small>${esc(a.filename)}${a.archived_at?' · '+esc(shortTime(a.archived_at)):''}</small>${!editor.readonly&&thisVersion&&!a.archived_at?`<button type="button" class="text-button" data-word-archive="${esc(a.id)}">确认此稿已由我归档</button>`:''}</li>`;
      }).join('')}</ul>`:''}<p data-word-error role="alert"></p>`;
    const sel=host.querySelector('[data-word-tpl-select]');
    if(sel)sel.onchange=()=>{selectedTemplateId=sel.value;draw();};
    host.querySelector('[data-word-download]').onclick=()=>cfg.confirm_before_export?options():download(savedLayout(),false);
    host.querySelector('[data-word-format]').onclick=options;
    host.querySelectorAll('[data-word-archive]').forEach(b=>b.onclick=async()=>{
      if(!clean()||!confirm('请先在本机自行归档这份 Word。确认已经归档？此处仅登记确认，不会移动文件或更改实验状态。'))return;
      busy=true;try{const ed=current.find(a=>a.id===b.dataset.wordArchive);
        const res=await api('/api/command',{action:'word_archive',revision:editor.revision,payload:{edition:{id:ed.id,version:r.version,record_updated_at:stamp,record_id:r.id}}});state=res.state;editor.revision=state.revision;if(res.undo)boot.undo=res.undo;draw();
      }catch(err){msg(err.message);}finally{busy=false;renderUndoControl();}
    });
  }
  function msg(s){host.querySelector('[data-word-error]').textContent=s;}
  function clean(){if(busy)return false;if(!editor.readonly){labCollectEditor();if(labDraftFingerprint()!==editor.baseline){msg('当前表单有未保存修改，请先保存，再生成或确认归档。');return false;}}return true;}
  function options(){
    if(!clean())return;const box=$('#word-format-dialog'),saved=savedLayout();
    const order=saved?[...saved,...defaults.filter(x=>!saved.some(a=>a.key===x.key))]:defaults;
    box.innerHTML=`<div class="dialog-head"><h2>确认 Word 栏目</h2><button type="button" data-word-close class="icon-button" aria-label="关闭 Word 栏目设置">×</button></div><p>选择要包含的栏目，可调整标题和顺序。本次选择不修改原实验。</p><div data-format-list>${order.map(s=>`<div class="word-format-row" data-key="${esc(s.key)}"><input aria-label="包含${esc(s.title)}" type="checkbox" ${!saved||saved.some(a=>a.key===s.key)?'checked':''}><input type="text" maxlength="60" aria-label="栏目名称" value="${esc(s.title)}"><button type="button" class="text-button" data-up aria-label="上移">↑</button><button type="button" class="text-button" data-down aria-label="下移">↓</button></div>`).join('')}</div><label class="inline-check"><input type="checkbox" data-remember ${saved?'checked':''}>以后在此浏览器沿用此格式</label><button type="button" data-reset class="text-button">恢复默认六栏目</button><div class="dialog-actions"><button class="button secondary" data-cancel>取消</button><button class="button primary" data-export>按此格式生成</button></div><p role="alert"></p>`;
    box.querySelectorAll('[data-up],[data-down]').forEach(b=>b.onclick=()=>{const row=b.parentNode;if(b.hasAttribute('data-up')&&row.previousElementSibling)row.previousElementSibling.before(row);else if(b.hasAttribute('data-down')&&row.nextElementSibling)row.nextElementSibling.after(row);});
    box.querySelector('[data-reset]').onclick=()=>{
      const list=box.querySelector('[data-format-list]');
      for(const def of defaults){const row=[...list.children].find(el=>el.dataset.key===def.key);row.querySelector('[type=text]').value=def.title;row.querySelector('[type=checkbox]').checked=true;list.append(row);}
      box.querySelector('[data-remember]').checked=false;
    };
    box.querySelector('[data-word-close]').onclick=box.querySelector('[data-cancel]').onclick=()=>box.close();box.querySelector('[data-export]').onclick=()=>{
      const items=[...box.querySelectorAll('[data-key]')].filter(row=>row.querySelector('input').checked).map(row=>({key:row.dataset.key,title:row.querySelector('[type=text]').value.trim()}));
      if(!items.length||items.some(x=>!x.title)){box.querySelector('[role=alert]').textContent='请至少保留一个有标题的栏目。';return;}try{if(box.querySelector('[data-remember]').checked)localStorage.setItem(prefKey,JSON.stringify(items));else localStorage.removeItem(prefKey);}catch{}box.close();download(items,true);
    };box.showModal();
  }
  async function download(format,confirmed){
    if(!clean())return;busy=true;const form=$('#lab-record-form');form.inert=true;msg('');
    try{const res=await api('/api/lab/word',{record_id:r.id,record_updated_at:stamp,version:r.version,revision:editor.revision,snapshot:editor.context?.id,format,format_confirmed:confirmed,...(selectedTemplateId?{template_id:selectedTemplateId}:{})});
      if(res.state){state=res.state;editor.revision=state.revision;boot.undo=res.undo;}
      if(res.state)rememberFormat(res.edition.id,format,res.template_name);
      const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(res.document),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
      const a=document.createElement('a');a.href=url;a.download=res.edition.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);draw();toast(`Word 草稿已按「${res.template_name||'标准模版'}」生成，归档仍由你确认。`);
    }catch(err){msg(err.message);}finally{busy=false;form.inert=false;renderUndoControl();}
  }
  draw();
  loadTemplates();
}
