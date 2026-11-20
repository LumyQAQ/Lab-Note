"""Build the shareable application archive from reviewed, explicit paths."""
from pathlib import Path
import re
import hashlib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = """
AUTHORS.md
app/cell_count.py
app/co_culture.py
app/finish_sampling.py
app/group_units.py
app/lab_exports.py
app/lab_records.py
app/lab_schemas.json
app/launch.py
app/manual_groups.py
app/medium.py
app/occupied_targets.py
app/relocation.py
app/replate.py
app/server.py
app/static/app.js
app/static/archived-cultures.css
app/static/archived-cultures.js
app/static/assay-groups.js
app/static/autocomplete.js
app/static/count.css
app/static/count.js
app/static/experiments.css
app/static/experiments.js
app/static/groups.js
app/static/home.css
app/static/home.js
app/static/index.html
app/static/lineage-links.js
app/static/manual-groups.css
app/static/manual-groups.js
app/static/medium.css
app/static/medium.js
app/static/notebook-256.png
app/static/notebook-512.png
app/static/notebook.webmanifest
app/static/occupied-targets.css
app/static/occupied-targets.js
app/static/quick-medium.css
app/static/quick-medium.js
app/static/relocation.css
app/static/relocation.js
app/static/replate.css
app/static/replate.js
app/static/selection.js
app/static/source-picker.css
app/static/source-picker.js
app/static/style.css
app/static/transfer-cards.js
app/static/transfer.js
app/static/well-groups.css
app/static/well-groups.js
app/static/workday.css
app/static/workday.js
app/store.py
app/transfer.py
app/transfer_cultivation.py
app/well_groups.py
app/workday.py
README.md
启动实验日记.command
tests/test_public_app.py
""".splitlines()


def main():
    target = ROOT / 'docs/downloads/lab-note-v1.0.zip'
    target.parent.mkdir(parents=True, exist_ok=True)
    pending = target.with_suffix('.tmp')
    with zipfile.ZipFile(pending, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in filter(None, FILES):
            source = ROOT / name
            if source.is_symlink() or not source.is_file() or ROOT not in source.resolve().parents:
                raise ValueError(f'发布清单中有无效文件 {name}')
            content = source.read_bytes()
            if name == 'README.md':
                content = re.sub(rb'<!-- repository-only:start -->.*?<!-- repository-only:end -->',
                                 b'', content, flags=re.S)
            info = zipfile.ZipInfo('Lab-Note/'+name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name.endswith('.command') else 0o100644) << 16
            archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED)
    digest = hashlib.sha256(pending.read_bytes()).hexdigest()
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        target.with_suffix('.zip.sig').unlink(missing_ok=True)
    pending.replace(target)
    (target.parent/'SHA256SUMS.txt').write_text(f'{digest}  {target.name}\n')
    print(target.name, target.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
