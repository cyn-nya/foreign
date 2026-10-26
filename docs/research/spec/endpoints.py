import json, io, sys, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
p = os.path.join(os.path.dirname(__file__), 'aholo-openapi.json')
d = json.load(open(p, encoding='utf-8'))
S = d['components']['schemas']

def resolve(sc, depth=0):
    if depth > 6: return '...'
    if not isinstance(sc, dict): return sc
    if '$ref' in sc:
        name = sc['$ref'].split('/')[-1]
        return {'__ref': name}
    out = {}
    if 'type' in sc: out['type'] = sc['type']
    if 'enum' in sc: out['enum'] = sc['enum']
    if 'default' in sc: out['default'] = sc['default']
    if 'format' in sc: out['format'] = sc['format']
    if 'description' in sc: out['desc'] = sc['description'][:300]
    if 'required' in sc: out['required'] = sc['required']
    if 'properties' in sc:
        out['props'] = {k: resolve(v, depth + 1) for k, v in sc['properties'].items()}
    if 'items' in sc:
        out['items'] = resolve(sc['items'], depth + 1)
    if 'oneOf' in sc: out['oneOf'] = [resolve(x, depth+1) for x in sc['oneOf']]
    if 'allOf' in sc: out['allOf'] = [resolve(x, depth+1) for x in sc['allOf']]
    return out

def dump_schema(name):
    sc = S.get(name)
    print('\n===== SCHEMA:', name, '=====')
    print(json.dumps(sc, ensure_ascii=False, indent=1)[:6000])

def dump_op(path, method):
    op = d['paths'][path][method]
    print('\n########', method.upper(), path, '########')
    print('summary:', op.get('summary'))
    print('operationId:', op.get('operationId'))
    print('security:', json.dumps(op.get('security'), ensure_ascii=False))
    print('params:', json.dumps(op.get('parameters'), ensure_ascii=False, indent=1)[:3000])
    rb = op.get('requestBody')
    if rb:
        for ct, spec in rb.get('content', {}).items():
            print('requestBody', ct, '->', json.dumps(spec.get('schema'), ensure_ascii=False))
    resp = op.get('responses', {})
    for code, r in resp.items():
        for ct, spec in (r.get('content') or {}).items():
            print(f'response {code} {ct} ->', json.dumps(spec.get('schema'), ensure_ascii=False))

WANT = [
    ('/world/v1/reconstructions', 'post'),
    ('/world/v1/generations', 'post'),
    ('/world/v1/{worldId}', 'get'),
    ('/lux3d/v1/generate/task/get', 'get'),
    ('/lux3d/v1/generate/img-to-3d/task/create', 'post'),
    ('/lux3d/v1/generate/text-to-3d/task/create', 'post'),
    ('/spatial-understanding/v1/tasks', 'post'),
    ('/spatial-understanding/v1/tasks/{taskId}', 'get'),
    ('/asset/v1/token', 'get'),
]
for path, m in WANT:
    dump_op(path, m)

# collect all schema names referenced by those ops
names = set()
def collect(o):
    if isinstance(o, dict):
        if '$ref' in o: names.add(o['$ref'].split('/')[-1])
        for v in o.values(): collect(v)
    elif isinstance(o, list):
        for v in o: collect(v)
for path, m in WANT:
    collect(d['paths'][path][m])
for n in sorted(names):
    dump_schema(n)
