#!/usr/bin/env python3
# package-set://bitfield-studio/packages/polymarket/do-work/build-l2-auth-message.py
#
# Polymarket CLOB L2 (API-key) auth MESSAGE-BUILDER — the PUBLIC half of the per-request signer.
#
# WHY THIS EXISTS (the vault-backed signing split, L069 + SP9):
#   The HMAC-SHA256 over the L2 secret is done INSIDE the credentials-vault slot (the secret never
#   leaves the vault — `SecretOperation::Sign`, scheme hmac_sha256). This script does the PUBLIC,
#   SECRET-FREE half: it assembles the exact message bytes to be signed (timestamp + method + path
#   [+ body]) and the 4 STATIC POLY_* header values, then hands the vault `message_b64` to sign.
#   The signature (POLY_SIGNATURE) comes back from the vault step, NOT from here.
#   This is the Polymarket caller-side of the shared computed-injection seam; the EIP-712 ORDER
#   signature (secp256k1, wallet key) is a SEPARATE signer (build-eip712-digest.mjs → vault secp256k1).
#
# WHY A SCRIPT, NOT A BINDING:
#   The message needs a FRESH UNIX-SECONDS timestamp, and the workflow binding language has NO `now`
#   op (verified: workflow-core/src/executor/context.rs has no now/timestamp/clock op). Only a process
#   has a wall clock. The body also needs single->double-quote normalization. So this is a one-shot
#   compute.process step whose stdout feeds the vault-sign step + the http_fetch headers.
#
# EXACT MESSAGE construction (mirrors py-clob-client signing/hmac.py + sign-poly-hmac.py BYTE-FOR-BYTE,
# so the vault's hmac_sha256 KAT matches what this builder produces):
#   message = str(timestamp) + str(method) + str(requestPath)
#             + ( str(body).replace("'", '"') if body else "" )   # single->double quotes; body = EXACT wire JSON
#   timestamp = UNIX SECONDS (the order-struct timestamp is ms, but THIS L2 header is seconds)
#   message_b64 = STANDARD base64 of message.utf8   (NOT urlsafe — the vault decodes message_b64 to the raw
#               bytes to sign; the urlsafe encodings in the vault call apply to the KEY + the OUTPUT, not this wrapper)
#
# Contract (SINGLE-ARG, matches the executor computed-injection seam #125:
#   the seam runs every message-builder as `<interpreter> <script> message.json <builder_request_JSON>`):
#   argv[1] = output path for the result JSON
#   argv[2] = request JSON text { method, path, body?, timestamp?, public_creds?:{api_key, passphrase, address} }
#             body = the exact JSON string on the wire (or omitted for GET); timestamp optional (defaults to now seconds);
#             public_creds = the NON-SECRET L2 identifiers (become POLY_ADDRESS/API_KEY/PASSPHRASE static headers);
#             api_secret is NOT here — it stays in the vault (the vault `sign` op holds it).
# stdout / output file:
#   { "ok": true,
#     "message_b64": "<STANDARD base64 of the message string — hand this to the vault sign op as message_b64>",
#     "message": "<the exact message string, for debugging/KAT>",
#     "timestamp": "<seconds>",
#     "static_headers": { "POLY_ADDRESS","POLY_API_KEY","POLY_PASSPHRASE","POLY_TIMESTAMP" } }  # POLY_SIGNATURE added by the seam from the vault output
#   On bad/missing request: { "ok": false, "error": "...", "message_b64": null }
#
# NON-NEGOTIABLE invariants (1000x):
#   1. Pure given (request, timestamp). No network, no secret, no HMAC, no order placement.
#   2. NEVER touches api_secret or any key material — the vault owns signing. This script is secret-free by construction.
#   3. The `message` it produces is BYTE-IDENTICAL to sign-poly-hmac.py's message (the reference), so the
#      vault hmac arm signing message_b64 yields the same POLY_SIGNATURE as the reference signer.

import base64
import datetime
import json
import sys


def _now_seconds() -> str:
    return str(int(datetime.datetime.now(datetime.timezone.utc).timestamp()))


def build_l2_message(timestamp, method, request_path, body=None):
    """Assemble the exact L2 auth message string (mirrors sign-poly-hmac.py:59-62 byte-for-byte). Pure, secret-free."""
    message = str(timestamp) + str(method) + str(request_path)
    if body is not None and body != "":
        # body must be the EXACT JSON string sent on the wire; single->double quotes to match Go/TS impls.
        message += str(body).replace("'", '"')
    return message


def build_l2_auth(request):
    """Build {message_b64, message, timestamp, static_headers} for one CLOB request. Pure, secret-free.

    SINGLE-ARG contract (matches the executor computed-injection seam #125: the seam runs every
    message-builder as `<interpreter> <script> message.json <builder_request_JSON>` — ONE positional JSON arg).

    request: { method, path, body?, timestamp?, public_creds?:{api_key, passphrase, address} }
      - timestamp defaults to now seconds
      - public_creds carries the NON-SECRET L2 identifiers (api_secret is NEVER here — it stays in the vault);
        omit it to skip the identifier static_headers (POLY_TIMESTAMP is always emitted).
    Returns {ok, message_b64, message, timestamp, static_headers} or {ok:false, error, message_b64:None}."""
    request = request if isinstance(request, dict) else {}

    method = str(request.get("method") or "GET").upper()
    request_path = request.get("path")
    if not request_path:
        return {"ok": False, "error": "missing request path", "message_b64": None}
    body = request.get("body")  # may be None (GET) or a JSON string (POST/DELETE)
    timestamp = str(request.get("timestamp") or _now_seconds())

    message = build_l2_message(timestamp, method, request_path, body)
    # STANDARD base64 (not urlsafe): the vault decodes message_b64 to the raw message bytes to sign.
    message_b64 = base64.b64encode(message.encode("utf-8")).decode("utf-8")

    static_headers = {"POLY_TIMESTAMP": timestamp}
    public_creds = request.get("public_creds")  # folded INTO the request per the single-arg seam contract
    if isinstance(public_creds, dict):
        # Only the NON-SECRET identifiers. api_secret is NEVER here — it stays in the vault.
        if public_creds.get("address"):
            static_headers["POLY_ADDRESS"] = public_creds["address"]
        if public_creds.get("api_key"):
            static_headers["POLY_API_KEY"] = public_creds["api_key"]
        if public_creds.get("passphrase"):
            static_headers["POLY_PASSPHRASE"] = public_creds["passphrase"]

    return {
        "ok": True,
        "message_b64": message_b64,
        "message": message,
        "timestamp": timestamp,
        "static_headers": static_headers,
    }


def _load(arg):
    try:
        return json.loads(arg)
    except Exception:
        return None


def main() -> int:
    # SEAM CONTRACT (#125): `<interpreter> <script> <out_path> <builder_request_JSON>` — ONE positional JSON arg.
    out_path = sys.argv[1] if len(sys.argv) > 1 else "poly-l2-message.json"
    request = _load(sys.argv[2]) if len(sys.argv) > 2 else None  # {method, path, body?, timestamp?, public_creds?}
    result = build_l2_auth(request)
    with open(out_path, "w") as f:
        json.dump(result, f)
    sys.stdout.write(json.dumps(result))
    return 0  # exit 0 either way; `ok` carries the decision (honest failure is data)


if __name__ == "__main__":
    sys.exit(main())
