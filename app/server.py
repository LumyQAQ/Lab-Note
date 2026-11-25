#!/usr/bin/env python3
"""Personal notebook served on the loopback interface."""
import argparse
import csv
import errno
import html
import io
import json
import mimetypes
import os
import secrets
import socket
import sqlite3
import sys
import threading
import traceback
import zipfile
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import date
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0,str(ROOT))
from store import Store, Conflict, current_time, day_number, TYPES, LAYOUTS
from medium import medium_summary
from cell_count import count_summary,estimate_total,seeding_summary
from lab_records import load_schema
from lab_exports import record_html, SOFTWARE_CREDIT
from group_units import member_active
from platform_config import default_data_dir, port_value

DEFAULT_DATA = default_data_dir()


def export_rows(state, record_date):
    rows = [['日期', '容器编号', '容器名称', '容器类型', '位置', '培养状态', '孔位',
             '细胞', '类型', '批次', 'Day', 'Day0日期', '计时依据', '特殊处理', '浓度', '处理时间', '观察备注', '关联实验',
             '实验开始时间','组成角色','每个目标加入量','来源','转移凭据','组成原处理',
             '混合来源整份编号','混合来源整份加入量（非组分量）','混合来源角色','孔位修正凭据','培养基成分','组成来源培养基',
             '最近细胞计数','计数适用范围','进行中处理（追加日志）','显示合并组','铺入细胞数（每培养单元）']]
    grouping={cid:g['name'] for g in state.get('display_groups',[]) for cid in g['container_ids']}
    for c in state['containers']:
        for key, w in c['wells'].items():
            if not w['cell']:
                continue
            for part in w.get('components') or [w]:
                day = part.get('day', day_number(part['day0'], record_date))
                refs = [part['origin']] if part.get('origin') else w.get('source_refs',[])
                origin = '; '.join(f'{r["id"]} / {r["well"]}' for r in refs)
                rows.append([record_date, c['id'], c['name'], c['type'], c['location'],
                             '在培养' if c['status'] == 'active' and member_active(w) else '已结束', key,
                             part['cell'], part['kind'], part['batch'], str(day), part['day0'], part['anchor'],
                             w['treatment'], w['concentration'], w['treated_at'], w['notes'], w['experiment'],
                             w.get('experiment_started_at',''),part.get('role',''),part.get('amount',''),origin,
                             w.get('lineage_id',''),part['treatment'] if w.get('components') else '',
                             part.get('aliquot_id',''),part.get('aliquot_amount',''),part.get('aliquot_role',''),w.get('placement_id',''),
                             medium_summary(w.get('medium')),medium_summary(part.get('source_medium')) if w.get('components') else '',
                             count_summary(w.get('cell_count')),'整个培养单元（非单组分计数）' if w.get('components') else '培养单元',
                             '\n'.join(t['name']+' '+t.get('concentration','')+' / 开始 '+t['started_at'] for t in w.get('active_treatments',[])) if c['status']=='active' and member_active(w) else '培养已结束',grouping.get(c['id'],''),seeding_summary(w.get('seeding'))])
    return rows


class PortUnavailable(OSError):
    """The loopback listener could not bind the requested port."""


