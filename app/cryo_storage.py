"""Customizable cryo-storage topology, slot mapping, correlation and contamination risk."""
from copy import deepcopy
from datetime import datetime
import re
import uuid

from medium import merge_medium, number, text
from platform_config import TZ

DEVICE_KINDS = ('ln2', 'minus80', 'custom')
NUMBERING_MODES = ('alpha', 'numeric')
STORAGE_STAGES = ('gradient', 'stored', 'unassigned')
CONTAMINATION_PROPAGATION_DAYS = 30


def ensure_cryo_storage(state):
    storage = state.setdefault('cryo_storage', {})
    storage.setdefault('devices', [])
    storage.setdefault('racks', [])
    storage.setdefault('boxes', [])
    storage.setdefault('templates', [])
    return storage


def box_slot_keys(rows, cols, numbering='alpha'):
    if type(rows) is not int or type(cols) is not int or not (1 <= rows <= 12 and 1 <= cols <= 12):
        raise ValueError('冻存盒行数与列数须为 1–12 的整数')
    if numbering not in NUMBERING_MODES:
        raise ValueError('冻存盒编号方式须为行列坐标（alpha）或顺序编号（numeric）')
    if numbering == 'numeric':
        return [str(i + 1) for i in range(rows * cols)]
    return [f'{chr(65 + r)}{c + 1}' for r in range(rows) for c in range(cols)]


def normalize_tags(value, label, limit):
    if value is None or value == '':
        return []
    if isinstance(value, str):
        raw = [part.strip() for part in re.split(r'[,，、;；\n]', value) if part.strip()]
    elif isinstance(value, list):
        if any(not isinstance(item, str) for item in value):
            raise ValueError(f'{label}须为文本列表')
        raw = [item.strip() for item in value if item.strip()]
    else:
        raise ValueError(f'{label}格式无效')
    result, seen = [], set()
    for item in raw:
        if len(item) > limit:
            raise ValueError(f'单项{label}不能超过 {limit} 字')
        key = item.casefold()
        if key not in seen:
            seen.add(key)
            result.append(item)
    if len(result) > 20:
        raise ValueError(f'单个批次最多记录 20 项{label}')
    return result


def normalize_per_vial_count(value):
    if value is None or value == '' or value == {}:
        return None
    if not isinstance(value, dict):
        raise ValueError('每管细胞数（科学计数法）格式无效')
    allowed = {'coefficient', 'exponent', 'unit'}
    if set(value) - allowed:
        raise ValueError('每管细胞数字段无效')
    coeff_raw = str(value.get('coefficient', '')).strip()
    exp_raw = str(value.get('exponent', '')).strip()
    unit_raw = str(value.get('unit', '')).strip()
    if not coeff_raw and not exp_raw:
        return None
    coefficient = number(coeff_raw, '每管细胞数系数')
    exponent = text(exp_raw, '10 的指数', 12)
    unit = text(unit_raw or 'cells', '细胞数单位', 100)
    if not coefficient or not re.fullmatch(r'[+-]?\d+', exponent) or not unit:
        raise ValueError('请完整填写科学计数法的系数与整数指数（例如 5 × 10^6）')
    return {'coefficient': coefficient, 'exponent': str(int(exponent)), 'unit': unit}


def format_per_vial_count(value):
    if not isinstance(value, dict) or not value.get('coefficient'):
        return ''
    return f'{value["coefficient"]} × 10^{value["exponent"]} {value.get("unit") or "cells"}'


def normalize_optional_fields(payload, *, existing=None):
    base = existing or {}
    cell_kind = text(payload['cell_kind'], '细胞类型', 80) if 'cell_kind' in payload else (base.get('cell_kind') or '')
    resistance_tags = (normalize_tags(payload['resistance_tags'], '抗性标签', 60)
                       if 'resistance_tags' in payload else list(base.get('resistance_tags') or []))
    special_treatments = (normalize_tags(payload['special_treatments'], '特殊处理标签', 80)
                          if 'special_treatments' in payload
                          else list(base.get('special_treatments') or []))
    subclone = text(payload['subclone'], '亚克隆 / 克隆号', 60) if 'subclone' in payload else (base.get('subclone') or '')
    passage = text(payload['passage'], '细胞代次', 60) if 'passage' in payload else (base.get('passage') or '')
    donor = text(payload['donor'], '细胞供者来源', 200) if 'donor' in payload else (base.get('donor') or '')
    suggested_vessel = (text(payload['suggested_vessel'], '复苏容器备注', 120)
                        if 'suggested_vessel' in payload else (base.get('suggested_vessel') or ''))
    if 'per_vial_count' in payload:
        per_vial_count = normalize_per_vial_count(payload['per_vial_count'])
    else:
        per_vial_count = base.get('per_vial_count')
    day0 = text(payload['day0'], '原始激活日期', 10) if 'day0' in payload else (base.get('day0') or '')
    if day0:
        try:
            datetime.strptime(day0, '%Y-%m-%d')
        except ValueError:
            raise ValueError('请填写有效的原始激活日期') from None
    return {
        'cell_kind': cell_kind,
        'resistance_tags': resistance_tags,
        'special_treatments': special_treatments,
        'passage': passage,
        'subclone': subclone,
        'donor': donor,
        'suggested_vessel': suggested_vessel,
        'per_vial_count': per_vial_count,
        'day0': day0,
    }


def _find_device(storage, device_id):
    return next((d for d in storage['devices'] if d['id'] == device_id), None)


def _find_rack(storage, rack_id):
    return next((r for r in storage['racks'] if r['id'] == rack_id), None)


def _find_box(storage, box_id):
    return next((b for b in storage['boxes'] if b['id'] == box_id), None)


def box_location_label(storage, box):
    dev = _find_device(storage, box.get('device_id'))
    rack = _find_rack(storage, box.get('rack_id')) if box.get('rack_id') else None
    parts = [dev['name'] if dev else '未知设备']
    if rack:
        parts.append(rack['name'])
    parts.append(box['name'])
    return ' / '.join(parts)


def slot_snapshot(storage, box, slot_key, entry):
    dev = _find_device(storage, box.get('device_id'))
    rack = _find_rack(storage, box.get('rack_id')) if box.get('rack_id') else None
    return {
        'box_id': box['id'],
        'box_name': box['name'],
        'device_id': box.get('device_id', ''),
        'device_name': dev['name'] if dev else '',
        'rack_id': box.get('rack_id', ''),
        'rack_name': rack['name'] if rack else '',
        'layer': box.get('layer'),
        'slot': slot_key,
        'vial_label': entry.get('vial_label', ''),
    }


def batch_withdrawals(state, lot_id):
    return [w for w in state.get('frozen_withdrawals', []) if w.get('lot_id') == lot_id]


def batch_remaining(state, lot):
    return lot['vials'] - sum(w['vials'] for w in batch_withdrawals(state, lot['id']))


def batch_placed_slots(state, lot_id):
    storage = ensure_cryo_storage(state)
    hits = []
    for box in storage['boxes']:
        order = {k: idx for idx, k in enumerate(box_slot_keys(box['rows'], box['cols'], box.get('numbering', 'alpha')))}
        for slot_key in sorted(box.get('slots', {}), key=lambda k: order.get(k, 10**6)):
            entry = box['slots'][slot_key]
            if entry.get('batch_id') == lot_id:
                hits.append((box, slot_key, entry))
    return hits


def batch_unplaced(state, lot):
    return batch_remaining(state, lot) - len(batch_placed_slots(state, lot['id']))


def refresh_batch_location(state, lot):
    storage = ensure_cryo_storage(state)
    placed = batch_placed_slots(state, lot['id'])
    unplaced = batch_remaining(state, lot) - len(placed)
    if unplaced <= 0:
        lot['storage_stage'] = 'stored'
    by_box = {}
    for box, slot_key, _ in placed:
        by_box.setdefault(box['id'], (box, []))[1].append(slot_key)
    parts = [f'{box_location_label(storage, box)} · {"、".join(keys)}' for box, keys in by_box.values()]
    stage = lot.get('storage_stage', 'unassigned')
    if unplaced > 0 and stage == 'gradient':
        parts.append(f'暂存盒（{unplaced} 管）')
    elif unplaced > 0 and lot.get('manual_location'):
        parts.append(lot['manual_location'])
    elif not parts and lot.get('manual_location'):
        parts.append(lot['manual_location'])
    if parts:
        lot['location'] = '；'.join(parts)[:500]
    else:
        lot['location'] = ''


