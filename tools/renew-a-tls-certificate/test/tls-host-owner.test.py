"""Private descriptor and DNS credential behavior, using the real Linux memfd owner."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

# Beside the owner on its server (host-test installs this file as <owner>.test.py), or in the tool folder here.
source = Path(__file__).with_name(Path(__file__).name.replace('.test.py', '.py'))
if not source.exists():
    source = Path(__file__).parent.parent / 'do-work' / 'tls-host-owner.py'
spec = importlib.util.spec_from_file_location('portable_tls', source)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


def made_up_layout(state):
    return {'state': str(state), 'ingress': {'service': 'example-public-tls'},
            'receptionist': {'service': 'example-receptionist', 'account': 'example-mcp',
                             'binary_pattern': r'/opt/example/source/[a-f0-9]{40}/target/release/example-receptionist',
                             'listen': '127.0.0.1:9443',
                             'environment': {'EXAMPLE_LISTEN': '{listen}', 'EXAMPLE_ORIGIN': 'https://{hostname}'}}}


def pwd_entry():
    import pwd
    return pwd.getpwuid(os.getuid())


class TLS(unittest.TestCase):
    def test_activation_requires_real_canonical_metadata_readback(self):
        good = {'resource': 'https://app.example.com/mcp', 'authorization_servers': ['https://app.example.com']}
        calls = []
        def response(args):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, json.dumps(good).encode(), b'')
        with patch.object(owner, 'run', response):
            owner.verify_receptionist('app.example.com')
        self.assertIn('--resolve', calls[0])
        self.assertNotIn('-k', calls[0])
        good['resource'] = 'https://other.example.com/mcp'
        with patch.object(owner, 'run', response), patch.object(owner.time, 'sleep'):
            with self.assertRaises(ValueError):
                owner.verify_receptionist('app.example.com')

    def test_a_receptionist_build_others_cannot_start_is_refused_before_anything_is_switched(self):
        import tempfile
        # Under /tmp: every folder above it must let others pass, as on the server.
        with tempfile.TemporaryDirectory(dir='/tmp') as root:
            root = os.path.realpath(root)
            os.chmod(root, 0o755)
            folder = Path(root) / 'opt' / 'example' / 'source' / ('a' * 40) / 'target' / 'release'
            folder.mkdir(parents=True)
            for one in [folder, *folder.parents]:
                if str(one).startswith(root):
                    one.chmod(0o755)
            binary = folder / 'example-receptionist'
            binary.write_bytes(b'#!/bin/sh\n'); binary.chmod(0o700)
            owned = Path(root) / 'owner'
            layout = made_up_layout(owned)
            layout['receptionist']['binary_pattern'] = root + r'/opt/example/source/[a-f0-9]{40}/target/release/example-receptionist'
            calls = []
            with patch.object(owner, 'layout', lambda: layout), patch.object(owner, 'run', lambda *a, **k: calls.append(a)), \
                 patch.object(owner, 'certificate_status', lambda host: calls.append(host)):
                with self.assertRaises(ValueError) as refused:
                    owner.configure({'hostname': 'app.example.com', 'nginx': 'events {}', 'receptionistBinary': str(binary)})
                self.assertIn(f'chmod 0755 {binary}', str(refused.exception))
                self.assertEqual(calls, [])
                self.assertFalse(owned.exists())
                binary.chmod(0o755)
                self.assertEqual(owner.startable(str(binary)), str(binary))
                with self.assertRaises(ValueError):
                    owner.startable(str(Path(root) / 'missing'))
                with self.assertRaises(ValueError):
                    owner.receptionist_binary('/tmp/unowned')

    def test_every_product_fact_is_read_from_the_layout_beside_the_owner(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            units, owned = Path(root) / 'units', Path(root) / 'owner'
            units.mkdir()
            calls = []
            real_path = owner.Path
            def path(value, *more):
                return units if str(value) == '/etc/systemd/system' else real_path(value, *more)
            with patch.object(owner, 'layout', lambda: made_up_layout(owned)), patch.object(owner, 'run', lambda args, **k: calls.append(args)), \
                 patch.object(owner, 'certificate_status', lambda host: None), patch.object(owner, 'startable', lambda binary: binary), \
                 patch.object(owner, 'Path', path):
                answer = owner.configure({'hostname': 'app.example.com', 'nginx': 'events {}',
                                          'receptionistBinary': '/opt/example/source/' + 'b' * 40 + '/target/release/example-receptionist'})
            self.assertTrue(answer['receptionist_configured'])
            ingress = (units / 'example-public-tls.service').read_text()
            self.assertIn(f'-c {owned}/nginx.conf', ingress)
            self.assertIn(f'ExecStart=/usr/bin/python3 {owner.SCRIPT} launch', (units / 'example-receptionist.service').read_text())
            self.assertEqual(json.loads((owned / 'receptionist.json').read_text())['hostname'], 'app.example.com')
            self.assertIn(['systemctl', 'enable', '--now', 'example-public-tls.service'], calls)
            self.assertEqual(os.stat(owned / 'nginx.conf').st_mode & 0o777, 0o600)

    def followed_layout(self, root):
        layout = made_up_layout(Path(root) / 'owner')
        layout['receptionist']['account'] = 'example-mcp'
        layout['receptionist']['releases'] = {
            'folder': str(Path(root) / 'releases'), 'program': 'example-forwarder', 'target': 'x86_64-unknown-linux-gnu', 'body_max_bytes': 1 << 20,
            'feed': {'urls': ['https://releases.example.com/forwarder-feed.json'], 'public_keys': ['a' * 64]},
            'retire': {'folder': str(Path(root) / 'source'), 'name': '[a-f0-9]{40}'}}
        return layout

    def test_the_program_a_host_starts_is_the_release_current_names_else_the_seed(self):
        import tempfile
        me = pwd_entry()
        with tempfile.TemporaryDirectory() as root, patch.object(owner.pwd, 'getpwnam', lambda name: me):
            layout = self.followed_layout(root)['receptionist']
            self.assertIsNone(owner.followed_binary(layout), 'no current yet: the seed starts')
            release = Path(root) / 'releases' / 'example-forwarder' / ('c' * 40)
            release.mkdir(parents=True)
            (release / 'example-forwarder').write_bytes(b'#!/bin/sh\n')
            (release / 'example-forwarder').chmod(0o755)
            os.symlink('c' * 40, Path(root) / 'releases' / 'example-forwarder' / 'current')
            self.assertEqual(owner.followed_binary(layout), str(Path(root) / 'releases' / 'example-forwarder' / 'current' / 'example-forwarder'))
            (release / 'example-forwarder').chmod(0o644)
            self.assertIsNone(owner.followed_binary(layout), 'a release that cannot be run is not started')
            (release / 'example-forwarder').chmod(0o755)
            self.assertIsNone(owner.followed_binary({**layout, 'releases': None}), 'a host with no releases layout follows nothing')

    def test_a_host_that_follows_releases_writes_its_feed_file_and_lets_the_service_write_only_its_own_folder(self):
        import tempfile
        me = pwd_entry()
        with tempfile.TemporaryDirectory() as root:
            units, layout = Path(root) / 'units', self.followed_layout(root)
            units.mkdir()
            calls, real_path = [], owner.Path
            path = lambda value, *more: units if str(value) == '/etc/systemd/system' else real_path(value, *more)
            with patch.object(owner, 'layout', lambda: layout), patch.object(owner, 'run', lambda args, **k: calls.append(args)), \
                 patch.object(owner, 'certificate_status', lambda host: None), patch.object(owner, 'startable', lambda binary: binary), \
                 patch.object(owner.pwd, 'getpwnam', lambda name: me), patch.object(owner.os, 'chown', lambda *a: None), patch.object(owner, 'Path', path):
                owner.configure({'hostname': 'app.example.com', 'nginx': 'events {}',
                                 'receptionistBinary': '/opt/example/source/' + 'b' * 40 + '/target/release/example-receptionist'})
            unit = (units / 'example-receptionist.service').read_text()
            folder = Path(root) / 'releases' / 'example-forwarder'
            self.assertIn(f'ProtectSystem=strict\nReadWritePaths={folder}\n', unit)
            feed = json.loads((Path(root) / 'releases' / 'release-feed.json').read_text())
            self.assertEqual(feed, {'urls': ['https://releases.example.com/forwarder-feed.json'], 'public_keys': ['a' * 64], 'releases': str(Path(root) / 'releases')})
            self.assertEqual(os.stat(Path(root) / 'releases' / 'release-feed.json').st_mode & 0o777, 0o644)
        # A host with no releases layout keeps the read-only system and no extra path.
        self.assertNotIn('ReadWritePaths', owner.receptionist_unit(made_up_layout('/x')['receptionist'], None))

    def test_a_seed_is_the_newest_release_for_the_target_with_the_program_alone_at_its_root(self):
        import io, tarfile, tempfile
        def archive(names):
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w:gz') as tar:
                for name in names:
                    info = tarfile.TarInfo(name); info.size = 4
                    tar.addfile(info, io.BytesIO(b'prog'))
            return raw.getvalue()
        def serving(body, held=None):
            entry = {'commit': 'd' * 40, 'sequence': 9, 'target': 'x86_64-unknown-linux-gnu', 'url': 'https://releases.example.com/body.tar.gz', 'bytes': len(body)}
            older = {**entry, 'commit': 'e' * 40, 'sequence': 3}
            feed = json.dumps({'releases': [older, entry, {**entry, 'sequence': 99, 'target': 'aarch64-unknown-linux-gnu'}]}).encode()
            class Response(io.BytesIO):
                __enter__ = lambda self: self
                __exit__ = lambda self, *a: None
            return lambda request, timeout: Response(feed if request.full_url.endswith('feed.json') else body)
        with tempfile.TemporaryDirectory() as root:
            layout = self.followed_layout(root)
            (Path(root) / 'releases' / 'example-forwarder').mkdir(parents=True)
            with patch.object(owner, 'layout', lambda: layout), patch.object(owner.urllib.request, 'urlopen', serving(archive(['example-forwarder']))):
                answer = owner.seed({})
            self.assertEqual((answer['commit'], answer['sequence']), ('d' * 40, 9), 'the newest release of this target, not another target\'s')
            placed = Path(answer['binary'])
            self.assertEqual((placed.read_bytes(), placed.stat().st_mode & 0o777), (b'prog', 0o755))
            with patch.object(owner, 'layout', lambda: layout), patch.object(owner.urllib.request, 'urlopen', serving(archive(['example-forwarder', 'extra']))):
                with self.assertRaises(ValueError):
                    owner.seed({})
            with patch.object(owner, 'layout', lambda: layout), patch.object(owner.urllib.request, 'urlopen', serving(archive(['example-forwarder']))):
                layout['receptionist']['releases']['feed']['urls'] = ['http://releases.example.com/forwarder-feed.json']
                with self.assertRaises(ValueError):
                    owner.seed({})

    def test_retiring_the_hand_road_removes_old_build_folders_but_the_one_the_seed_runs_from(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            layout = self.followed_layout(root)
            source = Path(root) / 'source'
            for name in ['a' * 40, 'b' * 40, 'not-a-build']:
                (source / name / 'target').mkdir(parents=True)
            owned = Path(root) / 'owner'
            owned.mkdir()
            (owned / 'receptionist.json').write_text(json.dumps({'hostname': 'app.example.com', 'binary': f"{source / ('b' * 40)}/target/release/x"}))
            with patch.object(owner, 'layout', lambda: layout):
                self.assertEqual(owner.retire({}), {'retired': 1})
            self.assertEqual(sorted(one.name for one in source.iterdir()), ['b' * 40, 'not-a-build'])

    def test_a_rollback_runs_the_programs_own_verb_as_its_account_and_refuses_a_name_that_is_not_a_commit(self):
        import tempfile
        me = pwd_entry()
        with tempfile.TemporaryDirectory() as root:
            layout = self.followed_layout(root)
            calls = []
            def run(args, **kwargs):
                calls.append((args, kwargs))
                return subprocess.CompletedProcess(args, 0, b'{"current":"%s"}' % (b'f' * 40) if args[1:2] == ['release'] else b'', b'')
            with patch.object(owner, 'layout', lambda: layout), patch.object(owner, 'run', run), patch.object(owner.pwd, 'getpwnam', lambda name: me), \
                 patch.object(owner, 'followed_binary', lambda receptionist: '/r/current/example-forwarder'), patch.object(owner, 'verify_receptionist', lambda host: None):
                answer = owner.roll_back({'hostname': 'app.example.com', 'commit': 'c' * 40})
                with self.assertRaises(ValueError):
                    owner.roll_back({'hostname': 'app.example.com', 'commit': '../etc'})
            self.assertEqual(answer, {'rolled_back': 'c' * 40, 'current': 'f' * 40})
            args, kwargs = calls[0]
            self.assertEqual(args[:3], ['/r/current/example-forwarder', 'release', 'roll-back'])
            self.assertEqual((args[4], args[5:]), ('c' * 40, ['a' * 64]))
            self.assertEqual((kwargs['user'], kwargs['group']), (me.pw_uid, me.pw_gid), 'run as the service account that owns the folder')
            self.assertEqual(calls[1][0], ['systemctl', 'restart', 'example-receptionist.service'])

    def test_certificate_hostname_is_not_shell_or_path(self):
        for name in ['etc/passwd', 'good.com\n', 'good.com;false', '-bad.com']:
            with self.assertRaises(ValueError):
                owner.hostname(name)

    @unittest.skipUnless(hasattr(os, 'memfd_create'), 'Linux retained-host descriptor facility')
    def test_private_credential_is_regular_anonymous_file_and_inherited_child_reads_it(self):
        canary = b'dns_cloudflare_api_token = PRIVATE_TEST_CANARY\n'
        fd = owner.memory_file('test-tls', canary)
        try:
            self.assertEqual(os.fstat(fd).st_mode & 0o777, 0o600)
            self.assertIn('memfd:test-tls', os.readlink(f'/proc/self/fd/{fd}'))
            # openssl reads the inherited descriptor; no credential in argv or env.
            child = subprocess.run(['openssl', 'base64', '-A', '-in', f'/proc/self/fd/{fd}'], pass_fds=(fd,), capture_output=True, check=True)
            import base64
            self.assertEqual(base64.b64decode(child.stdout), canary)
        finally:
            os.close(fd)

    @unittest.skipUnless(hasattr(os, 'memfd_create'), 'Linux retained-host descriptor facility')
    # The owner runs as root on the server and keeps certbot's logs in /run; a computer where /run cannot be written
    # (any account but root) skips this and says so.
    @unittest.skipUnless(os.access('/run', os.W_OK), 'needs root: certbot logs are kept in /run, as on the server')
    def test_failed_provider_diagnostic_cannot_return_the_token(self):
        canary = 'TEST_TOKEN_1234567890_PRIVATE'
        seen = []
        def provider(args, **kwargs):
            seen.append(args)
            fd = kwargs['pass_fds'][0]
            self.assertEqual(os.read(fd, 4096), f'dns_cloudflare_api_token = {canary}\n'.encode())
            self.assertNotIn(canary, json.dumps(args))
            return subprocess.CompletedProcess(args, 1, canary.encode(), b'provider unavailable')
        with patch.object(owner.subprocess, 'run', provider), patch.object(owner, 'dns_snapshot', return_value={}):
            with self.assertRaises(ValueError) as failure:
                owner.certificate('issue', {'hostname': 'app.example.com', 'token': canary})
        self.assertNotIn(canary, str(failure.exception))
        self.assertIn('--dns-cloudflare', seen[0])

    @unittest.skipUnless(hasattr(os, 'memfd_create'), 'Linux retained-host descriptor facility')
    # The owner runs as root on the server and keeps certbot's logs in /run; a computer where /run cannot be written
    # (any account but root) skips this and says so.
    @unittest.skipUnless(os.access('/run', os.W_OK), 'needs root: certbot logs are kept in /run, as on the server')
    def test_a_dry_run_renewal_asks_the_staging_server_and_changes_no_certificate(self):
        seen = []
        def provider(args, **kwargs):
            seen.append(args)
            return subprocess.CompletedProcess(args, 0, b'', b'')
        with patch.object(owner.subprocess, 'run', provider), patch.object(owner, 'dns_snapshot', return_value={}), \
             patch.object(owner, 'certificate_status', lambda host: {'hostname': host}), \
             patch.object(owner.Path, 'exists', lambda self: True), patch.object(owner.Path, 'read_bytes', lambda self: b'same'):
            answer = owner.certificate('renew', {'hostname': 'app.example.com', 'token': 'T' * 24, 'dryRun': True})
        self.assertIn('--dry-run', seen[0])
        self.assertTrue(answer['dry_run'])
        self.assertFalse(answer['certificate_changed'])


if __name__ == '__main__':
    unittest.main()
