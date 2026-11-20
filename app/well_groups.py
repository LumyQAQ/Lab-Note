"""Logical plate bindings; biological well records remain independent."""
from collections import Counter
import uuid
from copy import deepcopy

from group_units import member_active
from medium import DEFAULT, recipe_key


def _plate(state, cid):
    from store import LAYOUTS
    container = next((c for c in state['containers'] if c['id'] == cid), None)
    if not container or container['type'] not in LAYOUTS or container['status'] != 'active':
        raise ValueError('请选择在培养的孔板')
    return container


def apply_well_group_save(state, payload, now):
    from store import coordinates
    container = _plate(state, payload.get('id'))
    name, gid, keys = payload.get('name'), payload.get('group_id'), payload.get('wells')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
        raise ValueError('培养组名称须为 1–120 个字符')
    groups = container.get('well_groups', [])
    if 'group_id' in payload and (not isinstance(gid, str) or not gid):
        raise ValueError('培养组编号无效')
    existing = next((group for group in groups if group['id'] == gid), None)
    if gid is not None and existing is None:
        raise ValueError('找不到该培养组')
    valid = set(coordinates(container['type']))
    if (not isinstance(keys, list) or len(keys) < (1 if existing else 2)
            or any(not isinstance(key, str) or key not in valid
                   or not member_active(container['wells'].get(key, {})) for key in keys)
            or len(keys) != len(set(keys))):
        raise ValueError('新培养组须选择至少两个已填写的在培养孔位；编辑后须保留至少一个有效孔位')
    occupied = {key for group in groups if group['id'] != gid for key in group['wells']}
    if occupied.intersection(keys):
        raise ValueError('一个孔位只能属于一个培养组，请先调整原分组')
    group = {**(existing or {'id': 'WG-'+uuid.uuid4().hex[:16].upper(), 'created_at': now}),
             'name': name.strip(), 'wells': list(keys), 'updated_at': now}
    if existing:
        if set(keys) != set(existing['wells']) and _automatic(existing):
            group['auto_split'] = False
        groups[groups.index(existing)] = group
    else:
        container.setdefault('well_groups', []).append(group)
    return {'id': container['id'], 'group_id': group['id'], 'name': group['name'],
            'wells': list(keys), 'change': 'update' if existing else 'create'}


def apply_well_group_remove(state, payload):
    container = _plate(state, payload.get('id'))
    gid = payload.get('group_id')
    if not isinstance(gid, str) or not gid:
        raise ValueError('培养组编号无效')
    groups = container.get('well_groups', [])
    group = next((group for group in groups if group['id'] == gid), None)
    if group is None:
        raise ValueError('找不到该培养组')
    groups.remove(group)
    if not groups:
        container.pop('well_groups', None)
    return {'id': container['id'], 'group_id': gid, 'name': group['name'],
            'wells': list(group['wells'])}


def _automatic(group):
    # Older collection and inherited groups predate the explicit policy.
    return group.get('auto_split', bool(group.get('origin_pool_id') or group.get('parent_group_id')))


def _condition(well):
    medium = recipe_key({**DEFAULT, **(well.get('medium') or {})})
    treatment = well.get('treatment', '').strip()
    dose = well.get('concentration', '').strip()
    started = well.get('treated_at', '') if treatment or dose else ''
    active = tuple(sorted((item['name'], item.get('concentration', ''), item.get('started_at', ''))
                          for item in well.get('active_treatments', [])))
    identity = tuple(well.get(field, '') for field in ('cell', 'kind', 'batch', 'day0', 'anchor'))
    return identity, medium, treatment, dose, started, active


