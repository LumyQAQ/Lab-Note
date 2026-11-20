"""Transactional record transfer. Records provenance, never infers experimental amounts."""
from copy import deepcopy
from datetime import datetime
import uuid
import json

from store import TZ, FIELDS, LAYOUTS, coordinates, empty_well, current_time
from group_units import is_dish, GROUP_TYPES, normalize_quantity, group_quantity, member_active, resize_members
from manual_groups import get_display_group
from transfer_cultivation import apply_cultivation, prepare_cultivation, target_culture_action
from well_groups import record_condition_groups
from cell_count import normalize_seeding
from co_culture import append_culture, source_population, validate_draft_append
from occupied_targets import validate_occupied_options, source_only_links, validate_link_cycles

MODES = {'passage':'传代扩增', 'seed':'实验分装', 'mix':'合并 / 共培养'}


def text_field(value, label, limit=5000):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f'{label}须为文本，最多{limit}字符')
    return value.strip()


def apply_transfer(state, payload, validate_well):
    mode = payload.get('mode')
    if mode == 'replate':
        from replate import apply_replate
        return apply_replate(state, payload, validate_well, now=current_time())
    if mode not in MODES:
        raise ValueError('请选择传代、实验分装或合并培养')
    at = text_field(payload.get('at', ''), '操作时间', 40)
    try:
        parsed = datetime.fromisoformat(at)
    except ValueError:
        raise ValueError('请填写有效操作时间') from None
    if parsed.tzinfo is not None:
        raise ValueError('请填写北京时间，不附加其他时区')
    if parsed.replace(tzinfo=TZ) > current_time():
        raise ValueError('不能把未来的转移计划记录为已完成')
    day = parsed.date().isoformat()
    sources_input = payload.get('sources', [])
    targets_input = payload.get('targets', [])
    new_input = payload.get('new_containers', [])
    end_sources = payload.get('end_sources', [])
    if not isinstance(sources_input, list) or not 1 <= len(sources_input) <= 200:
        raise ValueError('请选择1–200个已填写的来源培养单元')
    if not isinstance(targets_input, list) or not 1 <= len(targets_input) <= 100:
        raise ValueError('请添加1–100组目标孔位')
    if not isinstance(new_input, list) or len(new_input) > 100:
        raise ValueError('新建目标容器过多')
    if not isinstance(end_sources, list) or any(not isinstance(x,str) for x in end_sources):
        raise ValueError('无效的结束来源列表')
    containers = {c['id']:c for c in state['containers']}
    validate_occupied_options(targets_input)
    validate_draft_append(targets_input)
    source_keys = set()
    sources = []
    for index, item in enumerate(sources_input):
        if not isinstance(item, dict):
            raise ValueError('无效来源')
        c = containers.get(item.get('id'))
        key = item.get('well')
        association_only = source_only_links(index, targets_input, containers)
        if not c or key not in c['wells'] or not c['wells'][key].get('cell'):
            raise ValueError('来源须为已填写细胞的培养单元')
        if not association_only and (c['status'] != 'active' or not member_active(c['wells'][key])):
            raise ValueError('来源须为在培养容器中的非空孔位')
        if (c['id'], key) in source_keys:
            raise ValueError('同一个来源孔位不能重复添加')
        source_keys.add((c['id'], key))
        w = c['wells'][key]
        components = w.get('components') or [w]
        if any(x['day0'] > day for x in components) or w.get('experiment_started_at','') > at or w.get('introduced_at','') > at:
            raise ValueError('操作时间不能早于来源的培养或实验起始时间')
        if w.get('components') and mode != 'mix' and not association_only:
            raise ValueError('混合培养孔请使用合并 / 共培养模式继续转移，以保留所有组成')
        sources.append({'id':c['id'], 'name':c['name'], 'well':key,
                        'role':text_field(item.get('role',''),'细胞角色',120),
                        'amount':text_field(item.get('amount',''),'每个目标的加入量',300),
                        'snapshot':deepcopy(w)})
    record = {'id':'TR-'+uuid.uuid4().hex[:16].upper(), 'mode':mode, 'at':at,
              'recorded_at':current_time().isoformat(), 'sources':sources, 'targets':[],
              'experiment':text_field(payload.get('experiment',''),'实验编号',500),
              'notes':text_field(payload.get('notes',''),'操作备注'), 'ended_sources':list(end_sources)}
    new_ids = {}
    for item in new_input:
        if not isinstance(item,dict):
            raise ValueError('无效新容器')
        key = text_field(item.get('key',''),'新容器标识',120)
        name = text_field(item.get('name',''),'新容器名称',120)
        if not key or key in new_ids or not name:
            raise ValueError('每个新容器必须有唯一标识和名称')
        kind = item.get('type')
        quantity=normalize_quantity(kind,item.get('quantity',1))
        keys = coordinates(kind,quantity)
        c = {'id':'C-'+uuid.uuid4().hex[:10].upper(), 'name':name, 'type':kind,
             'location':text_field(item.get('location',''),'位置',300), 'status':'active',
             'created_at':current_time().isoformat(), 'quantity':quantity, 'checked_date':'', 'default_treated_at':'',
             'wells':{k:empty_well() for k in keys}}
        new_ids[key] = c['id'];containers[c['id']] = c;state['containers'].append(c)
    used_new = set()
    used_sources = set()
    destination_keys = set()
    updates=payload.get('target_updates',[])
    if not isinstance(updates,list) or len(updates)>100:
        raise ValueError('目标容器修改列表无效')
    updated_ids=set();record['container_updates']=[]
    for update in updates:
        if not isinstance(update,dict) or set(update)-{'id','name','type','location','quantity'}:
            raise ValueError('目标容器信息字段无效')
        cid=text_field(update.get('id',''),'目标容器编号',120)
        c=containers.get(cid)
        if not c or c['status']!='active' or cid in updated_ids or not any(isinstance(t,dict) and t.get('id')==cid for t in targets_input):
            raise ValueError('只能修改本次明确使用的已有目标容器，且不能重复修改')
        updated_ids.add(cid)
        name=text_field(update.get('name',c['name']),'目标容器名称',120)
        if not name:raise ValueError('请填写目标容器名称')
        kind=update.get('type',c['type']);quantity=normalize_quantity(kind,update.get('quantity',group_quantity(c) if kind in GROUP_TYPES else 1));keys=coordinates(kind,quantity)
        location=text_field(update.get('location',c['location']),'目标位置',300)
        original={**{k:c[k] for k in ['name','type','location']},'quantity':group_quantity(c)}
        if kind!=c['type'] or quantity!=group_quantity(c):
            if any(s['id']==cid for s in sources):
                raise ValueError('本次来源容器不能同时修改类型或数量，请先在培养信息中修改')
            c['wells']=resize_members(c,kind,quantity,keys,empty_well)
        c.update(name=name,type=kind,quantity=quantity,location=location,checked_date='')
        record['container_updates'].append({'id':cid,'before':original,'after':{k:c[k] for k in ['name','type','quantity','location']}})
    # References always point at the state before any target group was written.
    previous_targets = {cid: deepcopy(c['wells']) for cid, c in containers.items()}
    for target in targets_input:
        if not isinstance(target,dict):
            raise ValueError('无效目标')
        if bool(target.get('id')) == bool(target.get('new_key')):
            raise ValueError('每组目标须选择一个已有或新建容器')
        cid = target.get('id') or new_ids.get(target.get('new_key'))
        c = containers.get(cid)
        keys = target.get('wells', [])
        indices = target.get('source_indices', [])
        if not c or c['status'] != 'active':
            raise ValueError('目标容器不存在或已结束培养')
        if not isinstance(keys,list) or not keys or any(not isinstance(k,str) or k not in c['wells'] for k in keys):
            raise ValueError('请选择有效目标孔位')
        if not isinstance(indices,list) or not indices or any(type(i) is not int or i<0 or i>=len(sources) for i in indices) or len(set(indices)) != len(indices):
            raise ValueError('请为每组目标指定有效来源')
        if len(set(keys)) != len(keys):
            raise ValueError('目标孔不能重复')
        occupied_action = target.get('occupied_action')
        linking = occupied_action == 'link'
        culture_action = target_culture_action(target, mode)
        if linking and any(not previous_targets[cid][key].get('cell') for key in keys):
            raise ValueError('补充来源关联只能选择已有细胞的目标；请将空孔另设为转移目标')
        if (occupied_action or 'occupied_confirmed' in target) and any(previous_targets[cid][key].get('cell') for key in keys) and target.get('occupied_confirmed') is not True:
            raise ValueError('请先确认已有细胞目标的处理方式与修改前后内容')
        if not linking and mode != 'mix' and len(indices) != 1:
            selected_sources=[sources[i] for i in indices]
            source_ids={s['id'] for s in selected_sources}
            parent=containers[selected_sources[0]['id']]
            fields=['cell','kind','batch','day0','anchor','treatment','concentration','active_treatments']
            if target.get('inherit_medium'):fields.append('medium')
            signatures={json.dumps({f:s['snapshot'].get(f) for f in fields},sort_keys=True,ensure_ascii=False) for s in selected_sources}
            display=get_display_group(state,payload.get('display_group_id'))
            native=len(source_ids)==1 and parent['type'] in GROUP_TYPES and group_quantity(parent)>1
            displayed=display is not None and all(s['id'] in display['container_ids'] for s in selected_sources)
            if not (native or displayed) or len(signatures)!=1:
                raise ValueError('批量传代须为同组且培养信息一致的瓶/皿；来源有差异时请分别设置去向，或明确选择合并培养')
        if not linking and type(target.get('append',False)) is not bool:
            raise ValueError('无效的加入现有细胞设置')
        if not linking and type(target.get('inherit_medium',False)) is not bool:
            raise ValueError('无效的培养基沿用设置')
        if not linking and mode=='mix' and target.get('inherit_medium'):
            raise ValueError('合并培养不能由来源配方自动推算目标培养基，请在目标孔记录实际成分')
        reference_wells = deepcopy(c['wells']) if target.get('draft_append') else previous_targets[cid]
        cultivation_target = ({'cultivation_mode': 'same', **target}
                              if occupied_action == 'append' and mode != 'mix' else target)
        cultivation = prepare_cultivation(cultivation_target, sources, reference_wells, at) if not linking else None
        seeding = normalize_seeding(target['seeding']) if not linking and 'seeding' in target else None
        used_sources.update(indices)
        if target.get('new_key'):used_new.add(target['new_key'])
        treatment = text_field(target.get('treatment',''),'目标新处理') if not linking else ''
        concentration = text_field(target.get('concentration',''),'目标浓度 / 剂量') if not linking else ''
        for key in keys:
            dest_key = (cid,key)
            selected_source_keys = {(sources[i]['id'], sources[i]['well']) for i in indices}
            if dest_key in (selected_source_keys if linking else source_keys):
                raise ValueError('来源孔不能同时作为本次目标；请新建后代记录')
            previous_planned = dest_key in destination_keys
            if previous_planned and not target.get('draft_append'):
                raise ValueError('目标孔重复；叠加本次安排须明确选择加入共培养')
            destination_keys.add(dest_key)
            previous = deepcopy(c['wells'][key])
            if previous.get('member_status')=='archived':raise ValueError('已结束的瓶/皿不能直接作为目标，请先恢复或另建目标')
            occupied = bool(previous['cell'])
            if occupied and not occupied_action and (mode != 'mix' or not target.get('append')):
                raise ValueError(f'{c["name"]} {key} 已有细胞；仅合并模式且明确勾选加入现有细胞时可追加')
            if occupied and not linking and (any(x['day0'] > day for x in previous.get('components',[previous])) or previous.get('experiment_started_at','') > at or previous.get('introduced_at','') > at):
                raise ValueError('操作时间不能早于目标已有细胞的培养或实验起始时间')
            links = [{'id':sources[i]['id'],'name':sources[i]['name'],'well':sources[i]['well']} for i in indices]
            operation = occupied_action if occupied and occupied_action else 'append' if occupied else 'seed'
            if linking:
                w = {**previous, 'source_refs': links, 'lineage_correction_id': record['id']}
                c['wells'][key] = w
                record['targets'].append({'id':cid,'name':c['name'],'type':c['type'],'location':c['location'],
                    'well':key,'source_indices':indices,'operation':'link','previous':previous,'result':deepcopy(w)})
                continue
            retaining = occupied and operation == 'append'
            if retaining:
                w = append_culture(previous, [source_population(sources[i]) for i in indices],
                                   {'id': cid, 'name': c['name'], 'well': key}, at, record['id'])
            elif mode == 'mix':
                components = []
                for i in indices:
                    source = sources[i];original = source['snapshot']
                    for part in original.get('components') or [original]:
                        component = {f:part[f] for f in FIELDS}
                        component.update({'role':part.get('role','') if original.get('components') else source['role'],
                                          'amount':'' if original.get('components') else source['amount'],
                                          'origin':{'id':source['id'],'name':source['name'],'well':source['well'],
                                                    'lineage_id':original.get('lineage_id','')}})
                        source_medium=original.get('medium') or part.get('source_medium')
                        if source_medium:component['source_medium']=deepcopy(source_medium)
                        if original.get('components'):
                            # The aliquot amount belongs to the whole mixed sample,
                            # not independently to each of its populations.
                            component.update(aliquot_id=f'{record["id"]}:{cid}:{key}:{i}',
                                             aliquot_amount=source['amount'],aliquot_role=source['role'])
                        components.append(component)
                started = at
                w = {**empty_well(), 'cell':' + '.join(dict.fromkeys(x['cell'] for x in components)),
                     'kind':'混合培养', 'day0':started[:10], 'anchor':'共培养开始', 'components':components,
                     'experiment_started_at':started}
            else:
                original = sources[indices[0]]['snapshot']
                w = {**empty_well(), **{f:original[f] for f in ['cell','kind','batch','day0','anchor']}}
                w.update(role=sources[indices[0]]['role'] if len(indices)==1 else '',amount=sources[indices[0]]['amount'] if len(indices)==1 else '')
                if len(indices)>1:w['source_contributions']=[{k:sources[i][k] for k in ['id','well','role','amount']} for i in indices]
                if target.get('inherit_medium') and original.get('medium'):
                    w['medium']=deepcopy(original['medium'])
                if mode == 'passage' and culture_action in (None, 'passage') and w['kind'] == '细胞系':
                    w.update(day0=day, anchor='传代')
                if mode == 'seed':w['experiment_started_at'] = at
            if treatment:w['treatment'] = '\n'.join(x for x in [w['treatment'],treatment] if x)
            if concentration:w['concentration'] = '\n'.join(x for x in [w['concentration'],concentration] if x)
            if cultivation is not None:apply_cultivation(w, cultivation[key])
            if seeding is not None:
                w['seeding'] = {**seeding, 'at': at,
                                'per': '孔' if c['type'] in LAYOUTS else '皿' if is_dish(c['type']) else '瓶',
                                'addition': retaining}
            if record['experiment']:w['experiment'] = record['experiment']
            if record['notes']:w['notes'] = '\n'.join(x for x in [w['notes'],record['notes']] if x)
            if not retaining or treatment or concentration or (cultivation is not None and any(
                    w.get(field, '') != previous.get(field, '') for field in ['treatment', 'concentration'])):
                w['treated_at'] = at if w['treatment'] or w['concentration'] or not retaining else ''
            w.update(introduced_at=at, lineage_id=record['id'], source_refs=links, transfer_mode=mode)
            validate_well(w)
            c['wells'][key] = w
            record['targets'].append({'id':cid,'name':c['name'],'type':c['type'],'location':c['location'],'well':key,'source_indices':indices,
                                      'operation':operation,'previous':previous if occupied else None,
                                      **({'culture_action':culture_action} if culture_action and not retaining else {}),
                                      **({'previous_planned':True} if previous_planned else {}),
                                      **({'previous_snapshot':previous} if not occupied else {}),'result':deepcopy(w)})
        c['checked_date'] = ''
        if not linking and c['type'] in LAYOUTS:c['default_treated_at'] = at
    if used_new != set(new_ids):
        raise ValueError('有新建容器尚未分配目标孔位，请补充或移除')
    if used_sources != set(range(len(sources))):
        raise ValueError('有来源尚未分配去向，请补充或取消该来源')
    record_condition_groups(record, targets_input, new_ids)
    validate_link_cycles(containers, record['targets'])
    if all(target['operation'] == 'link' for target in record['targets']):
        record['mode'] = 'relink'
    for cid in end_sources:
        c = containers.get(cid)
        if not c or c['status'] != 'active' or not any(s['id']==cid for s in sources):
            raise ValueError('只能结束本次选择且仍在培养的来源容器')
        if any((cid,k) not in source_keys for k,w in c['wells'].items() if w['cell']):
            raise ValueError('来源孔板还有未选择的细胞，不能结束整块孔板')
        if any(k[0]==cid for k in destination_keys):
            raise ValueError('目标仍在该容器中，不能结束该来源容器')
        c['status'] = 'archived'
        c['checked_date'] = ''
    ended=payload.get('end_members',[])
    if not isinstance(ended,list):raise ValueError('结束瓶/皿列表无效')
    record['ended_members']=[]
    for item in ended:
        if not isinstance(item,dict):raise ValueError('结束瓶/皿格式无效')
        c=containers.get(item.get('id'));keys=item.get('wells',[])
        if not c or c['status'] != 'active' or c['type'] not in GROUP_TYPES or not isinstance(keys,list) or not keys or any((c['id'],k) not in source_keys or not member_active(c['wells'][k]) for k in keys):
            raise ValueError('只能结束本次已选择且仍在培养的来源瓶/皿')
        if any((c['id'],k) in destination_keys for k in keys):raise ValueError('本次目标瓶/皿不能同时结束')
        for k in keys:c['wells'][k]['member_status']='archived'
        if not any(member_active(w) for w in c['wells'].values()):c['status']='archived'
        c['checked_date']='';record['ended_members'].append({'id':c['id'],'wells':list(keys)})
    for source in sources:
        containers[source['id']]['checked_date'] = ''
    return record
