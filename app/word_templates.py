"""Standard & user-uploaded Word (.docx) experiment record template registry."""
from datetime import datetime
import io
import json
import os
from pathlib import Path
import re
import uuid
import xml.etree.ElementTree as ET
import zipfile
from functools import wraps
from threading import RLock
from platform_config import TZ

ROOT = Path(__file__).resolve().parent
BUILTIN_TEMPLATES_DIR = ROOT / 'templates'
MAX_TEMPLATE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_EXPANDED_BYTES = 40 * 1024 * 1024
_registry_lock = RLock()


def _serialized(fn):
    @wraps(fn)
    def run(*args, **kwargs):
        with _registry_lock:
            return fn(*args, **kwargs)
    return run

BUILTIN_CATALOG = [
    {
        'id': 'builtin-standard-v1',
        'name': 'Lab Note 标准实验记录模版 V1.0（六栏目）',
        'filename': 'LabNote_标准实验记录模版_V1.0_六栏目.docx',
        'description': '官方标准六栏目版式：宋体小四 + Times New Roman 五号 + 中西文一空格 + 页脚页码 + 图件留位。',
        'scope': '通用实验记录（默认导出基准）',
    },
    {
        'id': 'builtin-transwell-v1',
        'name': 'Transwell 初始实验记录模版 V1.0（六栏目）',
        'filename': 'Transwell_初始实验记录模版_V1.0_六栏目.docx',
        'description': '覆盖 Transwell 迁移 / 侵袭 / 间接共培养上下室分组、孔径、Matrigel 包被与染色计数终点。',
        'scope': 'Transwell 实验',
    },
    {
        'id': 'builtin-organoid-v1',
        'name': '类器官培养与共培养初始实验记录模版 V1.0（六栏目）',
        'filename': '类器官培养与共培养_初始实验记录模版_V1.0_六栏目.docx',
        'description': '覆盖类器官来源/代次、Matrigel/BME 液滴比例与体积、培养基因子及免疫细胞共培养 E:T 铺板。',
        'scope': '类器官培养 / 共培养',
    },
]

DEFAULT_SECTIONS = [
    {'key': 'purpose', 'title': '实验目的'},
    {'key': 'materials', 'title': '实验设备及试剂'},
    {'key': 'solutions', 'title': '溶剂配制'},
    {'key': 'steps', 'title': '实验步骤'},
    {'key': 'results', 'title': '实验数据与结果'},
    {'key': 'conclusion', 'title': '本轮总结'},
]

DEFAULT_STYLE = {
    'margin_top': 1020,
    'margin_bottom': 1020,
    'margin_left': 1134,
    'margin_right': 1134,
    'header_fill': 'F0F0F0',
    'title_size': 32,
    'heading_size': 26,
    'body_cjk_size': 24,
    'body_ascii_size': 21,
    'cjk_font': '宋体',
    'ascii_font': 'Times New Roman',
}

_SECTION_HINTS = [
    ('purpose', ('目的', '背景', '简介', '立项', '目标', 'purpose', 'objective')),
    ('materials', ('设备', '试剂', '材料', '耗材', '仪器', '抗体', '引物', 'material', 'reagent')),
    ('solutions', ('溶剂', '配制', '配方', '体系', '缓冲液', 'solution', 'buffer', 'preparation')),
    ('steps', ('步骤', '方法', '流程', '操作', '方案', '铺板', 'protocol', 'method', 'step')),
    ('results', ('数据', '结果', '原始', '分析', '图表', 'result', 'data')),
    ('conclusion', ('总结', '结论', '讨论', '小结', '问题', '下步', '备注', 'conclusion', 'summary')),
]

_PLACEHOLDER_RE = re.compile(r'\{\{\s*([a-zA-Z0-9_:-]+)\s*\}\}')
_HEADING_PREFIX_RE = re.compile(r'^(?:[一二三四五六七八九十]+[、.．]\s*|\d+[.、．]\s*|（[一二三四五六七八九十\d]+）\s*)')
_CN_HEADING_RE = re.compile(r'^[一二三四五六七八九十]+[、.．]\s*(.+)$')
_W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def _tpl_dir(data_dir):
    return Path(data_dir).resolve() / 'word_templates'


def _registry_path(data_dir):
    return _tpl_dir(data_dir) / 'registry.json'


