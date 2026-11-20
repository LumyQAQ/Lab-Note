"""Standalone human-readable exports of structured lab records."""
import html
from medium import medium_summary
from cell_count import count_summary, seeding_summary


SOFTWARE_CREDIT = '<footer><small>由 Lab Note 导出 · 软件作者 <a rel="author noopener" href="https://github.com/LumyQAQ" target="_blank">LumyQAQ</a></small></footer>'


def esc(value):return html.escape(str(value if value is not None else ''))


def _body(record,schema):
    module=schema['modules'][record['type']];variant=module['variants'][record['variant']]
    sources=record.get('all_cell_sources',record.get('cell_sources',[]))
    source_names={s.get('table_key',s['key']):s['container_name']+' / '+s['well']+' · '+s['snapshot']['cell']+'（观察 '+s['observed_at']+'）' for s in sources}
    for group in record.get('all_source_groups', record.get('source_groups', [])):
        members='；'.join(s['container_name']+' / '+s['well'] for s in group['sources'])
        source_names[group.get('table_key', group['key'])]=group['name']+'（'+members+'）'
    def field_block(keys):
        fields=[next(f for f in variant['fields'] if f['key']==key) for key in keys]
        return '<table>'+''.join(f'<tr><th>{esc(f["label"])}</th><td>{esc(record.get("data",{}).get(f["key"],""))}</td></tr>' for f in fields)+'</table>'
    def table_block(key):
        table=next(t for t in variant['tables'] if t['key']==key)
        columns=table['columns'];rows=record.get('tables',{}).get(table['key'],[])
        heading=''.join('<th>'+esc(c['label'])+'</th>' for c in columns)
        body=''.join('<tr>'+''.join('<td>'+esc(source_names.get(row.get(c['key']),row.get(c['key'],'')) if c['type']=='source' else c.get('option_labels',{}).get(row.get(c['key']),row.get(c['key'],'')))+'</td>' for c in columns)+'</tr>' for row in rows)
        return '<h3>'+esc(table['label'])+'</h3><table><thead><tr>'+heading+'</tr></thead><tbody>'+body+'</tbody></table>'
    layout=variant.get('sections',[{'fields':[f['key'] for f in variant['fields']], 'tables':[t['key'] for t in variant['tables']]}])
    sections=[]
    for section in layout:
        if section.get('label'):sections.append('<h3>'+esc(section['label'])+'</h3>')
        if section.get('fields'):sections.append(field_block(section['fields']))
        sections.extend(table_block(key) for key in section.get('tables',[]))
    if record.get('files'):
        sections.append('<h3>原始文件索引</h3><p>仅保存路径/链接，原文件不包含在此导出中。</p><table>'+''.join('<tr><td>'+esc(f['label'])+'</td><td>'+esc(f['path'])+'</td><td>'+esc(f['description'])+'</td></tr>' for f in record['files'])+'</table>')
    return ''.join(sections)


def _source_html(source):
    w=source['snapshot']
    return f'<section><h3>{esc(source["container_name"])} / {esc(source["well"])}</h3><p>{esc(source["container_id"])} · 观察于 {esc(source["observed_at"])} · 关联于 {esc(source["captured_at"])}</p><p>细胞：{esc(w["cell"])} · 批次：{esc(w.get("batch",""))} · 关联时 Day {esc(w.get("day",""))} · Day0：{esc(w.get("day0",""))}</p><p>当时处理：{esc(w.get("treatment",""))}</p><pre>{esc(medium_summary(w.get("medium")))}</pre><pre>{esc(count_summary(w.get("cell_count")))}</pre><pre>{esc(seeding_summary(w.get("seeding")))}</pre></section>'


def record_html(record,schema):
    module=schema['modules'][record['type']];variant=module['variants'][record['variant']]
    status=dict(module['statuses']).get(record['status'],record['status'])
    header=f'<h1>{esc(record["title"])}</h1><p>{esc(module["label"])} / {esc(variant["label"])} · {esc(record["id"])} · v{record["version"]}</p><p>记录日期：{esc(record["record_date"])} · 状态：{esc(status)} · 实验分组：{esc(record.get("experiment",""))}</p>'
    sources=[_source_html(s) for s in record.get('all_cell_sources',record.get('cell_sources',[]))]
    groups=[]
    for group in record.get('all_source_groups',record.get('source_groups',[])):
        groups.append('<section><h3>'+esc(group['name'])+'</h3><p>收集组捕获于 '+esc(group['captured_at'])+
                      '</p><pre>'+esc(group.get('notes',''))+'</pre>'+''.join(_source_html(s) for s in group['sources'])+'</section>')
    group_section='<h2>收集组来源</h2>'+''.join(groups) if groups else ''
    refs=[]
    for ref in record.get('record_refs',[]):
        parent=ref['snapshot']
        refs.append('<details><summary>'+esc(ref['title'])+' · '+esc(ref['id'])+' · 关联版本 v'+str(ref['version'])+'</summary><p>捕获于 '+esc(ref['captured_at'])+'</p>'+_body(parent,schema)+'</details>')
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+esc(record['title'])+'</title><style>body{font:14px system-ui;color:#243c35;margin:36px;line-height:1.7}table{border-collapse:collapse;width:100%;margin:12px 0;font-size:12px}td,th{border:1px solid #ccd7ce;padding:8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#edf3e9}pre{white-space:pre-wrap;font:inherit}section,details{border:1px solid #ccd7ce;padding:15px;margin:16px 0}h3{margin-bottom:6px}@media print{details{display:block}@page{size:A4 landscape}}</style>'+header+_body(record,schema)+group_section+'<h2>关联时的细胞来源</h2>'+(''.join(sources) or '<p>未关联细胞来源</p>')+'<h2>关联药物 / 上游记录版本</h2>'+(''.join(refs) or '<p>未关联上游记录</p>')+'<h2>备注</h2><pre>'+esc(record.get('notes',''))+'</pre>'+SOFTWARE_CREDIT+'</html>'
