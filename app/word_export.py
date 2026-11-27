"""Versioned Word draft. Only serializes saved notebook fields; never opens evidence paths."""
import io
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from hashlib import sha256
from pathlib import Path
from xml.sax.saxutils import escape

_W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
_CN_NUMS = '一二三四五六七八九十'
_PLACEHOLDER_RE = re.compile(r'\{\{\s*([a-zA-Z0-9_:-]+)\s*\}\}')
_CJK_TO_ASCII = re.compile(r'([\u4e00-\u9fff])([A-Za-z0-9α-ωΑ-Ωμµ])')
_ASCII_TO_CJK = re.compile(r'([A-Za-z0-9%°℃])([\u4e00-\u9fff])')
_NUM_TO_UNIT = re.compile(r'(\d)(μL|µL|mL|μM|µM|mM|μg|µg|ng|mg|°C|℃)')
_KEEP_TOKEN_RE = re.compile(r'(?:https?://\S+|/[^\s]+|\b[A-Z]{2,8}-[A-Za-z0-9-]+\b|\S+\.(?:png|jpg|jpeg|tif|tiff|pdf|xlsx|xls|csv|docx|fcs|txt)\b)')


def config():
    return json.loads(Path(__file__).with_name('word_format.json').read_text(encoding='utf8'))


def format_cjk_spacing(text):
    """Apply Chinese-English/number single-space typography without mutating paths, URLs or filenames."""
    s = '' if text is None else str(text)
    if not s:
        return s
    parts = []
    pos = 0
    for m in _KEEP_TOKEN_RE.finditer(s):
        if m.start() > pos:
            seg = s[pos:m.start()]
            seg = _CJK_TO_ASCII.sub(r'\1 \2', seg)
            seg = _ASCII_TO_CJK.sub(r'\1 \2', seg)
            seg = _NUM_TO_UNIT.sub(r'\1 \2', seg)
            parts.append(seg)
        parts.append(m.group(0))
        pos = m.end()
    if pos < len(s):
        seg = s[pos:]
        seg = _CJK_TO_ASCII.sub(r'\1 \2', seg)
        seg = _ASCII_TO_CJK.sub(r'\1 \2', seg)
        seg = _NUM_TO_UNIT.sub(r'\1 \2', seg)
        parts.append(seg)
    return ''.join(parts)


def layout(chosen=None, template=None):
    cfg = config()
    defaults = cfg['sections']
    by = {s['key']: s for s in defaults}
    if chosen is None:
        if template and isinstance(template.get('sections'), list) and template['sections']:
            out = []
            for part in template['sections']:
                key = part.get('key', '')
                title = (part.get('title') or '').strip()
                if not key or not title:
                    continue
                sec = by.get(key) or {'key': key, 'title': title, 'fields': [], 'tables': []}
                out.append((sec, title))
            if out:
                return out
        return [(s, s['title']) for s in defaults]
    if not isinstance(chosen, list) or not 1 <= len(chosen) <= max(len(defaults), 12):
        raise ValueError('请至少保留一个导出栏目')
    out = []
    seen = set()
    for part in chosen:
        if not isinstance(part, dict) or not isinstance(part.get('key'), str) or part['key'] in seen:
            raise ValueError('栏目无效或重复')
        key = part['key']
        if key not in by and not key.startswith('custom_'):
            raise ValueError('栏目无效或重复')
        title = part.get('title')
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 60:
            raise ValueError('请填写 1–60 字的栏目标题')
        seen.add(key)
        sec = by.get(key) or {'key': key, 'title': title.strip(), 'fields': [], 'tables': []}
        out.append((sec, title.strip()))
    return out


def xml(text):
    return escape(re.sub(r'[^\t\n\r\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]', '', str(text)))


def para(text, *, size=None, bold=False, keep=False, after=85, style=None, align=None, spacing_norm=False):
    text = '' if text is None else str(text)
    if spacing_norm:
        text = format_cjk_spacing(text)
    chunks = re.findall(r'[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]+|[^\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]+', text) if size is None else [text]
    runs = []
    for chunk in chunks:
        pts = size or (24 if re.match(r'[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]', chunk) else 21)
        lines = '<w:br/>'.join('<w:t xml:space="preserve">' + xml(s) + '</w:t>' for s in chunk.split('\n'))
        runs.append('<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>'
                    + ('<w:b/>' if bold else '') + f'<w:sz w:val="{pts}"/></w:rPr>{lines}</w:r>')
    tag = '<w:pStyle w:val="' + style + '"/>' if style else ''
    jc = f'<w:jc w:val="{align}"/>' if align else ''
    return f'<w:p><w:pPr>{tag}{jc}{"<w:keepNext/>" if keep else ""}<w:spacing w:after="{after}"/></w:pPr>' + ''.join(runs) + '</w:p>'


