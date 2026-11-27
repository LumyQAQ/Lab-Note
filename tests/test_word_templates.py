"""Word output, uploaded templates, and bundled blank-template privacy checks."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import word_export as export
import word_templates as templates

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def document(blob, name='word/document.xml'):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        return ET.fromstring(archive.read(name))


def contents(blob):
    return ''.join(document(blob).itertext())


def patch_package(blob, files):
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(blob)) as source, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as target:
        for name in source.namelist():
            target.writestr(name, files.pop(name, source.read(name)))
        for name, value in files.items():
            target.writestr(name, value)
    return out.getvalue()


class WordTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.directory = Path(folder.name)
        self.schema = {'modules': {'generic': {'variants': {'note': {
            'fields': [{'key': 'objective', 'label': '目的'}, {'key': 'operator', 'label': '记录人'}, {'key': 'results', 'label': '结果'}],
            'tables': [{'key': 'measurements', 'label': '测量值', 'columns': [{'key': 'value', 'label': '读数', 'type': 'number'}]}],
        }}}}}
        self.record = {'id': 'REC-TEST', 'type': 'generic', 'variant': 'note', 'title': '空白功能验证',
                       'record_date': '2026-01-01', 'version': 2, 'updated_at': '2026-01-01T12:00:00',
                       'data': {'objective': '检查导出', 'operator': '测试员', 'results': '第一行\n第二行'},
                       'tables': {'measurements': [{'value': 0}]}, 'files': [], 'notes': ''}

    def test_six_sections_zero_values_and_deterministic_version(self):
        blob = export.make_word(self.record, self.schema)
        self.assertEqual(blob, export.make_word(self.record, self.schema))
        text = contents(blob)
        for section in export.config()['sections']:
            self.assertIn(section['title'], text)
        self.assertIn('测量值读数0', text)
        meta = export.edition_meta(self.record, blob)
        self.assertEqual(meta['version'], 2)
        self.assertIn('v2-', meta['filename'])
        self.assertEqual(len(meta['id']), 64)
        self.assertIn('PAGE', ''.join(document(blob, 'word/footer1.xml').itertext()))

    def test_custom_section_selection_and_validation(self):
        text = contents(export.make_word(self.record, self.schema, [{'key': 'results', 'title': '本次读数'}]))
        self.assertIn('一、本次读数', text)
        self.assertNotIn('实验目的', text)
        with self.assertRaises(ValueError):
            export.make_word(self.record, self.schema, [])
        with self.assertRaises(ValueError):
            export.layout([{'key': 'unknown', 'title': '未知'}])

    def test_three_bundled_templates_blank_and_no_external_relationships(self):
        items = templates.list_templates(self.directory)['templates']
        self.assertEqual(len(items), 3)
        for item in items:
            self.assertTrue(item['file_available'])
            blob, filename = templates.read_template_bytes(self.directory, item['id'])
            self.assertEqual(filename, item['filename'])
            text = contents(blob)
            self.assertIn('待填', text)
            self.assertIn('本轮总结', text)
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                for name in archive.namelist():
                    self.assertFalse(name.startswith(('word/media/', 'word/embeddings/')))
                    if name.endswith(('.xml', '.rels')):
                        raw = archive.read(name).decode()
                        for private in ('/Users/', 'ziranfeng', 'lab-culture', 'TargetMode="External"'):
                            self.assertNotIn(private, raw)
            self.assertEqual(templates.parse_docx_template(blob)['mode'], 'structure')

    def test_import_default_delete_and_original_download(self):
        blob = export.make_blank_standard_template()
        item = templates.import_template(self.directory, name='我的模版', filename='../custom.docx', content_bytes=blob, set_as_default=True)
        self.assertEqual(item['filename'], 'custom.docx')
        self.assertEqual(templates.resolve_active_template(self.directory)['id'], item['id'])
        self.assertEqual(templates.read_template_bytes(self.directory, item['id'])[0], blob)
        templates.delete_template(self.directory, item['id'])
        self.assertEqual(templates.list_templates(self.directory)['default_template_id'], 'builtin-standard-v1')
        with self.assertRaises(ValueError):
            templates.delete_template(self.directory, 'builtin-standard-v1')

    def test_split_run_placeholders_and_table_data_and_footer(self):
        body = '<w:p><w:r><w:t>prefix {{ti</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>tle}} / {{version}}</w:t></w:r></w:p>'
        body += export.para('{{section:results}}')
        blob = export._package_ooxml(body)
        footer = '<w:ftr xmlns:w="' + W + '"><w:p><w:r><w:t>{{record_id}}</w:t></w:r></w:p></w:ftr>'
        blob = patch_package(blob, {'word/footer1.xml': footer})
        entry = templates.import_template(self.directory, name='占位符', filename='fill.docx', content_bytes=blob)
        tpl = templates.resolve_active_template(self.directory, entry['id'])
        self.assertEqual(tpl['mode'], 'placeholder')
        filled = export.make_word(self.record, self.schema, template=tpl)
        text = contents(filled)
        self.assertIn('prefix 空白功能验证 / v2', text)
        self.assertIn('读数：0', text)
        self.assertNotIn('{{', text)
        self.assertTrue(document(filled).findall('.//{' + W + '}br'))
        self.assertIn('REC-TEST', ''.join(document(filled, 'word/footer1.xml').itertext()))
        self.assertEqual(blob, templates.read_template_bytes(self.directory, entry['id'])[0])

    def test_one_placeholder_recognized(self):
        blob = export._package_ooxml(export.para('{{title}}'))
        self.assertEqual(templates.parse_docx_template(blob)['mode'], 'placeholder')

    def test_reject_invalid_unsafe_and_expanded_uploads(self):
        valid = export.make_blank_standard_template()
        for blob in (b'', b'not a zip', b'x' * (templates.MAX_TEMPLATE_BYTES + 1)):
            with self.assertRaises(ValueError):
                templates.parse_docx_template(blob)
        for files in ({'word/vbaProject.bin': b'macro'}, {'word/embeddings/object.bin': b'object'},
                      {'word/huge.xml': b' ' * (templates.MAX_EXPANDED_BYTES + 1)},
                      {'word/document.xml': b'<!DOCTYPE root [<!ENTITY x "value">]><root>&x;</root>'},
                      {'word/_rels/evil.rels': '<Relationships><Relationship TargetMode="External" Type="image" Target="file:///private/data"/></Relationships>'}):
            with self.assertRaises(ValueError):
                templates.parse_docx_template(patch_package(valid, files))

    def test_backup_sidecar_keeps_registry_and_custom_document(self):
        blob = export.make_blank_standard_template()
        item = templates.import_template(self.directory, name='备用', filename='one.docx', content_bytes=blob)
        path = templates.snapshot_templates(self.directory, self.directory / 'snapshot.zip')
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.read('word_templates/' + item['id'] + '.docx'), blob)
            self.assertEqual(json.loads(archive.read('word_templates/registry.json'))['templates'][0]['id'], item['id'])

    def test_evidence_paths_are_text_only(self):
        self.record['files'] = [{'label': '原始文件', 'path': '/nonexistent/evidence.csv', 'description': '', 'adopted': True}]
        text = contents(export.make_word(self.record, self.schema))
        self.assertIn('/nonexistent/evidence.csv', text)


if __name__ == '__main__':
    unittest.main()
