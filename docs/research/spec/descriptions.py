import json, io, sys, os, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
p = os.path.join(os.path.dirname(__file__), 'aholo-openapi.json')
d = json.load(open(p, encoding='utf-8'))

print('#################### FULL OPERATION DESCRIPTIONS ####################')
for path, item in d['paths'].items():
    for method, op in item.items():
        if method not in ('get', 'post', 'put', 'delete', 'patch'):
            continue
        tags = op.get('tags', [])
        if tags and tags[0] == 'RenderCloudOpenUSDGuide':
            continue
        print('\n' + '=' * 78)
        print(f"{method.upper()} {path}   [{op.get('operationId')}]")
        print('-' * 78)
        print(op.get('summary', ''))
        desc = op.get('description') or ''
        print(desc)

print('\n\n#################### QUOTA / CONCURRENCY / PRICING MENTIONS ####################')
raw = json.dumps(d, ensure_ascii=False)
for kw in ['并发', '额度', '配额', '限流', 'QPS', '每分钟', 'credit', '积分', '收费', '计费', '价格', 'rate limit', 'trial', '免费']:
    hits = [m.start() for m in re.finditer(re.escape(kw), raw)]
    if hits:
        print(f'\n### keyword: {kw}  ({len(hits)} hits)')
        seen = set()
        for h in hits[:6]:
            snippet = raw[max(0, h - 180):h + 220].replace('\\n', ' ')
            if snippet[:60] in seen:
                continue
            seen.add(snippet[:60])
            print('   ...', snippet, '...')
