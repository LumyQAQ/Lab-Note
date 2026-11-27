"""Declare a plate's experiment in the notebook without selecting or changing wells."""
from datetime import datetime
from platform_config import TZ

from lab_records import apply_lab_record, load_schema



def record_plate_ids(record):
    """Only the record's own observed sources, actual target captures or explicit plate."""
    ids = {(record.get('plate_context') or {}).get('container_id')}
    if record.get('merged_record_ids'):
        ids.update(x['container_id'] for x in record.get('well_observations',[]) if x.get('binding',{}).get('snapshot'))
    sources = list(record.get('cell_sources', []))
    for group in record.get('source_groups', []):
        members = set(group.get('members', []))
        sources.extend(s for s in group.get('sources', []) if s.get('key') in members
                       and s.get('table_key', s.get('key')) == s.get('key'))
    for s in sources:
        if not s.get('snapshot_id') and s.get('snapshot') and s.get('key') == f"{s['container_id']}|{s['well']}|":
            ids.add(s['container_id'])
    for group in record.get('infection_layout', {}).get('groups', []):
        ids.update(t['container_id'] for t in group.get('targets', []) if t.get('snapshot') and t.get('well'))
    return ids - {None, ''}


def _prefill_from_plate(plate, module_id, variant_id):
    """Build initial data/tables from Transwell or Organoid simulated wells on this plate."""
    data = {}
    tables = {}
    wells = plate.get('wells') or {}
    if module_id == 'transwell':
        data['plate_spec'] = plate.get('type', '')
        rows = []
        pore_seen = ''
        coat_seen = ''
        for key, well in wells.items():
            ac = well.get('assay_contents') or {}
            if ac.get('kind') != 'transwell':
                continue
            if not pore_seen and ac.get('pore_size_um') in ('0.4', '3.0', '5.0', '8.0'):
                pore_seen = ac['pore_size_um']
            if not coat_seen and ac.get('matrigel_coating'):
                coat_seen = ac['matrigel_coating']
            lower_parts = [p for p in (ac.get('lower_cell'), ac.get('lower_cells_per_well'), ac.get('lower_medium')) if p]
            rows.append({
                'well': key,
                'group': ac.get('group', ''),
                'mode': ac.get('transwell_mode', ''),
                'upper_cell': ac.get('upper_cell', ''),
                'upper_count': ac.get('upper_cells_per_well', ''),
                'upper_volume_ul': ac.get('upper_volume_ul', ''),
                'lower_condition': ' / '.join(lower_parts),
                'lower_volume_ul': ac.get('lower_volume_ul', ''),
                'coating': ac.get('matrigel_coating', ''),
            })
        if pore_seen:
            data['pore_size'] = pore_seen
        if coat_seen:
            data['matrigel_coating'] = coat_seen
        if rows:
            tables['chamber_groups'] = rows
    elif module_id == 'organoid':
        data['plate_spec'] = plate.get('type', '')
        rows = []
        org_seen = ''
        mat_seen = ''
        dome_seen = ''
        for key, well in wells.items():
            ac = well.get('assay_contents') or {}
            if ac.get('kind') != 'organoid':
                continue
            if not org_seen and ac.get('organoid_name'):
                org_seen = ac['organoid_name']
            if not mat_seen and ac.get('matrix_type'):
                mat_seen = ac['matrix_type']
            if not dome_seen and ac.get('dome_volume_ul'):
                dome_seen = ac['dome_volume_ul']
            if variant_id == 'coculture':
                rows.append({
                    'well': key,
                    'group': ac.get('group', ''),
                    'organoid': ac.get('organoid_name', ''),
                    'matrix': ' · '.join(p for p in (ac.get('matrix_type'), ac.get('organoid_mode')) if p),
                    'effector': ac.get('effector_cell', ''),
                    'et_ratio': ac.get('et_ratio', ''),
                    'effector_count': ac.get('effector_cells_per_well', ''),
                    'final_volume_ul': ac.get('final_volume_ul', ''),
                })
            else:
                dome_desc = ''
                if ac.get('dome_volume_ul') and ac.get('dome_count'):
                    dome_desc = f"{ac['dome_volume_ul']} μL × {ac['dome_count']}"
                elif ac.get('dome_volume_ul'):
                    dome_desc = f"{ac['dome_volume_ul']} μL"
                rows.append({
                    'well': key,
                    'group': ac.get('group', ''),
                    'organoid': ac.get('organoid_name', ''),
                    'matrix': ac.get('matrix_type', ''),
                    'dome': dome_desc,
                    'medium': ac.get('medium', ''),
                    'final_volume_ul': ac.get('final_volume_ul', ''),
                })
        if org_seen:
            data['organoid_source'] = org_seen
        if mat_seen:
            data['matrix_ratio'] = mat_seen
        if dome_seen:
            data['dome_volume_ul'] = dome_seen
        if rows:
            tables['plating_groups'] = rows
    return data, tables


