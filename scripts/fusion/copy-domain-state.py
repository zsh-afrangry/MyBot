"""Snapshot original domain databases using SQLite backup; never overwrite a destination.

Only the fusion database will be migrated. Private row contents are not printed.

The legacy source has no implicit default: the migration is complete, and the new system must not
depend on /home/afrangry/.openclaw existing. Point KURUMI_LEGACY_SOURCE at an extracted legacy tree
(for example the archived copy under /home/afrangry/kurumi-backups).
"""
import os
import json
import sqlite3
from pathlib import Path
os.umask(0o077)

legacy_root = os.environ.get('KURUMI_LEGACY_SOURCE')
if not legacy_root:
    raise SystemExit(
        'KURUMI_LEGACY_SOURCE is not set.\n'
        'This is a one-shot migration script and the migration is already complete, so there is no\n'
        'implicit legacy path. Extract the archived tree and point at it, e.g.\n'
        '  mkdir -p /tmp/legacy\n'
        '  zstd -dc /home/afrangry/kurumi-backups/2026-10-05-pre-consolidation/'
        'state/legacy-openclaw-full.tar.zst | tar -C /tmp/legacy -xf -\n'
        '  KURUMI_LEGACY_SOURCE=/tmp/legacy python3 scripts/fusion/copy-domain-state.py'
    )

source = Path(legacy_root) / 'state'
target = Path('/home/afrangry/.openclaw-fusion/state')
report = []
for domain, name in [('personal-weather', 'weather.sqlite'), ('personal-reminders', 'reminders.sqlite')]:
    dst = target / domain / name
    if dst.exists():
        raise RuntimeError(f'Refusing to replace existing fusion database: {domain}')
    dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    original = sqlite3.connect(f'file:{source / domain / name}?mode=ro', uri=True)
    copy = sqlite3.connect(dst)
    original.backup(copy)
    assert copy.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not copy.execute('PRAGMA foreign_key_check').fetchall()
    report.append({'domain': domain, 'sqliteBackup': True, 'integrity': 'ok'})
    original.close()
    copy.close()
Path('/home/afrangry/kurumi-fusion/docs/verification/migration/04-domain-copy.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report))