def make_server(data_dir=DEFAULT_DATA, port=8875):
    store = Store(data_dir)
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body, mime='application/json; charset=utf-8', filename=None):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode() if mime.startswith('application/json') else body.encode()
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.send_header('Referrer-Policy','same-origin')
            self.send_header('Cross-Origin-Resource-Policy','same-origin')
            if filename:
                self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            port = self.server.server_port
            return self.headers.get('Host','') in (f'127.0.0.1:{port}',f'localhost:{port}')

        def do_GET(self):
            if not self.valid_host():
                return self.send(403, {'error':'工作台地址无效'})
            parsed = urlparse(self.path)
            path = parsed.path
            try:
                if path in ('/notebook.webmanifest','/notebook-256.png','/notebook-512.png'):
                    mime='application/manifest+json' if path.endswith('.webmanifest') else 'image/png'
                    return self.send(200,(ROOT/'static'/path[1:]).read_bytes(),mime)
                if path == '/api/health':
                    return self.send(200,{'app':'lab-culture-v1','data_dir':str(store.directory),'pid':os.getpid()})
                if path == '/api/state':
                    backups = sorted(store.directory.joinpath('backups').glob('*.sqlite3'), reverse=True)
                    self.send(200, {'app':'lab-culture-v1', 'state':store.state(), 'token':token,
                                    'today':current_time().date().isoformat(), 'types':TYPES, 'layouts':LAYOUTS,
                                    'cell_names':store.cell_names(),
                                    'treatments':store.treatments(),
                                    'medium_history':store.medium_history(),
                                    'medium_recipes':store.medium_recipes(),
                                    'count_history':store.count_history(),
                                    'undo':store.undo_info(),'workday':store.workday(),
                                    'lab_schema':load_schema(),
                                    'data_dir':str(store.directory), 'last_backup':backups[0].name if backups else None})
                elif path == '/api/snapshots':
                    self.send(200, store.snapshots())
                elif path == '/api/lab/schema':
                    self.send(200,load_schema())
                elif path.startswith('/api/lab/records/'):
                    leaf=path.rsplit('/',1)[-1];record_id,ext=leaf.rsplit('.',1) if '.' in leaf else (leaf,'')
                    snap_id=parse_qs(parsed.query).get('snapshot',[None])[0]
                    record=store.get_lab_record(record_id,snap_id)
                    if ext=='html':self.send(200,record_html(record,load_schema()),'text/html; charset=utf-8',record['id']+'.html')
                    elif ext=='json':self.send(200,json.dumps(record,ensure_ascii=False,indent=2).encode(),'application/json; charset=utf-8',record['id']+'.json')
                    elif not ext:self.send(200,record)
                    else:self.send(404,{'error':'导出格式不存在'})
                elif path.startswith('/api/snapshots/'):
                    self.send(200, store.get_snapshot(path.split('/')[-1]))
                elif path == '/api/events':
                    self.send(200, store.events(parse_qs(parsed.query).get('id',[None])[0]))
                elif path == '/api/workday':
                    self.send(200,store.workday())
                elif path == '/api/activities':
                    self.send(200,store.activities(parse_qs(parsed.query).get('container',[None])[0]))
                elif path == '/api/activities.csv':
                    day=parse_qs(parsed.query).get('date',[current_time().date().isoformat()])[0]
                    date.fromisoformat(day)
                    rows=[['实际发生时间','录入时间','操作','容器','孔位','内容','状态','撤销时间']]
                    for e in store.activities(day=day):
                        rows.append([e['occurred_at'],e['recorded_at'],e['title'],'; '.join(c['name'] for c in e['containers']),', '.join(e['wells']),e['summary'],'已撤销' if e['undone'] else '有效',e['undone_at'] or ''])
                    buffer=io.StringIO();writer=csv.writer(buffer)
                    for row in rows:writer.writerow(["'"+v if v.lstrip().startswith(('=','+','-','@','\t','\r')) else v for v in row])
                    self.send(200,buffer.getvalue().encode('utf-8-sig'),'text/csv; charset=utf-8',f'culture-activities-{day}.csv')
                elif path == '/api/transfers':
                    self.send(200, store.transfers(parse_qs(parsed.query).get('container',[''])[0]))
                elif path.startswith('/api/transfers/'):
                    self.send(200, store.get_transfer(path.rsplit('/',1)[-1]))
                elif path in ['/api/export.csv', '/api/diary.html']:
                    query = parse_qs(parsed.query)
                    snapshot_id = query.get('snapshot',[None])[0]
                    snap = store.get_snapshot(snapshot_id) if snapshot_id else None
                    state = snap['state'] if snap else store.state()
                    day = snap['date'] if snap else current_time().date().isoformat()
                    rows = export_rows(state, day)
                    if path.endswith('.csv'):
                        buffer = io.StringIO()
                        writer = csv.writer(buffer)
                        for row in rows:
                            writer.writerow(["'"+v if v.lstrip().startswith(('=','+','-','@','\t','\r')) else v for v in row])
                        self.send(200, buffer.getvalue().encode('utf-8-sig'), 'text/csv; charset=utf-8', f'culture-{day}.csv')
                    else:
                        table = ''.join('<tr>'+''.join(f'<{"th" if i==0 else "td"}>{html.escape(v)}</{"th" if i==0 else "td"}>' for v in row)+'</tr>' for i,row in enumerate(rows))
                        status = ('已核对' if snap['verified'] else '未核对') if snap else '当前状态导出（非冻结快照）'
                        output = f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>细胞培养日记 {day}</title><style>body{{font:14px system-ui;padding:36px;color:#223d36}}table{{border-collapse:collapse;width:100%;font-size:11px}}td,th{{border:1px solid #bbb;padding:8px;white-space:pre-wrap}}th{{background:#eef3ef}}@media print{{@page{{size:A3 landscape}}}}</style><h1>细胞培养日记 · {day}</h1><p>{status} · Asia/Shanghai · 容器编号与孔位用于实验追溯</p><table>{table}</table></html>'
                        entries=store.activities(day=day,max_revision=state['revision'])
                        journal_rows=''.join('<tr>'+''.join('<td>'+html.escape(v)+'</td>' for v in [e['occurred_at'],e['recorded_at'],e['title'],'; '.join(c['name'] for c in e['containers']),', '.join(e['wells']),e['summary'],'已撤销' if e['undone'] else '有效'])+'</tr>' for e in entries)
                        journal='<h2>当日追加操作与核对</h2><p>截至本记录版本；原日志保留，撤销状态按该版本显示。</p><table><tr><th>发生时间</th><th>录入时间</th><th>类型</th><th>容器</th><th>孔位</th><th>说明</th><th>状态</th></tr>'+journal_rows+'</table>'
                        output=output.replace('</html>',journal+SOFTWARE_CREDIT+'</html>')
                        self.send(200, output, 'text/html; charset=utf-8', f'culture-diary-{day}.html')
                elif path.startswith('/api/backups/'):
                    name = path.rsplit('/', 1)[-1]
                    if not name.startswith('culture-') or not name.endswith('.sqlite3') or '/' in name or '\\' in name or '..' in name:
                        raise ValueError('无效备份名')
                    backup = store.directory / 'backups' / name
                    if not backup.is_file():
                        return self.send(404, {'error':'备份不存在'})
                    with closing(sqlite3.connect(backup)) as conn:
                        tables={row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                        exported = {table:[dict(zip([column[0] for column in cursor.description], row)) for row in cursor]
                                    for table in ['current_state','events','snapshots','transfers','reversals']
                                    if table in tables
                                    for cursor in [conn.execute(f'SELECT * FROM {table}')]}
                    buffer = io.BytesIO()
                    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
                        archive.write(backup, 'culture.sqlite3')
                        archive.writestr('history.json', json.dumps(exported, ensure_ascii=False, indent=2))
                        archive.writestr('original-file.sha256', backup.with_suffix('.sha256').read_text().split()[0]+'  culture.sqlite3\n')
                        archive.writestr('恢复说明.txt', '数据库含完整当前记录、操作历史和每日快照。\n将 culture.sqlite3 放入新的恢复目录；运行 python3 server.py --data-dir /恢复目录 --port 8890 验证。不要覆盖正在使用的数据库。完整步骤见程序 README.md。')
                    self.send(200, buffer.getvalue(), 'application/zip', name.replace('.sqlite3','.zip'))
                elif path in ['/', '/index.html', '/groups.js', '/well-groups.js', '/well-groups.css', '/assay-groups.js', '/manual-groups.js', '/manual-groups.css', '/app.js', '/style.css', '/selection.js', '/source-picker.js', '/source-picker.css', '/replate.js', '/replate.css', '/quick-medium.js', '/quick-medium.css', '/transfer.js', '/transfer-cards.js', '/occupied-targets.js', '/occupied-targets.css', '/archived-cultures.js', '/archived-cultures.css', '/lineage-links.js', '/relocation.js', '/relocation.css', '/autocomplete.js', '/medium.js', '/medium.css','/count.js','/count.css','/workday.js','/workday.css','/home.js','/home.css','/experiments.js','/experiments.css','/result-paste.js']:
                    file = ROOT / 'static' / ('index.html' if path == '/' else path[1:])
                    self.send(200, file.read_bytes(), (mimetypes.guess_type(file)[0] or 'text/plain') + '; charset=utf-8')
                else:
                    self.send(404, {'error':'页面不存在'})
            except ValueError as error:
                self.send(400, {'error':str(error)})
            except Exception:
                traceback.print_exc()
                self.send(500, {'error':'读取失败，请检查本地服务日志'})

        def do_POST(self):
            if not self.valid_host():return self.send(403,{'error':'工作台地址无效'})
            origin = self.headers.get('Origin')
            if ((origin and origin!='http://'+self.headers['Host'])
                    or not secrets.compare_digest(self.headers.get('X-Lab-Token','').encode(),token.encode())):
                return self.send(403, {'error':'请求来源无效，请重新打开工作台。'})
            try:
                if self.headers.get_content_type() != 'application/json':
                    return self.send(415, {'error':'需要 JSON 请求'})
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 1000000:
                    raise ValueError('请求为空或过大')
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError('无效请求')
                if self.path == '/api/stop':
                    self.send(200,{'stopping':True})
                    self.server.shutdown()
                    return
                if self.path == '/api/command':
                    state = store.mutate(data.get('action'), data.get('payload', {}), data.get('revision'))
                    result={'state':state,'undo':store.undo_info(),'workday':store.workday(),
                            'medium_recipes':store.medium_recipes()}
                    if data.get('action')=='undo':
                        result['histories']={'cell_names':store.cell_names(),'treatments':store.treatments(),
                                             'medium_history':store.medium_history(),'count_history':store.count_history()}
                    elif (data['action'] in ('transfer','relocate')
                          or (data['action']=='create' and 'medium' in data['payload'])
                          or (data['action']=='activity' and 'medium_patch' in data['payload'])
                          or (data['action']=='wells' and 'medium' in data['payload'].get('patch',{}))):
                        result['histories']={'medium_history':store.medium_history()}
                    self.send(200,result)
                elif self.path == '/api/snapshot':
                    if not isinstance(data.get('revision'), int):
                        raise ValueError('快照缺少版本')
                    snap = store.snapshot(expected_revision=data['revision'])
                    self.send(200, snap)
                elif self.path == '/api/backup':
                    backup = store.backup()
                    self.send(200, {'filename':backup.name,'url':'/api/backups/'+backup.name})
                else:
                    self.send(404, {'error':'操作不存在'})
            except Conflict as error:
                self.send(409, {'error':str(error)})
            except (ValueError, KeyError, TypeError) as error:
                self.send(400, {'error':str(error)})
            except Exception:
                traceback.print_exc()
                self.send(500, {'error':'操作未能完成，请刷新核对记录，并检查服务日志'})

    class LocalListener(ThreadingHTTPServer):
        request_queue_size = 64
        allow_reuse_address = os.name != 'nt'

        def server_bind(self):
            if os.name=='nt':
                self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
            try:
                super().server_bind()
            except OSError as error:
                if error.errno in (errno.EADDRINUSE,errno.EACCES) or getattr(error,'winerror',None) in (10013,10048):
                    raise PortUnavailable(str(error)) from error
                raise

    server = LocalListener(('127.0.0.1', port), Handler)
    server.store = store
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',type=lambda v: 0 if v=='0' else port_value(v),default=8875)
    parser.add_argument('--ready-file',type=Path,help=argparse.SUPPRESS)
    parser.add_argument('--data-dir', type=Path, default=DEFAULT_DATA)
    parser.add_argument('--daily', action='store_true', help='Create today\'s automatic snapshot if after 22:00')
    args = parser.parse_args()
    if args.daily:
        result = Store(args.data_dir).daily()
        print(json.dumps({'created':bool(result), 'snapshot':result['id'] if result else None,
                          'date':current_time().date().isoformat()}, ensure_ascii=False))
        return
    try:
        server=make_server(args.data_dir,8875 if args.port is None else args.port)
    except PortUnavailable as error:
        if args.port is not None:
            print(f'无法绑定本机端口 {args.port}：{error}',flush=True)
            raise SystemExit(98)
        server=make_server(args.data_dir,0)
    if args.ready_file:
        tmp=args.ready_file.with_suffix('.tmp')
        tmp.write_text(json.dumps({'port':server.server_port,'pid':os.getpid()}),encoding='ascii')
        tmp.replace(args.ready_file)
    def scheduler():
        while True:
            try:
                server.store.daily()
            except Exception:
                traceback.print_exc()
            threading.Event().wait(30)
    threading.Thread(target=scheduler, daemon=True).start()
    print(f'细胞培养工作台 http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
