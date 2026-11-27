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
const plateContentTypes = {
  target_medium: {label:'靶细胞＋培养基', short:'靶'},
  target_effector: {label:'靶细胞＋效应细胞', short:'靶+效'},
  transwell: {label:'Transwell 双室（上室＋下室）', short:'TW'},
  organoid: {label:'类器官培养 / 共培养', short:'类器官'},
  medium: {label:'仅培养基（无细胞）', short:'培养基'},
  pbs: {label:'仅 PBS（无细胞）', short:'PBS'},
  empty: {label:'空孔', short:'空'}
};
function plateWellLayout(well) {
  return well?.assay_contents || null;
}
function isCytotoxicityPlate(container, source, activeKind='') {
  if(!boot.layouts[container.type])return false;
  if(activeKind)return ['cytotoxicity','transwell','organoid/culture','organoid/coculture'].includes(activeKind);
  if(String(container.type||'').startsWith('Transwell') || container.type==='低吸附U底96孔板')return true;
  return Object.values(container.wells).some(w=>['target_medium','target_effector','transwell','organoid'].includes(plateWellLayout(w)?.kind)) ||
    (source?.lab_records||[]).some(r=>['cytotoxicity','transwell','organoid'].includes(r.type) &&
      r.status!=='cancelled' && r.plate_context?.container_id===container.id);
}
function plateWellKind(well) {
  return plateWellLayout(well)?.kind || (well?.cell ? 'culture' : 'empty');
}
function plateWellHasCells(well) {
  const kind = plateWellKind(well);
  const layout = plateWellLayout(well);
  if (kind === 'culture' || kind === 'target_medium' || kind === 'target_effector') return true;
  if (kind === 'transwell') return !!(layout?.upper_cell || layout?.lower_cell);
  if (kind === 'organoid') return !!(layout?.organoid_name || layout?.effector_cell);
  return false;
}
function plateComponentRole(part) {
  const role=String(part.role||'').trim().toLowerCase().replace(/\s+/g,' ');
  if(['靶','靶细胞','target','target cell','target cells'].includes(role))return 'target_cell';
  if(['效应','效应细胞','effector','effector cell','effector cells'].includes(role))return 'effector_cell';
  return '';
}
function documentedPlateRoles(well, layout) {
  const parts=well.components || [], names=[...new Set(parts.map(part=>part.cell))];
  if(!names.length || names.some(name=>!name) || names.length>2)return null;
  if(names.length===1) {
    const roles=new Set(parts.map(plateComponentRole));
    if(roles.size!==2 || roles.has(''))return null;
  }
  const matches=names.map((name,i)=>({target_cell:name,effector_cell:names[names.length-1-i]})).filter(pair=>
    (!layout.target_cell || layout.target_cell===pair.target_cell) &&
    (!layout.effector_cell || layout.effector_cell===pair.effector_cell) &&
    parts.every(part=>!plateComponentRole(part) || pair[plateComponentRole(part)]===part.cell));
  return matches.length===1?matches[0]:null;
}
function plateCanTransferCells(well) {
  if(!well?.cell)return false;
  const layout=well.assay_contents;
  if(!layout)return true;
  if(layout.kind==='target_medium')return well.cell===layout.target_cell&&!well.components?.length;
  return layout.kind==='target_effector' && !!layout.target_cell && !!layout.effector_cell && !!documentedPlateRoles(well,layout);
}
function plateCellsPerWell(value) {
  const raw = value.trim();
  if (!raw) return '';
  if (raw.length>80 || !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]{1,2})?$/i.test(raw)) return null;
  const [mantissa, exponent='0'] = raw.toLowerCase().split('e');
  const [whole, fraction=''] = mantissa.split('.');
  const digits = whole+fraction, point = whole.length+Number(exponent);
  if (!/[1-9]/.test(digits)) return '0';
  if (point<1 || /[1-9]/.test(digits.slice(point))) return null;
  const count = digits.padEnd(point,'0').slice(0,point).replace(/^0+/,'');
  return count.length<=80 ? count : null;
}
function plateWellDescription(well) {
  const kind = plateWellKind(well), layout = plateWellLayout(well);
  if(kind === 'culture')return well.cell;
  if(kind === 'transwell') {
    return [plateContentTypes.transwell.label, layout?.transwell_mode,
      layout?.pore_size_um && (layout.pore_size_um + ' μm'),
      layout?.matrigel_coating && ('包被 ' + layout.matrigel_coating),
      layout?.upper_cell && ('上室 ' + layout.upper_cell),
      layout?.upper_cells_per_well && ('上室 ' + layout.upper_cells_per_well + ' 个/孔'),
      layout?.upper_volume_ul && ('上室 ' + layout.upper_volume_ul + ' µL'),
      layout?.lower_cell && ('下室 ' + layout.lower_cell),
      layout?.lower_medium && ('下室条件 ' + layout.lower_medium),
      layout?.lower_volume_ul && ('下室 ' + layout.lower_volume_ul + ' µL'),
      layout?.group && ('组名 ' + layout.group)].filter(Boolean).join(' · ');
  }
  if(kind === 'organoid') {
    return [plateContentTypes.organoid.label, layout?.organoid_name && ('类器官 ' + layout.organoid_name),
      layout?.organoid_mode, layout?.matrix_type && ('基质胶 ' + layout.matrix_type),
      layout?.dome_volume_ul && ('液滴 ' + layout.dome_volume_ul + ' µL' + (layout.dome_count ? ' × ' + layout.dome_count : '')),
      layout?.effector_cell && ('效应细胞 ' + layout.effector_cell),
      layout?.et_ratio && ('E:T ' + layout.et_ratio),
      layout?.effector_cells_per_well && ('效应 ' + layout.effector_cells_per_well + ' 个/孔'),
      layout?.final_volume_ul && ('终体积 ' + layout.final_volume_ul + ' µL'),
      layout?.medium && ('培养基 ' + layout.medium),
      layout?.group && ('组名 ' + layout.group)].filter(Boolean).join(' · ');
  }
  const mixed=kind==='target_effector';
  const sources=mixed?plateEffectorSourceNames(well):[];
  return [plateContentTypes[kind]?.label,layout?.target_cell?'靶细胞 '+layout.target_cell:mixed&&'靶细胞待补',
    mixed&&(layout.effector_cell?'效应细胞 '+layout.effector_cell:'效应细胞待补'),
    mixed&&(sources.length?'效应细胞来源 '+sources.join('、'):'效应细胞来源待关联'),
    layout?.target_cells_per_well&&'靶细胞加入数 '+layout.target_cells_per_well+' 个/孔',
    layout?.effector_cells_per_well&&'效应细胞加入数 '+layout.effector_cells_per_well+' 个/孔',
    layout?.final_volume_ul&&'每孔终体积 '+layout.final_volume_ul+' µL/孔',
    layout?.target_volume_ul&&'靶细胞悬液 '+layout.target_volume_ul+' µL/孔',
    layout?.effector_volume_ul&&'效应细胞悬液 '+layout.effector_volume_ul+' µL/孔',
    layout?.medium&&'培养基 '+layout.medium,
    layout?.group&&'组名 '+layout.group].filter(Boolean).join(' · ');
}
function plateEffectorSourceNames(well) {
  const layout=well.assay_contents;
  const sources=layout.effector_sources || [];
  const origins=sources.length ? sources : (well.components || [])
    .filter(part=>part.cell===layout.effector_cell &&
      (layout.effector_cell!==layout.target_cell || plateComponentRole(part)==='effector_cell'))
    .flatMap(part=>part.origin?.sources || [part.origin]).filter(source=>source?.id && source.well);
  return [...new Set(origins.map(source=>(source.name||source.id)+' / '+source.well))];
}
function layoutOnlyPlate(container) {
  const wells = Object.values(container.wells || {});
  return wells.some(plateWellLayout) && !wells.some(memberActive);
}
function plateContentsSummary(container) {
  const wells = Object.values(container.wells || {});
  const counts = {culture:0,target_medium:0,target_effector:0,transwell:0,organoid:0,medium:0,pbs:0,empty:0};
  for(const well of wells)counts[plateWellKind(well)]=(counts[plateWellKind(well)]||0)+1;
  const parts = [`${counts.culture + counts.target_medium + counts.target_effector} 有细胞`];
  if (counts.transwell) parts.push(`${counts.transwell} Transwell 双室`);
  if (counts.organoid) parts.push(`${counts.organoid} 类器官`);
  parts.push(`${counts.medium} 仅培养基`, `${counts.pbs} 仅 PBS`, `${counts.empty} 空孔`);
  return parts.join(' · ');
}
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
