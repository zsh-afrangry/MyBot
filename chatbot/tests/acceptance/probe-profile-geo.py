"""Authorized read-only provider comparison; emits no credentials or raw bodies."""
import json
import gzip
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

root = Path('/home/afrangry/.openclaw')
env = {}
for path in [root / '.env', root / 'gateway.systemd.env']:
    for line in path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            env[key] = value.strip().strip('"').strip("'")
config = json.loads((root / 'openclaw.json').read_text())['plugins']['entries']['personal-weather']['config']

def resolve(value):
    if isinstance(value, dict):
        return env[value['id']]
    return re.sub(r'\$\{([^}]+)\}', lambda match: env[match[1]], value)

results = []
for name, adm in [('重庆大学虎溪科学城校区', '重庆市沙坪坝区'),
                  ('重庆大学虎溪科学城校区', None), ('重庆', None), ('沙坪坝', '重庆')]:
    query = dict(location=name, range='cn', number='5', lang='zh')
    if adm:
        query['adm'] = adm
    request = urllib.request.Request('https://' + resolve(config['apiHost']) + '/geo/v2/city/lookup?' + urllib.parse.urlencode(query),
                                     headers={'X-QW-Api-Key': resolve(config['apiKey'])})
    row = dict(location=name, adm=adm)
    try:
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                status, body, encoding = response.status, response.read(100000), response.headers.get('Content-Encoding')
        except urllib.error.HTTPError as error:
            status, body, encoding = error.code, error.read(100000), error.headers.get('Content-Encoding')
        row['httpStatus'] = status
        row['contentEncoding'] = encoding
        if encoding == 'gzip':
            body = gzip.decompress(body)
        try:
            data = json.loads(body)
            row['businessCode'] = data.get('code')
            row['candidates'] = [{key: item.get(key) for key in ['name', 'adm1', 'adm2']} for item in data.get('location', [])]
        except (ValueError, TypeError):
            row['invalidJson'] = True
    except Exception as error:
        row['transportErrorType'] = type(error).__name__
    results.append(row)
output = root / 'docs/verification/profile-geo-provider-probe.json'
output.write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(output.read_text())
