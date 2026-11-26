"""Append-only laboratory activities and read-only day summaries."""
import json
import uuid
from copy import deepcopy
from datetime import datetime

from cell_count import normalize_count, count_summary
from medium import merge_medium, medium_summary, number, text
from transfer_cultivation import CULTURE_ACTIONS
from store import TZ, current_time
from group_units import group_quantity, member_active
from manual_groups import display_containers

ACTIVITY_NAMES={'observe':'观察','medium':'换液','medium_change':'换液','topup':'补液','treatment':'添加处理',
                'end_treatment':'结束处理','sample':'取样','count':'细胞计数','note':'其他备注'}
ACTION_NAMES={'create':'新增容器','wells':'更新培养记录','clear':'清空孔位','status':'培养状态变更',
              'rename':'修改容器信息','confirm':'核对全部培养','check':'单独核对容器','undo':'撤销记录修改',
              'transfer':'传代 / 开展实验','relocate':'孔位修正','member_status':'瓶/皿培养状态变更',
              'finish_sampling':'取样后结束培养',
              'well_group_save':'绑定孔位培养组','well_group_remove':'解除孔位培养组绑定',
              'merge_groups':'合并显示培养组','unmerge_groups':'取消显示合并'}


def apply_activity(state,payload,now=None):
    now=now or current_time()
    c=next((c for c in state['containers'] if c['id']==payload.get('id')),None)
    if not c or c['status']!='active':raise ValueError('请选择在培养的容器')
    keys=payload.get('wells',[])
    if not isinstance(keys,list) or not keys or any(not isinstance(k,str) or k not in c['wells'] or not member_active(c['wells'][k]) for k in keys) or len(keys)!=len(set(keys)):
        raise ValueError('请选择有效且仍在培养的已填写培养单元')
    kind=payload.get('kind')
    if kind not in ACTIVITY_NAMES:raise ValueError('请选择有效操作类型')
    at=text(payload.get('occurred_at',''),'实际操作时间',40)
    try:parsed=datetime.fromisoformat(at)
    except ValueError:raise ValueError('请填写实际操作时间') from None
    if parsed.tzinfo is not None or parsed.replace(tzinfo=TZ)>now:raise ValueError('实际操作时间须为已发生的北京时间，不能填写未来时间')
    at=parsed.isoformat(timespec='minutes')
    details=text(payload.get('details',''),'操作说明',5000)
    volume=number(payload.get('volume_value',''),'操作体积')
    volume_unit=text(payload.get('volume_unit',''),'体积单位',100)
    if volume and not volume_unit:raise ValueError('填写操作体积时需同时填写单位')
    treatment=text(payload.get('treatment',''),'处理名称',500)
    concentration=text(payload.get('concentration',''),'处理浓度',500)
    if kind in ['observe','note'] and not details:raise ValueError('请填写观察或操作说明')
    if kind in ['topup','sample'] and not details and not volume:raise ValueError('请填写操作说明或实际体积')
    exchanging=kind in ['medium','medium_change']
    confirm_checked=payload.get('confirm_checked',False)
    if type(confirm_checked) is not bool:raise ValueError('今日核对选项须为勾选或未勾选')
    if not exchanging and kind!='topup' and 'confirm_checked' in payload:raise ValueError('同时核对选项仅用于换液或补液操作')
    exchange_kind=payload.get('exchange_kind','full')
    if exchanging and exchange_kind not in ['full','half']:raise ValueError('请选择换液或半换液')
    if not exchanging and ('exchange_kind' in payload or 'medium_patch' in payload):raise ValueError('换液选项仅用于换液操作')
    medium_results={key:merge_medium(c['wells'][key].get('medium'),payload['medium_patch']) for key in keys} if exchanging and 'medium_patch' in payload else {}
    if kind=='treatment' and not treatment:raise ValueError('请填写新增处理名称')
    ids=payload.get('treatment_ids',[])
    if kind=='end_treatment' and (not isinstance(ids,list) or not ids or any(not isinstance(i,str) for i in ids) or len(set(ids))!=len(ids)):
        raise ValueError('请选择要结束的进行中处理')
    record={'id':c['id'],'name':c['name'],'activity_id':'ACT-'+uuid.uuid4().hex[:16].upper(),
            'kind':kind,'occurred_at':at,'wells':keys,'details':details,'volume_value':volume,
            'volume_unit':volume_unit,'treatment':treatment,'concentration':concentration,
            'treatment_ids':ids if kind=='end_treatment' else [],'cells':[],'ended_treatments':[]}
    if exchanging:
        record['exchange_kind']=exchange_kind
        if 'medium_patch' in payload:record['medium_patch']=deepcopy(payload['medium_patch'])
    for key in keys:
        w=c['wells'][key]
        if (parsed.date().isoformat()<w['day0'] or (w.get('introduced_at') and parsed<datetime.fromisoformat(w['introduced_at']))
                or (exchanging and (any(part.get('day0','')>parsed.date().isoformat() for part in w.get('components',[]))
                    or (w.get('experiment_started_at') and parsed<datetime.fromisoformat(w['experiment_started_at']))))):
            raise ValueError('操作时间不能早于所选培养记录的起始时间')
        record['cells'].append({'well':key,'cell':w['cell'],'batch':w['batch'],'day0':w['day0']})
        if key in medium_results:
            w['medium']=deepcopy(medium_results[key])
        if kind=='treatment':
            w.setdefault('active_treatments',[]).append({'id':record['activity_id'],'name':treatment,'concentration':concentration,'started_at':at})
        elif kind=='end_treatment':
            active={item['id']:item for item in w.get('active_treatments',[])}
            if any(i not in active for i in ids):raise ValueError(f'{key} 没有所选的进行中处理，请调整孔位选择')
            if any(parsed<datetime.fromisoformat(active[i]['started_at']) for i in ids):raise ValueError('结束时间不能早于处理开始时间')
            record['ended_treatments'].extend({'well':key,**deepcopy(active[i])} for i in ids)
            w['active_treatments']=[item for item in w.get('active_treatments',[]) if item['id'] not in ids]
        elif kind=='count':
            value=payload.get('cell_count')
            if not isinstance(value,dict) or value.get('clear'):raise ValueError('请填写本次真实计数结果')
            measured=value.get('measured_at')
            if measured and datetime.fromisoformat(measured).replace(second=0,microsecond=0)!=parsed.replace(second=0,microsecond=0):
                raise ValueError('计数时间应与本次操作时间一致')
            w['cell_count']=normalize_count({**value,'measured_at':at},w,now)
            record['cell_count']=deepcopy(w['cell_count'])
    c['checked_date']=now.astimezone(TZ).date().isoformat() if confirm_checked else ''
    if confirm_checked:record['checked_date']=c['checked_date']
    return record


