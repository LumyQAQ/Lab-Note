"""Correct well positions without creating a new biological culture lineage."""
from copy import deepcopy
import uuid

from store import LAYOUTS, coordinates, current_time, empty_well


def apply_relocation(state, payload):
    """Validate a translated selection, update state, and return detached audit data."""
    if not isinstance(payload, dict) or payload.get('mode') not in ('copy', 'move'):
        raise ValueError('请选择复制或移动孔位信息')
    mode = payload['mode']
    source_id, target_id = payload.get('source_id'), payload.get('target_id')
    if not isinstance(source_id, str) or not isinstance(target_id, str):
        raise ValueError('请选择来源和目标孔板')
    containers = {c['id']: c for c in state['containers']}
    source, target = containers.get(source_id), containers.get(target_id)
    for container in (source, target):
        if not container or container['status'] != 'active' or container['type'] not in LAYOUTS:
            raise ValueError('来源和目标须为在培养的孔板')

    keys = payload.get('wells')
    source_positions = {key: (ord(key[0]) - 65, int(key[1:]) - 1)
                        for key in coordinates(source['type'])}
    target_keys = set(coordinates(target['type']))
    if (not isinstance(keys, list) or not keys
            or any(not isinstance(key, str) or key not in source_positions
                   or key not in source['wells'] for key in keys)
            or len(keys) != len(set(keys))):
        raise ValueError('请选择有效且不重复的来源孔位')
    anchor, target_anchor = payload.get('anchor'), payload.get('target_anchor')
    if not isinstance(anchor, str) or anchor not in keys:
        raise ValueError('拖动起点须为选中的来源孔位')
    if not isinstance(target_anchor, str) or target_anchor not in target_keys:
        raise ValueError('请选择有效目标孔位')
    if source_id == target_id and anchor == target_anchor:
        raise ValueError('目标位置与原位置相同')
    source_row, source_col = source_positions[anchor]
    row_delta = ord(target_anchor[0]) - 65 - source_row
    col_delta = int(target_anchor[1:]) - 1 - source_col
    rows, cols = LAYOUTS[target['type']]
    occupied_sources = {key for key in keys if source['wells'][key]['cell']}
    if not occupied_sources:
        raise ValueError('所选孔位中没有可复制或移动的记录')

    # Validate the entire shape before building or applying any writes.
    destinations = []
    for key in keys:
        row, col = source_positions[key]
        row, col = row + row_delta, col + col_delta
        if not (0 <= row < rows and 0 <= col < cols):
            raise ValueError('所选孔位整体超出目标孔板边界')
        destination = f'{chr(65 + row)}{col + 1}'
        if destination not in target['wells']:
            raise ValueError('目标孔位不存在')
        if key not in occupied_sources:
            continue
        if target['wells'][destination]['cell'] and not (
                mode == 'move' and source_id == target_id and destination in occupied_sources):
            raise ValueError(f'{target["name"]} {destination} 已有记录，请选择空孔位')
        destinations.append((key, destination))

    now = current_time()
    record = {'id': 'POS-' + uuid.uuid4().hex[:16].upper(), 'mode': mode,
              'at': now.strftime('%Y-%m-%dT%H:%M'), 'recorded_at': now.isoformat(),
              'experiment': '', 'notes': '孔位信息复制' if mode == 'copy' else '孔位信息移动',
              'sources': [], 'targets': [], 'ended_sources': []}
    writes = []
    for index, (key, destination) in enumerate(destinations):
        original = deepcopy(source['wells'][key])
        result = deepcopy(original)
        result['placement_id'] = record['id']
        record['sources'].append({'id': source_id, 'name': source['name'], 'well': key,
                                  'role': '', 'amount': '', 'snapshot': original})
        record['targets'].append({'id': target_id, 'name': target['name'], 'well': destination,
                                  'source_indices': [index], 'previous': None,
                                  'result': deepcopy(result)})
        writes.append((destination, result))

    if mode == 'move':
        for key in occupied_sources:
            source['wells'][key] = empty_well()
        source['checked_date'] = ''
    for destination, result in writes:
        target['wells'][destination] = result
    target['checked_date'] = ''
    return record
