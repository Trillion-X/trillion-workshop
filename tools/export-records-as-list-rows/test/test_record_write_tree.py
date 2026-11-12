"""Stdlib tests for the `tree` staged format: a document that keeps its nodes and scopes as alternating [id, object] lists, read
into one row per node a scope reaches. Every node is made up (a made-up orchard browser with two profiles and a private page).
Run: python3 -I -m unittest discover -s tools/export-records-as-list-rows/test -v"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL / 'read-data'))

import records_write  # noqa: E402

AT = '2026-01-01T00:00:00.000Z'

SPEC = {
    'containers': 'browser.containers',
    'nodes_key': 'items',
    'scopes_key': 'spaces',
    'scope_where': {'profile.default': True},
    'scope_present': ['title'],
    'roots': {'select': 'containerIDs', 'markers': ['pinned', 'unpinned']},
    'children': 'childrenIds',
    'keep_when_present': 'data.tab',
}


def flat(entries):
    """Entries of [id, object] written as the one alternating list the file keeps."""
    return [item for entry in entries for item in entry]


def tab(node_id, url, title=None, children=None):
    return [node_id, {'id': node_id, 'title': title, 'data': {'tab': {'savedURL': url, 'savedTitle': 'Saved ' + node_id}},
                      'childrenIds': children or []}]


def folder(node_id, title, children):
    return [node_id, {'id': node_id, 'title': title, 'data': {'list': {}}, 'childrenIds': children}]


DOCUMENT = {'browser': {'containers': [
    {'items': flat([tab('t-other', 'https://other.test/')]), 'spaces': ['s-other', {'id': 's-other', 'title': 'Work',
                                                                             'profile': {'custom': {'_0': {}}},
                                                                             'containerIDs': ['unpinned', 'r-other']}]},
    {'items': flat([
        folder('f-recipes', 'Recipes', ['t-bread', 't-private']),
        tab('t-bread', 'https://orchard.test/bread'),
        tab('t-private', 'https://accounts.orchard.test/login'),
        folder('f-pinned', None, ['t-pinned']),
        tab('t-pinned', 'https://orchard.test/pinned', 'Pinned title'),
        ['t-unreached', {'id': 't-unreached', 'data': {'tab': {'savedURL': 'https://orchard.test/lost'}}, 'childrenIds': []}],
        ['itemContainer-1', {'id': 'itemContainer-1', 'data': {'itemContainer': {}}, 'childrenIds': ['f-recipes', 'f-pinned']}],
    ]), 'spaces': ['s-home', {'id': 's-home', 'title': 'Personal', 'profile': {'default': True},
                             'containerIDs': ['pinned', 'itemContainer-1', 'unpinned', 'r-missing']},
                  's-untitled', {'id': 's-untitled', 'profile': {'default': True}, 'containerIDs': ['unpinned', 'x']}]},
]}}


class TreeRows(unittest.TestCase):
    def test_a_scope_reaches_its_roots_nodes_once_with_its_folders_and_marker(self):
        rows = records_write.tree_rows(DOCUMENT, SPEC)
        by_id = {r['id']: r for r in rows}
        self.assertEqual(sorted(by_id), ['t-bread', 't-pinned', 't-private'],
                         'only the default profile named scope is read; the custom profile and the untitled one are not')
        self.assertEqual(by_id['t-bread']['_folder'], ['Recipes'])
        self.assertEqual(by_id['t-bread']['_space'], 'Personal')
        self.assertEqual(by_id['t-bread']['_root'], 'pinned')
        self.assertEqual(by_id['t-pinned']['_folder'], [], 'a folder with no title adds no name')
        self.assertEqual(by_id['t-pinned']['_root'], 'pinned')
        self.assertEqual(by_id['t-private']['_root'], 'pinned')

    def test_a_node_no_root_reaches_is_not_a_row_and_a_missing_root_is_skipped(self):
        ids = {r['id'] for r in records_write.tree_rows(DOCUMENT, SPEC)}
        self.assertNotIn('t-unreached', ids)
        self.assertNotIn('r-missing', ids)

    def test_a_node_without_its_keep_path_is_not_a_row_but_its_children_are_walked(self):
        document = {'browser': {'containers': [{'items': flat([
            folder('f', 'Group', ['t-a']), tab('t-a', 'https://a.test/')]), 'spaces': [
                's', {'title': 'Personal', 'profile': {'default': True}, 'containerIDs': ['pinned', 'f']}]}]}}
        rows = records_write.tree_rows(document, SPEC)
        self.assertEqual([(r['id'], r['_folder']) for r in rows], [('t-a', ['Group'])])

    def test_a_missing_path_or_a_non_list_is_not_a_crash(self):
        self.assertEqual(records_write.tree_rows({'browser': {}}, SPEC), [])
        self.assertEqual(records_write.tree_rows({'browser': {'containers': [{'items': None, 'spaces': None}]}}, SPEC), [])


class TreeSource(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='record-write-tree-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / 'Tree.json').write_text(json.dumps(DOCUMENT))

    def mapping(self):
        return {
            'lists_file': {'root': 'here', 'path': 'lists.json'},
            'limits': {'text_chars': 500, 'basis_sources': 10, 'per_command': 50, 'command_bytes': 24000},
            'by': 'tree-test', 'confidence': 'high', 'payload_note': 'A made-up tree.',
            'emit': ['tabs'],
            'sources': [{
                'name': 'tabs', 'list': 'tabs', 'kind': 'staged',
                'inputs': [{'root': 'here', 'path': 'Tree.json', 'format': 'tree', 'tree': SPEC}],
                'compute': {'id': {'text': 'tab:{id}'}},
                'values': {
                    'title': {'first_set': [{'path': 'title'}, {'path': 'data.tab.savedTitle'}]},
                    'url': {'path': 'data.tab.savedURL'},
                    'space': {'path': '_space'},
                    'folder': {'joined': {'of': {'path': '_folder'}, 'sep': ' / '}},
                },
                'skip_if': {'empty': {'path': 'url'}},
            }],
        }

    def test_each_tree_node_becomes_a_row_with_its_values_and_a_file_time(self):
        (self.tmp / 'lists.json').write_text(json.dumps({'lists': [{'id': 'tabs', 'value': {
            'label': 'Tabs', 'row_type': 'tab', 'title_field': 'title', 'fields': [
                {'id': 'title', 'kind': 'text', 'label': 'Title'}, {'id': 'url', 'kind': 'text', 'label': 'URL'},
                {'id': 'space', 'kind': 'text', 'label': 'Space'}, {'id': 'folder', 'kind': 'text', 'label': 'Folder'}]}}],
            'views': []}))
        payload = records_write.build(self.mapping(), {'here': self.tmp}, AT)
        records = {r['id']: r for c in payload['commands'] for r in c['input']['records']}
        bread = records['record:tab:tab:t-bread']['value']
        self.assertEqual(bread['url'], 'https://orchard.test/bread')
        self.assertEqual(bread['space'], 'Personal')
        self.assertEqual(bread['folder'], 'Recipes')
        self.assertEqual(bread['title'], 'Saved t-bread')
        self.assertEqual(records['record:tab:tab:t-pinned']['value']['title'], 'Pinned title')
        self.assertEqual(sorted(i for i in records if i.startswith('record:tab:')),
                         ['record:tab:tab:t-bread', 'record:tab:tab:t-pinned', 'record:tab:tab:t-private'])


if __name__ == '__main__':
    unittest.main()