def refresh_affected_batches(state, batch_ids):
    by_id = {b['id']: b for b in state.get('frozen_batches', [])}
    for bid in batch_ids:
        if bid in by_id:
            refresh_batch_location(state, by_id[bid])


def validate_placements(state, placements, max_count, *, exact=False, occupied_overlay=None):
    storage = ensure_cryo_storage(state)
    if not isinstance(placements, list):
        raise ValueError('目标格位列表格式无效')
    if exact and len(placements) != max_count:
        raise ValueError(f'请恰好选择 {max_count} 个空格位')
    if not exact and not (1 <= len(placements) <= max_count):
        raise ValueError(f'本次可落位 1–{max_count} 个格位')
    overlay = occupied_overlay if occupied_overlay is not None else set()
    normalized = []
    for item in placements:
        if not isinstance(item, dict):
            raise ValueError('格位条目格式无效')
        box_id = text(item.get('box_id', ''), '冻存盒编号', 120)
        slot_key = text(item.get('slot', ''), '格位坐标', 20)
        vial_label = text(item.get('vial_label', ''), '单管编号', 120)
        box = _find_box(storage, box_id)
        if not box:
            raise ValueError('所选冻存盒不存在')
        valid = set(box_slot_keys(box['rows'], box['cols'], box.get('numbering', 'alpha')))
        if slot_key not in valid:
            raise ValueError(f'冻存盒“{box["name"]}”不存在格位 {slot_key}')
        if slot_key in box.get('slots', {}) or (box_id, slot_key) in overlay:
            raise ValueError(f'冻存盒“{box["name"]}”格位 {slot_key} 已被占用')
        overlay.add((box_id, slot_key))
        normalized.append({'box': box, 'box_id': box_id, 'slot': slot_key, 'vial_label': vial_label})
    return normalized


def _split_labels_for_slots(labels_text, count):
    if not labels_text:
        return [''] * count
    parts = [k.strip() for k in re.split(r'[,，、;；\n]', labels_text) if k.strip()]
    if len(parts) == count and len({p.casefold() for p in parts}) == count:
        return parts
    return [''] * count


def _norm_cell(lot):
    return (lot.get('name') or '').strip().casefold()


def _norm_treatments(lot):
    return tuple(sorted({tag.strip().casefold() for tag in lot.get('special_treatments') or [] if tag.strip()}))


def _same_donor_compatible(a, b):
    da = (a.get('donor') or '').strip().casefold()
    db = (b.get('donor') or '').strip().casefold()
    return not da or not db or da == db


def relation_tier(anchor, other):
    if not _norm_cell(anchor) or _norm_cell(anchor) != _norm_cell(other):
        return None
    if not _same_donor_compatible(anchor, other):
        return None
    same_tx = _norm_treatments(anchor) == _norm_treatments(other)
    sa = (anchor.get('subclone') or '').strip().casefold()
    sb = (other.get('subclone') or '').strip().casefold()
    same_clone = (sa == sb)
    if same_tx and same_clone and (anchor.get('at') or '')[:10] == (other.get('at') or '')[:10]:
        return 'strong'
    if same_tx and same_clone:
        return 'weak'
    return 'weaker'


def _parse_passage_num(lot):
    m = re.fullmatch(r'[Pp]?\s*(\d+)', (lot.get('passage') or '').strip())
    return int(m.group(1)) if m else None


def _resistance_compatible(src, other):
    ra = {t.strip().casefold() for t in (src.get('resistance_tags') or []) if t and t.strip()}
    rb = {t.strip().casefold() for t in (other.get('resistance_tags') or []) if t and t.strip()}
    return not ra or not rb or bool(ra & rb)


def _within_contamination_window(src_at, other_at):
    if not src_at or not other_at or other_at <= src_at:
        return False
    try:
        d1 = datetime.fromisoformat(src_at[:10])
        d2 = datetime.fromisoformat(other_at[:10])
    except ValueError:
        return False
    delta = (d2 - d1).days
    return 0 <= delta <= CONTAMINATION_PROPAGATION_DAYS


def contamination_risk_map(state):
    batches = state.get('frozen_batches', [])
    by_id = {b['id']: b for b in batches}
    events = [
        w for w in state.get('frozen_withdrawals', [])
        if isinstance(w.get('contamination'), dict) and not w['contamination'].get('cleared_by_clean_thaw')
    ]
    result = {b['id']: {'level': 'none', 'hits': 0, 'events': []} for b in batches}
    for w in events:
        src = by_id.get(w.get('lot_id'))
        if not src:
            continue
        src_cell = _norm_cell(src)
        src_at = src.get('at') or ''
        src_p = _parse_passage_num(src)
        for b in batches:
            is_strong = (b['id'] == src['id']) or (relation_tier(src, b) == 'strong')
            b_p = _parse_passage_num(b)
            passage_ok = (src_p is None or b_p is None or b_p >= src_p)
            is_later_same = (
                bool(src_cell)
                and _norm_cell(b) == src_cell
                and _same_donor_compatible(src, b)
                and _resistance_compatible(src, b)
                and passage_ok
                and _within_contamination_window(src_at, b.get('at') or '')
            )
            if not (is_strong or is_later_same):
                continue
            reason = '同批次/强相关复苏污染' if is_strong else f'冻存后 {CONTAMINATION_PROPAGATION_DAYS} 天内同类型细胞风险'
            info = result[b['id']]
            info['hits'] += 1
            info['events'].append({
                'withdrawal_id': w['id'],
                'source_lot_id': src['id'],
                'source_name': src['name'],
                'source_at': src_at,
                'contamination': w['contamination'],
                'reason': reason,
            })
    for info in result.values():
        if info['hits'] >= 2:
            info['level'] = 'red'
        elif info['hits'] == 1:
            info['level'] = 'yellow'
    return result


# --- Commands ---

def apply_cryo_setup_preset(state, payload, now):
    storage = ensure_cryo_storage(state)
    name = text(payload.get('device_name', ''), '设备名称', 120)
    kind = payload.get('device_kind', 'custom')
    if not name or kind not in DEVICE_KINDS:
        raise ValueError('请填写设备名称并选择有效设备类型')
    location = text(payload.get('device_location', ''), '存放位置', 300)
    notes = text(payload.get('notes', ''), '备注', 1000)
    rows = payload.get('rows')
    cols = payload.get('cols')
    numbering = payload.get('numbering', 'alpha')
    box_slot_keys(rows, cols, numbering)
    box_count = payload.get('box_count', 1)
    if type(box_count) is not int or not 1 <= box_count <= 50:
        raise ValueError('单次创建冻存盒数量须为 1–50 的整数')
    use_rack = bool(payload.get('use_rack', False))
    rack_name = text(payload.get('rack_name', ''), '吊 / 架名称', 120) if use_rack else ''
    if use_rack and not rack_name:
        raise ValueError('请填写吊 / 架名称')
    box_prefix = text(payload.get('box_prefix', ''), '盒名前缀', 80) or ('第' if use_rack else '冻存盒')
    box_suffix = text(payload.get('box_suffix', ''), '盒名后缀', 40) if 'box_suffix' in payload else ('层' if use_rack else '')

    device = {
        'id': 'CRYOD-' + uuid.uuid4().hex[:10].upper(),
        'name': name,
        'kind': kind,
        'location': location,
        'notes': notes,
        'created_at': now,
    }
    storage['devices'].append(device)
    rack = None
    if use_rack:
        rack = {
            'id': 'CRYOR-' + uuid.uuid4().hex[:10].upper(),
            'device_id': device['id'],
            'name': rack_name,
            'layers': box_count,
            'notes': '',
            'created_at': now,
        }
        storage['racks'].append(rack)
    created_boxes = []
    for idx in range(1, box_count + 1):
        bname = f'{box_prefix} {idx} {box_suffix}'.strip() if box_suffix else f'{box_prefix} {idx}'
        box = {
            'id': 'CRYOB-' + uuid.uuid4().hex[:10].upper(),
            'device_id': device['id'],
            'rack_id': rack['id'] if rack else '',
            'layer': idx if use_rack else None,
            'name': bname[:120],
            'rows': rows,
            'cols': cols,
            'numbering': numbering,
            'slots': {},
            'notes': '',
            'created_at': now,
        }
        storage['boxes'].append(box)
        created_boxes.append(box['id'])
    return {
        'device_id': device['id'],
        'device_name': device['name'],
        'rack_id': rack['id'] if rack else '',
        'rack_name': rack['name'] if rack else '',
        'box_ids': created_boxes,
        'box_count': box_count,
        'grid': f'{rows}×{cols}',
    }


