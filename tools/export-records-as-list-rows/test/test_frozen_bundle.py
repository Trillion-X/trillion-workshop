"""frozen_bundle and do-work/freeze_a_bundle.py on made-up refs: a complete closure, a cycle and a diamond, an unresolved ref, a
file with no hash, a private part in a public bundle, byte-for-byte determinism, and the command's exit codes."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'read-data'))

import frozen_bundle  # noqa: E402
from record_write_send import blake3_hex  # noqa: E402

COMMAND = HERE.parent / 'do-work' / 'freeze_a_bundle.py'


def ref(kind, id_):
    return {'kind': kind, 'id': id_}


def file_part(kind, id_, hash_, public=True, dependencies=()):
    return {'ref': ref(kind, id_), 'integrity_hash': hash_, 'public_readable': public, 'dependencies': list(dependencies)}


def record_part(kind, id_, value, public=True, dependencies=()):
    return {'ref': ref(kind, id_), 'is_data': True, 'value': value, 'public_readable': public, 'dependencies': list(dependencies)}


def spec(parts, roots, tier='public', **more):
    return {'tier': tier, 'root': {'title': 'a made-up root'}, 'root_refs': roots, 'resolutions': parts, **more}


class FreezeTest(unittest.TestCase):
    def test_a_complete_closure_freezes_files_by_hash_and_records_as_data_sorted_by_key(self):
        parts = [
            file_part('page', 'home', 'h-home', dependencies=[ref('style', 'main'), ref('record', 'menu')]),
            file_part('style', 'main', 'h-style'),
            record_part('record', 'menu', {'items': ['a', 'b']}),
        ]
        done = frozen_bundle.freeze(spec(parts, [ref('page', 'home')]))
        self.assertTrue(done['ok'])
        self.assertEqual(done['bundle']['manifest_version'], frozen_bundle.MANIFEST_VERSION)
        self.assertEqual([row['ref']['id'] for row in done['bundle']['files']], ['home', 'main'])
        self.assertEqual(done['bundle']['records'], [{'ref': ref('record', 'menu'), 'value': {'items': ['a', 'b']}, 'public_readable': True}])
        self.assertEqual(done['bundle']['root'], {'title': 'a made-up root'})

    def test_a_cycle_and_a_diamond_end_and_each_part_appears_once(self):
        parts = [
            file_part('a', '1', 'h1', dependencies=[ref('b', '1'), ref('c', '1')]),
            file_part('b', '1', 'h2', dependencies=[ref('d', '1')]),
            file_part('c', '1', 'h3', dependencies=[ref('d', '1')]),
            file_part('d', '1', 'h4', dependencies=[ref('a', '1')]),
        ]
        done = frozen_bundle.freeze(spec(parts, [ref('a', '1'), ref('a', '1')]))
        self.assertTrue(done['ok'])
        self.assertEqual([row['ref']['kind'] for row in done['bundle']['files']], ['a', 'b', 'c', 'd'])

    def test_an_unresolved_ref_and_a_file_with_no_hash_refuse_and_give_no_bundle(self):
        parts = [file_part('a', '1', '', dependencies=[ref('logo', 'missing')])]
        done = frozen_bundle.freeze(spec(parts, [ref('a', '1')]))
        self.assertFalse(done['ok'])
        self.assertIsNone(done['bundle'])
        self.assertEqual({(issue['reason'], issue['ref']['kind']) for issue in done['reference_issues']}, {('unresolved', 'logo'), ('file-missing-hash', 'a')})

    def test_a_private_part_in_a_public_bundle_refuses_but_is_fine_in_another_tier(self):
        parts = [file_part('a', '1', 'h1', dependencies=[ref('b', '1'), ref('record', 'r')]), file_part('b', '1', 'h2', public=False), record_part('record', 'r', 1, public=False)]
        refused = frozen_bundle.freeze(spec(parts, [ref('a', '1')]))
        self.assertFalse(refused['ok'])
        self.assertEqual([(issue['reason'], issue['ref']['kind']) for issue in refused['tier_issues']], [('private-part-in-public-bundle', 'b'), ('private-part-in-public-bundle', 'record')])
        self.assertTrue(frozen_bundle.freeze(spec(parts, [ref('a', '1')], tier='held'))['ok'])
        self.assertFalse(frozen_bundle.freeze(spec(parts, [ref('a', '1')], tier='open', public_tiers=['open']))['ok'], 'which tiers are public is the caller\'s DATA')

    def test_the_same_closure_in_any_order_has_the_same_bytes_and_identity(self):
        one = [file_part('a', '1', 'h1', dependencies=[ref('b', '1')]), file_part('b', '1', 'h2')]
        two = [file_part('b', '1', 'h2'), file_part('a', '1', 'h1', dependencies=[ref('b', '1')])]
        first = frozen_bundle.canonical_bytes(frozen_bundle.freeze(spec(one, [ref('a', '1')], root={'z': 1, 'a': 2}))['bundle'])
        second = frozen_bundle.canonical_bytes(frozen_bundle.freeze({**spec(two, [ref('a', '1')]), 'root': {'a': 2, 'z': 1}})['bundle'])
        self.assertEqual(first, second)
        self.assertEqual(blake3_hex(first), blake3_hex(second))

    def test_a_ref_or_a_spec_that_is_not_plainly_shaped_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'A ref is'):
            frozen_bundle.freeze(spec([], [{'kind': 'a'}]))
        with self.assertRaisesRegex(ValueError, 'Two resolutions'):
            frozen_bundle.freeze(spec([file_part('a', '1', 'h'), file_part('a', '1', 'h')], []))
        with self.assertRaisesRegex(ValueError, 'tier is needed'):
            frozen_bundle.freeze({'root_refs': [], 'resolutions': []})


class CommandTest(unittest.TestCase):
    def run_command(self, folder, body):
        (folder / 'spec.json').write_text(json.dumps(body))
        run = subprocess.run([sys.executable, '-I', str(COMMAND), '--spec', str(folder / 'spec.json'), '--out', str(folder / 'bundle.json')], capture_output=True, text=True)
        return run

    def test_it_writes_the_canonical_bytes_once_and_names_their_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            body = spec([file_part('a', '1', 'h1'), record_part('record', 'r', {'k': 1})], [ref('a', '1'), ref('record', 'r')])
            first = self.run_command(folder, body)
            self.assertEqual(first.returncode, 0, first.stderr)
            said = json.loads(first.stdout)
            written = (folder / 'bundle.json').read_bytes()
            self.assertEqual(said['bundle_id'], f'1f:{blake3_hex(written)}')
            self.assertTrue(said['written'])
            self.assertEqual(json.loads(written)['manifest_version'], frozen_bundle.MANIFEST_VERSION)
            again = json.loads(self.run_command(folder, body).stdout)
            self.assertEqual((again['bundle_id'], again['written']), (said['bundle_id'], False))

    def test_a_refused_closure_writes_nothing_and_exits_3_and_a_bad_spec_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            refused = self.run_command(folder, spec([], [ref('a', '1')]))
            self.assertEqual(refused.returncode, 3)
            self.assertEqual(json.loads(refused.stdout)['reference_issues'][0]['reason'], 'unresolved')
            self.assertFalse((folder / 'bundle.json').exists())
            self.assertEqual(self.run_command(folder, {'tier': 'public'}).returncode, 2)


if __name__ == '__main__':
    unittest.main()
