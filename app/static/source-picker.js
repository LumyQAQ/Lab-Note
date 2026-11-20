'use strict';

function sourcePickerGroups(options){
  const groups=new Map();
  for(const option of options){
    if(!groups.has(option.id))groups.set(option.id,{container:state.containers.find(c=>c.id===option.id)||{id:option.id,name:option.name,wells:{}},options:[]});
    groups.get(option.id).options.push(option);
  }
  return [...groups.values()];
}
function sourcePickerView(groups,selected,viewId){
  return groups.find(g=>g.container.id===viewId)||groups.find(g=>g.options.some(o=>selected.has(o.key)))||groups[0];
}
function sourcePickerKeys(container,options){
  const dims=boot.layouts[container.type];
  if(dims)return Array.from({length:dims[0]},(_,r)=>Array.from({length:dims[1]},(_,c)=>String.fromCharCode(65+r)+(c+1))).flat();
  const keys=Object.keys(container.wells||{});
  for(const option of options)if(!keys.includes(option.well))keys.push(option.well);
  const defaults=groupKeys(container.type,container.quantity||1);
  for(let i=keys.length;i<defaults.length;i++){
    let key=defaults[i],suffix=i+1;while(keys.includes(key))key=defaults[i]+'-'+(++suffix);
    keys.push(key);
  }
  return keys;
}
function sourcePickerCount(selected,options){
  return `已选 ${selected.size} 处 · 当前容器 ${options.filter(o=>selected.has(o.key)).length} / ${options.length} 处`;
}
function sourcePickerSelectionMode({selectionMode,getSelectionMode}={}){
  const mode=typeof getSelectionMode==='function'?getSelectionMode():selectionMode;
  return mode||(typeof wellSelectionMode==='undefined'?'single':wellSelectionMode);
}
function sourcePickerMarkup({scope,options,selectedKeys=[],viewId='',lockedKeys=[],selectionMode,getSelectionMode}){
  const selected=new Set(selectedKeys),locked=new Set(lockedKeys),groups=sourcePickerGroups(options),view=sourcePickerView(groups,selected,viewId);
  if(!view)return `<section class="source-picker" data-source-picker="${esc(scope)}"><p class="source-picker-empty">暂无可选来源</p></section>`;
  const c=view.container,dims=boot.layouts[c.type],byWell=new Map(view.options.map(o=>[o.well,o])),keys=sourcePickerKeys(c,view.options);
  function wellMarkup(well){
    const option=byWell.get(well),key=option?.key||c.id+'|'+well,cell=option?.cell||c.wells?.[well]?.cell||'',isLocked=locked.has(key),ended=option?option.active===false:c.status==='archived'||c.wells?.[well]?.member_status==='archived';
    const label=dims?well:groupMemberLabel(c,well),status=isLocked?'已锁定':!option?cell?'不在本次可选来源中':'空位':ended?'已结束，仅用于来源更正':'';
    return `<button type="button" class="source-well ${cell?'filled':''} ${selected.has(key)?'selected':''} ${isLocked?'locked':''} ${ended?'ended':''}" data-well="${esc(well)}" data-source-key="${esc(key)}" aria-pressed="${selected.has(key)}" title="${esc(c.name+' / '+well+' · '+(cell||'空位')+(status?' · '+status:''))}" ${!option||isLocked?'disabled':''}><strong>${esc(label)}</strong><small>${esc(cell||'空位')}</small>${isLocked?'<span class="source-lock" aria-label="已锁定">锁</span>':''}</button>`;
  }
  const grid=dims?`<span class="source-axis" aria-hidden="true"></span>${Array.from({length:dims[1]},(_,col)=>`<span class="source-axis" data-source-column="${col+1}" aria-hidden="true">${col+1}</span>`).join('')}${Array.from({length:dims[0]},(_,row)=>`<span class="source-axis" data-source-row="${String.fromCharCode(65+row)}" aria-hidden="true">${String.fromCharCode(65+row)}</span>${keys.slice(row*dims[1],(row+1)*dims[1]).map(wellMarkup).join('')}`).join('')}`:keys.map(wellMarkup).join('');
  return `<section class="source-picker" data-source-picker="${esc(scope)}" data-source-container="${esc(c.id)}">
    <div class="source-picker-top"><label class="source-view-label">查看来源容器<select data-source-view="${esc(scope)}">${groups.map(g=>`<option value="${esc(g.container.id)}" ${g===view?'selected':''}>${esc(g.container.name+' · '+(g.container.type||'容器')+' · '+g.container.id)}</option>`).join('')}</select></label><span class="source-picker-count" data-source-count aria-live="polite">${sourcePickerCount(selected,view.options)}</span></div>
    <div class="source-picker-tools"><button type="button" class="text-button" data-source-all="${esc(scope)}">全选本容器可用来源</button><button type="button" class="text-button" data-source-none="${esc(scope)}">清空本容器选择</button><span>点选可多选${dims?' · 拖动可框选':''}</span></div>
    ${(c.well_groups||[]).some(group=>group.wells.some(well=>byWell.has(well)))?`<div class="source-picker-group-chips">${c.well_groups.filter(group=>group.wells.some(well=>byWell.has(well))).map(group=>`<button type="button" data-source-group="${esc(group.id)}" aria-pressed="false"><strong>${esc(group.name)}</strong><small>${group.wells.map(esc).join(' · ')}</small></button>`).join('')}</div>`:''}
    <p class="source-picker-warning" data-source-warning role="status" hidden></p>
    <div class="source-picker-scroll"><div class="source-picker-grid ${dims?'source-plate'+(dims[1]>6?' dense':''):'source-members'}" data-source-grid="${esc(scope)}" ${dims?`style="grid-template-columns:20px repeat(${dims[1]},minmax(38px,1fr))"`:''} aria-label="${esc(c.name+' 来源'+(dims?'孔板':'成员'))}">${grid}</div></div>
    <p class="source-picker-note">切换容器保留已选来源。灰色孔位不可选${locked.size?'；标有“锁”的来源已被锁定去向组使用':''}。${view.options.some(o=>o.active===false)?'标为已结束的来源：已结束，仅用于来源更正。':''}</p>
  </section>`;
}