def _load_registry(data_dir):
    path = _registry_path(data_dir)
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                data.setdefault('default_template_id', 'builtin-standard-v1')
                data.setdefault('templates', [])
                if not isinstance(data['templates'], list) or any(
                    not isinstance(t, dict) or not re.fullmatch(r'TPL-[A-F0-9]{12}', str(t.get('id', '')))
                    for t in data['templates']
                ):
                    raise ValueError('Invalid template registry')
                return data
        except (OSError, ValueError):
            pass
    return {'default_template_id': 'builtin-standard-v1', 'templates': []}


def _save_registry(data_dir, data):
    directory = _tpl_dir(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = _registry_path(data_dir)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(path)


def _map_heading_to_key(title, used_keys):
    clean = _HEADING_PREFIX_RE.sub('', title).strip()
    low = clean.casefold()
    for key, keywords in _SECTION_HINTS:
        if key not in used_keys and any(kw in low for kw in keywords):
            return key, clean
    return None, clean


def parse_docx_template(blob):
    """Inspect a .docx byte payload and extract placeholders, sections, and layout style."""
    if not isinstance(blob, (bytes, bytearray)) or not blob:
        raise ValueError('上传的模板文件为空')
    if len(blob) > MAX_TEMPLATE_BYTES:
        raise ValueError('模板文件不能超过 10 MB')
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as exc:
        raise ValueError('文件不是有效的 Word (.docx) 文档') from exc

    with zf:
        entries = zf.infolist()
        if len(entries) > 2000 or sum(item.file_size for item in entries) > MAX_EXPANDED_BYTES:
            raise ValueError('模板解压内容过大')
        if len({item.filename for item in entries}) != len(entries):
            raise ValueError('模板包含重复的文档部件')
        if any(item.flag_bits & 1 for item in entries):
            raise ValueError('不支持加密的 Word 模板')
        for item in entries:
            name = item.filename.lower()
            if 'vbaproject' in name or name.startswith(('word/embeddings/', 'word/activex/')):
                raise ValueError('模板不能包含宏或嵌入的可执行对象')
            if name.endswith(('.xml', '.rels')):
                part = zf.read(item)
                if b'<!DOCTYPE' in part.upper() or b'<!ENTITY' in part.upper():
                    raise ValueError('模板包含不支持的 XML 声明')
                try:
                    parsed_part = ET.fromstring(part)
                except ET.ParseError as exc:
                    raise ValueError('模板包含无效的 XML 部件') from exc
                if name == '[content_types].xml' and any(
                    'macroenabled' in part.get('ContentType', '').lower()
                    for part in parsed_part
                ):
                    raise ValueError('模板不能包含宏')
                if name.endswith('.rels'):
                    for rel in parsed_part:
                        if rel.get('TargetMode') == 'External' and not rel.get('Type', '').endswith('/hyperlink'):
                            raise ValueError('模板不能包含外部加载的文档或图片')
        if 'word/document.xml' not in zf.namelist():
            raise ValueError('Word 文档缺少正文 word/document.xml，请另存为标准 .docx 后重试')
        try:
            doc_xml = zf.read('word/document.xml')
            root = ET.fromstring(doc_xml)
        except Exception as exc:
            raise ValueError('无法解析 Word 文档正文 XML') from exc
        if root.tag != f'{{{_W_NS}}}document' or root.find(f'{{{_W_NS}}}body') is None:
            raise ValueError('文件不是标准 Word 文档正文')

        style = dict(DEFAULT_STYLE)
        sect = root.find(f'.//{{{_W_NS}}}sectPr')
        if sect is not None:
            pg_mar = sect.find(f'{{{_W_NS}}}pgMar')
            if pg_mar is not None:
                for attr, key in (('top', 'margin_top'), ('bottom', 'margin_bottom'),
                                  ('left', 'margin_left'), ('right', 'margin_right')):
                    raw = pg_mar.attrib.get(f'{{{_W_NS}}}{attr}')
                    if raw and raw.isdigit():
                        val = int(raw)
                        if 300 <= val <= 3600:
                            style[key] = val

        for shd in root.findall(f'.//{{{_W_NS}}}shd'):
            fill = (shd.attrib.get(f'{{{_W_NS}}}fill') or '').strip().upper()
            if re.fullmatch(r'[0-9A-F]{6}', fill) and fill not in ('FFFFFF', '000000', 'AUTO'):
                style['header_fill'] = fill
                break

        placeholders = []
        seen_ph = set()
        extracted_headings = []
        body = root.find(f'{{{_W_NS}}}body')
        if body is not None:
            for p in body.findall(f'{{{_W_NS}}}p'):
                text_str = ''.join((t.text or '') for t in p.findall(f'.//{{{_W_NS}}}t')).strip()
                if not text_str:
                    continue
                for ph in _PLACEHOLDER_RE.findall(text_str):
                    if ph not in seen_ph:
                        seen_ph.add(ph)
                        placeholders.append(ph)
                pstyle_el = p.find(f'{{{_W_NS}}}pPr/{{{_W_NS}}}pStyle')
                pstyle = (pstyle_el.attrib.get(f'{{{_W_NS}}}val') or '').lower() if pstyle_el is not None else ''
                is_heading = pstyle in ('heading1', 'heading 1', '1', 'a1') or 'heading1' in pstyle
                cn_match = _CN_HEADING_RE.match(text_str)
                if (is_heading or cn_match) and len(text_str) <= 60:
                    extracted_headings.append(text_str)

        # Also check placeholders inside table cells
        for tc in root.findall(f'.//{{{_W_NS}}}tc'):
            for p in tc.findall(f'{{{_W_NS}}}p'):
                text_str = ''.join((t.text or '') for t in p.findall(f'.//{{{_W_NS}}}t')).strip()
                for ph in _PLACEHOLDER_RE.findall(text_str):
                    if ph not in seen_ph:
                        seen_ph.add(ph)
                        placeholders.append(ph)

        # Headers and footers can also hold metadata placeholders.
        for name in zf.namelist():
            if re.fullmatch(r'word/(?:header|footer)\d+\.xml', name):
                for p in ET.fromstring(zf.read(name)).iter(f'{{{_W_NS}}}p'):
                    text_str = ''.join(t.text or '' for t in p.iter(f'{{{_W_NS}}}t'))
                    for ph in _PLACEHOLDER_RE.findall(text_str):
                        if ph not in seen_ph:
                            seen_ph.add(ph)
                            placeholders.append(ph)

    mode = 'placeholder' if placeholders else 'structure'
    sections = []
    used_keys = set()
    custom_idx = 0
    for h in extracted_headings:
        if re.search(r'[（(]续[)）]\s*$', h):
            continue
        mapped_key, clean_title = _map_heading_to_key(h, used_keys)
        if not clean_title:
            continue
        if mapped_key is None:
            custom_idx += 1
            mapped_key = f'custom_{custom_idx}'
        used_keys.add(mapped_key)
        sections.append({'key': mapped_key, 'title': clean_title[:60]})
        if len(sections) >= 12:
            break

    # If the user's document did not contain recognizable headings, fall back to standard 6 sections
    if not sections:
        sections = [dict(s) for s in DEFAULT_SECTIONS]

    return {
        'mode': mode,
        'placeholders': placeholders,
        'sections': sections,
        'style': style,
    }


def _builtin_entries():
    out = []
    for item in BUILTIN_CATALOG:
        file_path = BUILTIN_TEMPLATES_DIR / item['filename']
        exists = file_path.is_file()
        parsed_style = dict(DEFAULT_STYLE)
        if exists:
            try:
                parsed = parse_docx_template(file_path.read_bytes())
                parsed_style = parsed['style']
            except Exception:
                pass
        out.append({
            'id': item['id'],
            'name': item['name'],
            'filename': item['filename'],
            'description': item['description'],
            'scope': item['scope'],
            'builtin': True,
            'file_available': exists,
            'mode': 'structure',
            'sections': [dict(s) for s in DEFAULT_SECTIONS],
            'style': parsed_style,
            'placeholders': [],
        })
    return out


def list_templates(data_dir):
    reg = _load_registry(data_dir)
    builtins = _builtin_entries()
    customs = [{**t, 'builtin': False, 'file_available': (_tpl_dir(data_dir) / f'{t["id"]}.docx').is_file()}
               for t in reg.get('templates', [])]
    all_items = builtins + customs
    default_id = reg.get('default_template_id') or 'builtin-standard-v1'
    if not any(item['id'] == default_id for item in all_items):
        default_id = 'builtin-standard-v1'
    return {
        'default_template_id': default_id,
        'templates': [{**item, 'is_default': item['id'] == default_id} for item in all_items],
    }


def get_template(data_dir, template_id):
    info = list_templates(data_dir)
    return next((t for t in info['templates'] if t['id'] == template_id), None)


def resolve_active_template(data_dir, template_id=None):
    info = list_templates(data_dir)
    target_id = template_id or info['default_template_id']
    tpl = next((t for t in info['templates'] if t['id'] == target_id), None)
    if tpl is None:
        if template_id:
            raise ValueError('所选实验记录模板不存在')
        tpl = info['templates'][0]
    tpl = dict(tpl)
    if tpl['builtin']:
        fpath = BUILTIN_TEMPLATES_DIR / tpl['filename']
    else:
        fpath = _tpl_dir(data_dir) / f'{tpl["id"]}.docx'
    tpl['file_path'] = str(fpath) if fpath.is_file() else ''
    return tpl


@_serialized
def import_template(data_dir, *, name, filename, content_bytes, notes='', set_as_default=False):
    if not all(isinstance(value, str) for value in (name, filename, notes)):
        raise ValueError('模板名称、文件名和说明必须是文字')
    clean_name = (name or '').strip()
    raw_file = Path(filename or 'custom-template.docx').name
    if not raw_file.lower().endswith('.docx'):
        raise ValueError('仅支持上传 .docx 格式的 Word 模板文件')
    if not clean_name:
        clean_name = raw_file[:-5].strip() or '自定义实验记录模板'
    if len(clean_name) > 80:
        raise ValueError('模板名称不能超过 80 字')
    clean_notes = (notes or '').strip()[:500]
    parsed = parse_docx_template(content_bytes)
    tpl_id = 'TPL-' + uuid.uuid4().hex[:12].upper()
    directory = _tpl_dir(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f'{tpl_id}.docx'
    tmp = target.with_suffix('.tmp')
    tmp.write_bytes(content_bytes)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(target)

    entry = {
        'id': tpl_id,
        'name': clean_name,
        'filename': raw_file,
        'description': clean_notes or (
            f'占位符精准套打模板（检测到 {len(parsed["placeholders"])} 个占位符）'
            if parsed['mode'] == 'placeholder'
            else f'结构解析模板（识别 {len(parsed["sections"])} 个栏目）'
        ),
        'scope': '用户自建模板',
        'mode': parsed['mode'],
        'sections': parsed['sections'],
        'style': parsed['style'],
        'placeholders': parsed['placeholders'],
        'created_at': datetime.now(TZ).isoformat(timespec='seconds'),
    }
    reg = _load_registry(data_dir)
    reg['templates'].append(entry)
    if set_as_default:
        reg['default_template_id'] = tpl_id
    _save_registry(data_dir, reg)
    return {**entry, 'builtin': False, 'file_available': True, 'is_default': reg['default_template_id'] == tpl_id}


@_serialized
def set_default_template(data_dir, template_id):
    if not template_id or not get_template(data_dir, template_id):
        raise ValueError('找不到要设为默认的实验记录模板')
    reg = _load_registry(data_dir)
    reg['default_template_id'] = template_id
    _save_registry(data_dir, reg)
    return list_templates(data_dir)


@_serialized
def delete_template(data_dir, template_id):
    if any(b['id'] == template_id for b in BUILTIN_CATALOG):
        raise ValueError('系统内置标准模板不可删除')
    reg = _load_registry(data_dir)
    kept = [t for t in reg.get('templates', []) if t['id'] != template_id]
    if len(kept) == len(reg.get('templates', [])):
        raise ValueError('找不到要删除的自定义模板')
    reg['templates'] = kept
    if reg.get('default_template_id') == template_id:
        reg['default_template_id'] = 'builtin-standard-v1'
    _save_registry(data_dir, reg)
    (_tpl_dir(data_dir) / f'{template_id}.docx').unlink(missing_ok=True)
    return list_templates(data_dir)


def read_template_bytes(data_dir, template_id):
    tpl = get_template(data_dir, template_id)
    if not tpl:
        raise ValueError('找不到该实验记录模板')
    if tpl['builtin']:
        fpath = BUILTIN_TEMPLATES_DIR / tpl['filename']
        if fpath.is_file():
            return fpath.read_bytes(), tpl['filename']
        # Fallback: generate a clean standard blank docx on the fly if bundled file is absent
        from word_export import make_blank_standard_template
        return make_blank_standard_template(tpl['name']), tpl['filename']
    fpath = _tpl_dir(data_dir) / f'{tpl["id"]}.docx'
    if not fpath.is_file():
        raise ValueError('模板文件已丢失，请重新上传')
    return fpath.read_bytes(), tpl['filename']


@_serialized
def snapshot_templates(data_dir, zip_path):
    """Write a consistent template sidecar; archive names are relative to the data root."""
    registry = _load_registry(data_dir)
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('word_templates/registry.json', json.dumps(registry, ensure_ascii=False, indent=2) + '\n')
        for entry in registry['templates']:
            name = entry['id'] + '.docx'
            source = _tpl_dir(data_dir) / name
            if source.is_file():
                if source.is_symlink():
                    raise ValueError('模板文件不能是符号链接')
                blob = source.read_bytes()
                parse_docx_template(blob)
                archive.writestr('word_templates/' + name, blob)
    return Path(zip_path)