def apply_cryo_device_save(state, payload, now):
    storage = ensure_cryo_storage(state)
    name = text(payload.get('name', ''), '设备名称', 120)
    kind = payload.get('kind', 'custom')
    if not name or kind not in DEVICE_KINDS:
        raise ValueError('请填写设备名称并选择有效设备类型')
    location = text(payload.get('location', ''), '存放位置', 300)
    notes = text(payload.get('notes', ''), '备注', 1000)
    did = payload.get('id')
    if did:
        dev = _find_device(storage, did)
        if not dev:
            raise ValueError('找不到该冻存设备')
        dev.update(name=name, kind=kind, location=location, notes=notes)
        affected = {entry['batch_id'] for b in storage['boxes'] if b['device_id'] == did for entry in b.get('slots', {}).values()}
        refresh_affected_batches(state, affected)
        return {'device_id': did, 'name': name, 'change': 'update'}
    dev = {
        'id': 'CRYOD-' + uuid.uuid4().hex[:10].upper(),
        'name': name, 'kind': kind, 'location': location, 'notes': notes, 'created_at': now,
    }
    storage['devices'].append(dev)
    return {'device_id': dev['id'], 'name': name, 'change': 'create'}


def apply_cryo_device_delete(state, payload, now):
    storage = ensure_cryo_storage(state)
    did = text(payload.get('id', ''), '设备编号', 120)
    dev = _find_device(storage, did)
    if not dev:
        raise ValueError('找不到该冻存设备')
    boxes = [b for b in storage['boxes'] if b['device_id'] == did]
    occupied = sum(len(b.get('slots', {})) for b in boxes)
    if occupied:
        raise ValueError(f'设备“{dev["name"]}”下仍有 {occupied} 管冻存细胞，请先移走或取出后再删除')
    racks = [r for r in storage['racks'] if r['device_id'] == did]
    storage['boxes'] = [b for b in storage['boxes'] if b['device_id'] != did]
    storage['racks'] = [r for r in storage['racks'] if r['device_id'] != did]
    storage['devices'].remove(dev)
    return {'device_id': did, 'name': dev['name'], 'deleted_racks': len(racks), 'deleted_boxes': len(boxes)}


def apply_cryo_rack_save(state, payload, now):
    storage = ensure_cryo_storage(state)
    did = text(payload.get('device_id', ''), '所属设备', 120)
    dev = _find_device(storage, did)
    if not dev:
        raise ValueError('请选择有效的冻存设备')
    name = text(payload.get('name', ''), '吊 / 架名称', 120)
    if not name:
        raise ValueError('请填写吊 / 架名称')
    notes = text(payload.get('notes', ''), '备注', 1000)
    layers = payload.get('layers')
    if layers is not None and (type(layers) is not int or not 1 <= layers <= 50):
        raise ValueError('层数须为 1–50 的整数')
    rid = payload.get('id')
    if rid:
        rack = _find_rack(storage, rid)
        if not rack or rack['device_id'] != did:
            raise ValueError('找不到该吊 / 架')
        rack.update(name=name, layers=layers, notes=notes)
        affected = {entry['batch_id'] for b in storage['boxes'] if b.get('rack_id') == rid for entry in b.get('slots', {}).values()}
        refresh_affected_batches(state, affected)
        return {'rack_id': rid, 'device_id': did, 'name': name, 'change': 'update', 'box_ids': []}
    rack = {
        'id': 'CRYOR-' + uuid.uuid4().hex[:10].upper(),
        'device_id': did, 'name': name, 'layers': layers, 'notes': notes, 'created_at': now,
    }
    storage['racks'].append(rack)
    created_boxes = []
    if payload.get('create_boxes'):
        count = layers or payload.get('box_count')
        if type(count) is not int or not 1 <= count <= 50:
            raise ValueError('批量建盒层数须为 1–50 的整数')
        rows = payload.get('rows', 5)
        cols = payload.get('cols', 5)
        numbering = payload.get('numbering', 'alpha')
        box_slot_keys(rows, cols, numbering)
        prefix = text(payload.get('box_prefix', ''), '盒名前缀', 80) or '第'
        suffix = text(payload.get('box_suffix', ''), '盒名后缀', 40) if 'box_suffix' in payload else '层'
        for idx in range(1, count + 1):
            bname = f'{prefix} {idx} {suffix}'.strip() if suffix else f'{prefix} {idx}'
            box = {
                'id': 'CRYOB-' + uuid.uuid4().hex[:10].upper(),
                'device_id': did, 'rack_id': rack['id'], 'layer': idx, 'name': bname[:120],
                'rows': rows, 'cols': cols, 'numbering': numbering, 'slots': {}, 'notes': '', 'created_at': now,
            }
            storage['boxes'].append(box)
            created_boxes.append(box['id'])
    return {'rack_id': rack['id'], 'device_id': did, 'name': name, 'change': 'create', 'box_ids': created_boxes}


def apply_cryo_rack_delete(state, payload, now):
    storage = ensure_cryo_storage(state)
    rid = text(payload.get('id', ''), '吊 / 架编号', 120)
    rack = _find_rack(storage, rid)
    if not rack:
        raise ValueError('找不到该吊 / 架')
    boxes = [b for b in storage['boxes'] if b.get('rack_id') == rid]
    occupied = sum(len(b.get('slots', {})) for b in boxes)
    if occupied:
        raise ValueError(f'“{rack["name"]}”下仍有 {occupied} 管冻存细胞，请先移走或取出后再删除')
    storage['boxes'] = [b for b in storage['boxes'] if b.get('rack_id') != rid]
    storage['racks'].remove(rack)
    return {'rack_id': rid, 'name': rack['name'], 'deleted_boxes': len(boxes)}


def apply_cryo_box_save(state, payload, now):
    storage = ensure_cryo_storage(state)
    did = text(payload.get('device_id', ''), '所属设备', 120)
    dev = _find_device(storage, did)
    if not dev:
        raise ValueError('请选择有效的冻存设备')
    rid = text(payload.get('rack_id', ''), '所属吊 / 架', 120)
    if rid:
        rack = _find_rack(storage, rid)
        if not rack or rack['device_id'] != did:
            raise ValueError('所选吊 / 架不属于该设备')
    name = text(payload.get('name', ''), '冻存盒名称', 120)
    if not name:
        raise ValueError('请填写冻存盒名称')
    layer = payload.get('layer')
    if layer is not None and layer != '':
        if type(layer) is not int or not 1 <= layer <= 50:
            raise ValueError('层号须为 1–50 的整数')
    else:
        layer = None
    rows = payload.get('rows')
    cols = payload.get('cols')
    numbering = payload.get('numbering', 'alpha')
    box_slot_keys(rows, cols, numbering)
    notes = text(payload.get('notes', ''), '备注', 1000)
    bid = payload.get('id')
    if bid:
        box = _find_box(storage, bid)
        if not box:
            raise ValueError('找不到该冻存盒')
        if box.get('slots') and (rows != box['rows'] or cols != box['cols'] or numbering != box.get('numbering', 'alpha')):
            raise ValueError('该冻存盒已有冻存管占用，不能修改行列尺寸或编号方式')
        box.update(device_id=did, rack_id=rid, layer=layer, name=name, rows=rows, cols=cols, numbering=numbering, notes=notes)
        affected = {entry['batch_id'] for entry in box.get('slots', {}).values()}
        refresh_affected_batches(state, affected)
        return {'box_id': bid, 'name': name, 'change': 'update'}
    box = {
        'id': 'CRYOB-' + uuid.uuid4().hex[:10].upper(),
        'device_id': did, 'rack_id': rid, 'layer': layer, 'name': name,
        'rows': rows, 'cols': cols, 'numbering': numbering, 'slots': {}, 'notes': notes, 'created_at': now,
    }
    storage['boxes'].append(box)
    return {'box_id': box['id'], 'name': name, 'change': 'create'}


def apply_cryo_box_delete(state, payload, now):
    storage = ensure_cryo_storage(state)
    bid = text(payload.get('id', ''), '冻存盒编号', 120)
    box = _find_box(storage, bid)
    if not box:
        raise ValueError('找不到该冻存盒')
    if box.get('slots'):
        raise ValueError(f'冻存盒“{box["name"]}”仍有 {len(box["slots"])} 管冻存细胞，请先移走或取出后再删除')
    storage['boxes'].remove(box)
    return {'box_id': bid, 'name': box['name']}


