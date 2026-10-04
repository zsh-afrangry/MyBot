"""Snapshot original domain databases using SQLite backup; never overwrite a destination.

Only the fusion database will be migrated. Private row contents are not printed.
"""
import os
import json
import sqlite3
from pathlib import Path
os.umask(0o077)
source = Path('/home/afrangry/.openclaw/state')
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
