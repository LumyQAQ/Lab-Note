'use strict';

// A container group keeps its original identity; each bottle/dish is one well record.
function dishType(type) { return type==='培养皿'||[35,60,90,100,150].some(size=>type===size+'mm培养皿'); }
function groupType(type) { return dishType(type)||['T25','T75','T175','培养组'].includes(type); }
function groupKeys(type, quantity=1) {
  const base=dishType(type)?'培养皿':'培养瓶';
  const value=Number(quantity),count=Number.isInteger(value)?Math.min(100,Math.max(1,value)):1;
  return Array.from({length:count},(_,i)=>base+(i?i+1:''));
}
function groupQuantity(c) { return groupType(c?.type)?Number(c.quantity)||1:1; }
function groupResizeKeys(c,type,quantity){
  const keys=Object.keys(c.wells||{}).slice(0,quantity),defaults=groupKeys(type,quantity);
  for(let i=keys.length;i<quantity;i++){const base=defaults[i];let key=base,n=i+1;while(keys.includes(key))key=base+'-'+(++n);keys.push(key);}
  return keys;
}
function memberActive(w) { return !!w?.cell && w.member_status!=='archived'; }
function groupMemberLabel(c,key) {
  if(c?.display_group){const member=c.display_members[key];if(!member)return key;const siblings=Object.values(c.display_members).filter(m=>m.container_id===member.container_id),index=siblings.findIndex(m=>m.well===member.well);return member.container_name+' · '+member.container_type+(siblings.length>1?' / '+(index+1)+'号'+(dishType(member.container_type)?'皿':'瓶'):'');}
  if(!groupType(c?.type))return key;
  const index=Object.keys(c.wells||{}).indexOf(key);
  return index<0?key:`${index+1}号${dishType(c.type)?'皿':'瓶'}`;
}
function groupDefaultSelection(c) {
  const entries=Object.entries(c?.wells||{});
  if(c?.display_group&&c.status==='active')return entries.filter(([,w])=>memberActive(w)).map(([key])=>key);
  return entries.filter(([,w])=>c.status==='archived'?!!w.cell||w.member_status==='archived':w.member_status!=='archived').map(([key])=>key);
}
function groupTypeLabel(c) { return c.type+(groupType(c.type)&&groupQuantity(c)>1?' × '+groupQuantity(c):''); }
function groupCounts(c) {
  const wells=Object.values(c.wells||{});
  return {active:c.status==='active'?wells.filter(memberActive).length:0,ended:wells.filter(w=>w.member_status==='archived'||c.status==='archived'&&w.cell).length,empty:wells.filter(w=>!w.cell&&w.member_status!=='archived').length};
}
function groupDifferenceSummary(c) {
  if(!groupType(c.type)||groupQuantity(c)<2)return '';
  const wells=Object.values(c.wells||{}).filter(w=>c.status==='active'?memberActive(w):w.cell);
  if(wells.length<2)return '';
  const fields=[['cell','细胞'],['batch','批次'],['day0','Day 0'],['treatment','处理'],['concentration','剂量'],['active_treatments','持续处理'],['medium','培养基'],['cell_count','计数'],['seeding','铺入数量'],['experiment','关联实验']];
  const differences=fields.filter(([key])=>new Set(wells.map(w=>JSON.stringify(w[key]??null))).size>1).map(([,label])=>label);
  return differences.length?'成员差异：'+differences.join('、'):'各成员当前记录一致';
}
function cultureCheckedToday(c,day=boot.today){return typeof c.checked==='boolean'?c.checked:c.checked_date===day;}
function sortCulturesByCheck(containers,day=boot.today){
  const rank=c=>c.status!=='active'?2:cultureCheckedToday(c,day)?1:0;
  return [...containers].sort((a,b)=>rank(a)-rank(b));
}
function cultureCheckMarkup(c){
  const checked=cultureCheckedToday(c),ended=c.status!=='active',empty=!Object.values(c.wells||{}).some(memberActive);
  return `<button type="button" class="button secondary container-check-button ${checked?'is-checked':''}" data-check-culture="${esc(c.id)}" title="${esc(c.name)}：核对整个容器 / 培养组的当前记录" ${checked||ended||empty?'disabled':''}>${ended?'培养已结束':checked?'✓ 今日已核对':empty?'填写细胞后核对':'确认今日核对'}</button>`;
}

// Display groups are projections. Original containers, member keys, and records stay intact.
function displayContainers(source=state) {
  const originals=source?.containers||[],byId=new Map(originals.map(c=>[c.id,c])),owners=new Map(),groups=new Map();
  for(const group of source?.display_groups||[]) {
    const members=(group.container_ids||[]).map(id=>byId.get(id)).filter(c=>c&&!owners.has(c.id));
    if(!members.length)continue;
    const wells={},display_members={};
    for(const c of members) {
      owners.set(c.id,group.id);
      for(const [key,record] of Object.entries(c.wells||{})) {
        const virtual=c.id+'::'+key,w=structuredClone(record);
        if(c.status==='archived'&&w.cell)w.member_status='archived';
        wells[virtual]=w;display_members[virtual]={container_id:c.id,well:key,container_name:c.name,container_type:c.type,location:c.location||''};
      }
    }
    const types=[...new Set(members.map(c=>c.type))],locations=[...new Set(members.map(c=>c.location||'未填写位置'))],checked=[...new Set(members.filter(c=>c.status==='active').map(c=>c.checked_date||''))];
    groups.set(group.id,{id:group.id,name:group.name,type:types.length===1?types[0]:'培养组',primary_type:members[0].type,quantity:Object.keys(wells).length,location:locations.join(' · '),checked_date:checked.length===1?checked[0]:'',created_at:members.map(c=>c.created_at||group.created_at).sort()[0],updated_at:group.updated_at,status:members.some(c=>c.status==='active')?'active':'archived',wells,display_group:true,display_members,container_ids:members.map(c=>c.id),well_defaults:{},medium_defaults:{},default_treated_at:''});
  }
  const shown=new Set();
  return originals.flatMap(c=>{const id=owners.get(c.id);if(!id)return [c];if(shown.has(id))return [];shown.add(id);return [groups.get(id)];});
}
function displayMemberRef(source,id,key) {
  const c=displayContainers(source).find(c=>c.id===id);
  if(c?.display_group){const ref=c.display_members[key];return ref?{container_id:ref.container_id,well:ref.well}:null;}
  const original=(source?.containers||[]).find(c=>c.id===id);
  return original&&Object.prototype.hasOwnProperty.call(original.wells||{},key)?{container_id:id,well:key}:null;
}
function displayMemberLocation(source,originalId,well) {
  const group=displayContainers(source).find(c=>c.display_group&&c.container_ids.includes(originalId));
  return group?{id:group.id,key:originalId+'::'+well}:{id:originalId,key:well};
}
