"""Physical medium exchange and pooled expansion preserve biological identity."""
from copy import deepcopy
from datetime import datetime
import json
import uuid

from well_groups import record_condition_groups
from cell_count import normalize_seeding
from co_culture import append_culture, source_population, validate_draft_append
from group_units import is_dish, GROUP_TYPES, group_quantity, member_active, normalize_quantity, resize_members
from medium import number, text
from occupied_targets import validate_link_cycles, validate_occupied_options
from store import TZ, LAYOUTS, coordinates, current_time, empty_well
from transfer_cultivation import apply_cultivation, prepare_cultivation, validate_active_times, target_culture_action


def _validate_start(well, at):
    day = at.date().isoformat()
    if (well.get('day0', '') > day
            or any(part.get('day0', '') > day for part in well.get('components') or [])
            or any(well.get(field) and datetime.fromisoformat(well[field]) > at
                   for field in ['experiment_started_at', 'introduced_at'])):
        raise ValueError('操作时间不能早于培养或实验起始时间')


def _medium_change(value):
    if not isinstance(value, dict) or set(value) - {'volume_value', 'volume_unit'}:
        raise ValueError('换液体积记录格式无效')
    volume = number(value.get('volume_value', ''), '换液体积')
    unit = text(value.get('volume_unit', ''), '换液体积单位', 100)
    if volume and not unit:
        raise ValueError('填写换液体积时需同时填写单位')
    return {'volume_value': volume, 'volume_unit': unit}


def _active_signature(treatment):
    # Record identifiers distinguish historical receipts, not exposure conditions.
    return {key: value for key, value in treatment.items()
            if key not in ['id', 'source_treatment_ids']}


def _active_key(treatment):
    return json.dumps(_active_signature(treatment), sort_keys=True, ensure_ascii=False)


def _pool_result(selected, at):
    """Validate one physical collection and retain only shared current metadata."""
    snapshots = [source['snapshot'] for source in selected]
    if any(well.get('components') for well in snapshots):
        raise ValueError('整体收集扩孔只适用于同来源同处理细胞，混合培养请分别移孔')
    identity = ['cell', 'kind', 'batch', 'day0', 'anchor', 'treatment', 'concentration']
    first = snapshots[0]
    if any(any(well.get(field, '') != first.get(field, '') for field in identity)
           for well in snapshots[1:]):
        raise ValueError('整体收集扩孔须为相同细胞、批次、Day 0、计时锚点和处理条件')
    if first.get('treatment') or first.get('concentration'):
        if any(well.get('treated_at', '') != first.get('treated_at', '') for well in snapshots[1:]):
            raise ValueError('来源处理开始时间不同，不能作为同一收集组扩孔')
        if first.get('treated_at') and datetime.fromisoformat(first['treated_at']) > datetime.fromisoformat(at):
            raise ValueError('操作时间不能早于来源处理开始时间')
    active = [sorted(well.get('active_treatments') or [], key=_active_key) for well in snapshots]
    signatures = [[_active_signature(treatment) for treatment in items] for items in active]
    if any(signature != signatures[0] for signature in signatures[1:]):
        raise ValueError('来源进行中处理的名称、剂量或开始时间不同，不能整体收集扩孔')
    validate_active_times(active[0], at)
    references = [sorted({(ref['id'], ref['well']) for ref in well.get('source_refs') or []})
                  for well in snapshots]
    if any(refs != references[0] for refs in references[1:]):
        raise ValueError('来源关联凭据不同，不能作为同一收集组扩孔')
    if (not references[0] and len({source['id'] for source in selected}) > 1
            and not (first.get('pool_id') and all(well.get('pool_id') == first['pool_id'] for well in snapshots))):
        raise ValueError('跨容器整体收集须有相同来源关联或已有同一收集组凭据')

    excluded = {'cell_count', 'seeding', 'active_treatments', 'source_refs',
                'maintenance_id', 'maintenance_at', 'pool_id', 'collection_id', 'pool_sources', 'source_contributions'}
    result = empty_well()
    for field, value in first.items():
        if field not in excluded and all(field in well and well[field] == value for well in snapshots[1:]):
            result[field] = deepcopy(value)
    # Preserve shared ancestors without introducing links to current source wells.
    if references[0]:
        result['source_refs'] = [{'id': cid, 'well': key} for cid, key in references[0]]
    result['active_treatments'] = []
    for index, treatment in enumerate(active[0]):
        members = [items[index] for items in active]
        original_ids = sorted({identifier for item in members
                               for identifier in [item.get('id'), *(item.get('source_treatment_ids') or [])]
                               if identifier})
        shared = deepcopy(_active_signature(treatment))
        if all(item.get('id') == treatment.get('id') for item in members):
            if treatment.get('id'):
                shared['id'] = treatment['id']
        else:
            shared['id'] = 'PT-'+uuid.uuid4().hex[:16].upper()
        if len(original_ids) > 1 or any(item.get('source_treatment_ids') for item in members):
            shared['source_treatment_ids'] = original_ids
        result['active_treatments'].append(shared)
    result['pool_sources'] = []
    for source in selected:
        contribution = {field: deepcopy(source[field]) for field in ['id', 'name', 'well', 'role', 'amount']}
        contribution.update({field: deepcopy(source['snapshot'][field])
                             for field in ['maintenance_id', 'lineage_id', 'pool_id', 'collection_id', 'lineage_correction_id']
                             if source['snapshot'].get(field)})
        result['pool_sources'].append(contribution)
    return result