def event_entry(conn,row,cache=None):
    row=dict(row);p=json.loads(row['payload']);action=row['action']
    occurred=row['at'];summary='';title=ACTION_NAMES.get(action,action);operation=False
    containers=[];keys=p.get('wells',[])
    before=after=None;post_endings=None
    def states():
        nonlocal before,after
        if before is None:
            snapshots = row if 'before_state' in row else conn.execute(
                'SELECT before_state,after_state FROM events WHERE id=?', (row['id'],)
            ).fetchone()
            before = json.loads(snapshots['before_state'])
            after = json.loads(snapshots['after_state'])
        return before,after
    def names(ids):
        b,a=states();lookup={c['id']:c['name'] for c in b['containers']+a['containers']}
        lookup.update({g['id']:g['name'] for g in b.get('display_groups',[])+a.get('display_groups',[])})
        return [{'id':cid,'name':lookup.get(cid,cid)} for cid in dict.fromkeys(ids)]
    if action in ['well_group_save', 'well_group_remove']:
        containers = names([p['id']])
        if action == 'well_group_save' and p.get('change') == 'update':
            title = '编辑孔位培养组绑定'
        summary = p['name'] + '：' + '、'.join(keys) + '；各孔培养记录与历史保留'
    elif action in ['merge_groups','unmerge_groups']:
        containers=names([p['id'], *p.get('container_ids',[]), *p.get('previous_container_ids',[])])
        if action=='merge_groups' and p.get('change')=='update':title='编辑显示分组'
        summary=p['name']+'；原始瓶/皿记录与历史保留'
    elif action=='lab_record_save':
        from lab_records import load_schema
        module=load_schema()['modules'][p['record_type']]
        title=('新增' if p['change']=='create' else '更新')+module['label']+'记录'
        summary=p['title']+' · '+dict(module['statuses'])[p['status']]+' · 记录日期 '+p['record_date']+' · v'+str(p['version'])
        b,a=states();record=next((r for r in a.get('lab_records',[]) if r['id']==p['record_id']),{})
        containers=list({s['container_id']:{'id':s['container_id'],'name':s['container_name']} for s in record.get('all_cell_sources',[])}.values())
    elif action=='cryo_setup_preset':
        title='初始化冻存设备与盒位'
        summary=f"{p['device_name']}{(' / '+p['rack_name']) if p.get('rack_name') else ''} · {p['box_count']} 盒（{p['grid']}）"
    elif action in ('cryo_device_save','cryo_device_delete'):
        title='删除冻存设备' if action.endswith('delete') else ('修改冻存设备' if p.get('change')=='update' else '新增冻存设备')
        summary=p.get('name','')
    elif action in ('cryo_rack_save','cryo_rack_delete'):
        title='删除冻存吊 / 架' if action.endswith('delete') else ('修改冻存吊 / 架' if p.get('change')=='update' else '新增冻存吊 / 架')
        summary=p.get('name','') + (f" · 生成 {len(p['box_ids'])} 盒" if p.get('box_ids') else '')
    elif action in ('cryo_box_save','cryo_box_delete'):
        title='删除冻存盒' if action.endswith('delete') else ('修改冻存盒' if p.get('change')=='update' else '新增冻存盒')
        summary=p.get('name','')
    elif action=='cryo_stock_create':
        title='登记已有冻存库存';operation=True;occurred=p.get('at') or occurred
        summary=f"{p['name']} · {p['vials']} 管" + (f" · 已落位 {p['placed']} 管" if p.get('placed') else '')
    elif action=='cryo_place_vials':
        title='冻存管入盒落位';operation=True
        summary=f"{p['name']} · 落位 {p['placed']} 管" + (f" · {p['location']}" if p.get('location') else '')
    elif action=='cryo_move_slots':
        title='调整冻存格位';operation=True
        summary=f"移动 {p['moved']} 管"
    elif action=='cryo_batch_update':
        title='修改冻存信息'
        summary=p.get('name','')
        if p.get('split_from_lot_id'):
            title='拆分冻存批次并修改信息'
            summary += f" · 拆分 {p['split_count']} 管 · {p['split_from_lot_id']} → {p['lot_id']}"
    elif action=='cryo_mark_contamination':
        title='撤销冻存复苏污染标记' if p.get('cleared') else '标记复苏后细胞污染';operation=True
        occurred=p.get('at') or occurred
        summary=p.get('name','') + (f" · {p['kind']}" if p.get('kind') else '')

    elif action in ('cryo_discard_vials','cryo_withdraw_vials'):
        title='废弃冻存管' if action=='cryo_discard_vials' else ('取出并复苏' if p.get('mode')=='thaw' else '取出冻存管')
        occurred=p.get('at') or occurred
        operation=True
        summary=f"{p['name']} · {p['vials']} 管 · 剩余 {p['remaining']} 管"
        if p.get('slots'):
            summary+=' · 格位 '+'、'.join(f"{slot['box_name']}/{slot['slot']}" for slot in p['slots'])
        if p.get('reason'):summary+=' · '+p['reason']
    elif action=='finish_sampling':
        occurred=p['at'];operation=True
        containers=names(p['end_sources'])
        ended=[s for s in p['sources'] if s['id'] in p['end_sources']]
        keys=list(dict.fromkeys(s['well'] for s in ended))
        members={m['id'] for m in p.get('ended_members',[])}
        details=[('结束瓶/皿：' if c['id'] in members else '结束培养：')+c['name']+' / '+
                 '、'.join(s['well'] for s in ended if s['id']==c['id']) for c in containers]
        if p.get('experiment_ids'):details.append('关联实验记录：'+'、'.join(p['experiment_ids']))
        if p.get('notes'):details.append(p['notes'])
        summary='\n'.join(details)
    elif action=='activity':
        occurred=p['occurred_at'];title=ACTIVITY_NAMES[p['kind']];operation=True
        if p['kind'] in ['medium','medium_change'] and p.get('exchange_kind')=='half':title='半换液'
        containers=[{'id':p['id'],'name':p['name']}]
        items=[p.get('details','')]
        if p.get('volume_value'):items.append(p['volume_value']+' '+p.get('volume_unit',''))
        if p['kind']=='treatment':items.insert(0,p['treatment']+' '+p.get('concentration',''))
        if p['kind']=='end_treatment':items.insert(0,'结束：'+'、'.join(dict.fromkeys(t['name'] for t in p.get('ended_treatments',[]))))
        if p.get('cell_count'):items.insert(0,count_summary(p['cell_count']))
        if p.get('medium_patch'):items.append(medium_summary(p['medium_patch']))
        if p.get('checked_date'):items.append('同时确认今日核对：'+p['checked_date'])
        summary='\n'.join(x for x in items if x)
    elif action in ['transfer','relocate']:
        transfer=conn.execute('SELECT body FROM transfers WHERE id=?',(p.get('transfer_id'),)).fetchone()
        if transfer:
            t=json.loads(transfer['body']);occurred=t['at']
            has_endings=bool(t.get('post_operation_endings') or t.get('ended_sources') or t.get('ended_members'))
            operation=action=='transfer' and (t['mode']!='relink' or has_endings)
            title={'passage':'传代扩增','seed':'实验分装','mix':'合并培养','replate':'移孔换液','relink':'补充/更正来源关联','copy':'复制孔位信息','move':'移动孔位信息'}[t['mode']]
            if t.get('collection_groups'):
                title='合并收集 / 扩孔' if all(target.get('operation')=='expand' for target in t['targets']) else '移孔换液 / 扩孔'
            if t.get('cell_line_passage'):
                title = '孔板传代'
            actions = list(dict.fromkeys(CULTURE_ACTIONS[x['culture_action']] for x in t['targets'] if x.get('culture_action') in CULTURE_ACTIONS))
            if actions:
                title = ' / '.join(actions)
            if any(target.get('operation') == 'append' for target in t['targets']):
                title += ' / 加入共培养'
            if t['mode']=='relink' and has_endings:title+='并结束培养'
            containers=list({x['id']:{'id':x['id'],'name':x['name']} for x in t['sources']+t['targets']}.values())
            summary=' + '.join(s['name']+'/'+s['well'] for s in t['sources'])+' → '+'、'.join(x['name']+'/'+x['well'] for x in t['targets'])
            if any(x.get('operation') in ['link','replace','append'] for x in t['targets']):
                labels={'link':'补充/更正来源关联','replace':'替换现有细胞','append':'加入共培养','seed':'转移至空孔','replate':'移孔换液','expand':'合并收集 / 扩孔','move':'移动孔位','copy':'复制孔位'}
                summary+='\n'+'；'.join(x['name']+'/'+x['well']+'：'+labels.get(x.get('operation'), x.get('operation', '转移')) for x in t['targets'])
            post_endings=t.get('post_operation_endings')
            if post_endings:
                ended_containers=names(post_endings['end_sources'])
                containers=list({c['id']:c for c in containers+ended_containers}.values())
                ended=[s for s in post_endings['sources'] if s['id'] in post_endings['end_sources']]
                keys=list(dict.fromkeys(keys+[s['well'] for s in ended]))
                details=[c['name']+' / '+'、'.join(s['well'] for s in ended if s['id']==c['id']) for c in ended_containers]
                summary+='\n取样后结束培养（'+post_endings['at']+'）：'+'；'.join(details)
                if post_endings['experiment_ids']:summary+='\n关联实验记录：'+'、'.join(post_endings['experiment_ids'])
                if post_endings['notes']:summary+='\n'+post_endings['notes']
    elif action=='create':
        b,a=states();old={c['id'] for c in b['containers']};containers=names([c['id'] for c in a['containers'] if c['id'] not in old]);summary=p.get('name','')
    elif action=='confirm':
        b,a=states();containers=names([c['id'] for c in a['containers'] if c['status']=='active']);summary='用户核对全部在培养容器'
    elif action=='undo':
        target=conn.execute('SELECT * FROM events WHERE id=?',(p.get('target_event_id'),)).fetchone()
        if target:
            original=event_entry(conn,target,cache);containers=original['containers'];summary=f'撤销 #{target["id"]}：{original["title"]}；原日志与快照保留'
    else:
        containers=names([p['id']]) if p.get('id') else []
        if action=='check':
            summary={'no_operation':'未操作，确认今日核对','experiment':'已开展实验，确认今日核对'}.get(p.get('reason'),'已检查，无新增状态变化')+'；当天已有操作仍保留'
        elif action=='wells':
            patch=p.get('patch',{})
            if patch.get('cell_count') and not patch['cell_count'].get('clear'):
                title='细胞计数';operation=True;occurred=patch['cell_count']['measured_at'];summary=count_summary(patch['cell_count'])
            else:summary='更新：'+'、'.join({'medium':'培养基','cell_count':'细胞计数','cell':'细胞名称','day0':'Day 0','treatment':'处理说明','notes':'备注','batch':'批次'}.get(k,k) for k in patch)
            if patch.get('day0'):
                summary += ' · Day 0 ' + patch['day0'] + ('（'+patch['anchor']+'）' if patch.get('anchor') else '')
        elif action=='status':summary='结束培养' if p.get('status')=='archived' else '恢复培养'
        elif action=='member_status':summary=('结束所选瓶/皿培养' if p.get('status')=='archived' else '恢复所选瓶/皿培养')+'：'+'、'.join(keys)
        elif action=='rename':summary='容器信息：'+p.get('name','')+(' / '+p['type'] if p.get('type') else '')
        elif action=='clear':summary='清空当前孔位记录，历史保留'
    for split in p.get('well_group_splits', []):
        portions = ' / '.join('、'.join(wells) for wells in split['partitions'])
        summary += f"\n{split['name']}按培养条件拆分为 {portions}"
    if p.get('checked_after',{}).get('container_ids'):
        reviewed=names(p['checked_after']['container_ids'])
        containers=list({c['id']:c for c in containers+reviewed}.values())
        summary+='\n同时确认今日核对：'+'、'.join(c['name'] for c in reviewed)+' · '+p['checked_after']['date']
    if p.get('group_context'):
        context=p['group_context']
        containers=[{'id':context['id'],'name':context['name']}, *[
            {'id':ref['container_id'],'name':ref['container_name']} for ref in context['members'].values()]]
        containers=list({c['id']:c for c in containers}.values())
    return {'event_id':row['id'],'action':action,'title':title,'occurred_at':occurred,'recorded_at':row['at'],
            'container_ids':[c['id'] for c in containers],'containers':containers,'wells':keys,'summary':summary,
            'is_operation':operation,'undone':bool(row.get('undone_at')),'undone_at':row.get('undone_at'),
            'transfer_id':p.get('transfer_id'),'record_id':p.get('record_id'),'group_context':p.get('group_context'),
            **({'experiment_ids':p['experiment_ids'],'notes':p['notes'],'ended_members':p['ended_members']}
               if action=='finish_sampling' else {}),
            **({'post_operation_endings':post_endings} if post_endings else {})}