def table(t, rows, sources, *, header_fill='F0F0F0'):
    result_keys = ('ct', 'raw_value', 'value', 'events')
    cols = [c for c in t['columns'] if c['key'] in result_keys or any(r.get(c['key'], '') != '' for r in rows)]
    if not cols:
        return ''
    ranks = ['plate', 'well', 'group', 'sample', 'target', 'population', 'metric', *result_keys, 'replicate']
    if len(cols) <= 6:
        primary = cols
    else:
        prioritized = [c for key in ranks for c in cols if c['key'] == key]
        primary = prioritized[:5] or cols[:4]
        for c in cols:
            if c['key'] in result_keys and c not in primary:
                primary[-1] = c
    others = [c for c in cols if c not in primary]
    detailed = len(rows) > 8 and bool(others)
    head = [c['label'] for c in primary] + (['明细号' if detailed else '其他记录'] if others else [])
    weights = [1 if c['key'] in ('plate', 'well', 'ct', 'replicate') else 1.5 for c in primary] + ([.65 if detailed else 3] if others else [])
    widths = [round(9360 * w / sum(weights)) for w in weights]
    fill = header_fill if re.fullmatch(r'[0-9A-Fa-f]{6}', str(header_fill or '')) else 'F0F0F0'

    def tr(vals, header=False):
        cells = ''.join(
            f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/>'
            + (f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>' if header else '')
            + '</w:tcPr>' + para(x, size=20, bold=header, after=40) + '</w:tc>'
            for x, w in zip(vals, widths)
        )
        return '<w:tr><w:trPr>' + ('<w:tblHeader/>' if header else '') + '</w:trPr>' + cells + '</w:tr>'

    def value(r, c):
        v = r.get(c['key'], '')
        return sources.get(v, v) if c['type'] == 'source' else (c.get('option_labels', {}).get(v, v))

    body = [tr(head, True)]
    legend = {}
    for r in rows:
        vals = [value(r, c) if value(r, c) not in ('', None) else '—' for c in primary]
        if others:
            more = '；'.join(c['label'] + '：' + str(value(r, c)) for c in others if r.get(c['key'], '') != '')
            if detailed and more:
                ident = legend.setdefault(more, len(legend) + 1)
                vals.append(str(ident))
            else:
                vals.append(more or '—')
        body.append(tr(vals))
    borders = ''.join(f'<w:{k} w:val="single" w:sz="4" w:color="CBD4CD"/>' for k in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
    return (para(t['label'], bold=True, keep=True, spacing_norm=True)
            + '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>'
            + borders + '</w:tblBorders></w:tblPr><w:tblGrid>'
            + ''.join(f'<w:gridCol w:w="{w}"/>' for w in widths)
            + '</w:tblGrid>' + ''.join(body) + '</w:tbl>'
            + ''.join(para(f'明细 {n}：{v}', size=20) for v, n in legend.items()))


def _section_prefix(idx):
    if 0 <= idx < len(_CN_NUMS):
        return _CN_NUMS[idx] + '、'
    return f'{idx + 1}. '


def _collect_sections_content(r, schema, *, header_fill='F0F0F0'):
    cfg = config()
    v = schema['modules'][r['type']]['variants'][r['variant']]
    blocks = {s['key']: [] for s in cfg['sections']}
    plain = {s['key']: [] for s in cfg['sections']}

    def add(key, t, *, norm=True):
        blocks.setdefault(key, []).append(para(t, spacing_norm=norm))
        plain.setdefault(key, []).append(format_cjk_spacing(t) if norm else str(t))

    d = r['data']
    sf = {f: s['key'] for s in cfg['sections'] for f in s.get('fields', [])}
    st = {t: s['key'] for s in cfg['sections'] for t in s.get('tables', [])}
    for f in v['fields']:
        k = f['key']
        value = d.get(k, '')
        if value is not None and value != '' and k != 'operator':
            rendered = str(f.get('option_labels', {}).get(value, value))
            add(sf.get(k, 'steps'), f['label'] + '：' + rendered)
    sources = {}
    for source in r.get('all_cell_sources', []):
        label = source['container_name'] + ' / ' + source['well']
        composition = source.get('snapshot', {}).get('cell', '')
        if composition:
            label += ' · ' + composition
        sources[source.get('table_key', source['key'])] = label
    for g in r.get('all_source_groups', []):
        sources[g.get('table_key', g['key'])] = g['name'] + '（' + '、'.join(s['well'] for s in g['sources']) + '）'
    plate = r.get('plate_context')
    if plate:
        add('steps', '关联孔板：' + plate['container_name'] + ' · ' + plate['container_id'], norm=False)
    if sources:
        add('steps', '关联来源：' + '；'.join(dict.fromkeys(sources.values())), norm=False)

    if r.get('record_refs'):
        add('steps', '关联上游：' + '；'.join(f"{a['title']} · v{a['version']}" for a in r['record_refs']), norm=False)
    for t in v['tables']:
        rows = r['tables'].get(t['key'], [])
        if rows:
            t_key = st.get(t['key'], 'results')
            blocks.setdefault(t_key, []).append(table(t, rows, sources, header_fill=header_fill))
            plain.setdefault(t_key, []).append(t['label'] + '\n' + '\n'.join(
                '；'.join(c['label'] + '：' + str(sources.get(row.get(c['key'], ''), row.get(c['key'], ''))
                    if c.get('type') == 'source' else c.get('option_labels', {}).get(row.get(c['key'], ''), row.get(c['key'], '')))
                    for c in t['columns']) for row in rows))
    files = r.get('files', [])
    adopted = [f for f in files if f.get('adopted')]
    add('results', '最终采用的原始文件：' + ('' if adopted else '尚未标明'), norm=False)
    for f in adopted:
        add('results', ' · '.join(x for x in (f['label'], f['path'], f['description']) if x), norm=False)
    for f in files:
        if not f.get('adopted'):
            add('results', '其他文件索引：' + ' · '.join(x for x in (f['label'], f['path'], f['description']) if x), norm=False)
    for c in r.get('plating_corrections', []):
        add('results', f"孔位勘误：{c['container_name']} / {c['from_well']} → {c['to_well']}；{c['reason']}", norm=False)
    if r.get('notes'):
        add('conclusion', '记录备注：' + r['notes'])
    return blocks, plain


def _render_placeholder_docx(template_path, r, plain):
    """Clone user's uploaded .docx template and replace {{...}} placeholders in-place."""
    d = r.get('data') or {}
    mapping = {
        'title': r.get('title', ''),
        'record_date': r.get('record_date', ''),
        'operator': d.get('operator') or '待补',
        'record_id': r.get('id', ''),
        'version': f"v{r.get('version', 1)}",
        'status': '待本人确认归档',
        'notes': r.get('notes') or '待补',
        'section:purpose': '\n'.join(plain.get('purpose') or []) or '待补',
        'section:materials': '\n'.join(plain.get('materials') or []) or '待补',
        'section:solutions': '\n'.join(plain.get('solutions') or []) or '待补',
        'section:steps': '\n'.join(plain.get('steps') or []) or '待补',
        'section:results': '\n'.join(plain.get('results') or []) or '待补',
        'section:conclusion': '\n'.join(plain.get('conclusion') or []) or '待补',
    }
    ET.register_namespace('w', _W_NS)
    raw_bytes = Path(template_path).read_bytes()
    out_buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw_bytes), 'r') as zin, zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            content = zin.read(item.filename)
            if item.filename == 'word/document.xml' or re.fullmatch(r'word/(?:header|footer)\d+\.xml', item.filename):
                namespaces = {}
                for _, pair in ET.iterparse(io.BytesIO(content), events=['start-ns']):
                    prefix, uri = pair
                    namespaces[prefix] = uri
                    if not re.fullmatch(r'ns\d+', prefix):
                        ET.register_namespace(prefix, uri)
                root = ET.fromstring(content)
                for p in root.iter(f'{{{_W_NS}}}p'):
                    t_nodes = list(p.iter(f'{{{_W_NS}}}t'))
                    if not t_nodes:
                        continue
                    joined = ''.join(t.text or '' for t in t_nodes)
                    if '{{' not in joined:
                        continue
                    # Work backwards so offsets still address the original runs.
                    spans = []
                    offset = 0
                    for node in t_nodes:
                        spans.append((offset, offset + len(node.text or ''), node))
                        offset += len(node.text or '')
                    for match in reversed(list(_PLACEHOLDER_RE.finditer(joined))):
                        if match.group(1) not in mapping:
                            continue
                        affected = [(a, b, node) for a, b, node in spans if a < match.end() and b > match.start()]
                        for index, (start, end, node) in enumerate(affected):
                            before = (node.text or '')[:max(0, match.start() - start)]
                            after = (node.text or '')[match.end() - start:] if match.end() <= end else ''
                            node.text = before + (str(mapping[match.group(1)]) if index == 0 else '') + after
                            node.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
                for run in root.iter(f'{{{_W_NS}}}r'):
                    for node in list(run):
                        if node.tag != f'{{{_W_NS}}}t' or '\n' not in (node.text or ''):
                            continue
                        lines = node.text.split('\n')
                        node.text = lines[0]
                        at = list(run).index(node) + 1
                        for line in lines[1:]:
                            run.insert(at, ET.Element(f'{{{_W_NS}}}br'))
                            text_node = ET.Element(f'{{{_W_NS}}}t', {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})
                            text_node.text = line
                            run.insert(at + 1, text_node)
                            at += 2
                # Keep namespace declarations referenced by compatibility attributes.
                serialized = ET.tostring(root, encoding='utf-8')
                for prefix, uri in namespaces.items():
                    declaration = ('xmlns:' + prefix if prefix else 'xmlns')
                    if (declaration + '=').encode() not in serialized:
                        root.set(declaration, uri)
                content = ET.tostring(root, encoding='utf-8', xml_declaration=True)
            info = zipfile.ZipInfo(item.filename, (2000, 1, 1, 0, 0, 0))
            zout.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED)
    return out_buf.getvalue()