def apply_replate(state, payload, validate_well, now=None):
    """Stage all sources and destinations so overlaps and failures are atomic."""
    staged = deepcopy(state)
    record = _stage_replate(staged, payload, validate_well, now or current_time())
    state.clear()
    state.update(staged)
    return record


def _stage_replate(state, payload, validate_well, now):
    at = text(payload.get('at', ''), '操作时间', 40)
    try:
        parsed = datetime.fromisoformat(at)
    except ValueError:
        raise ValueError('请填写有效操作时间') from None
    if len(at) < 16 or at[10] != 'T' or parsed.tzinfo is not None or parsed.replace(tzinfo=TZ) > now:
        raise ValueError('操作时间须为已发生的北京时间，包含日期和时间')
    passage = payload.get('cell_line_passage', False)
    if type(passage) is not bool:
        raise ValueError('细胞系传代计时设置无效')
    clear = payload.get('clear_sources', True)
    if type(clear) is not bool:
        raise ValueError('清空来源设置须为布尔值')
    inputs, targets, new = (payload.get(key, []) for key in ['sources', 'targets', 'new_containers'])
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 200:
        raise ValueError('请选择1–200个已填写的来源培养单元')
    if not isinstance(targets, list) or not 1 <= len(targets) <= 100:
        raise ValueError('请添加1–100组目标孔位')
    if not isinstance(new, list) or len(new) > 100:
        raise ValueError('新建目标容器过多')
    validate_occupied_options(targets)
    validate_draft_append(targets)
    containers = {c['id']: c for c in state['containers']}
    originals = deepcopy(containers)
    sources, source_keys = [], set()
    for item in inputs:
        if not isinstance(item, dict):
            raise ValueError('无效来源')
        cid, key = text(item.get('id', ''), '来源编号', 200), text(item.get('well', ''), '来源孔位', 200)
        c = containers.get(cid)
        if not c or c['status'] != 'active' or key not in c['wells'] or not member_active(c['wells'][key]):
            raise ValueError('来源须为在培养容器中有效且有细胞的培养单元')
        if (cid, key) in source_keys:
            raise ValueError('同一个来源孔位不能重复添加')
        _validate_start(c['wells'][key], parsed)
        source_keys.add((cid, key))
        sources.append({'id': cid, 'name': c['name'], 'well': key,
                        'role': text(item.get('role', ''), '细胞角色', 120),
                        'amount': text(item.get('amount', ''), '记录加入量', 300),
                        'snapshot': deepcopy(c['wells'][key])})
    record = {'id': 'TR-'+uuid.uuid4().hex[:16].upper(), 'mode': 'replate', 'at': at,
              'recorded_at': now.isoformat(), 'clear_sources': clear,
              'sources': sources, 'targets': [], 'mapping': [], 'container_updates': [],
              'experiment': text(payload.get('experiment', ''), '实验编号', 500),
              'notes': text(payload.get('notes', ''), '操作备注', 5000)}
    if passage:
        record['cell_line_passage'] = True
    new_ids = {}
    for item in new:
        if not isinstance(item, dict):
            raise ValueError('无效新容器')
        key, name = text(item.get('key', ''), '新容器标识', 120), text(item.get('name', ''), '新容器名称', 120)
        if not key or key in new_ids or not name:
            raise ValueError('每个新容器必须有唯一标识和名称')
        kind = text(item.get('type', ''), '容器类型', 120)
        quantity = normalize_quantity(kind, item.get('quantity', 1))
        keys = coordinates(kind, quantity)
        c = {'id': 'C-'+uuid.uuid4().hex[:10].upper(), 'name': name, 'type': kind,
             'location': text(item.get('location', ''), '位置', 300), 'status': 'active',
             'created_at': now.isoformat(), 'quantity': quantity, 'checked_date': '',
             'default_treated_at': '', 'wells': {k: empty_well() for k in keys}}
        new_ids[key] = c['id']
        containers[c['id']] = c
        state['containers'].append(c)
    updates = payload.get('target_updates', [])
    if not isinstance(updates, list) or len(updates) > 100:
        raise ValueError('目标容器修改列表无效')
    updated = set()
    for update in updates:
        if not isinstance(update, dict) or set(update) - {'id', 'name', 'type', 'location', 'quantity'}:
            raise ValueError('目标容器信息字段无效')
        cid = text(update.get('id', ''), '目标容器编号', 120)
        c = containers.get(cid)
        if not c or c['status'] != 'active' or cid in updated or not any(t.get('id') == cid for t in targets):
            raise ValueError('只能修改本次明确使用的已有目标容器，且不能重复修改')
        updated.add(cid)
        name = text(update.get('name', c['name']), '目标容器名称', 120)
        if not name:
            raise ValueError('请填写目标容器名称')
        kind = text(update.get('type', c['type']), '容器类型', 120)
        quantity = normalize_quantity(kind, update.get('quantity', group_quantity(c) if kind in GROUP_TYPES else 1))
        keys = coordinates(kind, quantity)
        previous = {**{k: c[k] for k in ['name', 'type', 'location']}, 'quantity': group_quantity(c)}
        if kind != c['type'] or quantity != group_quantity(c):
            if any(s['id'] == cid for s in sources):
                raise ValueError('本次来源容器不能同时修改类型或数量，请先在培养信息中修改')
            c['wells'] = resize_members(c, kind, quantity, keys, empty_well)
        c.update(name=name, type=kind, quantity=quantity, checked_date='',
                 location=text(update.get('location', c['location']), '目标位置', 300))
        record['container_updates'].append({'id': cid, 'before': previous,
            'after': {k: c[k] for k in ['name', 'type', 'quantity', 'location']}})
    previous_wells = {cid: deepcopy(c['wells']) for cid, c in containers.items()}
    used_sources, used_new, destinations = set(), set(), set()
    collection_groups = {}
    for target in targets:
        cid = text(target.get('id', ''), '目标容器编号', 200)
        new_key = text(target.get('new_key', ''), '新容器标识', 120)
        if bool(cid) == bool(new_key):
            raise ValueError('每组目标须选择一个已有或新建容器')
        cid = cid or new_ids.get(new_key)
        c = containers.get(cid)
        keys, indices = target.get('wells', []), target.get('source_indices', [])
        if not c or c['status'] != 'active':
            raise ValueError('目标容器不存在或已结束培养')
        if not isinstance(keys, list) or not keys or any(not isinstance(k, str) or k not in c['wells'] for k in keys):
            raise ValueError('请选择有效目标孔位')
        if len(set(keys)) != len(keys):
            raise ValueError('目标孔不能重复')
        culture_action = target_culture_action(target, 'replate')
        reset_day = (culture_action == 'passage') if culture_action else passage
        distribution = target.get('distribution', 'paired')
        if distribution not in ['paired', 'pooled']:
            raise ValueError('请选择逐孔对应移孔或整体收集扩孔')
        if (not isinstance(indices, list) or not indices
                or any(type(i) is not int or i < 0 or i >= len(sources) for i in indices)
                or len(set(indices)) != len(indices)):
            raise ValueError('请为每组目标指定有效且不重复的来源')
        pooled = distribution == 'pooled'
        group_key = tuple(sorted(indices))
        if not pooled and (len(indices) != len(keys) or used_sources.intersection(indices)):
            raise ValueError('移孔换液须按顺序一对一指定来源和目标，每个来源只能使用一次')
        if pooled and group_key not in collection_groups and used_sources.intersection(indices):
            raise ValueError('收集组不能部分交叉，也不能重复使用已逐孔分配的来源')
        if target.get('occupied_action') == 'link' or target.get('append', False) is not False:
            raise ValueError('移孔换液不能补充来源关联；加入共培养须明确确认目标')
        cultivation_mode = target.get('cultivation_mode', 'same')
        if cultivation_mode not in ['same', 'custom']:
            raise ValueError('请选择沿用前培养体系或自定义培养体系')
        if pooled:
            indices = list(group_key)
            selected = [sources[index] for index in indices]
            collection_id = text(target.get('collection_id', ''), '收集关联编号', 200)
            if 'collection_id' in target and not collection_id:
                raise ValueError('收集关联编号不能为空')
            if collection_id:
                positions = {(source['id'], source['well']) for source in selected}
                if any(group.get('collection_id') == collection_id and key != group_key
                       for key, (group, _) in collection_groups.items()):
                    raise ValueError('不同来源组不能共用同一收集关联编号')
                for lab in state.get('lab_records', []):
                    for captured in lab.get('source_groups', []):
                        if captured.get('collection_id') == collection_id and {
                            (source['container_id'], source['well']) for source in captured['sources']} != positions:
                            raise ValueError('收集来源与已保存实验样本的关联不一致')
            if group_key not in collection_groups:
                group = {'id': 'POOL-'+uuid.uuid4().hex[:16].upper(),
                         'source_indices': indices, 'targets': []}
                base = _pool_result(selected, at)
                base['pool_id'] = group['id']
                base['introduced_at'] = at
                if collection_id:
                    group['collection_id'] = collection_id
                    base['collection_id'] = collection_id
                collection_groups[group_key] = (group, base)
                record.setdefault('collection_groups', []).append(group)
            group, base = collection_groups[group_key]
            if group.get('collection_id', '') != collection_id:
                raise ValueError('同一收集组的关联编号不一致')
            retains_all = target.get('occupied_action') == 'append' and all(
                c['wells'][key].get('cell') and ((cid, key) in destinations
                    or not (clear and (cid, key) in source_keys)) for key in keys)
            if cultivation_mode == 'same' and not retains_all and any(
                    source['snapshot'].get('medium') != selected[0]['snapshot'].get('medium')
                    for source in selected[1:]):
                raise ValueError('来源培养基不同，整体收集后请明确自定义目标培养体系')
        reference_wells = deepcopy(c['wells']) if target.get('draft_append') else previous_wells[cid]
        cultivation = (prepare_cultivation(target, sources, reference_wells, at)
                       if cultivation_mode == 'custom' else None)
        seeding = normalize_seeding(target['seeding']) if 'seeding' in target else None
        medium_change = _medium_change(target['medium_change']) if 'medium_change' in target else None
        used_sources.update(indices)
        if new_key:
            used_new.add(new_key)
        assignments = [(key, indices) for key in keys] if pooled else [(key, [index]) for key, index in zip(keys, indices)]
        for key, assigned in assignments:
            destination = (cid, key)
            source = sources[assigned[0]]
            origin = (source['id'], source['well'])
            previous_planned = destination in destinations
            if previous_planned and not target.get('draft_append'):
                raise ValueError('目标孔不能重复；叠加本次安排须明确选择加入共培养')
            destinations.add(destination)
            previous = deepcopy(c['wells'][key])
            if previous.get('member_status') == 'archived':
                raise ValueError('已结束的瓶/皿不能直接作为目标，请先恢复或另建目标')
            external = (previous.get('cell') and (previous_planned or
                        ((pooled or destination != origin) and not (clear and destination in source_keys))))
            if external:
                if target.get('occupied_action') not in ['replace', 'append'] or target.get('occupied_confirmed') is not True:
                    raise ValueError('已有细胞目标须明确选择替换或加入共培养，并确认修改前后内容')
                _validate_start(previous, parsed)
            retaining = bool(external and target.get('occupied_action') == 'append')
            if retaining:
                incoming = ([{'snapshot': base, 'origin': {'pool_id': group['id'],
                    'sources': [{field: item[field] for field in ['id', 'name', 'well']} for item in selected]}}]
                    if pooled else [source_population(source)])
                result = append_culture(previous, incoming, {'id': cid, 'name': c['name'], 'well': key}, at, record['id'])
            else:
                result = deepcopy(base if pooled else source['snapshot'])
            if reset_day and result['kind'] == '细胞系' and not result.get('components'):
                result.update(day0=parsed.date().isoformat(), anchor='传代')
            result.pop('cell_count', None)
            result.pop('seeding', None)
            if cultivation is not None:
                apply_cultivation(result, cultivation[key])
                if any(result.get(field, '') != (previous if retaining else source['snapshot']).get(field, '')
                       for field in ['treatment', 'concentration']):
                    result['treated_at'] = at if result['treatment'] or result['concentration'] else ''
            else:
                validate_active_times(result.get('active_treatments') or [], at)
            if seeding is not None:
                result['seeding'] = {**seeding, 'at': at, 'addition': retaining,
                    'per': '孔' if c['type'] in LAYOUTS else '皿' if is_dish(c['type']) else '瓶'}
            result.update(maintenance_id=record['id'], maintenance_at=at)
            validate_well(result)
            c['wells'][key] = result
            record['targets'].append({'id': cid, 'name': c['name'], 'type': c['type'],
                'location': c['location'], 'well': key, 'source_indices': list(assigned),
                'operation': 'append' if retaining else 'replace' if external else 'expand' if pooled else 'replate',
                **({'culture_action':culture_action} if culture_action and not retaining else {}),
                **({'previous_planned': True} if previous_planned else {}),
                **({'distribution': 'pooled', 'pool_id': group['id']} if pooled else {}),
                'previous': previous if previous.get('cell') else None,
                **({'previous_snapshot': previous} if not previous.get('cell') else {}),
                **({'medium_change': deepcopy(medium_change)} if medium_change is not None else {}),
                'result': deepcopy(result)})
            if pooled:
                group['targets'].append({'id': cid, 'well': key})
                record['mapping'].append({'source_indices': list(assigned), 'pool_id': group['id'],
                                          'distribution': 'pooled', 'target': {'id': cid, 'well': key}})
            else:
                record['mapping'].append({'source_index': assigned[0],
                    'source': {'id': source['id'], 'well': source['well']}, 'target': {'id': cid, 'well': key}})
        c['checked_date'] = ''
    if used_sources != set(range(len(sources))):
        raise ValueError('有来源尚未分配去向，请补充或取消该来源')
    if used_new != set(new_ids):
        raise ValueError('有新建容器尚未分配目标孔位，请补充或移除')
    if clear:
        for cid, key in source_keys - destinations:
            containers[cid]['wells'][key] = empty_well()
    record_condition_groups(record, targets, new_ids)
    validate_link_cycles(containers, record['targets'])
    _end_sources(payload, record, containers, originals, source_keys, destinations)
    for source in sources:
        containers[source['id']]['checked_date'] = ''
    return record


