def read(name):
    with open(os.path.join(HERE, name)) as f:
        return json.load(f)


class World:
    def __init__(self):
        self.lists = {item['list']['id']: item['list'] for item in read('lists.json')['lists']}
        self.rows = {lid: {r['id']: r['values'] for r in read(f'rows/{lid}.json')['rows']} for lid in self.lists}
        self.relations = read('relations.json')['relations']
        self.kinds = self.rows['world-kinds']
        self.entities = self.rows['world-entities']
        self.facts = self.rows['world-facts']
        self.type_to_list = {spec['row_type']: lid for lid, spec in self.lists.items()}

    def record(self, ref):
        """(list id, row id) for record:<row type>:<id>, or None for `me` and unknown refs."""
        if not ref.startswith(ROW_PREFIX):
            return None
        row_type, _, row_id = ref[len(ROW_PREFIX):].partition(':')
        lid = self.type_to_list.get(row_type)
        return (lid, row_id) if lid and row_id in self.rows[lid] else None

    def name(self, ref):
        hit = self.record(ref)
        if not hit:
            return ref
        lid, row_id = hit
        spec = self.lists[lid]
        return self.rows[lid][row_id].get(spec['title_field'], row_id)

    def kind_of(self, eid):
        return self.entities[eid]['kind'][0]

    def episode_order(self, eid):
        return self.entities.get(eid, {}).get('sequence', 0)

    def fact_time(self, fid):
        v = self.facts[fid]
        episode = (v.get('episode') or [None])[0]
        return (self.episode_order(episode) if episode else 0, v.get('cut_at_s', v.get('source_at_s', 0)))

    def fact_of(self, relation):
        m = re.match(r'fact:(\S+)', relation.get('said', ''))
        return m.group(1) if m else None

    def sentence(self, relation):
        reads = next((v['reads'] for v in self.kinds.values() if v['applies_to'] == 'relation' and v['label'] == relation['role']), None)
        s, o = self.name(relation['subject']), self.name(relation['object'])
        return reads.format(s=s, o=o) if reads else f'{s} is the {relation["role"]} of {o}'

    def resolve(self, query):
        q = query.lower().strip()
        if q in self.entities:
            return [q]
        exact = [eid for eid, v in self.entities.items() if q == v['name'].lower() or q in [a.lower() for a in v.get('aliases', [])]]
        return exact or [eid for eid, v in self.entities.items()
                         if q in v['name'].lower() or q in eid or any(q in a.lower() for a in v.get('aliases', []))]


def source_text(v):
    where = v['source']
    if 'source_at_s' in v:
        where += f' @ {v["source_at_s"]:.2f} s'
    if 'source_line' in v:
        where += f' line {v["source_line"]}'
    if 'cut_at_s' in v:
        where += f' (cut {v["cut_at_s"]:.3f} s)'
    return where


# ---------------------------------------------------------------- verify
NORM = re.compile(r"[^a-z0-9.%]")
norm = lambda s: NORM.sub('', s.lower().replace("'", '')).rstrip('.')
FITS = {
    'text': lambda x: isinstance(x, str), 'long-text': lambda x: isinstance(x, str),
    'number': lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
    'tags': lambda x: isinstance(x, list) and all(isinstance(i, str) for i in x),
    'link': lambda x: isinstance(x, list) and all(isinstance(i, str) for i in x),
    'choice': lambda x: isinstance(x, str),
}
ROWS_PER_WRITE = 200  # src/lists.json limits.rows_per_write
TEXT_CHARS = 20000    # src/lists.json limits.text_chars


def quote_problem(v, words_cache):
    src = v['source'] if os.path.isabs(v['source']) else os.path.join(HERE, v['source'])  # a relative source is read from this folder
    if not os.path.exists(src):
        return f'source missing: {src}'
    if 'said' not in v:  # a fact read off a saved frame has no words to match, only the frame file
        return None
    said = v['said']
    if 'source_at_s' in v:
        if src not in words_cache:
            with open(src) as f:
