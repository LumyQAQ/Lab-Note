'use strict';
function rectangleKeys(start,end,keys) {
  const a=/^([A-Z])(\d+)$/.exec(start),b=/^([A-Z])(\d+)$/.exec(end);
  if(!a||!b)return [];
  const r1=Math.min(a[1].charCodeAt(0),b[1].charCodeAt(0)),r2=Math.max(a[1].charCodeAt(0),b[1].charCodeAt(0));
  const c1=Math.min(+a[2],+b[2]),c2=Math.max(+a[2],+b[2]);
  return keys.filter(k=>{const m=/^([A-Z])(\d+)$/.exec(k);return m&&m[1].charCodeAt(0)>=r1&&m[1].charCodeAt(0)<=r2&&+m[2]>=c1&&+m[2]<=c2;});
}
function bindWellSelection(root,{getSelected,canStart,onChange,touchRange=false}) {
  let drag=null,suppressClick=false;
  const buttons=()=>[...root.querySelectorAll('[data-well]')];
  function buttonFrom(target){const b=target?.closest?.('[data-well]');return b&&root.contains(b)?b:null;}
  function paint(next,preview){onChange(next,preview);}
  root.touchRangeButton?.remove();
  let rangeButton=null,rangeOn=false,corner='';
  function resetRange(){
    rangeOn=false;corner='';
    rangeButton.textContent='两点框选';
    rangeButton.setAttribute('aria-pressed','false');
    root.querySelector('[data-range-corner]')?.removeAttribute('data-range-corner');
  }
  if(touchRange&&root.ownerDocument?.defaultView?.navigator?.maxTouchPoints>0&&buttons().some(b=>/^[A-Z]\d+$/.test(b.dataset.well))){
    rangeButton=root.ownerDocument.createElement('button');
    root.touchRangeButton=rangeButton;rangeButton.type='button';rangeButton.className='button secondary touch-range-button';resetRange();
    const target=root.parentElement.matches('.plate-scroll,.source-picker-scroll')?root.parentElement:root;
    target.before(rangeButton);
    rangeButton.onclick=()=>{
      if(rangeOn){resetRange();return;}
      rangeOn=true;rangeButton.setAttribute('aria-pressed','true');rangeButton.textContent='点选起始孔 · 取消框选';
    };
  }
  root.onpointerdown=e=>{
    if(e.button!==0||e.pointerType==='touch'||rangeOn)return;
    const button=buttonFrom(e.target);if(!button)return;
    suppressClick=false;
    if(!canStart()){suppressClick=true;return;}
    e.preventDefault();button.focus();
    drag={start:button.dataset.well,x:e.clientX,y:e.clientY,initial:new Set(getSelected()),moved:false,id:e.pointerId};
    root.setPointerCapture(e.pointerId);
  };
  root.onpointermove=e=>{
    if(!drag||e.pointerId!==drag.id)return;
    if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;
    drag.moved=true;e.preventDefault();
    const nodes=buttons();let end=drag.start,distance=Infinity;
    for(const b of nodes){const r=b.getBoundingClientRect();const d=(e.clientX-r.left-r.width/2)**2+(e.clientY-r.top-r.height/2)**2;if(d<distance){distance=d;end=b.dataset.well;}}
    const next=new Set(drag.initial);
    rectangleKeys(drag.start,end,nodes.map(b=>b.dataset.well)).forEach(k=>next.add(k));
    paint(next,true);
  };
  function finish(e,cancelled){
    if(!drag||e.pointerId!==drag.id)return;
    const currentDrag=drag;drag=null;suppressClick=true;
    let next=cancelled?currentDrag.initial:new Set(getSelected());
    if(!cancelled&&!currentDrag.moved){next=new Set(currentDrag.initial);next.has(currentDrag.start)?next.delete(currentDrag.start):next.add(currentDrag.start);}
    if(root.hasPointerCapture(e.pointerId))root.releasePointerCapture(e.pointerId);
    paint(next,false);
  }
  root.onpointerup=e=>finish(e,false);
  root.onpointercancel=e=>finish(e,true);
  root.onclick=e=>{
    if(suppressClick){suppressClick=false;e.preventDefault();return;}
    const button=buttonFrom(e.target);if(!button||button.disabled)return;
    if(rangeOn){
      if(!corner){corner=button.dataset.well;button.setAttribute('data-range-corner','');rangeButton.textContent=corner+' → 点选对角孔 · 取消';return;}
      if(!canStart()){resetRange();return;}
      const area=rectangleKeys(corner,button.dataset.well,buttons().filter(b=>!b.disabled).map(b=>b.dataset.well));
      const next=new Set([...getSelected(),...area]);resetRange();paint(next,false);return;
    }
    if(!canStart())return;
    const next=new Set(getSelected()),key=button.dataset.well;
    next.has(key)?next.delete(key):next.add(key);paint(next,false);
  };
}
if(typeof module!=='undefined')module.exports={rectangleKeys,bindWellSelection};
