"""Schema-validated lab records, immutable provenance, and explicit calculators."""
from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from platform_config import TZ
import json
import re
import uuid


NUMBER = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')
ACTUAL_TIME_FIELDS = {'prepared_at', 'aliquoted_at', 'extracted_at', 'acquired_at', 'seeded_date'}
ACTUAL_STATUSES = {'active', 'running', 'completed', 'available', 'depleted', 'disposed'}


def current_time():
    return datetime.now(TZ)


@lru_cache(maxsize=1)
def load_schema():
    return json.loads(Path(__file__).with_name('lab_schemas.json').read_text(encoding='utf-8'))


def _text(value, label, limit=5000):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f'{label}须为文本，最多{limit}字符')
    return value.strip()


def _list(value, label, limit):
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError(f'{label}须为列表，最多{limit}项')
    return value


def _date(value, label):
    if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        raise ValueError(f'{label}须为有效日期 YYYY-MM-DD')
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValueError(f'{label}须为有效日期') from None


def _datetime(value, label):
    if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})?', value):
        raise ValueError(f'{label}须为有效日期时间')
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError(f'{label}须为有效日期时间') from None
    return parsed.replace(tzinfo=TZ) if parsed.tzinfo is None else parsed


def _fields(values, descriptors, required, source_keys, status, now, extra_keys=()):
    if not isinstance(values, dict):
        raise ValueError('字段须为对象')
    allowed = {d['key'] for d in descriptors} | set(extra_keys)
    if set(values) - allowed:
        raise ValueError('包含当前模块未定义的字段')
    normalized = {}
    for descriptor in descriptors:
        key, label = descriptor['key'], descriptor['label']
        value = _text(values.get(key, ''), label)
        normalized[key] = value
        if not value:
            if required and descriptor.get('required'):
                raise ValueError(f'请填写{label}')
            continue
        kind = descriptor['type']
        if kind == 'number':
            try:
                numeric = Decimal(value)
            except InvalidOperation:
                raise ValueError(f'{label}须为有限数字') from None
            if not NUMBER.fullmatch(value) or not numeric.is_finite():
                raise ValueError(f'{label}须为有限数字')
            if 'min' in descriptor and numeric < Decimal(str(descriptor['min'])):
                raise ValueError(f'{label}不能小于{descriptor["min"]}')
            if descriptor.get('integer') and numeric != numeric.to_integral_value():
                raise ValueError(f'{label}须为整数')
            unit_key = descriptor.get('unit_key')
            if unit_key and not _text(values.get(unit_key, ''), '单位'):
                raise ValueError(f'请填写{label}的单位')
        elif kind == 'select' and value not in descriptor['options']:
            raise ValueError(f'{label}选项无效')
        elif kind == 'source':
            if value not in source_keys:
                raise ValueError(f'{label}须选择本记录关联的明确观察版本')
            normalized[key]=source_keys[value]
        elif kind in {'date', 'datetime'}:
            parsed = _date(value, label) if kind == 'date' else _datetime(value, label)
            if key in ACTUAL_TIME_FIELDS and status in ACTUAL_STATUSES:
                if parsed > (now.date() if kind == 'date' else now):
                    raise ValueError(f'{label}不能把未来计划标记为已执行')
    return normalized


def _source_key(item):
    cid = _text(item.get('container_id', ''), '来源容器', 200)
    well = _text(item.get('well', ''), '来源孔位', 200)
    snapshot_id = _text(item.get('snapshot_id', ''), '历史快照编号', 200)
    if not cid or not well or any('|' in v for v in (cid, well, snapshot_id)):
        raise ValueError('来源容器、孔位或快照编号无效')
    return cid, well, snapshot_id, '|'.join((cid, well, snapshot_id))


def _freeze_day(well, observed_date):
    result = deepcopy(well)
    for part in [result, *result.get('components', [])]:
        if part.get('cell') and part.get('day0'):
            days = (observed_date - _date(part['day0'], '来源Day 0')).days
            if days < 0:
                raise ValueError('来源Day 0不能晚于观察日期')
            part['day'] = days
        else:
            part['day'] = None
    return result