def _stock_source(state, source):
    if source is None:
        return []
    if not isinstance(source, dict):
        raise ValueError('培养来源格式无效')
    source_id = text(source.get('id', ''), '来源容器', 120)
    key = text(source.get('well', ''), '来源单元', 120)
    container = next((item for item in state['containers'] if item['id'] == source_id), None)
    well = (container or {}).get('wells', {}).get(key)
    if not well or not well.get('cell'):
        raise ValueError('请选择已有培养记录的来源容器与单元')
    snapshot = {field: well.get(field, '') for field in ('cell', 'kind', 'day0', 'batch')}
    if well.get('medium'):
        snapshot['medium'] = deepcopy(well['medium'])
    return [{'id': source_id, 'well': key, 'name': container['name'], 'snapshot': snapshot}]


def apply_cryo_stock_create(state, payload, now):
    """Register inventory, optionally linked to an explicitly selected culture unit."""
    ensure_cryo_storage(state)
    name = text(payload.get('name', ''), '细胞名称', 200)
    at = text(payload.get('at', ''), '冻存时间', 40)
    if len(at) == 10 and re.fullmatch(r'\d{4}-\d{2}-\d{2}', at):
        at = at + 'T00:00'
    try:
        stamp = datetime.fromisoformat(at)
    except ValueError:
        raise ValueError('请填写有效的冻存时间') from None
    now_dt = datetime.fromisoformat(now)
    if len(at) < 16 or at[10] != 'T' or stamp.tzinfo is not None or stamp.replace(tzinfo=TZ) > now_dt:
        raise ValueError('冻存时间须为已发生的北京时间')
    vials = payload.get('vials')
    if not name or type(vials) is not int or not 1 <= vials <= 1000:
        raise ValueError('请填写细胞名称及有效的正整数管数（1–1000）')
    stage = payload.get('storage_stage', 'stored')
    if stage not in STORAGE_STAGES:
        raise ValueError('存放状态无效')
    placements_raw = payload.get('placements') or []
    parsed_placements = []
    if placements_raw:
        parsed_placements = validate_placements(state, placements_raw, vials, exact=False)
        if len(parsed_placements) == vials:
            stage = 'stored'
    elif stage == 'stored':
        raise ValueError('直接入盒存放时请选择目标冻存盒格位，或切换为暂存盒 / 未定位')
    meta = normalize_optional_fields(payload)
    labels = text(payload.get('labels', ''), '冻存管编号', 1000)
    manual_location = text(payload.get('location', ''), '存放位置', 500)
    per_vial_text = format_per_vial_count(meta['per_vial_count']) or text(payload.get('per_vial', ''), '每管细胞数', 120)
    notes = text(payload.get('notes', ''), '冻存备注', 5000)
    source_lot_id = text(payload.get('source_lot_id', ''), '来源冻存批次', 120)
    if source_lot_id:
        if payload.get('source') is not None:
            raise ValueError('请选择一种培养来源')
        original = next((b for b in state.get('frozen_batches', []) if b['id'] == source_lot_id), None)
        if original is None:
            raise ValueError('来源冻存批次不存在')
        sources = deepcopy(original.get('sources') or [])
        refs = deepcopy(original.get('experiment_refs') or [])
    else:
        sources = _stock_source(state, payload.get('source'))
        refs = []
    sequence = payload.get('subclone_sequence')
    if sequence is not None:
        if not isinstance(sequence, dict):
            raise ValueError('批量亚克隆序号配置格式无效')
        if len(parsed_placements) < 2 or len(parsed_placements) != vials:
            raise ValueError('按格位分别生成独立亚克隆时，需至少选中 2 个空位且选中格数等于总管数')
        prefix = text(sequence.get('prefix', '#'), '亚克隆前缀', 40)
        first = sequence.get('start', 1)
        if type(first) is not int or not 0 <= first <= 99999:
            raise ValueError('亚克隆起始序号须为 0–99999 的整数')
    common = {
        'name': name,
        'at': at,
        'vials': vials,
        'sources': sources,
        'experiment_refs': refs,
        'recorded_at': now,
        'labels': labels,
        'location': manual_location,
        'manual_location': manual_location,
        'per_vial': per_vial_text,
        'notes': notes,
        'storage_stage': stage,
        **({'gradient_entered_at': at} if stage == 'gradient' else {}),
        **meta,
    }
    auto_labels = _split_labels_for_slots(labels, len(parsed_placements))
    placements = [(item, item['vial_label'] or label) for item, label in zip(parsed_placements, auto_labels)]
    groups = [[placed] for placed in placements] if sequence is not None else [placements]
    created = []
    for index, group in enumerate(groups):
        lot = {**deepcopy(common), 'id': 'FRZ-' + uuid.uuid4().hex[:16].upper()}
        if sequence is not None:
            lot.update(vials=1, subclone=f'{prefix}{first + index}', labels=group[0][1])
        state.setdefault('frozen_batches', []).append(lot)
        for item, label in group:
            item['box'].setdefault('slots', {})[item['slot']] = {
                'batch_id': lot['id'], 'vial_label': label, 'placed_at': now[:16],
            }
        refresh_batch_location(state, lot)
        created.append(lot)
    result = {
        'lot_id': created[0]['id'],
        'name': name,
        'vials': vials,
        'placed': len(placements),
        'at': at,
        'storage_stage': created[0]['storage_stage'],
        'location': '；'.join(lot['location'] for lot in created if lot['location'])[:500],
    }
    if sequence is not None:
        result.update(lot_ids=[lot['id'] for lot in created], subclones=[lot['subclone'] for lot in created])
    return result


def apply_cryo_place_vials(state, payload, now):
    lot_id = text(payload.get('lot_id', ''), '冻存批次编号', 120)
    lot = next((b for b in state.get('frozen_batches', []) if b['id'] == lot_id), None)
    if not lot:
        raise ValueError('冻存批次不存在')
    unplaced = batch_unplaced(state, lot)
    if unplaced <= 0:
        raise ValueError('该批次已没有待落位的冻存管')
    if 'manual_location' not in lot and lot.get('location') and not batch_placed_slots(state, lot_id):
        lot['manual_location'] = lot['location']
    parsed = validate_placements(state, payload.get('placements'), unplaced, exact=False)
    auto_labels = _split_labels_for_slots(lot.get('labels', ''), len(parsed)) if not batch_placed_slots(state, lot_id) else [''] * len(parsed)
    for item, auto_label in zip(parsed, auto_labels):
        item['box'].setdefault('slots', {})[item['slot']] = {
            'batch_id': lot['id'],
            'vial_label': item['vial_label'] or auto_label,
            'placed_at': now[:16],
        }
    refresh_batch_location(state, lot)
    return {
        'lot_id': lot['id'],
        'name': lot['name'],
        'placed': len(parsed),
        'remaining_unplaced': batch_unplaced(state, lot),
        'storage_stage': lot.get('storage_stage', 'unassigned'),
        'location': lot['location'],
    }


def apply_cryo_move_slots(state, payload, now):
    storage = ensure_cryo_storage(state)
    moves = payload.get('moves')
    if not isinstance(moves, list) or not 1 <= len(moves) <= 200:
        raise ValueError('请选择 1–200 个待移动格位')
    from_seen, to_seen = set(), set()
    staged = []
    for m in moves:
        if not isinstance(m, dict):
            raise ValueError('移位参数格式无效')
        fb = _find_box(storage, text(m.get('from_box_id', ''), '原冻存盒', 120))
        tb = _find_box(storage, text(m.get('to_box_id', ''), '目标冻存盒', 120))
        fs = text(m.get('from_slot', ''), '原格位', 20)
        ts = text(m.get('to_slot', ''), '目标格位', 20)
        if not fb or not tb:
            raise ValueError('原冻存盒或目标冻存盒不存在')
        if fs not in fb.get('slots', {}):
            raise ValueError(f'原格位 {fb["name"]} / {fs} 没有冻存管')
        if ts not in set(box_slot_keys(tb['rows'], tb['cols'], tb.get('numbering', 'alpha'))):
            raise ValueError(f'目标格位 {tb["name"]} / {ts} 无效')
        if (fb['id'], fs) in from_seen or (tb['id'], ts) in to_seen:
            raise ValueError('移动列表中存在重复的原格位或目标格位')
        from_seen.add((fb['id'], fs))
        to_seen.add((tb['id'], ts))
        staged.append((fb, fs, tb, ts))
    for _, _, tb, ts in staged:
        if ts in tb.get('slots', {}) and (tb['id'], ts) not in from_seen:
            raise ValueError(f'目标格位 {tb["name"]} / {ts} 已被占用')
    extracted = []
    affected = set()
    for fb, fs, tb, ts in staged:
        entry = fb['slots'].pop(fs)
        affected.add(entry['batch_id'])
        extracted.append((tb, ts, {**entry, 'moved_at': now[:16]}))
    for tb, ts, entry in extracted:
        tb.setdefault('slots', {})[ts] = entry
    refresh_affected_batches(state, affected)
    return {'moved': len(staged), 'batch_ids': sorted(affected)}