def apply_plate_experiment(state, payload, now, plate_types):
    if set(payload) - {'id', 'kind', 'date', 'record_id', 'confirmed_completed'}:
        raise ValueError('今日实验包含未知字段')
    if type(payload.get('confirmed_completed', False)) is not bool:
        raise ValueError('已完成记录的版本确认须为布尔值')
    day = datetime.fromisoformat(now).astimezone(TZ).date().isoformat()
    if payload.get('date') != day:
        raise ValueError('日期已变化，请刷新后登记北京时间今天的实验')
    plate = next((c for c in state['containers'] if c['id'] == payload.get('id')), None)
    if not plate or plate['status'] != 'active' or plate['type'] not in plate_types:
        raise ValueError('仅可为当前在用的实体孔板登记今日实验')

    modules = load_schema()['modules']
    kind = payload.get('kind')
    selection = next(((module_id, variant_id) for module_id, module in modules.items()
                      for variant_id, variant in module['variants'].items()
                      if kind and variant.get('plate_today_kind') == kind), None)
    if selection is None:
        raise ValueError('请选择支持从孔板登记的实验类型')
    module_id, variant_id = selection
    candidates = [r for r in state.get('lab_records', [])
                  if r['record_date'] == day and r['status'] != 'cancelled'
                  and r['type'] == module_id and (r['variant'] == variant_id
                      or (kind == 'infection' and r['variant'] == 'lentiviral'))
                  and (kind == 'infection' or not r.get('plate_context')
                       or r['plate_context']['container_id'] == plate['id'])
                  and plate['id'] in record_plate_ids(r)]
    if 'record_id' in payload:
        record = next((r for r in candidates if r['id'] == payload['record_id']), None)
        if record is None:
            raise ValueError('所选实验记录与本板、日期或实验类型不匹配')
    elif len(candidates) > 1:
        raise ValueError('本板今天有多份同类实验记录，请明确选择要使用的记录')
    else:
        record = next(iter(candidates), None)

    if record and record.get('plate_context'):
        # Infection records may already span multiple directly observed plates.
        return None
    if record:
        if record['status'] == 'completed' and payload.get('confirmed_completed') is not True:
            raise ValueError('关联这份已完成的实验记录将产生新版本，请先确认')
        change = 'update'
        record['version'] += 1
        record['updated_at'] = now
    else:
        change = 'create'
        module = modules[module_id]
        label = module['label']
        if kind not in ('infection', 'cytotoxicity') and len(module['variants']) > 1:
            label += ' · ' + module['variants'][variant_id]['label']
        prefill_data, prefill_tables = _prefill_from_plate(plate, module_id, variant_id)
        apply_lab_record(state, {'type': module_id, 'variant': variant_id,
                         'title': plate['name'] + ' · ' + label, 'record_date': day,
                         'status': 'draft',
                         **({'data': prefill_data} if prefill_data else {}),
                         **({'tables': prefill_tables} if prefill_tables else {})},
                         None)
        record = state['lab_records'][-1]
        record['created_at'] = record['updated_at'] = now
    record['plate_context'] = {'container_id': plate['id'], 'container_name': plate['name'],
                               'container_type': plate['type']}
    return {'id': plate['id'], 'kind': kind, 'record_date': day,
            'record_id': record['id'], 'title': record['title'], 'change': change,
            'record_type': record['type'], 'variant': record['variant'],
            'status': record['status'], 'version': record['version'],
            **({'confirmed_completed': True} if change == 'update' and record['status'] == 'completed' else {})}
