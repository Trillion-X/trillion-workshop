# Export one Arc profile's YouTube/Google login cookies to a Netscape cookies.txt that yt-dlp reads.
# yt-dlp's chrome reader asks the keychain for "Chrome Safe Storage"; Arc keeps its key as "Arc Safe Storage".
# usage: python3 -I arc-cookies.py "<Arc profile dir name, e.g. Default>" <out cookies.txt>
# Run it in your own Terminal: macOS asks once to allow "Arc Safe Storage" (choose Always Allow).
import hashlib, os, shutil, sqlite3, subprocess, sys, tempfile
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

profile, out = sys.argv[1], sys.argv[2]
db = os.path.expanduser(f"~/Library/Application Support/Arc/User Data/{profile}/Cookies")
pw = subprocess.run(["security", "find-generic-password", "-w", "-s", "Arc Safe Storage"],
                    capture_output=True, text=True, check=True).stdout.strip().encode()
key = hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, 16)

def decrypt(blob, host):
    if not blob.startswith(b"v10"):
        return blob.decode("utf-8", "replace")
    d = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
    p = d.update(blob[3:]) + d.finalize()
    p = p[: -p[-1]]
    # newer Chromium prefixes the value with sha256(host_key)
    if len(p) >= 32 and p[:32] == hashlib.sha256(host.encode()).digest():
        p = p[32:]
    return p.decode("utf-8")

tmp = tempfile.mkdtemp()
shutil.copy(db, os.path.join(tmp, "c.db"))
con = sqlite3.connect(os.path.join(tmp, "c.db"))
rows = con.execute("select host_key, path, is_secure, expires_utc, name, encrypted_value, value from cookies "
                   "where host_key like '%youtube.com' or host_key like '%google.com'").fetchall()
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
n = 0
with os.fdopen(fd, "w") as f:
    f.write("# Netscape HTTP Cookie File\n")
    for host, path, secure, exp, name, enc, val in rows:
        v = val or decrypt(enc, host)
        exp_unix = max(0, int(exp / 1_000_000 - 11644473600)) if exp else 0
        f.write("\t".join([host, "TRUE" if host.startswith(".") else "FALSE", path,
                           "TRUE" if secure else "FALSE", str(exp_unix), name, v]) + "\n")
        n += 1
shutil.rmtree(tmp)
print(f"wrote {n} cookies to {out}")