def apply_cryo_batch_update(state, payload, now):
    storage = ensure_cryo_storage(state)
    lot_id = text(payload.get('lot_id', ''), '冻存批次编号', 120)
    lot = next((b for b in state.get('frozen_batches', []) if b['id'] == lot_id), None)
    if not lot:
        raise ValueError('冻存批次不存在')

    # Validate optional split_slots (edit only selected slot(s) of a multi-vial batch as an independent lot)
    split_targets = []
    if 'split_slots' in payload:
        raw_split = payload['split_slots']
        if not isinstance(raw_split, list) or not raw_split:
            raise ValueError('请选择至少一个要单独修改的格位')
        seen_split = set()
        for spec in raw_split:
            if not isinstance(spec, dict):
                raise ValueError('待拆分格位格式无效')
            bid = text(spec.get('box_id', ''), '冻存盒编号', 120)
            skey = text(spec.get('slot', ''), '格位坐标', 20)
            box = _find_box(storage, bid)
            if not box or skey not in box.get('slots', {}) or box['slots'][skey].get('batch_id') != lot_id:
                raise ValueError(f'格位 {skey} 不属于本批次或为空')
            if (bid, skey) in seen_split:
                raise ValueError('待拆分格位存在重复')
            seen_split.add((bid, skey))
            split_targets.append((box, skey))
    do_split = bool(split_targets) and len(split_targets) < lot['vials']

    # Validate all field updates before mutating state
    updates = {}
    if 'name' in payload:
        name = text(payload.get('name', ''), '细胞名称', 200)
        if not name:
            raise ValueError('细胞名称不能为空')
        updates['name'] = name
    if 'at' in payload:
        at = text(payload.get('at', ''), '冻存时间', 40)
        if len(at) == 10 and re.fullmatch(r'\d{4}-\d{2}-\d{2}', at):
            at = at + 'T00:00'
        try:
            stamp = datetime.fromisoformat(at)
        except ValueError:
            raise ValueError('请填写有效的冻存时间') from None
        if len(at) < 16 or at[10] != 'T' or stamp.tzinfo is not None or stamp.replace(tzinfo=TZ) > datetime.fromisoformat(now):
            raise ValueError('冻存时间须为已发生的北京时间')
        if not do_split and any(at > w['at'] for w in batch_withdrawals(state, lot_id)):
            raise ValueError('冻存时间不能晚于已有出库记录')
        updates['at'] = at
    meta = normalize_optional_fields(payload, existing=lot)
    updates.update(meta)
    if 'per_vial_count' in payload:
        updates['per_vial'] = format_per_vial_count(meta['per_vial_count']) or text(payload.get('per_vial', ''), '每管细胞数', 120)
    elif 'per_vial' in payload:
        updates['per_vial'] = text(payload.get('per_vial', ''), '每管细胞数', 120)
    if 'labels' in payload:
        updates['labels'] = text(payload.get('labels', ''), '冻存管编号', 1000)
    if 'notes' in payload:
        updates['notes'] = text(payload.get('notes', ''), '冻存备注', 5000)
    if 'manual_location' in payload:
        updates['manual_location'] = text(payload.get('manual_location', ''), '存放位置', 500)

    next_stage = None
    if 'storage_stage' in payload:
        if do_split:
            raise ValueError('已落位的拆分格位不能切换暂存状态')
        next_stage = payload['storage_stage']
        if next_stage not in ('gradient', 'unassigned'):
            raise ValueError('仅支持在暂存盒暂存与未定位之间切换')
        if batch_unplaced(state, lot) <= 0:
            raise ValueError('该批次全部冻存管已落位或取出，无需切换暂存状态')

    slot_update_target = None
    if 'slot_update' in payload:
        su = payload['slot_update']
        if not isinstance(su, dict):
            raise ValueError('单管编号更新格式无效')
        box = _find_box(storage, text(su.get('box_id', ''), '冻存盒编号', 120))
        skey = text(su.get('slot', ''), '格位坐标', 20)
        if not box or skey not in box.get('slots', {}) or box['slots'][skey].get('batch_id') != lot_id:
            raise ValueError('找不到对应冻存格位')
        if split_targets and (box['id'], skey) not in seen_split:
            raise ValueError('单管编号对应的格位不在本次拆分范围内')
        slot_update_target = (box, skey, text(su.get('vial_label', ''), '单管编号', 120))

    if slot_update_target:
        box, skey, vlabel = slot_update_target
        box['slots'][skey]['vial_label'] = vlabel

    if do_split:
        new_lot = deepcopy(lot)
        new_lot['id'] = 'FRZ-' + uuid.uuid4().hex[:16].upper()
        new_lot['vials'] = len(split_targets)
        new_lot['storage_stage'] = 'stored'
        new_lot['recorded_at'] = now
        new_lot['split_from_lot_id'] = lot_id
        new_lot.pop('gradient_entered_at', None)
        new_lot.update(updates)
        lot['vials'] -= len(split_targets)
        for box, skey in split_targets:
            box['slots'][skey]['batch_id'] = new_lot['id']
        state.setdefault('frozen_batches', []).append(new_lot)
        refresh_batch_location(state, lot)
        refresh_batch_location(state, new_lot)
        return {
            'lot_id': new_lot['id'],
            'split_from_lot_id': lot_id,
            'split_count': len(split_targets),
            'name': new_lot['name'],
            'storage_stage': 'stored',
        }

    lot.update(updates)
    if next_stage is not None:
        lot['storage_stage'] = next_stage
        if next_stage == 'gradient':
            lot['gradient_entered_at'] = lot.get('gradient_entered_at') or now[:16]
    refresh_batch_location(state, lot)
    return {'lot_id': lot_id, 'name': lot['name'], 'storage_stage': lot.get('storage_stage', 'unassigned')}


def apply_cryo_mark_contamination(state, payload, now):
    wid = text(payload.get('withdrawal_id', ''), '取出记录编号', 120)
    entry = next((w for w in state.get('frozen_withdrawals', []) if w['id'] == wid), None)
    if not entry:
        raise ValueError('找不到该取出 / 复苏记录')
    lot = next((b for b in state.get('frozen_batches', []) if b['id'] == entry['lot_id']), None)
    if payload.get('clear') is True:
        entry.pop('contamination', None)
        return {'withdrawal_id': wid, 'lot_id': entry['lot_id'], 'name': lot['name'] if lot else '', 'cleared': True}
    at = text(payload.get('at', '') or now[:16], '发现污染时间', 40)
    if len(at) == 10 and re.fullmatch(r'\d{4}-\d{2}-\d{2}', at):
        at = at + 'T00:00'
    try:
        stamp = datetime.fromisoformat(at)
    except ValueError:
        raise ValueError('请填写有效的发现污染时间') from None
    if len(at) < 16 or at[10] != 'T' or stamp.tzinfo is not None or stamp.replace(tzinfo=TZ) > datetime.fromisoformat(now):
        raise ValueError('发现污染时间须为已发生的北京时间')
    if at < entry['at']:
        raise ValueError('发现污染时间不能早于取出 / 复苏时间')
    kind = text(payload.get('kind', ''), '污染类型', 80)
    notes = text(payload.get('notes', ''), '污染备注', 1000)
    entry['contamination'] = {'at': at, 'kind': kind, 'notes': notes, 'recorded_at': now}
    return {
        'withdrawal_id': wid,
        'lot_id': entry['lot_id'],
        'name': lot['name'] if lot else '',
        'at': at,
        'kind': kind,
        'cleared': False,
    }


