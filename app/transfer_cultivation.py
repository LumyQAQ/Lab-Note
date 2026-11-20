"""Explicit cultivation-system choices for transfer target groups."""
from copy import deepcopy
from datetime import datetime

from medium import DEFAULT, merge_medium, text


CULTURE_ACTIONS = {'passage': '传代扩增', 'move': '移孔换液', 'expand': '扩孔', 'exchange': '原位换液'}


def target_culture_action(target, mode):
    if 'culture_action' not in target:
        return None
    action = target['culture_action']
    if mode not in ('passage', 'replate') or not isinstance(action, str) or action not in CULTURE_ACTIONS:
        raise ValueError('无效的培养转移操作')
    return action


def cultivation_system(well):
    """Compare only the culture system, independently of cell identity or counts."""
    return {
        'medium': deepcopy(well.get('medium') or None),
        'treatment': (well.get('treatment') or '').strip(),
        'concentration': (well.get('concentration') or '').strip(),
        'active_treatments': deepcopy(well.get('active_treatments') or []),
    }


def validate_active_times(active, at):
    """A transfer cannot continue a treatment that had not yet started."""
    if not isinstance(active, list):
        raise ValueError('进行中处理记录格式无效')
    occurred = datetime.fromisoformat(at)
    for treatment in active:
        try:
            started = datetime.fromisoformat(treatment['started_at'])
        except (KeyError, TypeError, ValueError):
            raise ValueError('进行中处理的开始时间无效') from None
        if started.tzinfo is not None:
            raise ValueError('进行中处理的开始时间须为北京时间，不附加其他时区')
        if started > occurred:
            raise ValueError('操作时间不能早于沿用的进行中处理开始时间')


def continuation_reference(target, sources, previous_wells):
    reference = target.get('cultivation_reference')
    indices = target['source_indices']
    if 'cultivation_reference' not in target:
        if len(indices) == 1:
            return sources[indices[0]]['snapshot']
        raise ValueError('沿用进行中处理时，请明确选择一个来源或已有目标培养单元')
    if not isinstance(reference, dict):
        raise ValueError('培养体系参考单元无效')
    if reference.get('kind') == 'source':
        index = reference.get('source_index')
        if set(reference) - {'kind', 'source_index'} or type(index) is not int or index not in indices:
            raise ValueError('培养体系参考来源须为本组已选择的来源')
        return sources[index]['snapshot']
    if reference.get('kind') == 'target':
        key = reference.get('well')
        if (set(reference) - {'kind', 'well'} or not isinstance(key, str)
                or key not in target['wells'] or not previous_wells[key].get('cell')):
            raise ValueError('培养体系参考目标须为本组已选择且原先已有细胞的培养单元')
        return previous_wells[key]
    raise ValueError('培养体系参考单元无效')


def prepare_cultivation(target, sources, previous_wells, at):
    """Freeze one complete system per target before any target well is changed.

    Omitted cultivation_mode retains the legacy transfer behavior. The caller
    validates source indices and target keys before invoking this function.
    """
    if 'cultivation_mode' not in target:
        return None
    mode = target['cultivation_mode']
    if mode not in ['same', 'custom']:
        raise ValueError('请选择沿用前培养体系或自定义培养体系')
    if mode == 'same':
        inherited = None
        replacing = target.get('occupied_action') == 'replace'
        if replacing or any(not previous_wells[key].get('cell') for key in target['wells']):
            source_systems = [cultivation_system(sources[i]['snapshot']) for i in target['source_indices']]
            inherited = source_systems[0]
            if any(system != inherited for system in source_systems[1:]):
                raise ValueError('来源培养体系不一致，请自定义目标培养体系或分别设置去向')
        result = {}
        for key in target['wells']:
            previous = previous_wells[key]
            system = cultivation_system(previous) if previous.get('cell') and not replacing else deepcopy(inherited)
            validate_active_times(system['active_treatments'], at)
            result[key] = system
        return result

    custom = target.get('cultivation')
    if not isinstance(custom, dict) or set(custom) - {'medium', 'treatment', 'concentration', 'continue_active'}:
        raise ValueError('自定义培养体系格式无效')
    recipe = custom.get('medium')
    if not isinstance(recipe, dict):
        raise ValueError('请填写自定义培养基成分')
    continues = custom.get('continue_active', False)
    if type(continues) is not bool:
        raise ValueError('沿用进行中处理设置无效')
    system = {
        'medium': merge_medium(None, recipe or deepcopy(DEFAULT)),
        'treatment': text(custom.get('treatment', ''), '目标处理', 5000),
        'concentration': text(custom.get('concentration', ''), '目标浓度 / 剂量', 5000),
        'active_treatments': [],
    }
    if continues:
        reference = continuation_reference(target, sources, previous_wells)
        system['active_treatments'] = deepcopy(reference.get('active_treatments') or [])
        validate_active_times(system['active_treatments'], at)
    return {key: deepcopy(system) for key in target['wells']}


def apply_cultivation(well, system):
    """Replace current conditions without touching cell provenance or counts."""
    if system is None:
        return
    well.pop('medium', None)
    if system['medium'] is not None:
        well['medium'] = deepcopy(system['medium'])
    for field in ['treatment', 'concentration', 'active_treatments']:
        well[field] = deepcopy(system[field])
