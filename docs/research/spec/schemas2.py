import json, io, sys, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
p = os.path.join(os.path.dirname(__file__), 'aholo-openapi.json')
d = json.load(open(p, encoding='utf-8'))
S = d['components']['schemas']
for name in sorted(S):
    if any(k in name for k in ['WorldAsset', 'WorldOpenApi', 'SpatialUnderstandingTaskResult',
                                'SpatialUnderstandingTaskStatus', 'ImageToFourView', 'MultimodalToImage',
                                'MultiFormatExport', 'PartSplit', 'MaterialTransfer', 'TaskQueryData',
                                'TaskList', 'WorldResourceItem', 'GenerateWorldResourceItem',
                                'Articulation', 'Humanoid']):
        print('\n===== ' + name + ' =====')
        print(json.dumps(S[name], ensure_ascii=False, indent=1)[:4500])
