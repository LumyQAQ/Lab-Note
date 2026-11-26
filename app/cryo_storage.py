"""Customizable cryo-storage topology, slot mapping, correlation and contamination risk."""
from datetime import datetime
import re
import uuid

from medium import number, text
from platform_config import TZ

DEVICE_KINDS = ('ln2', 'minus80', 'custom')
NUMBERING_MODES = ('alpha', 'numeric')
STORAGE_STAGES = ('gradient', 'stored', 'unassigned')
CELL_KINDS = ('', '细胞系', '原代细胞')


def ensure_cryo_storage(state):
    storage = state.setdefault('cryo_storage', {})
    storage.setdefault('devices', [])
    storage.setdefault('racks', [])
    storage.setdefault('boxes', [])
    return storage


def box_slot_keys(rows, cols, numbering='alpha'):
    if type(rows) is not int or type(cols) is not int or not (1 <= rows <= 12 and 1 <= cols <= 12):
        raise ValueError('冻存盒行数与列数须为 1–12 的整数')
    if numbering not in NUMBERING_MODES:
        raise ValueError('冻存盒编号方式须为行列坐标（alpha）或顺序编号（numeric）')
    if numbering == 'numeric':
        return [str(i + 1) for i in range(rows * cols)]
    return [f'{chr(65 + r)}{c + 1}' for r in range(rows) for c in range(cols)]


def normalize_special_treatments(value):
    if value is None or value == '':
        return []
    if isinstance(value, str):
        raw = [part.strip() for part in re.split(r'[,，、;；\n]', value) if part.strip()]
    elif isinstance(value, list):
        if any(not isinstance(item, str) for item in value):
            raise ValueError('特殊处理标签须为文本列表')
        raw = [item.strip() for item in value if item.strip()]
    else:
        raise ValueError('特殊处理标签格式无效')
    result, seen = [], set()
    for item in raw:
        if len(item) > 80:
            raise ValueError('单项特殊处理标签不能超过 80 字')
        key = item.casefold()
        if key not in seen:
            seen.add(key)
            result.append(item)
    if len(result) > 20:
        raise ValueError('单个批次最多记录 20 项特殊处理标签')
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
    cell_kind = payload['cell_kind'] if 'cell_kind' in payload else (base.get('cell_kind') or '')
    if not isinstance(cell_kind, str) or cell_kind not in CELL_KINDS:
        raise ValueError('细胞类型须为细胞系、原代细胞或留空')
    special_treatments = (normalize_special_treatments(payload['special_treatments'])
                          if 'special_treatments' in payload
                          else list(base.get('special_treatments') or []))
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
        'special_treatments': special_treatments,
        'passage': passage,
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
    return [{'id': source_id, 'well': key, 'name': container['name'],
             'snapshot': {field: well.get(field, '') for field in ('cell', 'kind', 'day0', 'batch')}}]


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
    per_vial_text = text(payload.get('per_vial', ''), '每管细胞数', 120) or format_per_vial_count(meta['per_vial_count'])
    notes = text(payload.get('notes', ''), '冻存备注', 5000)
    lot = {
        'id': 'FRZ-' + uuid.uuid4().hex[:16].upper(),
        'name': name,
        'at': at,
        'vials': vials,
        'sources': _stock_source(state, payload.get('source')),
        'experiment_refs': [],
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
    state.setdefault('frozen_batches', []).append(lot)
    if parsed_placements:
        auto_labels = _split_labels_for_slots(labels, len(parsed_placements))
        for item, auto_label in zip(parsed_placements, auto_labels):
            item['box'].setdefault('slots', {})[item['slot']] = {
                'batch_id': lot['id'],
                'vial_label': item['vial_label'] or auto_label,
                'placed_at': now[:16],
            }
    refresh_batch_location(state, lot)
    return {
        'lot_id': lot['id'],
        'name': lot['name'],
        'vials': vials,
        'placed': len(parsed_placements),
        'at': at,
        'storage_stage': lot['storage_stage'],
        'location': lot['location'],
    }


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
    if 'name' in payload:
        name = text(payload.get('name', ''), '细胞名称', 200)
        if not name:
            raise ValueError('细胞名称不能为空')
        lot['name'] = name
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
        if any(at > w['at'] for w in batch_withdrawals(state, lot_id)):
            raise ValueError('冻存时间不能晚于已有出库记录')
        lot['at'] = at
    meta = normalize_optional_fields(payload, existing=lot)
    lot.update(meta)
    if 'per_vial_count' in payload:
        lot['per_vial'] = format_per_vial_count(meta['per_vial_count']) or text(payload.get('per_vial', ''), '每管细胞数', 120)
    elif 'per_vial' in payload:
        lot['per_vial'] = text(payload.get('per_vial', ''), '每管细胞数', 120)
    if 'labels' in payload:
        lot['labels'] = text(payload.get('labels', ''), '冻存管编号', 1000)
    if 'notes' in payload:
        lot['notes'] = text(payload.get('notes', ''), '冻存备注', 5000)
    if 'manual_location' in payload:
        lot['manual_location'] = text(payload.get('manual_location', ''), '存放位置', 500)
    if 'storage_stage' in payload:
        next_stage = payload['storage_stage']
        if next_stage not in ('gradient', 'unassigned'):
            raise ValueError('仅支持在暂存盒暂存与未定位之间切换')
        if batch_unplaced(state, lot) <= 0:
            raise ValueError('该批次全部冻存管已落位或取出，无需切换暂存状态')
        lot['storage_stage'] = next_stage
        if next_stage == 'gradient':
            lot['gradient_entered_at'] = lot.get('gradient_entered_at') or now[:16]
    if 'slot_update' in payload and isinstance(payload['slot_update'], dict):
        su = payload['slot_update']
        box = _find_box(storage, text(su.get('box_id', ''), '冻存盒编号', 120))
        skey = text(su.get('slot', ''), '格位坐标', 20)
        if not box or skey not in box.get('slots', {}) or box['slots'][skey].get('batch_id') != lot_id:
            raise ValueError('找不到对应冻存格位')
        box['slots'][skey]['vial_label'] = text(su.get('vial_label', ''), '单管编号', 120)
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


def apply_cryo_command(state, action, payload, now):
    """Dispatch only supported inventory operations within Store.mutate's transaction."""
    handler = INVENTORY_COMMANDS.get(action)
    if handler is None:
        raise ValueError('未知冻存库操作')
    return handler(state, payload, now)


INVENTORY_COMMANDS = {
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
