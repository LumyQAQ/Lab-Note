'use strict';
const plate=document.getElementById('plate');
const selected=new Map();
function axis(label){const el=document.createElement('span');el.className='axis';el.textContent=label;el.setAttribute('aria-hidden','true');plate.append(el);}
function choose(pos){
  for(const [key,button] of selected)button.setAttribute('aria-pressed',String(pos===key));
  document.getElementById('coord').textContent=pos;
  document.getElementById('sample').textContent='空孔';
  document.getElementById('summary').textContent='尚未填写培养信息或关联实验。';
}
axis('');for(let c=1;c<=6;c++)axis(String(c));
for(const row of 'ABCD'){axis(row);for(let c=1;c<=6;c++){
  const pos=row+c,button=document.createElement('button');button.type='button';button.className='well';button.setAttribute('aria-pressed','false');
  button.textContent=pos;button.setAttribute('aria-label',pos+' · 空孔');
  button.onclick=()=>choose(pos);plate.append(button);selected.set(pos,button);
}}
