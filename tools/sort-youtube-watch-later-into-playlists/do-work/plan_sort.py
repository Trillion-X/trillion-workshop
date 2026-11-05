    json.dump(out, open(f'{ACC}/sort-plan.json', 'w'), indent=1, ensure_ascii=False)
    open(f'{ACC}/SORT-PLAN.md', 'w').write('\n'.join(md) + '\n')
    for a in out['accounts']:
        print(a['channel'], a['watch_later_count'], 'unsorted', len(a['unsorted']), 'held', len(a['held_back']))
        for p in a['playlists']: print('  ', len(p['items']), p['title'])
if __name__ == '__main__': main()
