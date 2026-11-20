"""Non-destructive display groups over original bottle/dish containers."""
import uuid
from copy import deepcopy

from group_units import GROUP_TYPES, member_active


def get_display_group(state, group_id):
    return next((g for g in state.get('display_groups', []) if g['id'] == group_id), None)


def _group_view(state, group):
    by_id = {c['id']:c for c in state['containers']}
    originals = [by_id[cid] for cid in group['container_ids'] if cid in by_id]
    if not originals:
        raise ValueError('显示分组的原始培养容器不存在')
    wells, members = {}, {}
    for c in originals:
        for key, well in c['wells'].items():
            virtual = c['id'] + '::' + key
            wells[virtual] = deepcopy(well)
            if c['status'] == 'archived' and well.get('cell'):
                wells[virtual]['member_status'] = 'archived'
            members[virtual] = {'container_id':c['id'], 'well':key, 'container_name':c['name'],
                                'container_type':c['type'], 'location':c.get('location', '')}
    types = {c['type'] for c in originals}
    active = [c for c in originals if c['status'] == 'active']
    checks = {c.get('checked_date', '') for c in active}
    return {'id':group['id'], 'name':group['name'],
            'type':originals[0]['type'] if len(types) == 1 else '培养组',
            'primary_type':originals[0]['type'], 'quantity':len(wells),
            'location':' · '.join(dict.fromkeys(c.get('location', '') for c in originals if c.get('location'))),
            'status':'active' if active else 'archived',
            'created_at':min(c.get('created_at', group['created_at']) for c in originals),
            'checked_date':next(iter(checks)) if len(checks) == 1 else '',
            'wells':wells, 'display_group':True, 'display_members':members,
            'container_ids':list(group['container_ids'])}


def display_containers(state):
    groups = state.get('display_groups', [])
    membership = {cid:g for g in groups for cid in g['container_ids']}
    emitted, result = set(), []
    for c in state['containers']:
        group = membership.get(c['id'])
        if not group:
            result.append(c)
        elif group['id'] not in emitted:
            result.append(_group_view(state, group))
            emitted.add(group['id'])
    return result


def resolve_display_ref(state, container_id, key):
    group = get_display_group(state, container_id)
    if group:
        ref = _group_view(state, group)['display_members'].get(key)
        if not ref:
            raise ValueError('显示分组中找不到该培养单元')
        return ref['container_id'], ref['well']
    c = next((c for c in state['containers'] if c['id'] == container_id), None)
    if not c or key not in c['wells']:
        raise ValueError('找不到该培养单元')
    return container_id, key


def apply_merge(state, payload, now):
    name = payload.get('name', '')
    ids = payload.get('container_ids')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
        raise ValueError('显示分组名称须为 1–120 个字符')
    if not isinstance(ids, list) or not ids or any(not isinstance(cid, str) for cid in ids) or len(ids) != len(set(ids)):
        raise ValueError('请选择完整且不重复的原始培养容器')
    existing = get_display_group(state, payload.get('id'))
    if payload.get('id') and not existing:
        raise ValueError('找不到该显示分组')
    occupied = {cid for g in state.get('display_groups', []) if g is not existing for cid in g['container_ids']}
    if any(cid in occupied for cid in ids):
        raise ValueError('原始容器已属于其他显示分组，请先取消原分组')
    containers = {c['id']:c for c in state['containers']}
    identities, total = set(), 0
    for cid in ids:
        c = containers.get(cid)
        if not c or c['type'] not in GROUP_TYPES:
            raise ValueError('仅可合并已有的培养瓶或培养皿')
        if not c['wells']:
            raise ValueError('所选容器的每瓶/皿都需先填写细胞')
        for w in c['wells'].values():
            if not isinstance(w.get('cell'), str) or not w['cell'].strip() or w.get('components'):
                raise ValueError('所选每瓶/皿均需填写单一细胞，空记录或混合培养不能合并显示')
            identities.add((w['cell'].strip().casefold(), w.get('kind')))
            total += 1
    if len(identities) != 1:
        raise ValueError('只能合并细胞名称和细胞类型相同的瓶/皿')
    if not 2 <= total <= 100:
        raise ValueError('显示分组须包含 2–100 个瓶/皿')
    timestamp = now.isoformat() if hasattr(now, 'isoformat') else now
    group = {'id':existing['id'] if existing else 'DG-'+uuid.uuid4().hex[:12].upper(),
             'name':name.strip(), 'container_ids':list(ids),
             'created_at':existing['created_at'] if existing else timestamp, 'updated_at':timestamp}
    groups = list(state.get('display_groups', []))
    if existing:
        groups[groups.index(existing)] = group
    else:
        groups.append(group)
    state['display_groups'] = groups
    return {**deepcopy(group), 'change':'update' if existing else 'create',
            'previous_container_ids':list(existing['container_ids']) if existing else []}


