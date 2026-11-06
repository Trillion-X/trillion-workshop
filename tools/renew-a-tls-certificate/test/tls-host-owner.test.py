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