def _capture_sources(state, inputs, existing, refresh, snapshot_loader, now):
    previous = {item['key']: item for item in existing}
    sources, seen = [], set()
    snapshots = {}
    for item in _list(inputs, '细胞来源', 300):
        if not isinstance(item, dict):
            raise ValueError('细胞来源须为对象')
        cid, well, snapshot_id, key = _source_key(item)
        if key in seen:
            raise ValueError('同一细胞来源不能重复添加')
        seen.add(key)
        if key in previous and not refresh:
            sources.append(deepcopy(previous[key]))
            continue
        observed_at = now.isoformat()
        observed_date = now.date()
        source_state = state
        if snapshot_id:
            if snapshot_id not in snapshots:
                snapshots[snapshot_id] = snapshot_loader(snapshot_id)
            historical = snapshots[snapshot_id]
            if not historical or not isinstance(historical.get('state'), dict):
                raise ValueError('来源历史快照不存在')
            source_state = historical['state']
            observed_at = historical['at']
            observed_date = _date(historical['date'], '快照日期')
        container = next((c for c in source_state.get('containers', []) if c['id'] == cid), None)
        original = container.get('wells', {}).get(well) if container else None
        if not original or not original.get('cell'):
            raise ValueError('来源须为存在且已填写细胞的孔位')
        sources.append({'key': key, 'container_id': cid, 'container_name': container['name'],
                        'container_type': container['type'], 'well': well, 'snapshot_id': snapshot_id,
                        'captured_at': now.isoformat(), 'observed_at': observed_at,
                        'state_revision': source_state.get('revision', 0),
                        'snapshot': _freeze_day(original, observed_date)})
    return sources


def _capture_refs(records, record_id, inputs, existing, refresh, now):
    ids = [_text(item, '关联记录编号', 200) for item in _list(inputs, '关联记录', 100)]
    if len(set(ids)) != len(ids):
        raise ValueError('关联记录不能重复添加')
    by_id = {record['id']: record for record in records}
    if any(item not in by_id for item in ids):
        raise ValueError('关联的上游记录不存在')
    # Follow the current relationship graph, not nested historical payloads.
    # An iterative search avoids recursion limits on long experiment chains.
    pending, visited = list(ids), set()
    while pending:
        item = pending.pop()
        if item == record_id:
            raise ValueError('记录不能关联自身或形成循环依赖')
        if item in visited:
            continue
        visited.add(item)
        pending.extend(ref['id'] for ref in by_id.get(item, {}).get('record_refs', []))
    previous = {item['id']: item for item in existing}
    refs = []
    for item in ids:
        if item in previous and not refresh:
            refs.append(deepcopy(previous[item]))
        else:
            upstream = by_id[item]
            refs.append({**{key: upstream[key] for key in ('id', 'title', 'type', 'variant', 'status', 'version')},
                         'captured_at': now.isoformat(),
                         'snapshot': deepcopy({key: value for key, value in upstream.items() if key != 'record_refs'})})
    return refs


def _all_sources(sources, refs):
    result, seen = [], set()
    inherited = [source for ref in refs for source in ref['snapshot'].get(
        'all_cell_sources', ref['snapshot'].get('cell_sources', []))]
    for source,inherited_flag in [(s,False) for s in sources]+[(s,True) for s in inherited]:
        item=deepcopy(source)
        item['table_key']='OBS|'+source['key']+'|'+source['observed_at'] if inherited_flag else source['key']
        if item['table_key'] not in seen:
            result.append(item);seen.add(item['table_key'])
    return result


SOURCE_GROUP_FIELDS = {'id', 'name', 'members', 'notes', 'binding_id', 'collection_id'}


