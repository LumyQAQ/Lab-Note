'use strict';
function cellNameHistory(state,history=[]){
  const seen=new Set(),names=[];
  function add(value){if(typeof value!=='string'||!value.trim())return;const name=value.trim(),key=name.toLowerCase();if(!seen.has(key)){seen.add(key);names.push(name);}}
  history.forEach(add);
  (state?.containers||[]).forEach(c=>Object.values(c.wells).forEach(w=>(w.components||[w]).forEach(p=>add(p.cell))));
  return names;
}
function filterCellNames(names,query){const prefix=query.trim().toLowerCase();return names.filter(name=>name.toLowerCase().startsWith(prefix));}
function treatmentHistory(state,history=[]){
  const names=[],seen=new Set();
  const add=value=>{if(typeof value!=='string'||!value.trim())return;const text=value.trim(),key=text.toLowerCase();if(!seen.has(key)){seen.add(key);names.push(text);}};
  history.forEach(add);
  (state?.containers||[]).forEach(c=>Object.values(c.wells).forEach(w=>{add(w.treatment);(w.components||[]).forEach(p=>add(p.treatment));}));
  return names;
}
function filterTreatments(values,query){const text=query.trim().toLowerCase();return values.filter(value=>value.toLowerCase().includes(text));}
function attachCellNameAutocomplete(input,list,getNames){return attachHistoryAutocomplete(input,list,getNames);}
function attachHistoryAutocomplete(input,list,getNames,{label='名称',filter=filterCellNames,optionValue=item=>item,optionLabel=optionValue,onSelect=null}={}){
  let matches=[],index=-1;
  function close(){list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
  function highlight(){
    [...list.querySelectorAll('[role="option"]')].forEach((option,i)=>option.setAttribute('aria-selected',String(i===index)));
    if(index>=0)input.setAttribute('aria-activedescendant',list.id+'-'+index);else input.removeAttribute('aria-activedescendant');
  }
  function choose(i){
    const item=matches[i];if(item===undefined)return;
    input.value=optionValue(item);
    if(onSelect)onSelect(item);
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input',{bubbles:true}));
    close();input.focus();close();
  }
  function show(query){
    const history=getNames();matches=filter(history,query).slice(0,50);index=-1;
    list.replaceChildren();
    if(!matches.length){const message=input.ownerDocument.createElement('div');message.className='suggestion-empty';message.textContent=history.length?`没有匹配的历史${label}，可继续输入。`:`保存${label}后，会在这里显示历史联想。`;list.append(message);}
    matches.forEach((name,i)=>{const option=input.ownerDocument.createElement('button');option.type='button';option.id=list.id+'-'+i;option.setAttribute('role','option');option.setAttribute('aria-selected','false');option.tabIndex=-1;option.textContent=optionLabel(name);option.onmousedown=e=>e.preventDefault();option.onclick=()=>choose(i);list.append(option);});
    list.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
  }
  input.addEventListener('focus',()=>show(''));
  input.addEventListener('input',()=>show(input.value));
  input.addEventListener('blur',close);
  input.addEventListener('keydown',e=>{
    if(e.key==='Escape'){close();e.stopPropagation();return;}
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      if(list.hidden&&input.tagName==='TEXTAREA')return;
      e.preventDefault();if(list.hidden)show(input.value);if(!matches.length)return;
      index=e.key==='ArrowDown'?(index+1)%matches.length:index<0?matches.length-1:(index-1+matches.length)%matches.length;highlight();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block:'nearest'});
    }else if(e.key==='Enter'&&!list.hidden&&index>=0){e.preventDefault();choose(index);}
  });
}
if(typeof module!=='undefined')module.exports={cellNameHistory,filterCellNames,treatmentHistory,filterTreatments};
