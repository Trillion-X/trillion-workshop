"""Export one Chromium-family browser profile's login cookies (YouTube and Google by default) to a Netscape
cookies.txt that yt-dlp reads with --cookies.

yt-dlp's own Chrome reader asks the macOS keychain for "Chrome Safe Storage"; a browser such as Arc keeps its key under
its own name ("Arc Safe Storage"), so yt-dlp cannot read it. This reads the key under the browser's own name.

usage: python3 -I export_cookies.py --profile "<profile folder, e.g. Default>" --out <cookies.txt> [--browser arc]
         [--domain youtube.com --domain google.com] [--user-data <dir>] [--keychain-service <name>]
         [--cookies-db <path>] [--password-env <VAR>]

Run it in the person's own Terminal: macOS asks once to allow the browser's "Safe Storage" key (choose Always Allow).
--password-env reads that key's password from an environment variable instead of the keychain. The file is written
readable by its owner only. The last line printed is {"result": {...}} or {"error": "what to change"}.
"""
import argparse, hashlib, json, os, shutil, sqlite3, subprocess, sys, tempfile

# Where each browser keeps its profiles on macOS, and the name its cookie key has in the keychain.
BROWSERS = {
    'arc': ('~/Library/Application Support/Arc/User Data', 'Arc Safe Storage'),
    'chrome': ('~/Library/Application Support/Google/Chrome', 'Chrome Safe Storage'),
    'chromium': ('~/Library/Application Support/Chromium', 'Chromium Safe Storage'),
    'brave': ('~/Library/Application Support/BraveSoftware/Brave-Browser', 'Brave Safe Storage'),
    'edge': ('~/Library/Application Support/Microsoft Edge', 'Microsoft Edge Safe Storage'),
    'vivaldi': ('~/Library/Application Support/Vivaldi', 'Vivaldi Safe Storage'),
}
DOMAINS = ['youtube.com', 'google.com']


class Refusal(Exception):
    pass


def key_from(password):
    return hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", 1003, 16)


def decrypt(blob, host, key):
    if not blob.startswith(b"v10"):
        return blob.decode("utf-8", "replace")
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    d = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
    p = d.update(blob[3:]) + d.finalize()
    # A wrong key leaves padding that is not PKCS#7: refuse rather than write a garbled value.
    if not p or not 1 <= p[-1] <= 16 or p[-p[-1]:] != bytes([p[-1]]) * p[-1]:
        raise ValueError(f"a cookie for {host} did not decrypt with this key")
    p = p[: -p[-1]]
    # newer Chromium prefixes the value with sha256(host_key)
    if len(p) >= 32 and p[:32] == hashlib.sha256(host.encode()).digest():
        p = p[32:]
    return p.decode("utf-8")


def cookies_db(a):
    if a.cookies_db:
        db = a.cookies_db
    else:
        if not a.profile:
            raise Refusal('pass --profile (the profile folder name, e.g. Default or "Profile 1") or --cookies-db')
        base = os.path.join(os.path.expanduser(a.user_data or BROWSERS[a.browser][0]), a.profile)
        # Arc keeps <profile>/Cookies; newer Chrome keeps <profile>/Network/Cookies.
        db = next((p for p in (os.path.join(base, 'Network', 'Cookies'), os.path.join(base, 'Cookies')) if os.path.exists(p)),
                  os.path.join(base, 'Cookies'))
    if not os.path.exists(db):
        raise Refusal(f'no cookie database at {db}: check --browser and --profile (the folder names under the browser\'s user data), or pass --cookies-db')
    return db


def password(a):
    if a.password_env:
        value = os.environ.get(a.password_env)
        if value is None:
            raise Refusal(f'{a.password_env} is not set: set it to the browser\'s Safe Storage password, or leave out --password-env to ask the keychain')
        return value.encode()
    service = a.keychain_service or BROWSERS[a.browser][1]
    if not shutil.which('security'):
        raise Refusal(f'the macOS keychain command (security) is not here: run this on the Mac the browser is on, or pass --password-env with the "{service}" password')
    run = subprocess.run(["security", "find-generic-password", "-w", "-s", service], capture_output=True, text=True)
    if run.returncode != 0:
        raise Refusal(f'the keychain gave no "{service}" password: run this in your own Terminal and choose Always Allow, or pass --keychain-service with the name the browser uses')
    return run.stdout.strip().encode()


def export(db, out, key, domains):
    tmp = tempfile.mkdtemp()
    try:
        shutil.copy(db, os.path.join(tmp, "c.db"))
        con = sqlite3.connect(os.path.join(tmp, "c.db"))
        where = " or ".join("host_key like ?" for _ in domains)
        rows = con.execute("select host_key, path, is_secure, expires_utc, name, encrypted_value, value from cookies "
                           f"where {where}", [f'%{d}' for d in domains]).fetchall()
        con.close()
    finally:
        shutil.rmtree(tmp)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    n = 0
    with os.fdopen(fd, "w") as f:
        f.write("# Netscape HTTP Cookie File\n")
        for host, path, secure, exp, name, enc, val in rows:
            v = val or decrypt(enc, host, key)
            exp_unix = max(0, int(exp / 1_000_000 - 11644473600)) if exp else 0
            f.write("\t".join([host, "TRUE" if host.startswith(".") else "FALSE", path,
                               "TRUE" if secure else "FALSE", str(exp_unix), name, v]) + "\n")
            n += 1
    return n


def main(argv):
    p = argparse.ArgumentParser(description="Export a browser profile's login cookies to a cookies.txt for yt-dlp.")
    p.add_argument('--browser', choices=sorted(BROWSERS), default='arc')
    p.add_argument('--profile')
    p.add_argument('--out', required=True)
    p.add_argument('--domain', action='append')
    p.add_argument('--user-data')
    p.add_argument('--keychain-service')
    p.add_argument('--cookies-db')
    p.add_argument('--password-env')
    a = p.parse_args(argv)
    domains = a.domain or DOMAINS
    try:
        db = cookies_db(a)
        try:
            import cryptography  # noqa: F401
        except ImportError:
            raise Refusal('needs the cryptography package: python3 -m pip install -U cryptography')
        n = export(db, a.out, key_from(password(a)), domains)
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    except (sqlite3.Error, UnicodeDecodeError, ValueError, IndexError) as e:
        print(json.dumps({'error': f'could not read the cookies in {db} ({e}): check the --browser or --keychain-service matches the browser that wrote them'}))
        return 2
    print(json.dumps({'result': {'out': a.out, 'cookies': n, 'domains': domains, 'browser': a.browser, 'profile': a.profile}}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