def _capture_source_groups(inputs, existing, all_sources, refresh, now):
    """Freeze each pool as a set of individual observations, never a merged well.

    Existing groups survive later source/ref edits. An explicit refresh recaptures
    every member from the current source selection or rejects the whole save.
    """
    previous = {group['id']: group for group in existing}
    available = {source['table_key']: source for source in all_sources}
    groups, seen_ids, seen_observations = [], set(), set()
    for item in _list(inputs, '收集组', 300):
        if not isinstance(item, dict) or set(item) - SOURCE_GROUP_FIELDS:
            raise ValueError('收集组包含未定义的字段')
        group_id = _text(item.get('id', ''), '收集组编号', 200)
        name = _text(item.get('name', ''), '收集组名称', 200)
        if not group_id or '|' in group_id or not name:
            raise ValueError('请填写有效的收集组编号和名称')
        if group_id in seen_ids:
            raise ValueError('收集组编号不能重复')
        seen_ids.add(group_id)
        members = [_text(member, '收集组成员', 1000)
                   for member in _list(item.get('members', []), '收集组成员', 300)]
        if not members or any(not member for member in members) or len(set(members)) != len(members):
            raise ValueError('收集组须包含至少一个独立来源，成员不能重复')
        members = sorted(members)
        prior = previous.get(group_id)
        if prior and set(members) != set(prior['members']) and not refresh:
            raise ValueError('已有收集组的成员不能静默更改，请新建收集组或明确刷新来源')
        metadata = {'id': group_id, 'name': name, 'key': 'GROUP|' + group_id}
        for key in ('notes', 'binding_id', 'collection_id'):
            if key in item:
                metadata[key] = _text(item[key], '收集组备注' if key == 'notes' else '收集组关联编号',
                                      5000 if key == 'notes' else 200)
        if prior and not refresh:
            group = {**deepcopy(prior), **metadata}
        else:
            if any(member not in available for member in members):
                raise ValueError('收集组成员须选择本记录关联的独立观察版本；刷新时须重新选择全部成员')
            group = {**metadata, 'members': members,
                     'sources': [deepcopy(available[member]) for member in members],
                     'captured_at': now.isoformat()}
        # A direct source and an inherited OBS key can refer to the same capture.
        observations = [(source['key'], source['observed_at']) for source in group['sources']]
        if len(set(observations)) != len(observations) or seen_observations.intersection(observations):
            raise ValueError('同一来源观察不能重复归入收集组；多管取样可使用同组的多条样本行')
        seen_observations.update(observations)
        groups.append(group)
    return groups


def _all_source_groups(groups, refs):
    result = [{**deepcopy(group), 'table_key': group['key']} for group in groups]
    for ref in refs:
        for group in ref['snapshot'].get('all_source_groups', ref['snapshot'].get('source_groups', [])):
            # Carry a transitive path when necessary: a captured record can itself
            # contain two versions of the same original group ID.
            inherited_key = group.get('table_key', group['key'])
            suffix = inherited_key if inherited_key.startswith('OBS_GROUP|') else group['id']
            result.append({**deepcopy(group),
                           'table_key': f"OBS_GROUP|{ref['id']}|{ref['version']}|{suffix}"})
    return result


