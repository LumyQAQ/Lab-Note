"""Structured culture-medium records; no protocol or unit inference."""
from copy import deepcopy
from decimal import Decimal, InvalidOperation

DEFAULT = {'base':'','fbs':'','hs':'','ps':'unknown','triple':'unknown',
           'cytokines':[],'extra':'unknown','additives':[]}


def text(value, label, limit=500):
    if not isinstance(value,str) or len(value)>limit:
        raise ValueError(f'{label}须为不超过{limit}字的文本')
    return value.strip()


def number(value,label,maximum=None):
    value=text(value,label,80)
    if not value:return ''
    try:parsed=Decimal(value)
    except InvalidOperation:raise ValueError(f'{label}须为有效数值') from None
    if not parsed.is_finite() or parsed<0 or (maximum is not None and parsed>maximum):
        raise ValueError(f'{label}须为0–{maximum}之间的数值' if maximum is not None else f'{label}须为非负有限数值')
    return value


def normalize_items(items,label):
    if not isinstance(items,list) or len(items)>50:
        raise ValueError(f'{label}最多记录50项')
    result=[];seen=set()
    for item in items:
        if not isinstance(item,dict) or set(item)-{'name','concentration','unit'}:
            raise ValueError(f'{label}记录格式不正确')
        name=text(item.get('name',''),f'{label}名称',200)
        concentration=number(item.get('concentration',''),f'{label}浓度')
        unit=text(item.get('unit',''),f'{label}浓度单位',80)
        if not name:raise ValueError(f'请填写{label}名称，或移除空白行')
        if concentration and not unit:raise ValueError(f'{name}的浓度需同时填写单位')
        if name.casefold() in seen:raise ValueError(f'{label}名称重复：{name}，请合并或区分名称')
        seen.add(name.casefold());result.append({'name':name,'concentration':concentration,'unit':unit})
    return result


def merge_medium(existing,patch):
    if not isinstance(patch,dict) or not patch or set(patch)-set(DEFAULT):
        raise ValueError('培养基成分须包含有效且已勾选的项目')
    merged={**deepcopy(DEFAULT),**deepcopy(existing or {}),**deepcopy(patch)}
    merged['base']=text(merged['base'],'基础培养基',500)
    for key,label in [('fbs','FBS比例'),('hs','HS比例')]:merged[key]=number(merged[key],label,Decimal(100))
    if sum(Decimal(merged[k] or '0') for k in ['fbs','hs'])>100:
        raise ValueError('FBS与HS比例之和不能超过100%')
    for key in ['ps','triple','extra']:
        if merged[key] not in ['unknown','yes','no']:
            raise ValueError('添加状态须为未记录、添加或不添加')
    if 'extra' in patch and merged['extra']!='yes' and 'additives' not in patch:
        merged['additives']=[]
    merged['cytokines']=normalize_items(merged['cytokines'],'细胞因子')
    merged['additives']=normalize_items(merged['additives'],'额外添加剂')
    if merged['extra']!='yes' and merged['additives']:
        raise ValueError('填写额外添加剂时须选择“添加”')
    return merged


def medium_summary(value):
    if not value:return '未记录培养基成分'
    parts=[];labels={'base':'基础培养基','fbs':'FBS','hs':'HS','ps':'双抗 P/S','triple':'三抗','extra':'额外添加剂'}
    states={'unknown':'未记录','yes':'添加','no':'不添加'}
    for key,label in labels.items():
        if key not in value:continue
        v=value[key]
        rendered=states.get(v,'未记录') if key in states_keys() else (v+'%' if key in ['fbs','hs'] and v else v or '未记录')
        parts.append(f'{label}：{rendered}')
    for key,label in [('cytokines','细胞因子'),('additives','添加剂明细')]:
        if key in value:
            parts.append(label+'：'+('；'.join(x['name']+' '+(x['concentration']+' '+x['unit'] if x['concentration'] else '浓度未记录') for x in value[key]) or '未记录'))
    return '\n'.join(parts)


def states_keys():return ('ps','triple','extra')


def recipe_key(recipe):
    """Compare saved recipes without changing display spelling, precision or units."""
    def amount(value):
        return Decimal(value) if value else None

    def ingredients(items):
        return tuple(sorted((item['name'].casefold(), amount(item['concentration']), item['unit'])
                            for item in items))

    return (recipe['base'].casefold(), amount(recipe['fbs']), amount(recipe['hs']),
            recipe['ps'], recipe['triple'], ingredients(recipe['cytokines']),
            recipe['extra'], ingredients(recipe['additives']))


def saved_media(containers):
    for container in containers:
        yield container.get('medium_defaults')
        for well in container['wells'].values():
            yield well.get('medium')
            for part in well.get('components', []):
                yield part.get('source_medium') or part.get('medium')
