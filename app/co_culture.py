"""Compose occupied cultures without collapsing population history or amounts."""
from copy import deepcopy

from store import empty_well
from transfer_cultivation import validate_active_times


def validate_draft_append(targets):
    for target in targets:
        if 'draft_append' in target and type(target['draft_append']) is not bool:
            raise ValueError('本次安排追加设置须为布尔值')
        if target.get('draft_append') and (target.get('occupied_action') != 'append'
                                          or target.get('occupied_confirmed') is not True):
            raise ValueError('叠加本次已有安排须明确选择加入共培养并确认')


def population(snapshot, origin, role=None, amount=None):
    """Keep the full old population; its counts remain historical metadata."""
    part = deepcopy(snapshot)
    part.update(role=snapshot.get('role', '') if role is None else role,
                amount=snapshot.get('amount', '') if amount is None else amount, origin={
        **deepcopy(origin), 'lineage_id': snapshot.get('lineage_id', '')})
    if snapshot.get('medium'):
        part['source_medium'] = deepcopy(snapshot['medium'])
    return part


def append_culture(previous, incoming, origin, at, receipt_id):
    """Incoming items represent physical populations, not individual pool wells."""
    components = deepcopy(previous.get('components') or [population(previous, origin)])
    for index, source in enumerate(incoming):
        original = source['snapshot']
        validate_active_times(original.get('active_treatments') or [], at)
        if original.get('components'):
            for part in original['components']:
                component = deepcopy(part)
                component.update(amount='', aliquot_id=f'{receipt_id}:{origin["id"]}:{origin["well"]}:{index}',
                                 aliquot_amount=source.get('amount', ''), aliquot_role=source.get('role', ''))
                components.append(component)
        else:
            components.append(population(original, source['origin'],
                                         source.get('role', ''), source.get('amount', '')))
    started = previous.get('experiment_started_at') if previous.get('components') else None
    started = started or at
    result = {**empty_well(), 'cell': ' + '.join(dict.fromkeys(part['cell'] for part in components)),
              'kind': '混合培养', 'day0': started[:10], 'anchor': '共培养开始',
              'components': components, 'experiment_started_at': started, 'introduced_at': at}
    for field in ['treatment', 'concentration', 'treated_at', 'notes', 'experiment', 'medium',
                  'active_treatments', 'source_refs']:
        if field in previous:
            result[field] = deepcopy(previous[field])
    collection_ids = list(dict.fromkeys(
        [*previous.get('incoming_collection_ids', []),
         *(part['collection_id'] for part in components if part.get('collection_id')),
         *(cid for source in incoming for cid in source['snapshot'].get('incoming_collection_ids', []))]))
    if collection_ids:
        result['incoming_collection_ids'] = collection_ids
    validate_active_times(result.get('active_treatments') or [], at)
    return result


def source_population(source):
    return {'snapshot': source['snapshot'], 'role': source['role'], 'amount': source['amount'],
            'origin': {field: deepcopy(source[field]) for field in ['id', 'name', 'well']}}
