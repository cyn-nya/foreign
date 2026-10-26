import json, io, sys, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
p = os.path.join(os.path.dirname(__file__), 'aholo-openapi.json')
d = json.load(open(p, encoding='utf-8'))
print('openapi', d.get('openapi'))
print('info', d['info'].get('title'), d['info'].get('version'))
print('servers', json.dumps(d.get('servers'), ensure_ascii=False))
print('securitySchemes', json.dumps(d.get('components', {}).get('securitySchemes', {}), ensure_ascii=False, indent=1))
print('num paths', len(d.get('paths', {})))
print('num schemas', len(d.get('components', {}).get('schemas', {})))
print()
print('=== TAGS ===')
for t in d.get('tags', []):
    print('-', t['name'], '|', t.get('x-displayName'), '|', (t.get('description') or '')[:200].replace('\n', ' '))
print()
print('=== PATHS BY TAG ===')
from collections import defaultdict
by = defaultdict(list)
for path, item in d['paths'].items():
    for method, op in item.items():
        if method not in ('get', 'post', 'put', 'delete', 'patch'):
            continue
        tags = op.get('tags', ['(none)'])
        by[tags[0]].append((method.upper(), path, op.get('summary', ''), op.get('operationId', '')))
for tag in by:
    print('\n## ' + tag, f'({len(by[tag])})')
    for m, path, summ, opid in sorted(by[tag], key=lambda x: x[1]):
        print(f'  {m:5} {path}\n        {summ}   [{opid}]')
