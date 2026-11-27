"""Bottle/dish groups share one container identity but retain individual records."""
DISH_TYPES = ('培养皿', *(f'{size}mm培养皿' for size in (35, 60, 90, 100, 150)))
GROUP_TYPES = {'T25', 'T75', 'T175', *DISH_TYPES}

def is_dish(kind):
    return kind in DISH_TYPES

def normalize_quantity(kind,value=1):
    if isinstance(value,str) and value.isdigit():value=int(value)
    if type(value) is not int or not 1<=value<=100:
        raise ValueError('培养容器数量须为1–100的整数')
    if kind not in GROUP_TYPES and value!=1:
        raise ValueError('孔板按一块记录；多瓶/多皿数量仅适用于培养瓶和培养皿')
    return value

def group_keys(kind,quantity=1):
    quantity=normalize_quantity(kind,quantity)
    base='培养皿' if is_dish(kind) else '培养瓶'
    return [base]+[base+str(i) for i in range(2,quantity+1)]

def assay_kind(well):
    return (well.get('assay_contents') or {}).get('kind', '')

def well_contains_cells(well):
    if well.get('cell'):
        return True
    kind = assay_kind(well)
    if kind in ('target_medium', 'target_effector'):
        return True
    contents = well.get('assay_contents') or {}
    if kind == 'transwell':
        return bool(contents.get('upper_cell') or contents.get('lower_cell'))
    if kind == 'organoid':
        return bool(contents.get('organoid_name') or contents.get('effector_cell'))
    return False

ASSAY_ROLE_INDICES = {'靶':0, '靶细胞':0, 'target':0, 'target cell':0, 'target cells':0,
                      '效应':1, '效应细胞':1, 'effector':1, 'effector cell':1, 'effector cells':1}

def assay_role_index(part):
    return ASSAY_ROLE_INDICES.get(' '.join((part.get('role') or '').lower().split()))

def documented_assay_identities(well, target=None, effector=None):
    """Return the unique assignment allowed by the recorded names and component roles."""
    components = well.get('components') or []
    names = list(dict.fromkeys(part.get('cell') for part in components))
    role_indices = [assay_role_index(part) for part in components]
    if len(names) == 2 and all(names):
        possible = [(names[0], names[1]), (names[1], names[0])]
    elif len(names) == 1 and names[0] and set(role_indices) == {0, 1}:
        possible = [(names[0], names[0])]
    else:
        return None
    for part, role in zip(components, role_indices):
        if role is not None:
            possible = [pair for pair in possible if pair[role] == part['cell']]
    matches = [pair for pair in possible if (not target or target == pair[0])
               and (not effector or effector == pair[1])]
    return matches[0] if len(matches) == 1 else None

def can_transfer_cells(well):
    if not well.get('cell'):
        return False
    kind = assay_kind(well)
    if not kind:
        return True
    layout = well['assay_contents']
    if kind == 'target_medium':
        return well['cell'] == layout.get('target_cell') and not well.get('components')
    if kind == 'target_effector':
        target, effector = layout.get('target_cell'), layout.get('effector_cell')
        return bool(target and effector and documented_assay_identities(well, target, effector))
    return False

def member_active(well):
    return bool(well.get('cell')) and well.get('member_status','active')!='archived'

def group_quantity(container):
    return len(container['wells']) if container['type'] in GROUP_TYPES else 1

def resized_member_keys(container,kind,quantity):
    keys=list(container['wells'])[:quantity]
    for i in range(len(keys),quantity):
        base=group_keys(kind,quantity)[i];key=base;suffix=i+1
        while key in keys:suffix+=1;key=base+'-'+str(suffix)
        keys.append(key)
    return keys

def resize_members(container,kind,quantity,keys,empty_factory):
    if container['type'] in GROUP_TYPES and kind in GROUP_TYPES:
        old=list(container['wells'].items())
        lost=[key for key,w in old[len(keys):] if w.get('cell')]
        if lost:raise ValueError('这些瓶/皿仍有记录，不能直接减少数量：'+', '.join(lost)+'。可结束所选瓶/皿并保留历史。')
        # Member keys are identities used by experiment links. A type correction
        # changes presentation, never the identities of existing members.
        stable=resized_member_keys(container,kind,len(keys))
        return {key:old[i][1] if i<len(old) else empty_factory() for i,key in enumerate(stable)}
    lost=[key for key,w in container['wells'].items() if key not in keys and (w.get('cell') or assay_kind(w))]
    if lost:raise ValueError('新容器无法保留已填写培养单元：'+', '.join(lost))
    return {key:container['wells'].get(key,empty_factory()) for key in keys}


