"""End explicitly sampled cultures without altering assay or source evidence."""
from datetime import datetime

from group_units import GROUP_TYPES, group_quantity, member_active
from medium import text
from store import LAYOUTS, TZ, current_time


def _ids(value, label, maximum, required=False):
    if not isinstance(value, list) or len(value) > maximum or (required and not value):
        raise ValueError(f'{label}须为有效列表，最多{maximum}项')
    result = [text(item, label, 200) for item in value]
    if any(not item for item in result) or len(result) != len(set(result)):
        raise ValueError(f'{label}不能有空值或重复项')
    return result


def apply_finish_sampling(state, payload, now=None):
    """Validate the entire selection before changing any container/member status."""
    if not isinstance(payload, dict) or set(payload) - {'at', 'sources', 'end_sources', 'experiment_ids', 'notes'}:
        raise ValueError('取样后结束培养的请求格式无效')
    at = text(payload.get('at', ''), '实际操作时间', 40)
    try:
        parsed = datetime.fromisoformat(at)
    except ValueError:
        raise ValueError('请填写有效的实际操作日期和时间') from None
    if len(at) < 16 or at[10] != 'T':
        raise ValueError('请填写完整的实际操作日期和时间')
    if parsed.tzinfo is not None or parsed.replace(tzinfo=TZ) > (now or current_time()):
        raise ValueError('实际操作时间须为已发生的北京时间，不能填写未来时间')
    inputs = payload.get('sources', [])
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 200:
        raise ValueError('请选择1–200个已填写的来源培养单元')
    end_sources = _ids(payload.get('end_sources', []), '结束来源', 200, required=True)
    experiment_ids = _ids(payload.get('experiment_ids', []), '关联实验记录', 100)
    records = {record['id'] for record in state.get('lab_records', [])}
    if any(rid not in records for rid in experiment_ids):
        raise ValueError('关联实验记录不存在，请刷新后重新选择')
    notes = text(payload.get('notes', ''), '操作备注', 5000)
    containers = {c['id']: c for c in state['containers']}
    sources, selected = [], {}
    for item in inputs:
        if not isinstance(item, dict) or set(item) - {'id', 'well', 'role', 'amount'}:
            raise ValueError('来源培养单元格式无效')
        cid = text(item.get('id', ''), '来源容器编号', 200)
        key = text(item.get('well', ''), '来源培养单元', 200)
        c = containers.get(cid)
        if not c or c['status'] != 'active' or key not in c['wells'] or not member_active(c['wells'][key]):
            raise ValueError('来源须为在培养容器中有效且有细胞的培养单元')
        if key in selected.setdefault(cid, []):
            raise ValueError('同一个来源培养单元不能重复添加')
        selected[cid].append(key)
        sources.append({'id': cid, 'well': key})
    if any(cid not in selected for cid in end_sources):
        raise ValueError('只能结束本次选择的来源容器')

    ended_members = []
    for cid in end_sources:
        c = containers[cid]
        if c['type'] in LAYOUTS and any(member_active(w) and key not in selected[cid]
                                         for key, w in c['wells'].items()):
            raise ValueError('来源孔板还有未选择的在培养细胞，不能结束整块孔板')
        for key in selected[cid]:
            well = c['wells'][key]
            parts = well.get('components') or [well]
            if (well.get('day0', '') > parsed.date().isoformat()
                    or any(part['day0'] > parsed.date().isoformat() for part in parts)
                    or (well.get('introduced_at') and parsed < datetime.fromisoformat(well['introduced_at']))):
                raise ValueError('操作时间不能早于所选培养记录的起始时间')
        if c['type'] in GROUP_TYPES and group_quantity(c) > 1:
            ended_members.append({'id': cid, 'wells': list(selected[cid])})

    member_endings = {item['id']: item['wells'] for item in ended_members}
    for cid in end_sources:
        c = containers[cid]
        if cid in member_endings:
            for key in member_endings[cid]:
                c['wells'][key]['member_status'] = 'archived'
            if not any(member_active(w) for w in c['wells'].values()):
                c['status'] = 'archived'
        else:
            c['status'] = 'archived'
        c['checked_date'] = ''
    return {'at': at, 'sources': sources, 'end_sources': end_sources,
            'ended_members': ended_members, 'experiment_ids': experiment_ids, 'notes': notes}