def _remove_vials(state, payload, now, *, mode):
    """Release selected slots and append the corresponding inventory movement together."""
    storage = ensure_cryo_storage(state)
    lot_id = text(payload.get('lot_id', ''), '冻存批次编号', 120)
    lot = next((b for b in state.get('frozen_batches', []) if b['id'] == lot_id), None)
    if not lot:
        raise ValueError('冻存批次不存在')
    remaining = batch_remaining(state, lot)
    if remaining <= 0:
        raise ValueError('该批次已无剩余冻存管')
    at = text(payload.get('at', '') or now[:16], '出库时间', 40)
    if len(at) == 10 and re.fullmatch(r'\d{4}-\d{2}-\d{2}', at):
        at = at + 'T00:00'
    try:
        stamp = datetime.fromisoformat(at)
    except ValueError:
        raise ValueError('请填写有效的出库时间') from None
    if (len(at) < 16 or at[10] != 'T' or stamp.tzinfo is not None
            or stamp < datetime.fromisoformat(lot['at'])
            or stamp.replace(tzinfo=TZ) > datetime.fromisoformat(now)):
        raise ValueError('出库时间须在冻存时间与现在之间')
    n = payload.get('vials')
    if type(n) is not int or not 1 <= n <= remaining:
        raise ValueError(f'出库管数须为正整数，本批剩余 {remaining} 管')
    unplaced_before = batch_unplaced(state, lot)
    raw_slots = payload.get('slots')
    to_release = []
    if raw_slots is not None:
        if not isinstance(raw_slots, list) or len(raw_slots) > n:
            raise ValueError('所选出库格位数不能超过本次出库管数')
        seen = set()
        boxes_by_id = {b['id']: b for b in storage['boxes']}
        for spec in raw_slots:
            if not isinstance(spec, dict):
                raise ValueError('出库格位格式无效')
            bid = text(spec.get('box_id', ''), '冻存盒编号', 120)
            skey = text(spec.get('slot', ''), '格位坐标', 20)
            box = boxes_by_id.get(bid)
            if not box or skey not in box.get('slots', {}) or box['slots'][skey].get('batch_id') != lot_id:
                raise ValueError(f'格位 {skey} 不属于本批次或已空')
            if (bid, skey) in seen:
                raise ValueError('出库格位重复')
            seen.add((bid, skey))
            to_release.append((box, skey))
    if n - len(to_release) > unplaced_before:
        need = n - unplaced_before
        raise ValueError(f'本批次有 {len(batch_placed_slots(state, lot_id))} 管在冻存盒中，请至少选择 {need} 个对应格位')
    from_unplaced = n - len(to_release)
    from_gradient = from_unplaced if lot.get('storage_stage') == 'gradient' else 0
    reason = text(payload.get('reason', ''), '出库原因', 500)
    is_contamination = mode == 'discard' and payload.get('is_contamination') is True
    contam_kind = text(payload.get('contamination_kind', ''), '污染类型', 80) if is_contamination else ''
    notes = text(payload.get('notes', ''), '备注', 500)
    medium = None
    if 'medium' in payload:
        if mode != 'thaw':
            raise ValueError('仅复苏出库支持登记培养基配方')
        medium = merge_medium(None, payload['medium'])
    released = []
    for box, skey in to_release:
        entry = box['slots'].pop(skey)
        released.append(slot_snapshot(storage, box, skey, entry))
    item = {
        'id': 'OUT-' + uuid.uuid4().hex[:16].upper(),
        'lot_id': lot_id,
        'at': at,
        'vials': n,
        'labels': '、'.join(x['vial_label'] for x in released if x['vial_label']),
        'notes': '；'.join(part for part in (reason, notes) if part)[:500],
        'mode': mode,
        **({'discarded': True, 'discard_reason': reason} if mode == 'discard' else {}),
        'recorded_at': now,
    }
    if medium is not None:
        item['medium'] = medium
    if released:
        item['slots'] = released
    if from_gradient:
        item['from_gradient'] = from_gradient
    if is_contamination:
        item['contamination'] = {
            'at': at,
            'kind': contam_kind or '培养污染放弃入库',
            'notes': '；'.join(part for part in (reason, notes) if part)[:1000],
            'source': 'discard',
            'recorded_at': now,
        }
    state.setdefault('frozen_withdrawals', []).append(item)
    refresh_batch_location(state, lot)
    return {
        'withdrawal_id': item['id'],
        **({'medium': medium} if medium is not None else {}),
        'lot_id': lot_id,
        'name': lot['name'],
        'vials': n,
        'remaining': remaining - n,
        'at': at,
        'mode': mode,
        'from_gradient': from_gradient,
        'is_contamination': is_contamination,
        'reason': reason,
        'slots': released,
    }


def apply_cryo_discard_vials(state, payload, now):
    return _remove_vials(state, payload, now, mode='discard')


def apply_cryo_withdraw_vials(state, payload, now):
    mode = payload.get('mode', 'take')
    if mode not in ('take', 'thaw'):
        raise ValueError('取出记录类型无效')
    return _remove_vials(state, payload, now, mode=mode)


def apply_cryo_delete_slots(state, payload, now):
    """Remove mistaken slot entries directly without creating a withdrawal or contamination event."""
    storage = ensure_cryo_storage(state)
    raw_slots = payload.get('slots')
    if not isinstance(raw_slots, list) or not 1 <= len(raw_slots) <= 200:
        raise ValueError('请选择 1–200 个要删除的已占格位')
    boxes_by_id = {b['id']: b for b in storage['boxes']}
    lots_by_id = {b['id']: b for b in state.get('frozen_batches', [])}
    seen = set()
    targets = []
    for spec in raw_slots:
        if not isinstance(spec, dict):
            raise ValueError('待删除格位格式无效')
        bid = text(spec.get('box_id', ''), '冻存盒编号', 120)
        skey = text(spec.get('slot', ''), '格位坐标', 20)
        box = boxes_by_id.get(bid)
        if not box or skey not in box.get('slots', {}):
            raise ValueError(f'格位 {skey} 不存在或已空')
        if (bid, skey) in seen:
            raise ValueError('待删除格位重复')
        seen.add((bid, skey))
        entry = box['slots'][skey]
        lot = lots_by_id.get(entry.get('batch_id'))
        targets.append((box, skey, entry, lot))

    counts_by_lot = {}
    removed_snapshots = []
    for box, skey, entry, lot in targets:
        box['slots'].pop(skey)
        removed_snapshots.append(slot_snapshot(storage, box, skey, entry))
        if lot:
            counts_by_lot[lot['id']] = counts_by_lot.get(lot['id'], 0) + 1

    removed_lot_ids = []
    names = []
    for lot_id, n in counts_by_lot.items():
        lot = lots_by_id[lot_id]
        names.append(lot['name'])
        lot['vials'] -= n
        has_withdrawals = bool(batch_withdrawals(state, lot_id))
        if lot['vials'] <= 0 and not has_withdrawals:
            state['frozen_batches'] = [b for b in state.get('frozen_batches', []) if b['id'] != lot_id]
            removed_lot_ids.append(lot_id)
        else:
            refresh_batch_location(state, lot)

    return {
        'deleted': len(removed_snapshots),
        'names': list(dict.fromkeys(names)),
        'slots': removed_snapshots,
        'removed_lot_ids': removed_lot_ids,
    }