def event_rows(conn,max_revision=None):
    rows=conn.execute("""SELECT e.id,e.at,e.action,e.payload,
        json_extract(e.after_state,'$.revision') AS revision,
        r.at AS undone_at, json_extract(u.after_state,'$.revision') AS undo_revision
        FROM events e LEFT JOIN reversals r ON r.target_event_id=e.id
        LEFT JOIN events u ON u.id=r.undo_event_id ORDER BY e.id DESC""")
    for row in rows:
        row=dict(row)
        if max_revision is not None:
            if row['revision'] > max_revision:continue
            if row['undo_revision'] is not None and row['undo_revision'] > max_revision:row['undone_at']=None
        yield row


def build_workday(conn,state,now,entries=None):
    day=now.astimezone(TZ).date().isoformat()
    if entries is None:
        entries=[event_entry(conn,row) for row in event_rows(conn,state['revision'])]
    entries=[e for e in entries if e['occurred_at'][:10]==day]
    entries.sort(key=lambda e:(e['occurred_at'],e['event_id']),reverse=True)
    rows=[]
    for c in display_containers(state):
        related_ids={c['id'], *c.get('container_ids',[])}
        related=[e for e in entries if related_ids.intersection(e['container_ids']) and not e['undone']]
        if c['status']!='active' and not related:continue
        active_members=[w for w in c['wells'].values() if member_active(w)] if c['status']=='active' else []
        rows.append({'id':c['id'],'name':c['name'],'type':c['type'],'status':c['status'],
                     'checked':c['checked_date']==day,'occupied':len(active_members),
                     'quantity':c['quantity'] if c.get('display_group') else group_quantity(c),'total_members':len(c['wells']),'active_members':len(active_members),
                     'new_today':c['created_at'][:10]==day,'operation_count':sum(e['is_operation'] for e in related),
                     'edit_count':sum(not e['is_operation'] and e['action'] not in ['check','confirm','undo'] for e in related),
                     'last_activity':related[0]['occurred_at'] if related else None,
                     'active_treatment_count':sum(len(w.get('active_treatments',[])) for w in active_members)})
    active=[c for c in rows if c['status']=='active']
    snapshot=conn.execute("SELECT id,date,at,verified,json_extract(state,'$.revision') AS revision FROM snapshots WHERE date=? ORDER BY at DESC LIMIT 1",(day,)).fetchone()
    if snapshot:
        snapshot=dict(snapshot);snapshot['up_to_date']=snapshot['revision']==state['revision']
    baseline=conn.execute('SELECT id,date,at FROM snapshots WHERE date<? ORDER BY date DESC,at DESC LIMIT 1',(day,)).fetchone()
    return {'date':day,'revision':state['revision'],'counts':{'active':len(active),'pending':sum(not c['checked'] for c in active),
            'checked':sum(c['checked'] for c in active),'operations':sum(e['is_operation'] and not e['undone'] for e in entries),
            'edits':sum(not e['is_operation'] and not e['undone'] and e['action'] not in ['check','confirm','undo'] for e in entries)},
            'containers':rows,'timeline':deepcopy(entries[:200]),'snapshot':snapshot,'baseline':dict(baseline) if baseline else None}
