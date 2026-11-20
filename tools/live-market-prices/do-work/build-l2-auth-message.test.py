#!/usr/bin/env python3
# Tests for build-l2-auth-message.py: the PUBLIC (secret-free) L2 auth message builder.
# Ported from build-l2-auth-message.test.py.held (packages/polymarket at bitfield-packages 8ac9732afa). The old test
# compared each message with the reference signer sign-poly-hmac.py, which is not carried (it takes the secret in argv).
# Its message format is now pinned here as literal strings: timestamp + METHOD + path + body (single quotes normalized),
# and the vault's own known-answer test (credentials-vault crate, the HmacSha256 scheme) signs these bytes.
import base64
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(modname, filename):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


blm = _load("build_l2_auth_message", "build-l2-auth-message.py")

_failures = []
def check(name, cond):
    print(("PASS  " if cond else "FAIL  ") + name)
    if not cond:
        _failures.append(name)

TS = "1700000000"
# The KAT body the vault Rust unit test uses (keep in sync).
BODY = '{"order":{"salt":1,"maker":"0xMaker"},"owner":"key-abc","orderType":"GTC"}'
PUBLIC_CREDS = {"api_key": "key-abc", "passphrase": "pass-xyz", "address": "0xMaker"}

# 1. Message for POST /order with body: timestamp + METHOD + path + body.
r_post = blm.build_l2_auth({"method": "POST", "path": "/order", "body": BODY, "timestamp": TS, "public_creds": PUBLIC_CREDS})
check("POST message == ts+POST+/order+body", r_post["message"] == TS + "POST" + "/order" + BODY)

# 2. GET /orders, no body.
r_get = blm.build_l2_auth({"method": "GET", "path": "/orders", "timestamp": TS})
check("GET message == ts+GET+/orders exactly (no body segment)", r_get["message"] == TS + "GET" + "/orders")

# 3. message_b64 is STANDARD base64 of the message (NOT urlsafe); the vault decodes this to the raw bytes.
check("POST message_b64 == STANDARD base64(message)",
      r_post["message_b64"] == base64.b64encode(r_post["message"].encode("utf-8")).decode("utf-8"))
check("message_b64 round-trips to the exact message",
      base64.b64decode(r_post["message_b64"]).decode("utf-8") == r_post["message"])

# 4. Single->double quote normalization on the body.
r_single = blm.build_l2_auth({"method": "POST", "path": "/order", "body": "{'x':1}", "timestamp": TS})
check("single quotes normalized to double in message", r_single["message"].endswith('{"x":1}'))

# 5. Empty-string body == no body.
r_empty = blm.build_l2_auth({"method": "GET", "path": "/orders", "body": "", "timestamp": TS})
check("empty-string body omits body segment (== no body)", r_empty["message"] == TS + "GET" + "/orders")

# 6. static_headers carry ONLY the non-secret identifiers + timestamp; NEVER a secret.
sh = r_post["static_headers"]
check("static_headers has POLY_ADDRESS/API_KEY/PASSPHRASE/TIMESTAMP",
      set(sh.keys()) == {"POLY_ADDRESS", "POLY_API_KEY", "POLY_PASSPHRASE", "POLY_TIMESTAMP"})
check("static_headers POLY_TIMESTAMP == the message timestamp", sh["POLY_TIMESTAMP"] == TS)
check("static_headers carries NO POLY_SIGNATURE (added by the seam from the vault)", "POLY_SIGNATURE" not in sh)
check("static_headers carries NO secret field", "api_secret" not in sh and "POLY_SECRET" not in sh)

# 7. method uppercased; method/path/body/timestamp each change the message.
check("method uppercased", blm.build_l2_auth({"method": "post", "path": "/order", "body": BODY, "timestamp": TS})["message"].startswith(TS + "POST"))
check("path changes message", blm.build_l2_auth({"method": "POST", "path": "/orders", "body": BODY, "timestamp": TS})["message"] != r_post["message"])
check("body changes message", blm.build_l2_auth({"method": "POST", "path": "/order", "body": '{"x":2}', "timestamp": TS})["message"] != r_post["message"])
check("timestamp changes message", blm.build_l2_auth({"method": "POST", "path": "/order", "body": BODY, "timestamp": "9999999999"})["message"] != r_post["message"])

# 8. timestamp defaults to now in unix seconds (10 digits).
r_now = blm.build_l2_auth({"method": "GET", "path": "/time"})
check("default timestamp is unix seconds (10 digits)", r_now["timestamp"].isdigit() and len(r_now["timestamp"]) == 10)

# 9. public_creds omitted -> only POLY_TIMESTAMP in static_headers (no fabricated identifiers).
r_nocreds = blm.build_l2_auth({"method": "GET", "path": "/orders", "timestamp": TS})
check("no public_creds -> static_headers == {POLY_TIMESTAMP}", r_nocreds["static_headers"] == {"POLY_TIMESTAMP": TS})

# 9c. A nested api_secret in public_creds is never emitted.
r_leak = blm.build_l2_auth({"method": "GET", "path": "/orders", "timestamp": TS,
                            "public_creds": {**PUBLIC_CREDS, "api_secret": "SHOULD-NEVER-APPEAR"}})
check("nested api_secret is NEVER emitted in static_headers",
      "api_secret" not in r_leak["static_headers"] and "SHOULD-NEVER-APPEAR" not in r_leak["static_headers"].values())

# 10. Honest failure: missing path -> ok:false, message_b64 None, no fabricated message.
r_bad = blm.build_l2_auth({"method": "GET"})
check("missing path -> ok:false", r_bad["ok"] is False)
check("missing path -> message_b64 None", r_bad["message_b64"] is None)

print()
if _failures:
    print("%d FAILED: %s" % (len(_failures), ", ".join(_failures)))
    sys.exit(1)
print("ALL PASS")