def split_changed_well_groups(state, previous, now):
    """Partition automatic bindings, preserving well observations and pool receipts."""
    old_plates = {c['id']: c for c in previous['containers']}
    changes = []
    for plate in state['containers']:
        if plate['status'] != 'active' or not plate.get('well_groups'):
            continue
        old = old_plates.get(plate['id'], {})
        old_wells = old.get('wells', {})
        groups_before = {g['id']: g for g in old.get('well_groups', [])}
        updated = []
        for group in plate['well_groups']:
            members = group['wells']
            prior = groups_before.get(group['id'], {})
            if len(members) < 2 or not _automatic(group):
                updated.append(group)
                continue
            if members == prior.get('wells') and all(plate['wells'][k] == old_wells.get(k) for k in members):
                updated.append(group)
                continue
            partitions = {}
            for key in members:
                signature = _condition(plate['wells'][key])
                partitions.setdefault(signature, []).append(key)
            if len(partitions) == 1:
                updated.append(group)
                continue

            # Keep the original identity with the unchanged condition, even if
            # the first member was the one edited. A lone member is independent.
            def continuity(signature):
                wells = partitions[signature]
                unchanged = sum(key in prior.get('wells', []) and key in old_wells
                                and _condition(old_wells[key]) == signature for key in wells)
                return unchanged, len(wells)

            original_condition = max(partitions, key=continuity)
            for signature, wells in partitions.items():
                if len(wells) == 1:
                    continue
                subgroup = {**group, 'wells': wells, 'updated_at': now}
                if signature != original_condition:
                    subgroup.update(id='WG-'+uuid.uuid4().hex[:16].upper(), created_at=now,
                                    parent_group_id=group['id'], auto_split=True)
                updated.append(subgroup)
            changes.append({'id':plate['id'], 'group_id':group['id'], 'name':group['name'],
                            'members':list(members), 'partitions':list(partitions.values())})
        if updated:
            plate['well_groups'] = updated
        else:
            plate.pop('well_groups', None)
    return changes


def reconcile_well_groups(state, now):
    """Trim current bindings only; never backfill old records or touch snapshots."""
    from store import LAYOUTS, coordinates
    for container in state['containers']:
        if 'well_groups' not in container:
            continue
        if container['type'] not in LAYOUTS:
            container.pop('well_groups')
            continue
        valid = set(coordinates(container['type']))
        retained = []
        for group in container['well_groups']:
            keys = [key for key in group['wells'] if key in valid
                    and container['wells'].get(key, {}).get('cell')]
            if keys:
                if keys != group['wells']:
                    group.update(wells=keys, updated_at=now)
                if group.get('origin_pool_id') and {container['wells'][key].get('pool_id') for key in keys} != {group['origin_pool_id']}:
                    group.setdefault('auto_split', _automatic(group))
                    group.pop('origin_pool_id')
                    group['updated_at'] = now
                retained.append(group)
        if retained:
            container['well_groups'] = retained
        else:
            container.pop('well_groups')


def record_condition_groups(record, targets, new_ids):
    """Bind explicitly partitioned destinations independently of their shared source."""
    from store import LAYOUTS
    if not any('condition_group' in target for target in targets):
        return
    rows = {(row['id'], row['well']): row for row in record['targets']}
    counts = Counter((row['id'], row['well']) for row in record['targets'])
    for target in targets:
        if 'condition_group' not in target:
            continue
        name = target['condition_group']
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            raise ValueError('请填写条件组名称（最多 120 字）')
        cid = target.get('id') or new_ids[target['new_key']]
        positions = [(cid, key) for key in target['wells']]
        if any(counts[pos] != 1 for pos in positions):
            raise ValueError('同一目标孔仅可归入一个条件组，请调整目标孔')
        if (record['mode'] not in ('replate', 'passage') or rows[positions[0]]['type'] not in LAYOUTS
                or any(rows[pos]['operation'] == 'link' for pos in positions)
                or (record['mode'] == 'replate' and target.get('distribution') != 'pooled')):
            raise ValueError('条件组适用于同一来源传代或整体收集后的目标孔')
        group_id = 'WG-'+uuid.uuid4().hex[:16].upper()
        for pos in positions:
            rows[pos].update(condition_group=name.strip(), condition_group_id=group_id)


