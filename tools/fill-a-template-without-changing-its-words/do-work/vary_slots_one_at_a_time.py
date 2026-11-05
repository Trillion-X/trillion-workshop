                  'voice': [claim_for(x, d, b, t) for x in ss], 'screen': []}
        with open(os.path.join(NARRATOR, 'claims', f'{sid}.json'), 'w', encoding='utf-8') as f:
            json.dump(claims, f, ensure_ascii=False, indent=1)
        manifest[vid] = {'shot': sid, 'slots': {'DETAIL': d, 'BEAT': b, 'TEASE': t}, 'line': script}
    with open(os.path.join(HERE, 'lines.txt'), 'w', encoding='utf-8') as f:
        for vid, m in manifest.items():
            f.write(m['line'] + '\n')
    with open(os.path.join(HERE, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(len(manifest), 'variants written')