def _end_sources(payload, record, containers, originals, source_keys, destinations):
    ended = payload.get('end_sources', [])
    if not isinstance(ended, list) or any(not isinstance(cid, str) for cid in ended) or len(ended) != len(set(ended)):
        raise ValueError('无效的结束来源列表')
    record['ended_sources'] = list(ended)
    for cid in ended:
        c, original = containers.get(cid), originals.get(cid)
        if not original or original['status'] != 'active' or not any(s[0] == cid for s in source_keys):
            raise ValueError('只能结束本次选择且仍在培养的来源容器')
        if any(member_active(w) and (cid, key) not in source_keys for key, w in original['wells'].items()):
            raise ValueError('来源容器还有未选择的在培养细胞，不能结束整个容器')
        if any(destination[0] == cid for destination in destinations):
            raise ValueError('目标仍在该容器中，不能结束该来源容器')
        c['status'] = 'archived'
        c['checked_date'] = ''
    members = payload.get('end_members', [])
    if not isinstance(members, list):
        raise ValueError('结束瓶/皿列表无效')
    record['ended_members'] = []
    seen = set()
    for item in members:
        if not isinstance(item, dict):
            raise ValueError('结束瓶/皿格式无效')
        cid = text(item.get('id', ''), '来源容器编号', 200)
        c, original, keys = containers.get(cid), originals.get(cid), item.get('wells', [])
        if (not original or original['status'] != 'active' or cid in ended or original['type'] not in GROUP_TYPES
                or not isinstance(keys, list) or not keys
                or any(not isinstance(k, str) or (cid, k) not in source_keys for k in keys)
                or len(set(keys)) != len(keys) or any((cid, k) in seen for k in keys)):
            raise ValueError('只能结束本次已选择且仍在培养的来源瓶/皿，且不能重复')
        if any((cid, key) in destinations for key in keys):
            raise ValueError('本次目标瓶/皿不能同时结束')
        for key in keys:
            seen.add((cid, key))
            if c['wells'][key].get('cell'):
                c['wells'][key]['member_status'] = 'archived'
        if not any(member_active(w) for w in c['wells'].values()):
            c['status'] = 'archived'
        c['checked_date'] = ''
        record['ended_members'].append({'id': cid, 'wells': list(keys)})