def reconcile_transfer_groups(state, before, record, now):
    """Move bindings using receipt mappings, after all well writes have succeeded."""
    from store import LAYOUTS
    containers = {c['id']: c for c in state['containers']}
    bindings = {(c['id'], key): (c['id'], group)
                for c in before['containers'] for group in c.get('well_groups', [])
                for key in group['wells']}
    # A replacement is a new occupant even when its well key stays the same.
    destinations = {(target['id'], target['well']) for target in record['targets']
                    if target.get('operation') != 'link'}
    for container in state['containers']:
        for group in container.get('well_groups', []):
            keys = [key for key in group['wells'] if (container['id'], key) not in destinations]
            if keys != group['wells']:
                group.update(wells=keys, updated_at=now)
    reconcile_well_groups(state, now)
    if record['mode'] not in ['passage', 'replate', 'move', 'copy']:
        return

    def attach(cid, keys, inherited=None, pool_id=None, name=None):
        container = containers[cid]
        if container['type'] not in LAYOUTS:
            return
        keys = [key for key in keys if member_active(container['wells'].get(key, {}))]
        if not keys:
            return
        origin_cid, original = inherited if inherited else (None, None)
        same_plate = origin_cid == cid
        groups = container.setdefault('well_groups', [])
        group = next((g for g in groups if same_plate and g['id'] == original['id']), None)
        if group is None:
            if same_plate:
                group = {**deepcopy(original), 'wells': []}
            else:
                group = {'id': 'WG-'+uuid.uuid4().hex[:16].upper(),
                         'name': original['name'] if original else name,
                         'wells': [], 'created_at': now, 'auto_split': True}
                if original:
                    group['parent_group_id'] = original['id']
                    if original.get('origin_pool_id'):
                        group['origin_pool_id'] = original['origin_pool_id']
            groups.append(group)
        group['wells'] = list(dict.fromkeys(group['wells'] + keys))
        group['updated_at'] = now
        if pool_id:
            group.setdefault('auto_split', _automatic(original) if same_plate else True)
            group['origin_pool_id'] = pool_id

    named_groups = {}
    named_positions = set()
    for row in record['targets']:
        if row.get('condition_group_id'):
            named_groups.setdefault(row['condition_group_id'], []).append(row)
            named_positions.add((row['id'], row['well']))
    for gid, rows in named_groups.items():
        row = rows[0]
        members = [r['well'] for r in rows]
        group = {'id': gid, 'name': row['condition_group'], 'wells': members,
                 'auto_split': True, 'created_at': now, 'updated_at': now}
        origins = [record['sources'][i] for i in row['source_indices']]
        parents = [bindings.get((source['id'], source['well'])) for source in origins]
        if parents and parents[0] and all(parent == parents[0] for parent in parents):
            group['parent_group_id'] = parents[0][1]['id']
        if row.get('pool_id') and all(r['result'].get('pool_id') == row['pool_id']
                                      and not r['result'].get('components') for r in rows):
            group['origin_pool_id'] = row['pool_id']
        containers[row['id']].setdefault('well_groups', []).append(group)
    if record['mode'] == 'passage':
        return
    pooled_targets = set(named_positions)
    for pool in record.get('collection_groups', []):
        selected = [record['sources'][index] for index in pool['source_indices']]
        origins = [bindings.get((source['id'], source['well'])) for source in selected]
        inherited = origins[0] if origins and all(origin is not None and
            (origin[0], origin[1]['id']) == (origins[0][0], origins[0][1]['id'])
            for origin in origins) else None
        cells = list(dict.fromkeys(source['snapshot'].get('cell', '') for source in selected))
        name = ((cells[0] if len(cells) == 1 and cells[0] else '细胞') + ' 收集培养组')[:120]
        by_container = {}
        for target in pool['targets']:
            final = containers[target['id']]['wells'][target['well']]
            if (target['id'], target['well']) in named_positions:
                continue
            if final.get('components') or final.get('pool_id') != pool['id']:
                continue
            pooled_targets.add((target['id'], target['well']))
            by_container.setdefault(target['id'], []).append(target['well'])
        for cid, keys in by_container.items():
            attach(cid, keys, inherited, pool['id'], name)

    appended = {(target['id'], target['well']) for target in record['targets']
                if target.get('operation') == 'append'}
    paired = {}
    for target in record['targets']:
        if (target['id'], target['well']) in appended:
            continue
        if (target['id'], target['well']) in pooled_targets:
            continue
        indices = target.get('source_indices', [])
        if len(indices) != 1:
            continue
        source = record['sources'][indices[0]]
        inherited = bindings.get((source['id'], source['well']))
        if inherited:
            key = (target['id'], inherited[0], inherited[1]['id'])
            paired.setdefault(key, (inherited, []))[1].append(target['well'])
    for (cid, _, _), (inherited, keys) in paired.items():
        attach(cid, keys, inherited)
