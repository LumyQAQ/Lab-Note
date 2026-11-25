"""Local, transactional culture records. No network dependencies."""
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager, closing
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path
from platform_config import TZ
from medium import merge_medium, recipe_key, saved_media
from cell_count import normalize_count
from group_units import DISH_TYPES, GROUP_TYPES, group_keys, group_quantity, member_active, normalize_quantity, resize_members
from manual_groups import apply_merge, apply_unmerge, begin_projection, commit_projection, get_display_group

LAYOUTS = {'6孔板': (2, 3), '12孔板': (3, 4), '24孔板': (4, 6),
           '48孔板': (6, 8), '96孔板': (8, 12),
           '白底96孔板': (8, 12), '黑底96孔板': (8, 12)}
TYPES = ['T25', 'T75', 'T175', *DISH_TYPES, *LAYOUTS]
FIELDS = ['cell', 'kind', 'batch', 'day0', 'anchor', 'treatment',
          'concentration', 'treated_at', 'notes', 'experiment']
WELL_DEFAULT_FIELDS = ['kind','batch','day0','anchor']


def metadata_defaults(well):
    if not well or not well.get('cell') or well.get('components'):
        return {}
    return {key:well[key] for key in WELL_DEFAULT_FIELDS}


def current_time():
    return datetime.now(TZ)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def day_number(start, today):
    result = (date.fromisoformat(today) - date.fromisoformat(start)).days
    if result < 0:
        raise ValueError('Day 0 不能晚于记录日期')
    return result


def coordinates(container_type, quantity=1):
    if container_type not in TYPES:
        raise ValueError('不支持的培养容器')
    quantity = normalize_quantity(container_type, quantity)
    if container_type not in LAYOUTS:
        return group_keys(container_type, quantity)
    rows, cols = LAYOUTS[container_type]
    return [f'{chr(65+r)}{c+1}' for r in range(rows) for c in range(cols)]


def empty_well():
    return {key: '' for key in FIELDS}