// The parent owns committed selections. Pointer previews stay local until release.
function bindSourcePicker(root,{scope,options,getSelected,lockedKeys=[],canEdit=()=>true,onChange,onViewChange,selectionMode,getSelectionMode}){
  const picker=root?.dataset?.sourcePicker===scope?root:[...(root?.querySelectorAll('[data-source-picker]')||[])].find(node=>node.dataset.sourcePicker===scope);
  if(!picker)return;
  const view=sourcePickerGroups(options).find(g=>g.container.id===picker.dataset.sourceContainer),select=picker.querySelector('[data-source-view]');
  if(select)select.onchange=()=>onViewChange?.(select.value);
  if(!view)return;
  const locked=new Set(lockedKeys),editable=()=>typeof canEdit==='function'?canEdit():canEdit,grid=picker.querySelector('[data-source-grid]');
  const byWell=new Map(view.options.map(o=>[o.well,o])),byKey=new Map(view.options.map(o=>[o.key,o]));
  let previewSelection=null;
  const current=()=>new Set(previewSelection||getSelected());
  const groupMembers=group=>(group.wells||[]).filter(well=>{const record=view.container.wells?.[well];return view.container.status!=='archived'&&record?.cell&&record.member_status!=='archived';});
  function groupedSelection(candidate,previous,preview=false){
    const next=new Set(candidate),warning=picker.querySelector('[data-source-warning]');let message='';
    if(sourcePickerSelectionMode({selectionMode,getSelectionMode})==='group')for(const group of view.container.well_groups||[]){
      const members=groupMembers(group),keys=members.map(well=>byWell.get(well)?.key||view.container.id+'|'+well);
      const removed=keys.some(key=>previous.has(key)&&!next.has(key)),added=keys.some(key=>next.has(key)&&!previous.has(key));
      if(removed){for(const key of keys)if(!locked.has(key))next.delete(key);}
      else if(added){
        const unavailable=members.some(well=>{const option=byWell.get(well);return !option||option.active===false||!String(option.cell||view.container.wells?.[well]?.cell||'').trim()||locked.has(option.key)&&!previous.has(option.key);});
        if(unavailable){
          for(const key of keys)previous.has(key)?next.add(key):next.delete(key);
          message='培养组“'+group.name+'”包含本次不可选或已锁定的成员。请切换单孔后选择，或返回完整来源范围。';
        }else for(const key of keys)next.add(key);
      }
    }
    if(warning&&(preview||previewSelection===null||message)){warning.textContent=message;warning.hidden=!message;}
    return next;
  }
  function paint(next){
    for(const button of grid.querySelectorAll('[data-source-key]')){
      const key=button.dataset.sourceKey;
      button.classList.toggle('selected',next.has(key));button.setAttribute('aria-pressed',String(next.has(key)));
      button.disabled=!byKey.has(key)||locked.has(key)||!editable();
    }
    picker.querySelector('[data-source-count]').textContent=sourcePickerCount(next,view.options);
    for(const button of picker.querySelectorAll('[data-source-group]')){
      const group=(view.container.well_groups||[]).find(group=>group.id===button.dataset.sourceGroup),members=groupMembers(group),pressed=members.length>0&&members.every(well=>next.has(byWell.get(well)?.key||view.container.id+'|'+well));
      button.classList.toggle('selected',pressed);button.setAttribute('aria-pressed',String(pressed));button.disabled=!editable();
    }
  }
  function commit(next){
    previewSelection=null;paint(next);
    const previous=new Set(getSelected());
    if(next.size!==previous.size||[...next].some(key=>!previous.has(key)))onChange(new Set(next));
  }
  bindWellSelection(grid,{touchRange:true,
    getSelected:()=>{const selected=current();return new Set(view.options.filter(o=>selected.has(o.key)).map(o=>o.well));},
    canStart:editable,
    onChange:(wells,preview)=>{
      let next=new Set(getSelected());
      if(editable())for(const option of view.options){
        if(locked.has(option.key))continue;
        wells.has(option.well)?next.add(option.key):next.delete(option.key);
      }
      next=groupedSelection(next,new Set(getSelected()),preview);
      if(preview){previewSelection=next;paint(next);}else commit(next);
    }
  });
  const cancelSelection=grid.onpointercancel;grid.onpointercancel=event=>{cancelSelection(event);const warning=picker.querySelector('[data-source-warning]');if(warning){warning.textContent='';warning.hidden=true;}};
  // selection.js supplies rectangle geometry; the picker additionally guards disabled cells.
  for(const name of ['onpointerdown','onclick']){
    const handler=grid[name];grid[name]=event=>{const button=event.target?.closest?.('[data-well]');if(button&&(button.disabled||!byWell.has(button.dataset.well)))return;handler(event);};
  }
  for(const [attribute,add] of [['data-source-all',true],['data-source-none',false]]){
    const button=picker.querySelector('['+attribute+']');
    button.disabled=!editable()||!view.options.some(o=>!locked.has(o.key));
    button.onclick=()=>{
      if(!editable())return;
      const next=new Set(getSelected());
      for(const option of view.options)if(!locked.has(option.key))add?next.add(option.key):next.delete(option.key);
      commit(groupedSelection(next,new Set(getSelected())));
    };
  }
  for(const button of picker.querySelectorAll('[data-source-group]'))button.onclick=()=>{
    if(!editable())return;
    const group=(view.container.well_groups||[]).find(group=>group.id===button.dataset.sourceGroup),members=groupMembers(group),previous=new Set(getSelected()),next=new Set(previous),remove=members.every(well=>previous.has(byWell.get(well)?.key||view.container.id+'|'+well));
    // A named group chip always requests its full active membership.
    for(const well of members){const key=byWell.get(well)?.key||view.container.id+'|'+well;if(locked.has(key))continue;remove?next.delete(key):next.add(key);}
    const mode=sourcePickerSelectionMode({selectionMode,getSelectionMode});
    if(mode==='single'){
      for(const key of next)if(!previous.has(key)&&(!byKey.has(key)||byKey.get(key).active===false))next.delete(key);
      commit(next);
    }else commit(groupedSelection(next,previous));
  };
  paint(new Set(getSelected()));
}