def _package_ooxml(body_xml, *, margins=None):
    m = margins or {}
    top = int(m.get('margin_top', 1020))
    bottom = int(m.get('margin_bottom', 1020))
    left = int(m.get('margin_left', 1134))
    right = int(m.get('margin_right', 1134))
    footer_xml = (
        '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
        '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">第 </w:t></w:r>'
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> 页 / 共 </w:t></w:r>'
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> 页</w:t></w:r>'
        '</w:p></w:ftr>'
    )
    doc = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
        + body_xml
        + f'<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter1"/>'
        f'<w:pgSz w:w="11906" w:h="16838"/>'
        f'<w:pgMar w:top="{top}" w:right="{right}" w:bottom="{bottom}" w:left="{left}" w:header="720" w:footer="454" w:gutter="0"/>'
        '</w:sectPr></w:body></w:document>'
    )
    files = {
        '[Content_Types].xml': (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
            '</Types>'
        ),
        '_rels/.rels': (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>'
        ),
        'word/_rels/document.xml.rels': (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="style" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
            '</Relationships>'
        ),
        'word/styles.xml': (
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
            '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>'
            '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
            '</w:styles>'
        ),
        'word/footer1.xml': footer_xml,
        'word/document.xml': doc,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, content in files.items():
            z.writestr(
                zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0)),
                ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + content).encode('utf-8'),
                compress_type=zipfile.ZIP_DEFLATED,
            )
    return buf.getvalue()