def uses_shared_defaults(container):
    return container['type'] in LAYOUTS or group_quantity(container) > 1


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = self.directory / 'culture.sqlite3'
        self.lock = threading.RLock()
        self._recipe_cursor = -1
        self._recipe_last_undo = 0
        self._recipe_cache = {}
        with self.connect() as conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS current_state (
                    id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL,
                    payload TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots (
                    id TEXT PRIMARY KEY, date TEXT NOT NULL, at TEXT NOT NULL,
                    source TEXT NOT NULL, verified INTEGER NOT NULL, state TEXT NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS daily_once ON snapshots(date) WHERE source='auto';
                CREATE TABLE IF NOT EXISTS snapshot_backups (
                    snapshot_id TEXT PRIMARY KEY, filename TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS transfers (
                    id TEXT PRIMARY KEY, at TEXT NOT NULL, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reversals (
                    target_event_id INTEGER PRIMARY KEY, undo_event_id INTEGER UNIQUE NOT NULL, at TEXT NOT NULL);
            ''')
            conn.execute('INSERT OR IGNORE INTO current_state VALUES(1, ?)',
                         (encode({'revision': 0, 'containers': [], 'created_at': current_time().isoformat()}),))
        os.chmod(self.db, 0o600)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.db, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def state(self):
        with self.connect() as conn:
            state = json.loads(conn.execute('SELECT body FROM current_state WHERE id=1').fetchone()[0])
            self.add_plate_defaults(conn, state)
            self.add_well_defaults(conn, state)
            self.add_medium_defaults(conn, state)
            return state

    def add_plate_defaults(self, conn, state):
        # Older records have no editor default. Recover the most recently SAVED
        # time from the audit trail, without altering any well or historical record.
        missing = {c['id']: c for c in state['containers']
                   if c['type'] in LAYOUTS and 'default_treated_at' not in c}
        if not missing:
            return
        for row in conn.execute("SELECT payload FROM events WHERE action='wells' AND id NOT IN (SELECT target_event_id FROM reversals) ORDER BY id DESC"):
            payload = json.loads(row['payload'])
            patch = payload.get('patch', {})
            if payload.get('id') in missing and 'treated_at' in patch:
                missing.pop(payload['id'])['default_treated_at'] = patch['treated_at'].strip()
                if not missing:
                    break
        for container in missing.values():
            container['default_treated_at'] = ''

    def add_well_defaults(self, conn, state):
        missing={c['id']:c for c in state['containers'] if uses_shared_defaults(c) and not c.get('well_defaults')}
        if not missing:
            return
        # First successfully saved group is the template; later exceptions remain local.
        for row in conn.execute("SELECT payload,after_state FROM events WHERE action='wells' AND id NOT IN (SELECT target_event_id FROM reversals) ORDER BY id"):
            payload=json.loads(row['payload']);cid=payload.get('id')
            if cid not in missing:
                continue
            historic=next((c for c in json.loads(row['after_state'])['containers'] if c['id']==cid),None)
            if historic:
                candidate=next((metadata_defaults(historic['wells'].get(k)) for k in payload.get('wells',[]) if metadata_defaults(historic['wells'].get(k))),{})
                if candidate:
                    missing.pop(cid)['well_defaults']=candidate
            if not missing:
                break
        for c in missing.values():
            c['well_defaults']=next((metadata_defaults(w) for w in c['wells'].values() if metadata_defaults(w)),{})

    def cell_names(self):
        return self.field_history('cell')

    def add_medium_defaults(self, conn, state):
        missing={c['id']:c for c in state['containers'] if uses_shared_defaults(c) and not c.get('medium_defaults')}
        if not missing:return
        # Recover the first saved recipe for old plates, including recipes first
        # established by an explicit transfer/copy. Do not rewrite actual wells.
        for row in conn.execute("SELECT after_state FROM events WHERE action!='undo' AND id NOT IN (SELECT target_event_id FROM reversals) ORDER BY id"):
            for historical in json.loads(row['after_state'])['containers']:
                if historical['id'] not in missing:continue
                recipe=next((w['medium'] for w in historical['wells'].values() if w.get('medium')),None)
                if recipe:missing.pop(historical['id'])['medium_defaults']=deepcopy(recipe)
            if not missing:break
        for c in missing.values():
            c['medium_defaults']=deepcopy(next((w['medium'] for w in c['wells'].values() if w.get('medium')),{}))

    def treatments(self):
        return self.field_history('treatment')

    def medium_recipes(self):
        """Read actual saved mixtures, including recipes later replaced or cleared."""
        with self.lock, self.connect() as conn:
            conn.execute('BEGIN')
            newest, last_undo = conn.execute(
                'SELECT COALESCE(MAX(id),0), (SELECT COALESCE(MAX(undo_event_id),0) FROM reversals) FROM events'
            ).fetchone()
            if newest != self._recipe_cursor or last_undo != self._recipe_last_undo:
                rebuild = newest < self._recipe_cursor or last_undo != self._recipe_last_undo
                cursor = -1 if rebuild else self._recipe_cursor
                history = {} if rebuild else self._recipe_cache.copy()

                def remember(containers):
                    for medium in saved_media(containers):
                        if medium and medium.get('base'):
                            recipe = merge_medium(None, medium)
                            history.setdefault(recipe_key(recipe), recipe)

                # A submitted patch can contain just one changed serum percentage.
                # Only the resulting saved observation represents a reusable mixture.
                for row in conn.execute("""SELECT json_extract(after_state,'$.containers') FROM events
                        WHERE id > ? AND action IN ('create','wells','activity','transfer','relocate','lab_record_save')
                        AND id NOT IN (SELECT target_event_id FROM reversals) ORDER BY id""", (cursor,)):
                    remember(json.loads(row[0]))
                current = conn.execute("SELECT json_extract(body,'$.containers') FROM current_state").fetchone()
                remember(json.loads(current[0]))
                self._recipe_cache = history
                self._recipe_cursor, self._recipe_last_undo = newest, last_undo
            return deepcopy(list(reversed(self._recipe_cache.values())))

    def medium_history(self):
        history={'bases':[],'cytokines':[],'additives':[],'additive_entries':[]};seen={key:set() for key in history}
        def add(key,value):
            if isinstance(value,str) and value.strip() and value.strip().casefold() not in seen[key]:
                history[key].append(value.strip());seen[key].add(value.strip().casefold())
        def read(medium):
            if not isinstance(medium,dict):return
            add('bases',medium.get('base'))
            for key in ['cytokines','additives']:
                for item in medium.get(key,[]):
                    name=item.get('name') if isinstance(item,dict) else None
                    if not isinstance(name,str) or not name.strip():continue
                    name=name.strip();add(key,name)
                    if key=='additives':
                        dose=item.get('concentration','').strip()
                        unit=item.get('unit','').strip()
                        signature=(name.casefold(),dose,unit)
                        if signature not in seen['additive_entries']:
                            seen['additive_entries'].add(signature)
                            history['additive_entries'].append({'name':name,'concentration':dose,'unit':unit})
        with self.connect() as conn:
            conn.execute('BEGIN')
            for row in conn.execute("SELECT action,payload FROM events WHERE action IN ('create','wells','transfer','activity') AND id NOT IN (SELECT target_event_id FROM reversals) ORDER BY id DESC"):
                payload=json.loads(row['payload'])
                if row['action']=='create':read(payload.get('medium'))
                elif row['action']=='wells':read(payload.get('patch',{}).get('medium'))
                elif row['action']=='activity':read(payload.get('medium_patch'))
                else:
                    for target in payload.get('targets',[]):
                        if target.get('occupied_action')=='link':continue
                        if target.get('cultivation_mode')=='custom':read(target.get('cultivation',{}).get('medium'))
            state=json.loads(conn.execute('SELECT body FROM current_state').fetchone()[0])
            for medium in saved_media(state['containers']):read(medium)
        return history

    def count_history(self):
        history={'concentration_units':[],'total_units':[],'volume_units':[]};seen={k:set() for k in history}
        def read(value):
            if not isinstance(value,dict) or value.get('mode') not in ['concentration','total']:return
            for key,unit in [(value['mode']+'_units',value.get('unit')),('volume_units',value.get('volume_unit'))]:
                if isinstance(unit,str) and unit.strip() and unit.strip() not in seen[key]:
                    history[key].append(unit.strip());seen[key].add(unit.strip())
        with self.connect() as conn:
            for row in conn.execute("SELECT action,payload FROM events WHERE action IN ('wells','activity','transfer') AND id NOT IN (SELECT target_event_id FROM reversals) ORDER BY id DESC"):
                p=json.loads(row['payload']);read(p.get('patch',{}).get('cell_count') if row['action']=='wells' else p.get('cell_count'))
                if row['action']=='transfer':
                    for target in p.get('targets',[]):
                        if target.get('occupied_action')=='link':continue
                        if target.get('seeding'):read({**target['seeding'],'mode':'total'})
            state=json.loads(conn.execute('SELECT body FROM current_state').fetchone()[0])
            for c in state['containers']:
                for w in c['wells'].values():
                    read(w.get('cell_count'))
                    if w.get('seeding'):read({**w['seeding'],'mode':'total'})
        return history

    def field_history(self, field):
        names, seen = [], set()
        def add(name):
            if isinstance(name,str) and name.strip() and name.strip().casefold() not in seen:
                names.append(name.strip())
                seen.add(name.strip().casefold())
        with self.connect() as conn:
            # Saved edits form the persistent catalogue, even if a well was later
            # cleared or renamed. Most recently saved spelling wins.
            for row in conn.execute("SELECT action,payload FROM events WHERE action IN ('wells','transfer','activity') AND id NOT IN (SELECT target_event_id FROM reversals) ORDER BY id DESC"):
                payload=json.loads(row['payload'])
                if row['action']=='wells':
                    add(payload.get('patch',{}).get(field))
                elif row['action']=='activity' and field=='treatment' and payload.get('kind')=='treatment':
                    add(payload.get('treatment'))
                elif row['action']=='transfer' and field=='treatment':
                    for target in payload.get('targets',[]):
                        if target.get('occupied_action')=='link':continue
                        if target.get('cultivation_mode')=='custom':add(target.get('cultivation',{}).get('treatment'))
                        elif 'cultivation_mode' not in target:add(target.get('treatment'))
            state = json.loads(conn.execute('SELECT body FROM current_state WHERE id=1').fetchone()[0])
            for container in state['containers']:
                for well in container['wells'].values():
                    if field=='treatment':add(well.get('treatment'))
                    for part in well.get('components') or [well]:
                        add(part.get(field))
        return names

    def validate_well(self, well):
        if not well['cell']:
            if any(well.values()):
                raise ValueError('请先填写细胞名称；清空孔位请使用“清空所选”')
            return
        if well.get('components'):
            if well['kind'] != '混合培养' or well['anchor'] != '共培养开始':
                raise ValueError('混合孔须保留各来源细胞的身份')
            for component in well['components']:
                self.validate_well(component)
        elif well['kind'] not in ['细胞系', '原代细胞']:
            raise ValueError('请选择细胞系或原代细胞')
        allowed = ['激活扩增'] if well['kind'] == '原代细胞' else ['传代', '复苏']
        if not well.get('components') and well['anchor'] not in allowed:
            raise ValueError('原代细胞以激活扩增计时；细胞系以传代或复苏计时')
        day_number(well['day0'], current_time().date().isoformat())
        if well['treated_at']:
            parsed = datetime.fromisoformat(well['treated_at'])
            if parsed.replace(tzinfo=TZ) > current_time():
                raise ValueError('处理时间不能填写为未来时间；计划请写入备注')

    def mutate(self, action, payload, revision):
        if not isinstance(payload, dict) or not isinstance(revision, int):
            raise ValueError('请求缺少记录版本')
        with self.lock, self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            before = conn.execute('SELECT body FROM current_state WHERE id=1').fetchone()[0]
            state = json.loads(before)
            if state['revision'] != revision:
                raise Conflict('另一窗口已更新记录。请刷新后重新操作；本次修改未写入。')
            if action not in ['merge_groups', 'unmerge_groups', 'well_group_save', 'well_group_remove'] and not get_display_group(state, payload.get('id')):
                self.add_plate_defaults(conn, state)
                self.add_well_defaults(conn, state)
                self.add_medium_defaults(conn, state)
            now = current_time().isoformat()
            review_id=payload.get('check_after')
            review_roots=[]
            if 'check_after' in payload:
                if action not in ['transfer','finish_sampling'] or not isinstance(review_id,str) or not review_id:
                    raise ValueError('操作后核对的容器无效')
                group=get_display_group(state,review_id)
                roots=group['container_ids'] if group else [review_id]
                sources=payload.get('sources',[])
                if not isinstance(sources,list) or not any(isinstance(s,dict) and s.get('id') in roots for s in sources):
                    raise ValueError('只能核对本次来源所属的培养容器')
                review_roots=[c['id'] for c in state['containers'] if c['id'] in roots and c['status']=='active' and any(member_active(w) for w in c['wells'].values())]
                if not review_roots:raise ValueError('没有可核对的在培养来源')
                payload={k:v for k,v in payload.items() if k!='check_after'}
            projection = begin_projection(state, action, payload)
            undo_target=None
            if action == 'merge_groups':
                payload = apply_merge(state, payload, now)
            elif action == 'unmerge_groups':
                payload = apply_unmerge(state, payload)
            elif action == 'well_group_save':
                from well_groups import apply_well_group_save
                payload = apply_well_group_save(state, payload, now)
            elif action == 'well_group_remove':
                from well_groups import apply_well_group_remove
                payload = apply_well_group_remove(state, payload)
            elif action == 'create':
                name = str(payload.get('name', '')).strip()
                kind = payload.get('type', '')
                if not name or len(name) > 120:
                    raise ValueError('容器名称须为 1–120 个字符')
                quantity = normalize_quantity(kind, payload.get('quantity', 1))
                keys = coordinates(kind, quantity)
                recipe = {}
                if 'medium' in payload:
                    recipe = merge_medium(None, payload['medium'])
                    if not recipe['base']:
                        raise ValueError('请填写完全培养基的基础培养基名称')
                state['containers'].append({
                    'id': 'C-' + uuid.uuid4().hex[:10].upper(), 'name': name,
                    'type': kind, 'quantity': quantity, 'location': str(payload.get('location',''))[:300],
                    'status': 'active', 'created_at': now, 'checked_date': '',
                    'default_treated_at': '',
                    'well_defaults': {},
                    'medium_defaults': recipe,
                    'wells': {key: empty_well() for key in keys}})
            elif action == 'undo':
                candidate=self._undo_candidate(conn)
                if not candidate or type(payload.get('target_event_id')) is not int or payload['target_event_id']!=candidate['id']:
                    raise ValueError('只能撤销最近一条尚未撤销的变更；请重新打开撤销预览')
                actual=json.loads(before);expected=json.loads(candidate['after_state'])
                actual.pop('revision',None);expected.pop('revision',None)
                if actual!=expected:raise Conflict('当前状态与撤销目标不一致，未执行回退')
                state=json.loads(candidate['before_state']);state['revision']=revision
                undo_target=candidate['id'];payload={'target_event_id':undo_target,'original_action':candidate['action']}
            elif action == 'activity':
                from workday import apply_activity
                payload=apply_activity(state,payload)
            elif action == 'finish_sampling':
                from finish_sampling import apply_finish_sampling
                payload=apply_finish_sampling(state,payload,now=datetime.fromisoformat(now))
            elif action == 'lab_record_save':
                from lab_records import apply_lab_record
                def source_snapshot(snapshot_id):
                    row=conn.execute('SELECT * FROM snapshots WHERE id=?',(snapshot_id,)).fetchone()
                    if not row:raise ValueError('来源快照不存在')
                    result=dict(row);result['state']=json.loads(result['state']);return result
                payload=apply_lab_record(state,payload,source_snapshot)
            elif action == 'check':
                reason=payload.get('reason')
                if 'reason' in payload and reason not in ['no_operation','experiment']:
                    raise ValueError('请选择有效的今日核对原因')
                container=next((c for c in state['containers'] if c['id']==payload.get('id')),None)
                if not container or container['status']!='active' or not any(member_active(w) for w in container['wells'].values()):
                    raise ValueError('只能核对已填写细胞的在培养容器')
                container['checked_date']=current_time().date().isoformat()
                payload={'id':container['id'],'name':container['name'],'checked_date':container['checked_date']}
                if reason is not None:payload['reason']=reason
            elif action == 'transfer':
                from transfer import apply_transfer
                if 'finish_sampling' in payload and (payload.get('end_sources') or payload.get('end_members')):
                    raise ValueError('统一操作预览只能使用一份结束培养列表')
                record = apply_transfer(state, payload, self.validate_well)
                if 'finish_sampling' in payload:
                    from finish_sampling import apply_finish_sampling
                    if record['mode']=='replate':
                        from replate import finish_replate_sampling
                        endings=finish_replate_sampling(state,payload['finish_sampling'],record,now=datetime.fromisoformat(now))
                    else:
                        endings=apply_finish_sampling(state,payload['finish_sampling'],now=datetime.fromisoformat(now))
                    if datetime.fromisoformat(endings['at']) < datetime.fromisoformat(record['at']):
                        raise ValueError('结束培养时间不能早于本次转移操作时间')
                    members={item['id']:set(item['wells']) for item in endings['ended_members']}
                    if any(target['id'] in endings['end_sources'] and
                           (target['id'] not in members or target['well'] in members[target['id']])
                           for target in record['targets']):
                        raise ValueError('本次目标培养单元不能同时结束培养')
                    record['post_operation_endings']=endings
                    payload={**payload,'finish_sampling':endings}
                from well_groups import reconcile_transfer_groups
                reconcile_transfer_groups(state, json.loads(before), record, now)
                conn.execute('INSERT INTO transfers VALUES(?,?,?)', (record['id'],record['at'],encode(record)))
                payload = {**payload, 'mode':record['mode'], 'transfer_id':record['id']}
            elif action == 'relocate':
                from relocation import apply_relocation
                record = apply_relocation(state, payload)
                from well_groups import reconcile_transfer_groups
                reconcile_transfer_groups(state, json.loads(before), record, now)
                conn.execute('INSERT INTO transfers VALUES(?,?,?)', (record['id'],record['at'],encode(record)))
                payload = {**payload, 'transfer_id':record['id']}
            elif action == 'confirm':
                active = [c for c in state['containers'] if c['status'] == 'active']
                if not active or any(not any(member_active(w) for w in c['wells'].values()) for c in active):
                    raise ValueError('请先为每个在培养容器填写细胞，或将空容器结束培养')
                for container in active:
                    container['checked_date'] = current_time().date().isoformat()
            else:
                container = next((c for c in state['containers'] if c['id'] == payload.get('id')), None)
                if not container:
                    raise ValueError('找不到该培养容器')
                if action in ['wells', 'clear']:
                    if container['status'] != 'active' and not (action == 'clear' and container['type'] in GROUP_TYPES):
                        raise ValueError('结束培养的容器为只读；恢复培养后可编辑')
                    keys = payload.get('wells')
                    if not isinstance(keys, list) or not keys or any(not isinstance(k, str) or k not in container['wells'] for k in keys):
                        raise ValueError('请选择有效孔位')
                    patch = payload.get('patch', {})
                    if not isinstance(patch, dict) or set(patch) - (set(FIELDS)|{'medium','cell_count'}):
                        raise ValueError('未知的孔位字段')
                    if action == 'wells' and not patch:
                        raise ValueError('请至少选择一个要修改的字段')
                    if any(not isinstance(v, str) or len(v) > 5000 for k,v in patch.items() if k not in ['medium','cell_count']):
                        raise ValueError('字段需为文本且不超过 5000 字符')
                    for key in set(keys):
                        if action == 'wells' and container['wells'][key].get('member_status') == 'archived':
                            raise ValueError('所选瓶/皿已结束培养；恢复后可编辑，或使用“清空所选”保留历史并清空当前记录')
                        if action == 'wells' and container['wells'][key].get('components') and set(patch) & {'cell','kind','batch','day0','anchor'}:
                            raise ValueError('混合培养孔的细胞身份与Day0分别保存在组成中；请使用传代 / 开展实验继续记录，不能整体覆盖')
                        well = empty_well() if action == 'clear' else {**container['wells'][key], **{k:v.strip() for k,v in patch.items() if k not in ['medium','cell_count']}}
                        if action=='wells' and 'medium' in patch:
                            well['medium']=merge_medium(well.get('medium'),patch['medium'])
                        if action=='wells' and 'cell_count' in patch:
                            count=normalize_count(patch['cell_count'],well)
                            if count is None:well.pop('cell_count',None)
                            else:well['cell_count']=count
                        elif action=='wells' and 'day0' in patch and well.get('cell_count'):
                            try:normalize_count(well['cell_count'],well)
                            except ValueError:
                                raise ValueError('原计数不适用于新的培养起始日期。请在计数区“清除当前计数”或录入本次计数后保存；历史记录会保留。') from None
                        self.validate_well(well)
                        container['wells'][key] = well
                    if action == 'wells' and container['type'] in LAYOUTS and 'treated_at' in patch:
                        container['default_treated_at'] = patch['treated_at'].strip()
                    if action == 'wells' and not projection and uses_shared_defaults(container) and not container.get('well_defaults'):
                        container['well_defaults']=next((metadata_defaults(container['wells'][k]) for k in keys if metadata_defaults(container['wells'][k])),{})
                    if action=='wells' and not projection and uses_shared_defaults(container) and not container.get('medium_defaults'):
                        recipe=next((container['wells'][k]['medium'] for k in keys if container['wells'][k].get('medium')),None)
                        if recipe:container['medium_defaults']=deepcopy(recipe)
                elif action == 'member_status':
                    if container['type'] not in GROUP_TYPES:
                        raise ValueError('只有培养瓶/培养皿组可单独结束或恢复成员')
                    status = payload.get('status')
                    if status not in ['active', 'archived']:
                        raise ValueError('无效的培养状态')
                    keys = payload.get('wells')
                    if not isinstance(keys, list) or not keys or any(not isinstance(k, str) or k not in container['wells'] or not container['wells'][k]['cell'] for k in keys) or len(keys) != len(set(keys)):
                        raise ValueError('请选择有效且已填写细胞的瓶/皿')
                    if status == 'active' and container['status'] == 'archived':
                        # Root-level archive predates member flags. Keep every
                        # unselected occupied member ended when restoring a subset.
                        for well in container['wells'].values():
                            if well['cell']:
                                well['member_status'] = 'archived'
                    for key in keys:
                        container['wells'][key]['member_status'] = status
                    if status == 'active':
                        container['status'] = 'active'
                    elif not any(member_active(w) for w in container['wells'].values()):
                        container['status'] = 'archived'
                elif action == 'status':
                    if payload.get('status') not in ['active', 'archived']:
                        raise ValueError('无效的培养状态')
                    container['status'] = payload['status']
                    occupied = [w for w in container['wells'].values() if w['cell']]
                    if payload['status'] == 'active' and container['type'] in GROUP_TYPES and occupied and not any(member_active(w) for w in occupied):
                        for well in occupied:
                            well['member_status'] = 'active'
                elif action == 'rename':
                    name = str(payload.get('name', '')).strip()
                    if not name or len(name) > 120:
                        raise ValueError('请填写容器名称（最多120字）')
                    kind = payload.get('type',container['type'])
                    quantity = normalize_quantity(kind, payload.get('quantity', group_quantity(container) if kind in GROUP_TYPES else 1))
                    keys = coordinates(kind, quantity)
                    container['wells'] = resize_members(container, kind, quantity, keys, empty_well)
                    container['type'] = kind
                    container['quantity'] = quantity
                    container['name'] = name
                    container['location'] = str(payload.get('location', ''))[:300]
                else:
                    raise ValueError('未知操作')
                container['checked_date'] = ''
            if review_roots:
                checked=[]
                for c in state['containers']:
                    if c['id'] in review_roots and c['status']=='active' and any(member_active(w) for w in c['wells'].values()):
                        c['checked_date']=datetime.fromisoformat(now).date().isoformat();checked.append(c['id'])
                payload={**payload,'check_after':review_id,'checked_after':{'container_ids':checked,'date':datetime.fromisoformat(now).date().isoformat()}}
            payload = commit_projection(state, projection, action, payload)
            if action != 'undo':
                from well_groups import reconcile_well_groups
                reconcile_well_groups(state, now)
            if action in {'wells', 'activity', 'transfer', 'relocate'}:
                from well_groups import split_changed_well_groups
                splits = split_changed_well_groups(state, json.loads(before), now)
                if splits:
                    payload = {**payload, 'well_group_splits': splits}
            if action in ['transfer','relocate','rename']:
                self.add_well_defaults(conn,state)
                self.add_medium_defaults(conn,state)
            state['revision'] += 1
            body = encode(state)
            conn.execute('UPDATE current_state SET body=? WHERE id=1', (body,))
            inserted=conn.execute('INSERT INTO events(at,action,payload,before_state,after_state) VALUES(?,?,?,?,?)',
                         (now, action, encode(payload), before, body))
            if undo_target is not None:
                conn.execute('INSERT INTO reversals VALUES(?,?,?)',(undo_target,inserted.lastrowid,now))
        return state

    def snapshot(self, now=None, source='manual', expected_revision=None):
        now = (now or current_time()).astimezone(TZ)
        day = now.date().isoformat()
        with self.lock, self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            existing = conn.execute("SELECT id FROM snapshots WHERE date=? AND source='auto'", (day,)).fetchone() if source == 'auto' else None
            snapshot = None
            if existing:
                snapshot_id = existing['id']
            else:
                state = json.loads(conn.execute('SELECT body FROM current_state WHERE id=1').fetchone()[0])
                if source=='auto' and state['revision']==0:
                    return None  # A never-used notebook has no day to archive.
                if expected_revision is not None and state['revision'] != expected_revision:
                    raise Conflict('记录已变化，请刷新后再保存快照')
                active = [c for c in state['containers'] if c['status'] == 'active']
                verified = bool(active) and all(c['checked_date'] == day and any(member_active(w) for w in c['wells'].values()) for c in active)
                for container in state['containers']:
                    for well in container['wells'].values():
                        well['day'] = day_number(well['day0'], day) if well['cell'] else None
                        for component in well.get('components',[]):
                            component['day'] = day_number(component['day0'],day)
                snapshot_id = uuid.uuid4().hex
                snapshot = {'id': snapshot_id, 'date': day, 'at': now.isoformat(),
                            'source': source, 'verified': verified, 'state': state}
                conn.execute('INSERT INTO snapshots VALUES(?,?,?,?,?,?)',
                             (snapshot_id, day, snapshot['at'], source, int(verified), encode(state)))
        self.ensure_snapshot_backup(snapshot_id)
        return snapshot

    def ensure_snapshot_backup(self, snapshot_id):
        with self.connect() as conn:
            receipt = conn.execute('SELECT filename FROM snapshot_backups WHERE snapshot_id=?', (snapshot_id,)).fetchone()
        if receipt and (self.directory / 'backups' / receipt['filename']).is_file():
            return
        backup = self.backup()
        with self.connect() as conn:
            conn.execute('INSERT OR REPLACE INTO snapshot_backups VALUES(?,?)', (snapshot_id, backup.name))

    def daily(self, now=None):
        now = (now or current_time()).astimezone(TZ)
        if now.hour < 22:
            return None
        return self.snapshot(now, 'auto')

    def snapshots(self):
        with self.connect() as conn:
            return [{**dict(row), 'verified': bool(row['verified'])} for row in conn.execute(
                'SELECT id,date,at,source,verified FROM snapshots ORDER BY at DESC,rowid DESC')]

    def get_snapshot(self, snapshot_id):
        with self.connect() as conn:
            row = conn.execute('SELECT * FROM snapshots WHERE id=?', (snapshot_id,)).fetchone()
            if row is None:
                raise ValueError('快照不存在')
            result = dict(row)
            result['state'] = json.loads(result['state'])
            result['verified'] = bool(result['verified'])
            return result

    def events(self, container_id=None):
        from workday import event_entry
        with self.connect() as conn:
            state = json.loads(conn.execute('SELECT body FROM current_state').fetchone()[0])
            group = get_display_group(state, container_id)
            related_ids = {container_id, *(group['container_ids'] if group else [])}
            events = []
            for row in conn.execute('SELECT e.*,r.at AS undone_at FROM events e LEFT JOIN reversals r ON r.target_event_id=e.id ORDER BY e.id DESC'):
                event = {key:row[key] for key in ['id','at','action','payload','undone_at']}
                event['payload'] = json.loads(event['payload'])
                event['undone']=bool(event['undone_at'])
                event['entry']=event_entry(conn,row)
                if not container_id or related_ids.intersection(event['entry']['container_ids']) or event['action'] == 'confirm':
                    events.append(event)
                if len(events) >= 200:
                    break
            return events

    def get_transfer(self, transfer_id):
        with self.connect() as conn:
            row = conn.execute('SELECT body FROM transfers WHERE id=?',(transfer_id,)).fetchone()
            if not row:
                raise ValueError('转移凭据不存在')
            record=json.loads(row['body'])
            reversed_row=conn.execute("SELECT r.at FROM events e JOIN reversals r ON r.target_event_id=e.id WHERE json_extract(e.payload,'$.transfer_id')=?",(transfer_id,)).fetchone()
            record['undone']=bool(reversed_row);record['undone_at']=reversed_row['at'] if reversed_row else None
            return record

    def get_lab_record(self,record_id,snapshot_id=None):
        state=self.get_snapshot(snapshot_id)['state'] if snapshot_id else self.state()
        record=next((r for r in state.get('lab_records',[]) if r['id']==record_id),None)
        if not record:raise ValueError('实验记录不存在于所选版本')
        return deepcopy(record)

    def transfers(self, container_id):
        with self.connect() as conn:
            current_state=json.loads(conn.execute('SELECT body FROM current_state').fetchone()[0])
            group=get_display_group(current_state,container_id)
            related_ids={container_id,*(group['container_ids'] if group else [])}
            records = []
            for row in conn.execute('SELECT body FROM transfers ORDER BY rowid DESC'):
                record = json.loads(row['body'])
                if any(x['id'] in related_ids for x in record['sources']+record['targets']):
                    reversed_row=conn.execute("SELECT r.at FROM events e JOIN reversals r ON r.target_event_id=e.id WHERE json_extract(e.payload,'$.transfer_id')=?",(record['id'],)).fetchone()
                    records.append({**{key:record[key] for key in ['id','mode','at','sources','targets']},**({'cell_line_passage':True} if record.get('cell_line_passage') else {}),'undone':bool(reversed_row),'undone_at':reversed_row['at'] if reversed_row else None})
            return records

    def _undo_candidate(self,conn):
        return conn.execute("SELECT e.* FROM events e LEFT JOIN reversals r ON r.target_event_id=e.id WHERE e.action!='undo' AND r.target_event_id IS NULL ORDER BY e.id DESC LIMIT 1").fetchone()

    def undo_info(self):
        from workday import event_entry
        with self.connect() as conn:
            row=self._undo_candidate(conn)
            if not row:return None
            entry=event_entry(conn,row)
            return {'event_id':row['id'],'action':row['action'],'title':entry['title'],'at':row['at'],'containers':entry['containers'],'summary':entry['summary']}

    def workday(self,now=None):
        from workday import build_workday
        with self.connect() as conn:
            conn.execute('BEGIN')
            state=json.loads(conn.execute('SELECT body FROM current_state').fetchone()[0])
            return build_workday(conn,state,now or current_time())

    def activities(self,container_id=None,day=None,max_revision=None):
        from workday import event_rows,event_entry
        with self.connect() as conn:
            rows = list(event_rows(conn,max_revision))
            state = json.loads(rows[0]['after_state']) if max_revision is not None and rows else json.loads(conn.execute('SELECT body FROM current_state').fetchone()[0])
            group = get_display_group(state, container_id)
            related_ids = {container_id, *(group['container_ids'] if group else [])}
            entries=[event_entry(conn,row) for row in rows]
        entries=[e for e in entries if (e['is_operation'] or e['action'] in ['check','confirm'])
                 and (not container_id or related_ids.intersection(e['container_ids'])) and (not day or e['occurred_at'][:10]==day)]
        entries.sort(key=lambda e:(e['occurred_at'],e['event_id']),reverse=True)
        return entries[:200] if day is None else entries

    def backup(self):
        directory = self.directory / 'backups'
        directory.mkdir(exist_ok=True)
        target = directory / f'culture-{current_time():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}.sqlite3'
        temporary = target.with_suffix('.tmp')
        with self.lock, self.connect() as source, closing(sqlite3.connect(temporary)) as destination:
            source.backup(destination)
            if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('备份完整性校验失败')
        os.chmod(temporary, 0o600)
        temporary.replace(target)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        target.with_suffix('.sha256').write_text(f'{digest}  {target.name}\n')
        return target
