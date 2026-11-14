"""No-op overlay decoder — the removable-capability floor for the egress overlay.

Why this file exists (L063 / L112 removable-capability):
  The transcript def weaves an OPTIONAL "overlay" decoder (a just-SENT message
  echoed optimistically before the source-of-record confirms it). That overlay is
  owned by whichever egress package is installed (e.g. content-distribution). When
  that package is NOT a member of the running package set, its decoder bytes are
  absent, and the def's `egress_decoder_script` read fails.

  A missing OPTIONAL enrichment must degrade to "no optimistic atom" — it must
  NEVER break the native transcript. The def therefore falls the decoder mount's
  content back to THIS chat-owned file. materialize-transcript.py imports whatever
  is mounted at `decode_egress_ledger.py`; when this no-op is mounted it returns
  zero overlay atoms, so `apply_overlays` leaves the native page unchanged.

Non-negotiable invariants:
  * Chat-owned, zero coupling: this file knows NOTHING about any egress package's
    record shapes, addresses, or vocabulary. It is a blind empty decoder.
  * Interface parity: exposes `decode(observation, descriptor)` returning the same
    envelope shape a real overlay decoder returns, with empty collections.
"""


def decode(observation, descriptor):
    """Return zero overlay atoms — the native transcript is left untouched.

    Matches the overlay-decoder contract materialize-transcript.py depends on:
    a dict with an `atoms` list (empty here); `threads`/`rejections` included for
    shape parity with real decoders even though the overlay path reads only atoms.
    """
    return {"threads": [], "atoms": [], "rejections": []}