def make_blank_standard_template(title='Lab Note 标准实验记录模版 V1.0（六栏目）'):
    """Fallback generator for a clean standard six-column .docx template."""
    cfg = config()
    body = (
        para(title, size=32, bold=True, keep=True, style='Title', align='center')
        + para('实验日期：待补　记录人：待补　课题 / 编号：待补', align='center', after=140)
    )
    for idx, sec in enumerate(cfg['sections']):
        body += para(_section_prefix(idx) + sec['title'], bold=True, size=26, keep=True, style='Heading1')
        body += para('（待填写）')
    return _package_ooxml(body)


def make_word(r, schema, chosen=None, *, template=None):
    style = (template or {}).get('style') or {}
    header_fill = style.get('header_fill') or 'F0F0F0'
    blocks, plain = _collect_sections_content(r, schema, header_fill=header_fill)
    if template and template.get('mode') == 'placeholder' and template.get('file_path') and Path(template['file_path']).is_file() and chosen is None:
        return _render_placeholder_docx(template['file_path'], r, plain)

    selected = layout(chosen, template=template)
    d = r['data']
    title_size = int(style.get('title_size', 32))
    heading_size = int(style.get('heading_size', 26))
    body = (
        para(r['title'], size=title_size, bold=True, keep=True, style='Title', spacing_norm=False)
        + para(f"实验日期：{r['record_date']}　记录人：{d.get('operator') or '未记录'}")
        + para(f"实验编号：{r['id']}　记录版本：v{r['version']}　文档状态：待本人确认归档")
    )
    for idx, (section, title) in enumerate(selected):
        body += para(_section_prefix(idx) + title, bold=True, size=heading_size, keep=True, style='Heading1')
        body += ''.join(blocks.get(section['key']) or []) or para('未记录')
    return _package_ooxml(body, margins=style)


def edition_meta(record, blob):
    digest = sha256(blob).hexdigest()
    name = re.sub(r'[\x00-\x1f/\\:*?"<>|]', '_', record['title']).strip('. ')[:60] or '实验记录'
    return dict(
        id=digest,
        record_id=record['id'],
        version=record['version'],
        record_updated_at=record['updated_at'],
        filename=f"{record['record_date']} {name} {record['id']} v{record['version']}-{digest[:8]}.docx",
    )