def apply_cryo_clear_yellow_by_thaw(state, payload, now):
    """Clear a yellow (1-hit) contamination warning when a clean thaw of the same / strong-related batch confirms no contamination."""
    wid = text(payload.get('withdrawal_id', ''), '复苏记录编号', 120)
    withdrawals = state.get('frozen_withdrawals', [])
    w_clean = next((w for w in withdrawals if w['id'] == wid), None)
    if not w_clean:
        raise ValueError('找不到该复苏记录')
    if w_clean.get('discarded'):
        raise ValueError('弃置记录不能用于无污染复苏验证')
    if isinstance(w_clean.get('contamination'), dict):
        raise ValueError('该复苏记录本身已标记污染，不能用于解除预警')
    if w_clean.get('mode') != 'thaw' and not isinstance(w_clean.get('destination'), dict):
        raise ValueError('请使用已登记复苏培养的同批次记录来确认无污染')
    by_id = {b['id']: b for b in state.get('frozen_batches', [])}
    clean_lot = by_id.get(w_clean.get('lot_id'))
    if not clean_lot:
        raise ValueError('找不到对应的冻存批次')
    risks = contamination_risk_map(state)
    info = risks.get(clean_lot['id']) or {'level': 'none', 'hits': 0, 'events': []}
    if info['level'] == 'red':
        raise ValueError('当前为红色高危（≥2 次污染），不能仅凭单次复苏无污染直接解除')
    if info['level'] != 'yellow':
        raise ValueError('该批次当前没有待解除的黄色污染预警')
    at = text(payload.get('at', '') or now[:16], '确认时间', 40)
    if len(at) == 10 and re.fullmatch(r'\d{4}-\d{2}-\d{2}', at):
        at = at + 'T00:00'
    try:
        stamp = datetime.fromisoformat(at)
    except ValueError:
        raise ValueError('请填写有效的确认时间') from None
    if len(at) < 16 or at[10] != 'T' or stamp.tzinfo is not None or stamp.replace(tzinfo=TZ) > datetime.fromisoformat(now):
        raise ValueError('确认时间须为已发生的北京时间')
    if at < w_clean['at']:
        raise ValueError('确认时间不能早于复苏时间')
    notes = text(payload.get('notes', ''), '无污染确认备注', 1000)

    # Match the active contamination event(s) from the same batch or strong-related same-day peer
    target_wids = []
    for ev in info['events']:
        src_lot = by_id.get(ev['source_lot_id'])
        if not src_lot:
            continue
        if src_lot['id'] == clean_lot['id'] or relation_tier(src_lot, clean_lot) == 'strong':
            if at < ev['contamination'].get('at', ''):
                raise ValueError('确认时间不能早于污染发现时间')
            target_wids.append(ev['withdrawal_id'])
    if not target_wids:
        raise ValueError('仅支持通过同批次（或同日强相关批次）的复苏无污染记录来解除黄色预警')

    cleared_wids = []
    for w in withdrawals:
        if w['id'] in target_wids and isinstance(w.get('contamination'), dict):
            w['contamination']['cleared_by_clean_thaw'] = {
                'withdrawal_id': w_clean['id'],
                'lot_id': clean_lot['id'],
                'at': at,
                'notes': notes,
                'recorded_at': now,
            }
            cleared_wids.append(w['id'])
    w_clean['clean_verification'] = {
        'at': at,
        'notes': notes,
        'clears_withdrawal_ids': cleared_wids,
        'recorded_at': now,
    }
    return {
        'withdrawal_id': w_clean['id'],
        'lot_id': clean_lot['id'],
        'name': clean_lot['name'],
        'at': at,
        'notes': notes,
        'cleared_withdrawal_ids': cleared_wids,
    }


def apply_cryo_template_save(state, payload, now):
    """Save or update a reusable cryo cell entry template."""
    storage = ensure_cryo_storage(state)
    name = text(payload.get('name', ''), '细胞名称', 200)
    if not name:
        raise ValueError('保存模板前请填写细胞名称')
    meta = normalize_optional_fields(payload)
    default_label_parts = [name]
    if meta['resistance_tags']:
        default_label_parts.append('/'.join(meta['resistance_tags'][:2]))
    elif meta['special_treatments']:
        default_label_parts.append('/'.join(meta['special_treatments'][:1]))
    label = text(payload.get('label', ''), '模板名称', 120) or ' '.join(default_label_parts)[:120]
    notes = text(payload.get('notes', ''), '默认备注', 1000)
    tid = text(payload.get('id', ''), '模板编号', 120)
    templates = storage['templates']
    existing = next((t for t in templates if tid and t['id'] == tid), None)
    if existing is None:
        existing = next((t for t in templates if t.get('label', '').casefold() == label.casefold()), None)
    data = {
        'label': label,
        'name': name,
        'cell_kind': meta['cell_kind'],
        'special_treatments': meta['special_treatments'],
        'resistance_tags': meta['resistance_tags'],
        'donor': meta['donor'],
        'suggested_vessel': meta['suggested_vessel'],
        'per_vial_count': meta['per_vial_count'],
        'passage': meta['passage'],
        'subclone': meta['subclone'],
        'notes': notes,
        'updated_at': now,
    }
    if existing is not None:
        existing.update(data)
        return {'template_id': existing['id'], 'label': existing['label'], 'name': existing['name'], 'change': 'update'}
    if len(templates) >= 50:
        raise ValueError('最多保存 50 个常用细胞模板，请先删除不再使用的模板')
    tpl = {'id': 'CRYOT-' + uuid.uuid4().hex[:10].upper(), 'created_at': now, **data}
    templates.append(tpl)
    return {'template_id': tpl['id'], 'label': tpl['label'], 'name': tpl['name'], 'change': 'create'}


def apply_cryo_template_delete(state, payload, now):
    storage = ensure_cryo_storage(state)
    tid = text(payload.get('id', ''), '模板编号', 120)
    tpl = next((t for t in storage['templates'] if t['id'] == tid), None)
    if not tpl:
        raise ValueError('找不到该常用细胞模板')
    storage['templates'].remove(tpl)
    return {'template_id': tid, 'label': tpl.get('label') or tpl.get('name') or tid}


def _stock_group_key(lot):
    return (
        _norm_cell(lot),
        _norm_treatments(lot),
        tuple(sorted(t.strip().casefold() for t in (lot.get('resistance_tags') or []) if t.strip())),
        (lot.get('subclone') or '').strip().casefold(),
        (lot.get('donor') or '').strip().casefold(),
    )


def stock_group_remaining_map(state):
    lots = state.get('frozen_batches', [])
    withdrawals = {}
    for entry in state.get('frozen_withdrawals', []):
        lid = entry['lot_id']
        withdrawals[lid] = withdrawals.get(lid, 0) + entry['vials']
    keys = {lot['id']: _stock_group_key(lot) for lot in lots}
    totals = {}
    for lot in lots:
        key = keys[lot['id']]
        totals[key] = totals.get(key, 0) + max(0, lot['vials'] - withdrawals.get(lot['id'], 0))
    return {lid: totals[key] for lid, key in keys.items()}