ASSAY_CONTENT_NAMES = {
    'target_medium': '靶细胞＋培养基',
    'target_effector': '靶细胞＋效应细胞',
    'medium': '仅培养基（无细胞）',
    'pbs': '仅 PBS（无细胞）',
    'transwell': 'Transwell 双室（上室＋下室）',
    'organoid': '类器官培养 / 共培养',
}

ASSAY_CELL_LABELS = {
    'target_cells_per_well': '靶细胞加入数',
    'effector_cells_per_well': '效应细胞加入数',
    'upper_cells_per_well': '上室细胞数',
    'lower_cells_per_well': '下室细胞数',
}
ASSAY_VOLUME_LABELS = {
    'final_volume_ul': '每孔终体积',
    'target_volume_ul': '靶细胞悬液',
    'effector_volume_ul': '效应细胞悬液',
    'upper_volume_ul': '上室体积',
    'lower_volume_ul': '下室体积',
    'dome_volume_ul': '基质胶液滴体积',
}


def assay_effector_sources(well):
    contents = well.get('assay_contents') or {}
    if contents.get('kind') != 'target_effector':
        return []
    if contents.get('effector_sources'):
        return contents['effector_sources']
    effector = contents.get('effector_cell')
    if not effector:
        return []
    sources = {}
    for part in well.get('components') or []:
        if part.get('cell') != effector or (effector == contents.get('target_cell') and assay_role_index(part) != 1):
            continue
        origin = part.get('origin') or {}
        for source in origin.get('sources') or [origin]:
            if source.get('id') and source.get('well'):
                key = (source['id'], source['well'])
                sources[key] = {'id':source['id'], 'well':source['well'], 'name':source.get('name') or source['id']}
    return list(sources.values())


def assay_contents_label(well):
    """Describe the recorded well composition without inventing a culture identity."""
    contents = well.get('assay_contents') or {}
    kind = ASSAY_CONTENT_NAMES.get(assay_kind(well))
    if not kind:
        return ''
    parts = [kind]
    for key, label in [('target_cell', '靶细胞'), ('effector_cell', '效应细胞'),
                       ('transwell_mode', '模式'), ('pore_size_um', '孔径'), ('matrigel_coating', '包被'),
                       ('upper_cell', '上室'), ('upper_medium', '上室培养基'),
                       ('lower_cell', '下室'), ('lower_medium', '下室条件'),
                       ('organoid_name', '类器官'), ('organoid_mode', '模式'), ('matrix_type', '基质胶'),
                       ('dome_count', '液滴数'), ('et_ratio', 'E:T 比'),
                       ('medium', '培养基'), ('group', '组名')]:
        if contents.get(key):
            suffix = ' μm' if key == 'pore_size_um' and 'μm' not in str(contents[key]) and 'um' not in str(contents[key]).lower() else ''
            parts.append(f'{label} {contents[key]}{suffix}')
        elif contents.get('kind') == 'target_effector' and key in ('target_cell', 'effector_cell'):
            parts.append(label + '待补')
    for field, label in ASSAY_VOLUME_LABELS.items():
        if contents.get(field):
            parts.append(f'{label} {contents[field]} µL')
    for field, label in ASSAY_CELL_LABELS.items():
        if contents.get(field):
            parts.append(f'{label} {contents[field]} 个/孔')
    if contents.get('kind') == 'target_effector':
        sources = assay_effector_sources(well)
        parts.append('效应细胞来源 ' + '、'.join(f"{s['name']} / {s['well']}" for s in sources)
                     if sources else '效应细胞来源待关联')
    if contents.get('effector_transfer_id'):
        parts.append('流转凭据 ' + contents['effector_transfer_id'])
    return ' · '.join(parts)
