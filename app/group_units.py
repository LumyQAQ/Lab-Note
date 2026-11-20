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
    lost=[key for key,w in container['wells'].items() if w.get('cell') and key not in keys]
    if lost:raise ValueError('新容器无法保留已填写培养单元：'+', '.join(lost))
    return {key:container['wells'].get(key,empty_factory()) for key in keys}