def render_box_print_html(state, box_id):
    """Render a clean, self-contained A4-landscape printable HTML sheet for a cryo box."""
    import html as _html
    storage = ensure_cryo_storage(state)
    box = _find_box(storage, box_id)
    if not box:
        raise ValueError('找不到该冻存盒')
    loc = box_location_label(storage, box)
    rows = int(box.get('rows') or 9)
    cols = int(box.get('cols') or 9)
    numbering = box.get('numbering') or 'alpha'
    slots = box.get('slots') or {}
    batches = {b['id']: b for b in state.get('frozen_batches', [])}
    risks = contamination_risk_map(state)
    group_rem = stock_group_remaining_map(state)
    printed_at = datetime.now(TZ).strftime('%Y-%m-%d %H:%M')

    # Assign subtle sequential print tones by content signature
    tone_palette = [
        ('#eef5f0', '#b8d1c2'),
        ('#eef3f8', '#b8cbe0'),
        ('#f5f0f9', '#d2bee4'),
        ('#f9f2e9', '#dfcaa9'),
        ('#eaf5f5', '#afd3d3'),
        ('#f8eff2', '#ddb8c4'),
        ('#f2f5e9', '#c9d4a7'),
        ('#eff0f9', '#bec2e3'),
    ]
    sig_to_tone = {}
    def _sig(lot):
        return (*_stock_group_key(lot), (lot.get('passage') or '').strip().casefold(), (lot.get('at') or '')[:10])

    all_keys = box_slot_keys(rows, cols, numbering)
    for k in all_keys:
        entry = slots.get(k)
        lot = batches.get(entry['batch_id']) if entry else None
        if lot:
            s = _sig(lot)
            if s not in sig_to_tone:
                sig_to_tone[s] = tone_palette[len(sig_to_tone) % len(tone_palette)]

    header_cells = '<th class="axis"></th>' + ''.join(f'<th class="axis">{c + 1}</th>' for c in range(cols))
    grid_rows = []
    lot_slots_in_box = {}
    for r in range(rows):
        row_label = chr(65 + r) if numbering == 'alpha' else str(r + 1)
        tds = [f'<th class="axis">{_html.escape(row_label)}</th>']
        for c in range(cols):
            key = f'{chr(65 + r)}{c + 1}' if numbering == 'alpha' else str(r * cols + c + 1)
            entry = slots.get(key)
            lot = batches.get(entry['batch_id']) if entry else None
            if not lot:
                tds.append(f'<td class="cell empty"><div class="coord">{_html.escape(key)}</div><div class="empty-txt">空</div></td>')
                continue
            lot_slots_in_box.setdefault(lot['id'], []).append(key)
            bg, bd = sig_to_tone.get(_sig(lot), ('#eef5f0', '#b8d1c2'))
            risk = risks.get(lot['id'], {}).get('level', 'none')
            cls = 'cell occupied'
            if risk == 'red':
                cls += ' risk-red'
            elif risk == 'yellow':
                cls += ' risk-yellow'
            clone_html = f'<span class="badge clone">{_html.escape(lot["subclone"])}</span>' if lot.get('subclone') else ''
            low_n = group_rem.get(lot['id'], 0)
            low_html = f'<span class="badge low">剩{low_n}</span>' if 0 < low_n <= 2 else ''
            risk_html = '<span class="badge red">高危</span>' if risk == 'red' else ('<span class="badge yellow">预警</span>' if risk == 'yellow' else '')
            sub_parts = []
            if lot.get('resistance_tags'):
                sub_parts.append(' '.join(lot['resistance_tags']))
            if lot.get('special_treatments'):
                sub_parts.append(' / '.join(lot['special_treatments']))
            if lot.get('passage'):
                sub_parts.append(lot['passage'])
            sub_txt = ' · '.join(sub_parts)
            date_txt = (lot.get('at') or '')[:10]
            style = f' style="background:{bg};border-color:{bd}"' if risk == 'none' else ''
            tds.append(
                f'<td class="{cls}"{style}>'
                f'<div class="cell-top"><span class="coord">{_html.escape(key)}</span><span class="badges">{clone_html}{low_html}{risk_html}</span></div>'
                f'<div class="cell-name">{_html.escape(lot["name"])}</div>'
                + (f'<div class="cell-sub">{_html.escape(sub_txt)}</div>' if sub_txt else '')
                + (f'<div class="cell-date">{_html.escape(date_txt)}</div>' if date_txt else '')
                + '</td>'
            )
        grid_rows.append('<tr>' + ''.join(tds) + '</tr>')

    summary_rows = []
    for lid, skeys in lot_slots_in_box.items():
        lot = batches[lid]
        tx = ' / '.join(lot.get('special_treatments') or []) or '未记录'
        res = ' '.join(lot.get('resistance_tags') or []) or '—'
        risk = risks.get(lid, {}).get('level', 'none')
        risk_lbl = '红色高危' if risk == 'red' else ('黄色预警' if risk == 'yellow' else '正常')
        low_n = group_rem.get(lid, 0)
        rem_lbl = f'{batch_remaining(state, lot)} 管' + (f'（同类总剩 {low_n}）' if 0 < low_n <= 2 else '')
        summary_rows.append(
            '<tr>'
            f'<td><strong>{_html.escape(lot["name"])}</strong></td>'
            f'<td>{_html.escape(lot.get("subclone") or "—")}</td>'
            f'<td>{_html.escape(res)}</td>'
            f'<td>{_html.escape(tx)}</td>'
            f'<td>{_html.escape(lot.get("passage") or "—")}</td>'
            f'<td>{_html.escape((lot.get("at") or "")[:10])}</td>'
            f'<td>{_html.escape("、".join(skeys))}</td>'
            f'<td>{_html.escape(rem_lbl)}</td>'
            f'<td>{_html.escape(risk_lbl)}</td>'
            '</tr>'
        )
    summary_html = (
        '<h2>盒内批次清单</h2>'
        '<table class="summary"><thead><tr>'
        '<th>细胞名称</th><th>亚克隆</th><th>抗性</th><th>特殊处理</th><th>代次</th><th>冻存日期</th><th>盒内坐标</th><th>库存</th><th>状态</th>'
        '</tr></thead><tbody>' + ''.join(summary_rows) + '</tbody></table>'
    ) if summary_rows else '<p class="muted">此冻存盒当前为空盒。</p>'

    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        f'<title>冻存盒分布图 · {_html.escape(loc)}</title>'
        '<style>'
        '*{box-sizing:border-box}'
        'body{font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:#17322b;margin:0;padding:18px 22px;background:#fff}'
        '.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px;border-bottom:2px solid #1e5b4c;padding-bottom:10px}'
        'h1{margin:0;font-size:19px;color:#14362d}'
        '.meta{margin-top:4px;color:#556b64;font-size:12px}'
        '.btn{padding:7px 14px;border:1px solid #1e5b4c;background:#1e5b4c;color:#fff;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}'
        'table.grid{width:100%;border-collapse:separate;border-spacing:4px;table-layout:fixed}'
        'th.axis{font-size:11px;color:#5a7069;font-weight:600;width:24px;text-align:center;padding:2px}'
        'td.cell{border:1.2px solid #d7dfd9;border-radius:6px;padding:4px 5px;vertical-align:top;height:56px;overflow:hidden}'
        'td.cell.empty{background:#fbfcfb;color:#aab8b2}'
        'td.cell.risk-yellow{background:#fef6db !important;border-color:#d4971a !important}'
        'td.cell.risk-red{background:#fdecea !important;border-color:#c93d35 !important}'
        '.cell-top{display:flex;justify-content:space-between;align-items:center;gap:2px;margin-bottom:1px}'
        '.coord{font-size:10px;font-weight:700;color:#526b64}'
        '.empty-txt{font-size:10px;text-align:center;margin-top:10px}'
        '.badges{display:flex;gap:2px;flex-wrap:wrap;justify-content:flex-end}'
        '.badge{font-size:9px;padding:0 4px;border-radius:999px;font-weight:700;line-height:1.4}'
        '.badge.clone{background:#ece3f8;color:#5b2f91}'
        '.badge.low{background:#fff0d4;color:#995400}'
        '.badge.yellow{background:#f7d57e;color:#6f4200}'
        '.badge.red{background:#e5534b;color:#fff}'
        '.cell-name{font-weight:700;font-size:11px;line-height:1.2;word-break:break-word}'
        '.cell-sub{font-size:9.5px;color:#3d574f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}'
        '.cell-date{font-size:9px;color:#667d75}'
        'h2{font-size:14px;margin:18px 0 8px;color:#14362d}'
        'table.summary{width:100%;border-collapse:collapse;font-size:11px}'
        'table.summary th,table.summary td{border:1px solid #d5ded8;padding:5px 7px;text-align:left}'
        'table.summary th{background:#eef4f0;color:#1a3d34}'
        '.muted{color:#667d75}'
        '@media print{.no-print{display:none !important}body{padding:0}@page{size:A4 landscape;margin:10mm}}'
        '</style></head><body>'
        f'<div class="topbar"><div><h1>冻存盒分布图 · {_html.escape(loc)}</h1>'
        f'<div class="meta">{rows}×{cols}（{"A1 行列坐标" if numbering == "alpha" else "顺序编号"}）· 已占 {len(slots)}/{rows * cols} 格 · 导出时间 {printed_at}</div></div>'
        '<button id="print-now-btn" class="btn no-print" type="button">打印 / 另存为 PDF</button></div>'
        f'<table class="grid"><thead><tr>{header_cells}</tr></thead><tbody>{"".join(grid_rows)}</tbody></table>'
        f'{summary_html}'
        '<script src="/cryo-print.js"></script>'
        '</body></html>'
    )


def apply_cryo_command(state, action, payload, now):
    """Dispatch only supported inventory operations within Store.mutate's transaction."""
    handler = INVENTORY_COMMANDS.get(action)
    if handler is None:
        raise ValueError('未知冻存库操作')
    return handler(state, payload, now)


INVENTORY_COMMANDS = {
    'cryo_delete_slots': apply_cryo_delete_slots,
    'cryo_clear_yellow_by_thaw': apply_cryo_clear_yellow_by_thaw,
    'cryo_template_save': apply_cryo_template_save,
    'cryo_template_delete': apply_cryo_template_delete,
    'cryo_setup_preset': apply_cryo_setup_preset,
    'cryo_device_save': apply_cryo_device_save,
    'cryo_device_delete': apply_cryo_device_delete,
    'cryo_rack_save': apply_cryo_rack_save,
    'cryo_rack_delete': apply_cryo_rack_delete,
    'cryo_box_save': apply_cryo_box_save,
    'cryo_box_delete': apply_cryo_box_delete,
    'cryo_stock_create': apply_cryo_stock_create,
    'cryo_place_vials': apply_cryo_place_vials,
    'cryo_move_slots': apply_cryo_move_slots,
    'cryo_batch_update': apply_cryo_batch_update,
    'cryo_mark_contamination': apply_cryo_mark_contamination,
    'cryo_discard_vials': apply_cryo_discard_vials,
    'cryo_withdraw_vials': apply_cryo_withdraw_vials,
}