def apply_unmerge(state, payload):
    group = get_display_group(state, payload.get('id'))
    if not group:
        raise ValueError('找不到该显示分组')
    state['display_groups'] = [g for g in state.get('display_groups', []) if g['id'] != group['id']]
    return deepcopy(group)


def begin_projection(state, action, payload):
    """Add a temporary native-shaped view for the existing command validators."""
    group = get_display_group(state, payload.get('id'))
    if not group or action in ['merge_groups', 'unmerge_groups']:
        return None
    if action not in ['wells', 'clear', 'activity', 'member_status', 'check', 'status']:
        raise ValueError('请使用“编辑分组”修改显示分组；修改容器类型或数量前请取消显示合并')
    view = _group_view(state, group)
    keys = payload.get('wells') if action != 'status' else list(view['wells'])
    if action == 'check' and keys is None:
        keys = [key for key, w in view['wells'].items() if member_active(w)]
    if not isinstance(keys, list) or not keys or len(keys) != len(set(k for k in keys if isinstance(k, str))) or any(not isinstance(k, str) or k not in view['wells'] for k in keys):
        raise ValueError('请选择有效且不重复的瓶/皿')
    if action == 'check' and any(not member_active(view['wells'][key]) for key in keys):
        raise ValueError('只能核对仍在培养的已填写瓶/皿')
    if action == 'check':
        root_ids = {view['display_members'][key]['container_id'] for key in keys}
        keys = [key for key, ref in view['display_members'].items() if ref['container_id'] in root_ids]
    context = {'id':group['id'], 'name':group['name'],
               'members':{key:deepcopy(view['display_members'][key]) for key in keys}}
    view['type'] = view['primary_type']
    projection = {'view':view, 'before':deepcopy(view), 'keys':keys, 'context':context}
    state['containers'].append(view)
    return projection


def commit_projection(state, projection, action, payload):
    """Write changed individual records back, then discard the temporary view."""
    if projection is None:
        return payload
    view, before = projection['view'], projection['before']
    state['containers'].remove(view)
    originals = {c['id']:c for c in state['containers']}
    affected = {before['display_members'][key]['container_id'] for key in projection['keys']}
    if action == 'status':
        for cid in affected:
            c = originals[cid]
            c['status'] = payload['status']
            occupied = [w for w in c['wells'].values() if w.get('cell')]
            if payload['status'] == 'active' and occupied and not any(member_active(w) for w in occupied):
                for w in occupied:
                    w['member_status'] = 'active'
            c['checked_date'] = ''
    else:
        if action == 'member_status':
            for cid in affected:
                if originals[cid]['status'] == 'archived':
                    for w in originals[cid]['wells'].values():
                        if w.get('cell'):
                            w['member_status'] = 'archived'
        for key in projection['keys']:
            ref = before['display_members'][key]
            if view['wells'][key] != before['wells'][key]:
                originals[ref['container_id']]['wells'][ref['well']] = deepcopy(view['wells'][key])
        for cid in affected:
            c = originals[cid]
            if action == 'member_status':
                c['status'] = 'active' if any(member_active(w) for w in c['wells'].values()) else 'archived'
            c['checked_date'] = view['checked_date'] if action == 'check' or (action == 'activity' and payload.get('checked_date')) else ''
    return {**payload, 'group_context':projection['context']}