def apply_lab_record(state, payload, snapshot_loader):
    """Validate fully, then replace/append one record; return a slim audit payload."""
    if not isinstance(payload, dict):
        raise ValueError('实验记录须为对象')
    for flag in ('refresh_sources', 'refresh_refs'):
        if type(payload.get(flag, False)) is not bool:
            raise ValueError('刷新选项须为布尔值')
    records = state.get('lab_records', [])
    requested_id = _text(payload.get('id', ''), '记录编号', 200)
    existing = next((record for record in records if record['id'] == requested_id), None)
    if requested_id and existing is None:
        raise ValueError('待编辑的实验记录不存在')
    kind = _text(payload.get('type', ''), '模块类型', 100)
    variant = _text(payload.get('variant', ''), '记录阶段', 100)
    module = load_schema()['modules'].get(kind)
    if not module or variant not in module['variants']:
        raise ValueError('实验模块或阶段无效')
    if existing and (existing['type'] != kind or existing['variant'] != variant):
        raise ValueError('已有记录不能改变模块或阶段，请新建记录')
    status = _text(payload.get('status', 'draft'), '记录状态', 100)
    if status not in {item[0] for item in module['statuses']}:
        raise ValueError('记录状态无效')
    now = current_time()
    record_date = _text(payload.get('record_date', ''), '记录日期', 10)
    parsed_date = _date(record_date, '记录日期')
    if status not in {'draft', 'planned'} and parsed_date > now.date():
        raise ValueError('未来日期的记录只能保存为草稿或计划')
    title = _text(payload.get('title', ''), '记录标题', 200)
    if not title:
        raise ValueError('请填写记录标题')
    record_id = requested_id or module['prefix'] + '-' + uuid.uuid4().hex[:16].upper()
    prior = existing or {}
    sources = _capture_sources(state, payload.get('cell_sources', []), prior.get('cell_sources', []),
                               payload.get('refresh_sources', False), snapshot_loader, now)
    refs = _capture_refs(records, record_id, payload.get('record_refs', []), prior.get('record_refs', []),
                         payload.get('refresh_refs', False), now)
    all_sources = _all_sources(sources, refs)
    group_inputs = payload.get('source_groups', [
        {key: value for key, value in group.items() if key in SOURCE_GROUP_FIELDS}
        for group in prior.get('source_groups', [])])
    groups = _capture_source_groups(group_inputs, prior.get('source_groups', []), all_sources,
                                    payload.get('refresh_sources', False), now)
    all_groups = _all_source_groups(groups, refs)
    source_keys = {source['table_key']:source['table_key'] for source in all_sources}
    # Legacy logical keys remain accepted only when they resolve unambiguously.
    for logical in {source['key'] for source in all_sources}:
        choices=[s for s in all_sources if s['key']==logical]
        if logical not in source_keys and len({s['observed_at'] for s in choices})==1:
            source_keys[logical]=choices[0]['table_key']
    source_keys.update({group['table_key']: group['table_key'] for group in all_groups})
    descriptor = module['variants'][variant]
    required = status not in {'draft', 'planned'}
    data = _fields(payload.get('data', {}), descriptor['fields'], required, source_keys, status, now)
    table_inputs = payload.get('tables', {})
    if not isinstance(table_inputs, dict) or set(table_inputs) - {t['key'] for t in descriptor['tables']}:
        raise ValueError('数据表包含当前模块未定义的表格')
    tables = {}
    for table in descriptor['tables']:
        rows, row_ids = [], set()
        for item in _list(table_inputs.get(table['key'], []), table['label'], 2000):
            row = _fields(item, table['columns'], False, source_keys, status, now, ('row_id',))
            supplied_id = _text(item.get('row_id', ''), '数据行编号', 200)
            if not any(row.values()):
                continue
            if required:
                _fields(item, table['columns'], True, source_keys, status, now, ('row_id',))
            row_id = supplied_id or 'ROW-' + uuid.uuid4().hex[:16].upper()
            if row_id in row_ids:
                raise ValueError('同一表格的数据行编号不能重复')
            row_ids.add(row_id)
            row['row_id'] = row_id
            if kind == 'drug' and table['key'] == 'aliquots':
                if row['remaining'] and not row['unit']:
                    raise ValueError('请填写剩余量单位')
                if row['remaining'] and row['volume'] and Decimal(row['remaining']) > Decimal(row['volume']):
                    raise ValueError('剩余量不能大于初始量')
            rows.append(row)
        tables[table['key']] = rows
    files = []
    for item in _list(payload.get('files', []), '原始文件索引', 100):
        if not isinstance(item, dict) or set(item) - {'label', 'path', 'description'}:
            raise ValueError('原始文件索引字段无效')
        normalized = {key: _text(item.get(key, ''), '文件索引') for key in ('label', 'path', 'description')}
        if any(normalized.values()):
            files.append(normalized)
    record = {'id': record_id, 'type': kind, 'variant': variant, 'schema_version':1, 'title': title,
              'record_date': record_date, 'status': status,
              'experiment': _text(payload.get('experiment', ''), '实验编号'),
              'notes': _text(payload.get('notes', ''), '记录备注'),
              'data': data, 'tables': tables, 'files': files, 'cell_sources': sources,
              'all_cell_sources': all_sources, 'record_refs': refs,
              'version': prior.get('version', 0) + 1,
              'created_at': prior.get('created_at', now.isoformat()), 'updated_at': now.isoformat()}
    if 'source_groups' in payload or 'source_groups' in prior or all_groups:
        record['source_groups'] = groups
        record['all_source_groups'] = all_groups
    replacement = list(records)
    if existing:
        replacement[records.index(existing)] = record
    else:
        replacement.append(record)
    state['lab_records'] = replacement
    # Frozen groups may retain older observations no longer selected individually.
    # Include their wells in the audit/reverse-link contract without changing the
    # existing all_cell_sources observation namespace.
    event_sources = list(all_sources)
    event_keys = {(source['key'], source['observed_at']) for source in event_sources}
    for group in all_groups:
        for source in group['sources']:
            key = (source['key'], source['observed_at'])
            if key not in event_keys:
                event_sources.append(source)
                event_keys.add(key)
    return {'record_id': record_id, 'record_type': kind, 'variant': variant, 'title': title,
            'status': status, 'record_date': record_date, 'version': record['version'],
            'container_ids': list(dict.fromkeys(source['container_id'] for source in event_sources)),
            'cell_sources': [{key: source[key] for key in ('key', 'container_id', 'well', 'snapshot_id')}
                             for source in event_sources],
            'change': 'update' if existing else 'create'}