def finish_replate_sampling(state, payload, record, now):
    """Validate vacated original sources, then apply only explicit endings."""
    from finish_sampling import apply_finish_sampling
    projected = deepcopy(state)
    projected_containers = {c['id']: c for c in projected['containers']}
    destinations = {(target['id'], target['well']) for target in record['targets']}
    if record['clear_sources']:
        for source in record['sources']:
            position = (source['id'], source['well'])
            if position not in destinations:
                projected_containers[source['id']]['wells'][source['well']] = deepcopy(source['snapshot'])
    endings = apply_finish_sampling(projected, payload, now=now)
    if datetime.fromisoformat(endings['at']) < datetime.fromisoformat(record['at']):
        raise ValueError('结束培养时间不能早于本次移孔换液操作时间')
    members = {item['id']: set(item['wells']) for item in endings['ended_members']}
    if any(cid in endings['end_sources'] and (cid not in members or key in members[cid])
           for cid, key in destinations):
        raise ValueError('本次目标培养单元不能同时结束培养')
    containers = {c['id']: c for c in state['containers']}
    for cid in endings['end_sources']:
        c = containers[cid]
        if cid in members:
            for key in members[cid]:
                if c['wells'][key].get('cell'):
                    c['wells'][key]['member_status'] = 'archived'
            if not any(member_active(w) for w in c['wells'].values()):
                c['status'] = 'archived'
        else:
            c['status'] = 'archived'
        c['checked_date'] = ''
    return endings
