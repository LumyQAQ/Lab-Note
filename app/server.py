#!/usr/bin/env python3
"""Desktop loopback notebook with optional paired HTTPS access."""
import argparse
import base64
import binascii
import csv
import errno
import hashlib
import hmac
import re
import html
import io
import json
import os
import secrets
import socket
import sqlite3
import sys
import subprocess
import threading
import traceback
import zipfile
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import date
from urllib.parse import urlparse, parse_qs, quote

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0,str(ROOT))
from store import Store, Conflict, current_time, day_number, TYPES, LAYOUTS
from medium import medium_summary
from cell_count import count_summary,estimate_total,seeding_summary
from lab_records import load_schema
from lab_exports import record_html, SOFTWARE_CREDIT
from word_export import make_word, edition_meta, config as word_config
import word_templates
from group_units import member_active
from platform_config import default_data_dir, port_value
from mobile_access import COOKIE, DEVICE_LIFETIME, MobileAccess, MobileListener

DEFAULT_DATA = default_data_dir()
STATIC_MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}
DEVICE_FILES = {'/devices': 'devices.html', '/devices.js': 'devices.js',
                '/devices.css': 'devices.css', '/devices/qr.js': 'vendor/qrcodegen.js'}


def open_local_directory(directory):
    target = Path(directory)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ValueError(f'无法打开或创建备份目录（{target}）：{exc.strerror or exc}') from exc
    if sys.platform == 'darwin':
        result = subprocess.run(['/usr/bin/open', str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace').strip()
            raise ValueError(f'无法在访达中打开目录：{err or target}')
    elif os.name == 'nt':
        os.startfile(str(target))
    else:
        subprocess.Popen(['xdg-open', str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return target


def pick_local_directory(initial_dir=None):
    init = Path(initial_dir) if initial_dir else None
    if sys.platform == 'darwin':
        if init and init.is_dir():
            cmd = [
                '/usr/bin/osascript',
                '-e', 'on run argv',
                '-e', 'activate',
                '-e', 'set defaultLoc to POSIX file (item 1 of argv)',
                '-e', 'return POSIX path of (choose folder with prompt "选择 Lab Note 本地备份目录" default location defaultLoc)',
                '-e', 'end run',
                str(init),
            ]
        else:
            cmd = [
                '/usr/bin/osascript',
                '-e', 'activate',
                '-e', 'return POSIX path of (choose folder with prompt "选择 Lab Note 本地备份目录")',
            ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired as exc:
            raise ValueError('等待选择文件夹超时，请重试或直接手动输入路径。') from exc
        if proc.returncode != 0:
            stderr = (proc.stderr or '').strip()
            if '-128' in stderr or 'User canceled' in stderr or '用户已取消' in stderr:
                return None
            raise ValueError(f'无法打开系统文件夹选择器：{stderr or "请直接手动输入备份目录路径。"}')
        chosen = (proc.stdout or '').strip()
        if not chosen:
            return None
        return str(Path(chosen).resolve(strict=False))
    if os.name == 'nt':
        env = dict(os.environ)
        if init and init.is_dir():
            env['LAB_NOTE_INIT_DIR'] = str(init)
        script = (
            'Add-Type -AssemblyName System.Windows.Forms; '
            '$d = New-Object System.Windows.Forms.FolderBrowserDialog; '
            '$d.Description = "选择 Lab Note 本地备份目录"; '
            'if ($env:LAB_NOTE_INIT_DIR) { $d.SelectedPath = $env:LAB_NOTE_INIT_DIR }; '
            'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
        )
        try:
            proc = subprocess.run(['powershell', '-NoProfile', '-STA', '-Command', script],
                                  capture_output=True, text=True, env=env, timeout=300)
        except subprocess.TimeoutExpired as exc:
            raise ValueError('等待选择文件夹超时，请重试或直接手动输入路径。') from exc
        if proc.returncode != 0:
            raise ValueError('无法打开系统文件夹选择器，请直接手动输入备份目录路径。')
        chosen = (proc.stdout or '').strip()
        return str(Path(chosen).resolve(strict=False)) if chosen else None
    raise ValueError('当前系统暂不支持弹出文件夹选择器，请直接输入备份目录路径。')


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


def make_server(data_dir=DEFAULT_DATA, port=8875, *, mobile_port=8876):
    store = Store(data_dir)
    token = secrets.token_urlsafe(32)
    sharing = MobileAccess(store.directory, mobile_port)

    # ZIP timestamps are deterministic; hash asset bytes so different builds get different URLs.
    static_root = ROOT / 'static'
    def version_asset(match):
        attr, name = match.groups()
        digest = hashlib.sha256((static_root / name).read_bytes()).hexdigest()[:12]
        return f'{attr}="/{name}?v={digest}"'
    index = re.sub(r'(src|href)="/([A-Za-z0-9_.-]+\.(?:js|css))"', version_asset,
                   (static_root/'index.html').read_text(encoding='utf-8')).encode()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body, mime='application/json; charset=utf-8', filename=None, headers=None):
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
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            if filename:
                fallback = re.sub(r'[^A-Za-z0-9_.-]', '_', filename) or 'download'
                self.send_header('Content-Disposition', f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}")
            self.end_headers()
            self.wfile.write(body)

        @property
        def mobile(self):
            return isinstance(self.server, MobileListener)

        def valid_host(self):
            hosts = self.headers.get_all('Host', [])
            if len(hosts) != 1:
                return False
            if self.mobile:
                return 'https://' + hosts[0] == self.server.origin
            port = self.server.server_port
            return hosts[0] in (f'127.0.0.1:{port}',f'localhost:{port}')

        def request_token(self):
            if not self.mobile:
                return token
            device = sharing.credential(self.server, self.headers.get('Cookie'))
            if device:
                return hmac.new(token.encode(), device.encode(), 'sha256').hexdigest()

        def pair_page(self, error='', status=200):
            page = (static_root / 'pair.html').read_text(encoding='utf-8')
            message = f'<p role="alert"><strong>{html.escape(error)}</strong></p>' if error else ''
            return self.send(status, page.replace('<!--error-->', message), 'text/html; charset=utf-8')

        def submit_pairing(self):
            try:
                if self.headers.get_content_type() != 'application/x-www-form-urlencoded':
                    raise ValueError('配对表单格式无效。')
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size <= 2048:
                    raise ValueError('配对表单长度无效。')
                form = parse_qs(self.rfile.read(size).decode(), max_num_fields=3)
                secret = sharing.pair(self.server, form.get('code', [''])[0], form.get('name', [''])[0])
            except ValueError as error:
                return self.pair_page(str(error), 400)
            except OSError:
                return self.pair_page('配对凭据未能保存，请检查电脑存储后重试。', 500)
            cookie = f'{COOKIE}={secret}; Path=/; Max-Age={DEVICE_LIFETIME}; HttpOnly; Secure; SameSite=Strict'
            return self.send(303, b'', 'text/plain', headers={'Location': '/', 'Set-Cookie': cookie})

        def do_GET(self):
            if not self.valid_host():
                return self.send(403, {'error':'工作台地址无效'})
            parsed = urlparse(self.path)
            path = parsed.path
            try:
                if path == '/sw.js':
                    return self.send(200, (static_root / 'sw.js').read_bytes(), 'text/javascript; charset=utf-8',
                                     headers={'Service-Worker-Allowed': '/'})
                if path in ('/notebook.webmanifest','/notebook-256.png','/notebook-512.png'):
                    mime='application/manifest+json' if path.endswith('.webmanifest') else 'image/png'
                    return self.send(200,(ROOT/'static'/path[1:]).read_bytes(),mime)
                csrf = self.request_token()
                if not csrf:
                    if path in ('/', '/index.html', '/pair'):
                        return self.pair_page()
                    return self.send(401, {'error': '请在此设备的工作台首页重新配对。'})
                if self.mobile and (path.startswith(('/devices', '/api/backups/')) or path in
                                    ('/api/sharing', '/api/health', '/api/version', '/api/update-check', '/api/storage-stats', '/api/backup-status', '/api/backup-dir')):
                    return self.send(403, {'error': '请在电脑上管理工作台。'})
                if path == '/api/sharing':
                    return self.send(200, {**sharing.status(), 'token': token})
                if path == '/devices/ca.cer':
                    cert = sharing.certificate()
                    if cert:
                        return self.send(200, cert, 'application/x-x509-ca-cert', 'Lab-Note-CA.cer')
                    return self.send(404, {'error': '开启共享后即可下载证书。'})
                if path in DEVICE_FILES:
                    file = static_root / DEVICE_FILES[path]
                    return self.send(200, file.read_bytes(), STATIC_MIME[file.suffix] + '; charset=utf-8')
                if path == '/api/health':
                    return self.send(200,{'app':'lab-culture-v1','data_dir':str(store.directory),'install_dir':str(ROOT.parent),'pid':os.getpid()})
                if path == '/api/version':
                    from update_check import configured_download_url, configured_repo, read_app_version
                    return self.send(200, {'version': read_app_version(), 'repo': configured_repo(),
                                           'download_url': configured_download_url()})
                if path == '/api/update-check':
                    from update_check import check_for_updates
                    force = parse_qs(parsed.query).get('force', ['0'])[0] in ('1','true','yes')
                    return self.send(200, check_for_updates(force=force))
                if path == '/api/backup-dir':
                    return self.send(200, store.backup_dir_info())
                if path == '/api/backup-status':
                    return self.send(200, store.backup_status())
                if path == '/api/storage-stats':
                    return self.send(200, store.storage_stats())
                if path == '/api/cryo/box-print':
                    from cryo_storage import render_box_print_html
                    query = parse_qs(parsed.query)
                    box_id = query.get('box_id', [''])[0]
                    output = render_box_print_html(store.state(), box_id)
                    return self.send(200, output, 'text/html; charset=utf-8',
                                     'cryo-box.html' if query.get('download')==['1'] else None)
                if path == '/api/state':
                    from update_check import configured_download_url, configured_repo, read_app_version
                    desktop = {}
                    if not self.mobile:
                        desktop = {'github_repo': configured_repo(), 'download_url': configured_download_url(),
                                   'data_dir': str(store.directory), **store.backup_dir_info()}
                    self.send(200, {'app':'lab-culture-v1', 'state':store.state(), 'token':csrf,
                                    'app_version':read_app_version(), 'mobile_client':self.mobile,
                                    'today':current_time().date().isoformat(), 'types':TYPES, 'layouts':LAYOUTS,
                                    'cell_names':store.cell_names(),
                                    'treatments':store.treatments(),
                                    'medium_history':store.medium_history(),
                                    'medium_recipes':store.medium_recipes(),
                                    'count_history':store.count_history(),
                                    'undo':store.undo_info(),'workday':store.workday(),
                                    'lab_schema':load_schema(), 'word_format':word_config(), 'plate_contents_version':2, **desktop})
                elif path == '/api/command-status':
                    request_id = parse_qs(parsed.query).get('request_id', [''])[0]
                    self.send(200, store.command_status(request_id))
                elif path == '/api/snapshots':
                    self.send(200, store.snapshots())
                elif path == '/api/lab/schema':
                    self.send(200,load_schema())
                elif path == '/api/word-templates':
                    self.send(200, word_templates.list_templates(store.directory))
                elif path.startswith('/api/word-templates/') and path.endswith('/download'):
                    tpl_id = path[len('/api/word-templates/'):-len('/download')].strip('/')
                    if not tpl_id or '/' in tpl_id or '..' in tpl_id:
                        raise ValueError('无效模板编号')
                    blob, fname = word_templates.read_template_bytes(store.directory, tpl_id)
                    self.send(200, blob, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fname)
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
                    backup = store.resolve_backup_file(name)
                    if backup is None:
                        return self.send(404, {'error':'备份不存在'})
                    with closing(sqlite3.connect(backup)) as conn:
                        tables={row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                        from state_codec import unpack_state_blob
                        exported = {table:[{col[0]: unpack_state_blob(value) if isinstance(value, bytes) else value
                                            for col, value in zip(cursor.description, row)} for row in cursor]
                                    for table in ['current_state','events','snapshots','transfers','reversals','command_requests']
                                    if table in tables
                                    for cursor in [conn.execute(f'SELECT * FROM {table}')]}
                    buffer = io.BytesIO()
                    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
                        archive.write(backup, 'culture.sqlite3')
                        template_snapshot = backup.with_suffix('.templates.zip')
                        if template_snapshot.is_file() and not template_snapshot.is_symlink():
                            with zipfile.ZipFile(template_snapshot) as templates:
                                for member in templates.infolist():
                                    if member.filename == 'word_templates/registry.json' or re.fullmatch(r'word_templates/TPL-[A-F0-9]{12}\.docx', member.filename):
                                        archive.writestr(member.filename, templates.read(member))
                        archive.writestr('history.json', json.dumps(exported, ensure_ascii=False, indent=2))
                        archive.writestr('original-file.sha256', backup.with_suffix('.sha256').read_text().split()[0]+'  culture.sqlite3\n')
                        archive.writestr('恢复说明.txt', '数据库含完整当前记录、操作历史和每日快照。若包含 word_templates 文件夹，请一并复制到恢复目录以恢复个人模板和默认模板设置。\n将 culture.sqlite3 放入新的恢复目录；运行 python3 server.py --data-dir /恢复目录 --port 8890 验证。不要覆盖正在使用的数据库。完整步骤见程序 README.md。')
                    self.send(200, buffer.getvalue(), 'application/zip', name.replace('.sqlite3','.zip'))
                elif path in ['/', '/index.html', '/theme.js', '/theme-dark.css', '/cryo-print.js', '/groups.js', '/well-groups.js', '/well-groups.css', '/assay-groups.js', '/manual-groups.js', '/manual-groups.css', '/app.js', '/style.css', '/selection.js', '/source-picker.js', '/source-picker.css', '/replate.js', '/replate.css', '/quick-medium.js', '/quick-medium.css', '/transfer.js', '/transfer-cards.js', '/occupied-targets.js', '/occupied-targets.css', '/archived-cultures.js', '/archived-cultures.css', '/lineage-links.js', '/relocation.js', '/relocation.css', '/autocomplete.js', '/medium.js', '/medium.css','/count.js','/count.css','/workday.js','/workday.css','/home.js','/home.css','/experiments.js','/experiments.css','/result-paste.js', '/word-editions.js', '/plate-today.js', '/cryo-storage.js', '/cryo-storage.css']:
                    file = ROOT / 'static' / ('index.html' if path == '/' else path[1:])
                    self.send(200, index if path in ('/','/index.html') else file.read_bytes(), STATIC_MIME[file.suffix] + '; charset=utf-8')
                else:
                    self.send(404, {'error':'页面不存在'})
            except ValueError as error:
                self.send(400, {'error':str(error)})
            except Exception:
                traceback.print_exc()
                self.send(500, {'error':'读取失败，请检查本地服务日志'})

        def do_POST(self):
            if not self.valid_host():return self.send(403,{'error':'工作台地址无效'})
            origins = self.headers.get_all('Origin', [])
            if self.mobile:
                if origins != [self.server.origin]:
                    return self.send(403, {'error':'请从此设备的工作台操作。'})
                if self.path == '/pair':
                    return self.submit_pairing()
                if self.path not in ('/api/command', '/api/snapshot', '/api/lab/word'):
                    return self.send(403, {'error':'请在电脑上管理工作台。'})
            elif origins and origins != ['http://' + self.headers['Host']]:
                return self.send(403, {'error':'请求来源无效，请重新打开工作台。'})
            csrf = self.request_token()
            if not csrf:
                return self.send(401, {'error':'设备授权已失效，请重新配对。'})
            if not secrets.compare_digest(self.headers.get('X-Lab-Token','').encode(),csrf.encode()):
                return self.send(403, {'error':'请求来源无效，请重新打开工作台。'})
            try:
                if self.headers.get_content_type() != 'application/json':
                    return self.send(415, {'error':'需要 JSON 请求'})
                size = int(self.headers.get('Content-Length', '0'))
                max_size = 14 * 1024 * 1024 if self.path == '/api/word-templates/import' else 1000000
                if not 0 < size <= max_size:
                    raise ValueError('请求为空或过大')
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError('无效请求')
                if self.path == '/api/sharing':
                    action = data.get('action')
                    if action == 'start':
                        sharing.start(data.get('address'), Handler, auto_start=data.get('auto_start'))
                    elif action == 'stop':
                        sharing.stop()
                    elif action == 'code':
                        sharing.new_code()
                    elif action == 'revoke':
                        sharing.revoke(data.get('device_id'))
                    elif action == 'autostart':
                        if not isinstance(data.get('enabled'), bool):
                            raise ValueError('请选择是否自动恢复共享。')
                        sharing.set_autostart(data['enabled'])
                    else:
                        raise ValueError('未知设备管理操作')
                    return self.send(200, {**sharing.status(), 'token':token})
                if self.path == '/api/stop':
                    self.send(200,{'stopping':True})
                    self.server.shutdown()
                    return
                if self.path=='/api/lab/word':
                    with store.lock:
                        rec=store.get_lab_record(data.get('record_id'),data.get('snapshot'))
                        if rec['version']!=data.get('version') or rec['updated_at']!=data.get('record_updated_at'):raise Conflict('版本已变化，请重新打开记录')
                        if word_config().get('confirm_before_export') and data.get('format_confirmed') is not True:raise ValueError('请先确认文档格式')
                        tpl=word_templates.resolve_active_template(store.directory, data.get('template_id'))
                        blob=make_word(rec,load_schema(),data.get('format'),template=tpl);ed=edition_meta(rec,blob)
                        result={'edition':ed,'document':base64.b64encode(blob).decode('ascii'),'template_id':tpl['id'],'template_name':tpl['name']}
                        if not data.get('snapshot'):
                            result['state']=store.mutate('word_issue',{'edition':ed},data.get('revision'));result['undo']=store.undo_info()
                        return self.send(200,result)
                if self.path == '/api/word-templates/import':
                    raw_b64 = data.get('content_base64')
                    if not isinstance(raw_b64, str) or not raw_b64.strip():
                        raise ValueError('请上传有效的 .docx 模板文件')
                    try:
                        blob = base64.b64decode(raw_b64, validate=True)
                    except (ValueError, binascii.Error) as exc:
                        raise ValueError('模板文件 Base64 编码无效') from exc
                    if len(blob) > 10 * 1024 * 1024:
                        raise ValueError('模板文件不能超过 10 MiB')
                    with store.lock:
                        entry = word_templates.import_template(
                            store.directory,
                            name=data.get('name', ''),
                            filename=data.get('filename', 'template.docx'),
                            content_bytes=blob,
                            notes=data.get('notes', ''),
                            set_as_default=bool(data.get('set_as_default', False)),
                        )
                        return self.send(200, {'template': entry, **word_templates.list_templates(store.directory)})
                if self.path == '/api/word-templates/default':
                    with store.lock:
                        return self.send(200, word_templates.set_default_template(store.directory, data.get('template_id')))
                if self.path == '/api/word-templates/delete':
                    with store.lock:
                        return self.send(200, word_templates.delete_template(store.directory, data.get('template_id')))
                if self.path == '/api/command':
                    if data.get('action') == 'word_issue':
                        raise ValueError('请从 Word 导出入口生成文档')
                    state = store.mutate(data.get('action'), data.get('payload', {}), data.get('revision'),
                                         client_request_id=data.get('client_request_id'))
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
                elif self.path == '/api/compact':
                    with store.lock:
                        backup = store.backup()
                        result = store.compact_storage(keep_recent=10, vacuum=True)
                    self.send(200, {**result, 'backup':backup.name, 'last_backup':backup.name})
                elif self.path == '/api/backup-dir':
                    if data.get('reset') is True:
                        info = store.set_backup_dir(None)
                    else:
                        if 'path' not in data:
                            raise ValueError('请提供备份目录路径')
                        info = store.set_backup_dir(data.get('path'))
                    self.send(200, info)
                elif self.path == '/api/backup-dir/open':
                    target = open_local_directory(store.backup_dir())
                    self.send(200, {'opened': str(target)})
                elif self.path == '/api/backup-dir/pick':
                    picked = pick_local_directory(store.backup_dir())
                    if not picked:
                        return self.send(200, {'cancelled': True})
                    if data.get('apply') is True:
                        return self.send(200, {'cancelled': False, 'path': picked, **store.set_backup_dir(picked)})
                    self.send(200, {'cancelled': False, 'path': picked})
                elif self.path == '/api/backup':
                    backup = store.backup()
                    self.send(200, {'filename':backup.name,'url':'/api/backups/'+backup.name,'backup_dir':str(backup.parent)})
                else:
                    self.send(404, {'error':'操作不存在'})
            except Conflict as error:
                self.send(409, {'error':str(error), 'conflict':error.conflict})
            except (ValueError, KeyError, TypeError) as error:
                self.send(400, {'error':str(error)})
            except Exception:
                traceback.print_exc()
                self.send(500, {'error':'操作未能完成，请刷新核对记录，并检查服务日志'})

    class LocalListener(ThreadingHTTPServer):
        request_queue_size = 64
        allow_reuse_address = os.name != 'nt'

        def server_close(self):
            try:
                sharing.shutdown()
            finally:
                super().server_close()

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
    sharing.resume_autostart(Handler)
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
