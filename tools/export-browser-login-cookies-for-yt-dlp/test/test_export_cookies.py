"""Runs export_cookies.py on a made-up browser profile written here: a cookie database whose values are encrypted the
way Chromium does on macOS, with a made-up password passed through the environment (the keychain is never asked)."""
import hashlib, json, os, shutil, sqlite3, stat, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'do-work', 'export_cookies.py')
PASSWORD = 'made-up-safe-storage-password'

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    MISSING = None
except ImportError:
    MISSING = 'needs the cryptography package'


def encrypt(value, host=None, password=PASSWORD):
    key = hashlib.pbkdf2_hmac('sha1', password.encode(), b'saltysalt', 1003, 16)
    plain = (hashlib.sha256(host.encode()).digest() if host else b'') + value.encode()
    pad = 16 - len(plain) % 16
    e = Cipher(algorithms.AES(key), modes.CBC(b' ' * 16)).encryptor()
    return b'v10' + e.update(plain + bytes([pad]) * pad) + e.finalize()


# Chromium times are microseconds since 1601-01-01; 13_500_000_000_000_000 is 2028-10-18 (unix 1855526400).
EXPIRES = 13_500_000_000_000_000
EXPIRES_UNIX = str(int(EXPIRES / 1_000_000 - 11644473600))


def make_db(path, password=PASSWORD):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    con.execute('create table cookies (host_key text, path text, is_secure integer, expires_utc integer, name text, encrypted_value blob, value text)')
    con.executemany('insert into cookies values (?,?,?,?,?,?,?)', [
        ('.youtube.com', '/', 1, EXPIRES, 'TOKA', encrypt('wobble-123', password=password), ''),
        ('.google.com', '/', 1, EXPIRES, 'TOKB', encrypt('frobnitz-456', host='.google.com', password=password), ''),
        ('accounts.google.com', '/signin', 0, 0, 'PLAIN', b'', 'plain-value'),
        ('.example.org', '/', 1, EXPIRES, 'ELSEWHERE', encrypt('not-exported', password=password), ''),
    ])
    con.commit()
    con.close()


@unittest.skipIf(MISSING, MISSING)
class ExportCookies(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.user_data = os.path.join(self.dir, 'User Data')
        make_db(os.path.join(self.user_data, 'Profile 7', 'Cookies'))

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_it(self, *args, env=None):
        done = subprocess.run([sys.executable, '-I', SCRIPT, *args], capture_output=True, text=True,
                              env={**os.environ, 'ZZ_SAFE_STORAGE': PASSWORD, **(env or {})})
        return done, json.loads(done.stdout.strip().splitlines()[-1])

    def lines(self, out):
        with open(out) as f:
            return [l.split('\t') for l in f.read().splitlines()]

    def test_writes_the_youtube_and_google_cookies_decrypted_in_netscape_form(self):
        out = os.path.join(self.dir, 'nested', 'cookies.txt')
        done, last = self.run_it('--user-data', self.user_data, '--profile', 'Profile 7', '--out', out, '--password-env', 'ZZ_SAFE_STORAGE')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(last['result']['cookies'], 3)
        self.assertEqual(last['result']['domains'], ['youtube.com', 'google.com'])
        lines = self.lines(out)
        self.assertEqual(lines[0], ['# Netscape HTTP Cookie File'])
        self.assertEqual(sorted(lines[1:]), sorted([
            ['.youtube.com', 'TRUE', '/', 'TRUE', EXPIRES_UNIX, 'TOKA', 'wobble-123'],
            ['.google.com', 'TRUE', '/', 'TRUE', EXPIRES_UNIX, 'TOKB', 'frobnitz-456'],
            ['accounts.google.com', 'FALSE', '/signin', 'FALSE', '0', 'PLAIN', 'plain-value'],
        ]))
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)

    def test_domains_are_arguments_and_a_database_can_be_named_directly(self):
        out = os.path.join(self.dir, 'other.txt')
        done, last = self.run_it('--cookies-db', os.path.join(self.user_data, 'Profile 7', 'Cookies'), '--domain', 'example.org',
                                 '--out', out, '--password-env', 'ZZ_SAFE_STORAGE')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([l[5:] for l in self.lines(out)[1:]], [['ELSEWHERE', 'not-exported']])

    def test_newer_chrome_keeps_cookies_under_network(self):
        make_db(os.path.join(self.user_data, 'Default', 'Network', 'Cookies'))
        out = os.path.join(self.dir, 'net.txt')
        done, last = self.run_it('--browser', 'chrome', '--user-data', self.user_data, '--profile', 'Default', '--out', out,
                                 '--password-env', 'ZZ_SAFE_STORAGE')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(last['result']['cookies'], 3)

    def test_refusals_say_what_to_change(self):
        out = os.path.join(self.dir, 'x.txt')
        for args, env, message in [
            (['--user-data', self.user_data, '--profile', 'Nobody'], {}, 'no cookie database'),
            (['--user-data', self.user_data], {}, 'pass --profile'),
            (['--user-data', self.user_data, '--profile', 'Profile 7', '--password-env', 'ZZ_UNSET_VAR'], {}, 'is not set'),
            (['--user-data', self.user_data, '--profile', 'Profile 7', '--password-env', 'ZZ_SAFE_STORAGE'],
             {'ZZ_SAFE_STORAGE': 'the wrong password'}, 'could not read the cookies'),
        ]:
            done, last = self.run_it(*args, '--out', out, env=env)
            self.assertEqual(done.returncode, 2, done.stderr)
            self.assertIn(message, last['error'])

    @unittest.skipIf(shutil.which('security'), 'this computer has the macOS keychain command')
    def test_without_the_keychain_it_names_the_browsers_key(self):
        done, last = self.run_it('--user-data', self.user_data, '--profile', 'Profile 7', '--out', os.path.join(self.dir, 'k.txt'))
        self.assertEqual(done.returncode, 2)
        self.assertIn('"Arc Safe Storage"', last['error'])
        done, last = self.run_it('--user-data', self.user_data, '--profile', 'Profile 7', '--out', os.path.join(self.dir, 'k.txt'),
                                 '--keychain-service', 'Zorblet Safe Storage')
        self.assertIn('"Zorblet Safe Storage"', last['error'])


if __name__ == '__main__':
    unittest.main()
