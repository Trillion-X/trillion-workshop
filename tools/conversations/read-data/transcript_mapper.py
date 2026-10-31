#!/usr/bin/env python3
# tools/conversations/read-data/transcript_mapper.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# THE single canonical mapper that turns source-neutral `thread_specs`
# (normalized {thread, ordered messages}) into the canonical conversation
# content-atom contract {threads, atoms, rejections} the chat sidebar reads.
#
# This is the generative primitive shared by EVERY conversation source
# decoder (iMessage/Instagram/WhatsApp/JSONL/Hermes/Gemini/…). Each source is a
# thin ADAPTER that opens its store, normalizes into `thread_specs`, and calls
# `map_transcript` / `map_window`. The mapper knows NOTHING about any source
# (no sqlite schema, no instagrapi, no Baileys) — a source KIND is a leaf
# adapter, NEVER a branch here. Conversely the atom
# identity / speaker_ref / presentation / atom-schema conventions live ONLY
# here — one SSOT, so a convention change is one edit inherited by all sources.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. ZERO source knowledge, ZERO I/O in the mapping functions — pure, so the
#    whole atom/thread contract is unit-testable with plain dict fixtures.
# 2. This is the ONLY place that defines: atom_ref identity, thread_ref format,
#    speaker_ref format, atom schema, thread presentation, session_id ownership.
#    A decoder that re-implements any of these is a duplication violation.
# 3. `thread_spec` is the adapter/mapper boundary contract:
#      {session_id, native_ref?, title, messages:[{index,speaker,text,at,kind?}]}
#    The adapter has ALREADY normalized: speaker -> "me" | <handle-string>,
#    at -> ISO-8601 string | None, and set `index` = the message's canonical
#    position in the FULL thread (so an atom's identity is stable whether it is
#    produced by map_transcript or by a paged map_window).
# 4. Non-text messages (media-only / reactions: text is None/empty) are skipped
#    for the text transcript. A thread with zero text atoms is dropped.
# 5. Callable as a library (import) AND as a CLI so a non-Python adapter (e.g. a
#    Baileys Node worker) invokes the SAME mapper — there is never a 2nd mapper.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
#
# CLI: transcript_mapper.py <request.json> <out.json>
#   request.json (map_transcript): {mode?:"transcript", observation, descriptor?, thread_specs}
#   request.json (map_window):     {mode:"window", observation, descriptor?, thread_spec,
#                                    before_cursor?, limit?}
# =============================================================================
import copy
import datetime
from content_identity import content_hash as multihash_hex
import json
import pathlib
import sys

PREVIEW_CHARS = 240

# Fields a source message may carry that the mapper copies onto its atom without reading: a tool call's `tool`
# ({name, input, call_ref} or {call_ref}), the `origin_ref` a source gives a message, the `attachments` it names.
# They are open data of the source, not part of the mapper's own contract, so the mapper only carries them.
CARRIED_FIELDS = ("tool", "origin_ref", "attachments")

# What an atom's content revision is made of: its own words and who and when, and whatever it carries. A revision
# changes when any of these changes; the atom's identity (atom_ref) does not.
REVISION_FIELDS = ("kind", "speaker_ref", "at", "content", "relations", "state_events") + CARRIED_FIELDS

# ---------------------------------------------------------------------------
# PROVENANCE RANK — the DATA discriminant for content convergence.
# An atom's provenance is an INTEGER rank supplied by the adapter as data:
# higher == more authoritative. It is NOT a closed code enum — the mapper only
# ever compares two integers; the *names* below are conveniences for adapters
# and tests, never a branch in the engine. A source that omits provenance is
# treated as AUTHORITATIVE, so every pre-existing single-source decoder keeps
# its exact current behaviour (no optimistic tier => nothing ever collapses).
# ---------------------------------------------------------------------------
OPTIMISTIC = 0     # locally observed, not yet confirmed by the source of record
PROVISIONAL = 5    # low-confidence observation (draft, low-conf STT/OCR, API ack)
AUTHORITATIVE = 10  # the source of record's own copy — the ground truth

# ---------------------------------------------------------------------------
# ECHO-DELAY WINDOW — the DATA tolerance that makes convergence TEMPORAL, not
# just content-shaped (the deepest-root fix).
#
# WHY this exists: convergence must decide whether two atoms sharing a
# content_key (same thread, same speaker role, same normalized text) are the
# SAME real event observed twice — an optimistic local send + its later native
# echo — or TWO genuinely distinct events that merely share a body ("ok" today
# vs "ok" last week). There is NO shared correlation id between the two: the
# native store (e.g. chat.db) has never heard of our egress intent id. The ONLY
# discriminant left is that the two observations of ONE send-event land close in
# time (the echo arrives seconds after the local send), while two unrelated
# same-body messages do not. So convergence only collapses a lower-rank atom
# into a higher-rank one when BOTH carry a parseable `at` AND those timestamps
# are within this window. This is the correct available primitive, not a
# band-aid: without a shared id, temporal proximity IS the identity signal.
#
# FAIL-SAFE DIRECTION (unchanged invariant): when the window test cannot be
# satisfied (missing/unparseable timestamp, or out-of-window), convergence is
# DECLINED — the lower-rank atom stays visible as a harmless duplicate. A miss
# never hides a message. 300s is a generous default (a native echo lands in
# seconds); it is DATA and overridable per-call via `window_seconds`.
# ---------------------------------------------------------------------------
DEFAULT_CONVERGE_WINDOW_SECONDS = 300




def _atom_identity(thread_ref, index, native_ref=None):
    """Atom identity anchors to the source's DURABLE subject id (`native_ref` —
    e.g. chat.db message.guid) when the adapter supplies one, so identity is
    invariant under text edits, index/window shifts, and re-decodes. THIS is the
    deepest-root fix: a text/index hash re-keys an atom whenever the text or
    filtered-row ordinal changes, which orphans reactions (a tapback points at the
    target's native guid, not a text hash) and detaches edits. Sources without a
    native id use the adapter's source index. Adapters must retain original source
    indices across windows; content revisions are independent of occurrence identity."""
    if native_ref:
        return multihash_hex(f"{thread_ref}:native:{native_ref}".encode("utf-8"))
    return multihash_hex(json.dumps([thread_ref, "source-index", index], separators=(",", ":"), ensure_ascii=False).encode())


def _text_of(message):
    text = message.get("text")
    return text if isinstance(text, str) and text.strip() else None


def _rank_of(message, default_rank):
    """PURE: the atom's provenance rank as data. The adapter may stamp an integer
    `provenance` per message; absent -> the observation/module default. Coerced to
    int so a bad value fails loudly rather than silently disabling convergence."""
    raw = message.get("provenance")
    if raw is None:
        return default_rank
    return int(raw)


def _build_atoms(source_ref, thread_ref, batch_ref, messages, default_rank=AUTHORITATIVE):
    """PURE: normalized messages -> ordered atoms + their timestamps.

    Identity anchors to each message's `native_ref` (durable subject id) when
    present, else the historical index/text hash. An atom is emitted when it has
    renderable content — text present, OR it is a reaction, OR it carries
    lifecycle `state_events` (a retracted/unsent tombstone has no text but must
    still render). A pure media-only utterance (no text, no events) is still not
    part of the text transcript. Each atom carries its self-describing
    `state_events` (lifecycle: sent/delivered/read/failed/edited/retracted) and
    `relations` (a reaction's `reaction_target`) verbatim — the host maps event
    keys to glyphs from DATA; the mapper never enumerates them. A second pass
    resolves each reaction relation's `target_native_ref` to the in-batch target
    `target_atom_ref` (an off-page target simply stays unresolved and re-binds
    when its page loads)."""
    atoms, timestamps = [], []
    native_to_atom = {}
    for position, message in enumerate(messages):
        text = _text_of(message)
        kind = message.get("kind") or "utterance"
        state_events = message.get("state_events") or []
        native_ref = message.get("native_ref")
        if text is None and kind == "utterance" and not state_events:
            continue  # media-only utterance: not part of the text transcript
        index = message.get("index", position)
        speaker = message.get("speaker") or "them"
        at = message.get("at")
        if at:
            timestamps.append(at)
        atom_ref = f"atom:{_atom_identity(thread_ref, index, native_ref)}"
        content = {"text": text}
        if kind == "reaction":
            content["symbol"] = message.get("reaction_symbol")
            content["reaction_kind"] = message.get("reaction_kind") or "added"
        atom = {
            "atom_ref": atom_ref,
            "thread_ref": thread_ref,
            "kind": kind,
            "speaker_ref": f"speaker:{source_ref}:{speaker}",
            "at": at,
            "content": content,
            "relations": [dict(r) for r in (message.get("relations") or [])],
            "state_events": [dict(e) for e in state_events],
            "source_ref": source_ref,
            "observation_refs": [batch_ref],
            "provenance": _rank_of(message, default_rank),
        }
        for carried in CARRIED_FIELDS:
            if message.get(carried) is not None:
                atom[carried] = copy.deepcopy(message[carried])
        if native_ref:
            atom["native_ref"] = native_ref
            native_to_atom[native_ref] = atom_ref
        atoms.append(atom)
    # Second pass: bind each reaction relation to the target atom in THIS batch.
    for atom in atoms:
        for rel in atom["relations"]:
            target_native = rel.get("target_native_ref")
            if target_native and target_native in native_to_atom:
                rel["target_atom_ref"] = native_to_atom[target_native]
        atom["content_revision"] = multihash_hex(json.dumps(
            {key: atom.get(key) for key in REVISION_FIELDS if key in atom},
            sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())
    return atoms, timestamps


# ---------------------------------------------------------------------------
# PROVENANCE-RANKED CONTENT CONVERGENCE (the generative primitive)
# ---------------------------------------------------------------------------
# The same real utterance observed by two sources must render ONCE, keeping the
# most authoritative copy. Two genuinely distinct utterances (a real double
# "ok", two real sends of the same body) must render TWICE. The discriminant is
# the provenance rank carried as data.
#
# content_key groups atoms that are candidates to be the same utterance:
#   (thread_ref, speaker role, normalized text).
# Keying on the speaker ROLE (last speaker_ref segment) — not the full,
# source-qualified speaker_ref — is what lets `speaker:imessage:me` (native
# echo) and `speaker:egress-ledger:me` (optimistic send) converge while keeping
# two different *people* in a group distinct (their role carries their handle).
#
# Within a content_key group, a strictly-lower-rank atom is absorbed by a
# distinct strictly-higher-rank atom. The capacity rule is ONE ABSORPTION PER
# DISTINCT LOWER RANK — not a flat one-total, and not all-into-highest. This is
# the exact discriminant between the two things a shared content_key cannot tell
# apart on its own:
#
#   * TWO atoms of the SAME rank are two genuinely distinct real events — you
#     cannot observe one send-event twice at the same confidence tier from the
#     same logical source. So a higher atom absorbs at most ONE atom of any given
#     rank; a second same-rank atom stays visible. (One native echo + two real
#     optimistic sends of "ok" => the echo absorbs ONE optimistic; the second
#     real send stays visible until its OWN echo arrives.)
#   * Atoms of DIFFERENT lower ranks are the SAME event escalating in confidence
#     (OPTIMISTIC local send -> PROVISIONAL provider ack -> AUTHORITATIVE native
#     echo). So one authoritative atom absorbs the whole ladder — one atom per
#     distinct lower rank — collapsing a genuine 3-tier chain to a single
#     AUTHORITATIVE survivor. This is WHY provenance is a continuous integer
#     scale, not a 2-value flag: any (r_a < r_b < r_c) ladder of ONE utterance
#     converges for free, from data alone, with ZERO engine change.
#
# Either way a convergence miss yields a harmless DUPLICATE, never a hidden or
# lost message (fail-safe direction).
# ---------------------------------------------------------------------------
def _norm_text(text):
    """Casefold + whitespace-collapse so trivially-different renderings of the
    same utterance content-key together. PURE."""
    return " ".join((text or "").split()).casefold()


def _role_of(speaker_ref):
    """The speaker role = last ':' segment of speaker_ref (`speaker:<src>:<role>`).
    'me' for outbound in every source; the handle string for a distinct person."""
    return str(speaker_ref).rsplit(":", 1)[-1] if speaker_ref else ""


def content_key(atom):
    """PURE: the convergence candidate key for an atom — atoms sharing this key
    are the same utterance observed possibly-multiple times.

    Convergence is an UTTERANCE-dedup mechanism (an optimistic local send and its
    later authoritative native echo share body text). A non-utterance atom
    (reaction, tombstone) has no body and must NEVER group — many reactions from
    the same actor all have empty text and would otherwise share one key. So a
    non-utterance atom gets a unique key (its own atom_ref) and stands alone."""
    if (atom.get("kind") or "utterance") != "utterance":
        return ("__nonconverging__", atom.get("atom_ref"))
    return (
        atom.get("thread_ref"),
        _role_of(atom.get("speaker_ref")),
        _norm_text((atom.get("content") or {}).get("text")),
    )


def _epoch_of(at):
    """PURE: parse an atom's ISO-8601 `at` into a float epoch (seconds), or None
    if absent/unparseable. Normalizes a trailing 'Z' to '+00:00' and treats a
    tz-naive timestamp as UTC. Returning None on ANY failure is deliberate: it
    routes an un-timestampable atom into the fail-safe (no convergence) path
    rather than guessing a time and risking a wrong merge that hides a message."""
    if not at or not isinstance(at, str):
        return None
    text = at.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.timestamp()


def _within_window(higher, lower, window_seconds):
    """PURE: True only when BOTH atoms carry a parseable `at` AND the higher-rank
    absorber's time lies AT-OR-AFTER the lower-rank atom's time by no more than
    `window_seconds`. Missing/unparseable time on either side -> False (fail-safe:
    decline the merge, keep the visible duplicate).

    DIRECTIONAL, not symmetric `abs`: a higher-confidence observation of a send is
    a LATER re-observation of the SAME event — the native `is_from_me=1` echo lands
    in chat.db seconds AFTER we locally observed/emitted the OPTIMISTIC send atom,
    so the absorber's epoch is >= the absorbed atom's epoch. A symmetric `abs()`
    test would let a PRIOR authoritative message (e.g. an old "ok") within the
    window swallow a NEWER optimistic same-body send — HIDING a real just-sent
    message (the forbidden direction: a miss must yield a harmless VISIBLE
    DUPLICATE, never a lost message). Backward-time absorption is declined
    outright: `delta = a - b`; merge only when `0 <= delta <= window_seconds`."""
    a = _epoch_of(higher.get("at"))
    b = _epoch_of(lower.get("at"))
    if a is None or b is None:
        return False
    delta = a - b
    return 0 <= delta <= window_seconds


def _resolve_window(window_seconds):
    """PURE: coerce the caller-supplied window to a positive float, falling back
    to the DATA default. A None/non-positive/unparseable value NEVER disables the
    temporal guard (that would resurrect the time-blind defect) — it restores the
    default. This keeps the guard un-bypassable while the number stays DATA."""
    if window_seconds is None:
        return float(DEFAULT_CONVERGE_WINDOW_SECONDS)
    try:
        value = float(window_seconds)
    except (TypeError, ValueError):
        return float(DEFAULT_CONVERGE_WINDOW_SECONDS)
    if value <= 0:
        return float(DEFAULT_CONVERGE_WINDOW_SECONDS)
    return value


def converge_atoms(atoms, window_seconds=DEFAULT_CONVERGE_WINDOW_SECONDS):
    """PURE: collapse the lower-provenance observations of an utterance into a
    distinct higher-provenance observation, keeping the higher copy. Never
    mutates the input. Returns kept atoms in their original order.

    Capacity rule: ONE ABSORPTION PER DISTINCT LOWER RANK. A surviving
    higher-rank atom absorbs at most one atom of each strictly-lower rank, so:
      * a genuine confidence ladder of ONE utterance (OPTIMISTIC -> PROVISIONAL
        -> AUTHORITATIVE, all distinct ranks) fully collapses to a single
        AUTHORITATIVE survivor — from data alone, ZERO engine change for any
        (r_a < r_b < r_c) chain; and
      * two atoms of the SAME rank are two genuinely distinct real events (you
        cannot observe one send-event twice at the same confidence tier), so the
        second same-rank atom is NEVER absorbed and stays visible.

    Convergence fires ONLY when the two candidates are also within
    `window_seconds` of each other in time (see DEFAULT_CONVERGE_WINDOW_SECONDS):
    a shared content_key means "could be the same event", the temporal window is
    what proves it IS the same send observed twice rather than two unrelated
    same-body messages. Out-of-window / un-timestamped candidates are left as
    distinct visible atoms (fail-safe: never hide a real message).

    The kept (higher-rank) atom absorbs the dropped atom's `observation_refs`
    (order-preserving union) and records the absorbed identities in
    `converged_from`, so the full provenance trail survives on the surviving
    atom without changing its identity/timestamp."""
    window_seconds = _resolve_window(window_seconds)
    atoms = list(atoms or [])
    # Group indices by content_key, preserving first-seen order.
    groups = {}
    for i, atom in enumerate(atoms):
        groups.setdefault(content_key(atom), []).append(i)

    dropped = {}   # dropped_index -> absorber_index
    for key, idxs in groups.items():
        if len(idxs) < 2:
            continue
        # Descending by rank (highest first); stable tie-break on original order
        # keeps equal-rank atoms un-merged and deterministic.
        ordered = sorted(idxs, key=lambda i: (-int(atoms[i].get("provenance", AUTHORITATIVE)), i))
        absorbers = []  # kept higher-tier atoms; each may absorb one atom per rank
        for i in ordered:
            rank = int(atoms[i].get("provenance", AUTHORITATIVE))
            # An absorber is eligible only if it is a strictly-higher tier, has
            # NOT yet absorbed this rank, AND is within the echo-delay window of
            # this atom. One-per-distinct-rank is what lets a full confidence
            # ladder collapse while keeping two same-rank real events distinct.
            # The temporal test is what makes convergence a same-EVENT collapse
            # rather than a same-TEXT collapse (the time-blind defect).
            slot = next((a for a in absorbers
                         if a["rank"] > rank and rank not in a["consumed"]
                         and _within_window(atoms[a["idx"]], atoms[i], window_seconds)), None)
            if slot is not None:
                slot["consumed"].add(rank)
                dropped[i] = slot["idx"]
            else:
                absorbers.append({"idx": i, "rank": rank, "consumed": set()})

    if not dropped:
        return atoms

    # Fold each dropped atom's provenance trail onto its absorber.
    kept = []
    for i, atom in enumerate(atoms):
        if i in dropped:
            continue
        kept.append(dict(atom))
    kept_by_idx = {}
    live = 0
    for i, atom in enumerate(atoms):
        if i in dropped:
            continue
        kept_by_idx[i] = kept[live]
        live += 1
    for dropped_i, absorber_i in dropped.items():
        survivor = kept_by_idx[absorber_i]
        refs = list(survivor.get("observation_refs") or [])
        for r in (atoms[dropped_i].get("observation_refs") or []):
            if r not in refs:
                refs.append(r)
        survivor["observation_refs"] = refs
        trail = list(survivor.get("converged_from") or [])
        trail.append(atoms[dropped_i].get("atom_ref"))
        survivor["converged_from"] = trail
    return kept


def map_transcript(observation, descriptor, thread_specs):
    """N normalized thread_specs -> canonical {threads, atoms, rejections}.
    One source observation fans out to N conversation threads."""
    source_ref = observation["source_ref"]
    descriptor = descriptor or {}
    mark_ref = descriptor.get("display_mark_ref")
    batch_ref = observation.get("batch_ref")
    observed_at = observation.get("observed_at")
    # Observation-level provenance default (data): an optimistic egress adapter
    # sets provenance=OPTIMISTIC on its observation; native decoders omit it and
    # inherit AUTHORITATIVE, preserving their exact current behaviour.
    default_rank = _rank_of(observation, AUTHORITATIVE)

    threads, all_atoms, rejections = [], [], []
    for spec in thread_specs or []:
        session_id = spec.get("session_id")
        if not session_id:
            rejections.append({"source_ref": source_ref, "violation_path": "thread_spec.session_id",
                               "expected": "non-empty session_id", "got": repr(session_id)})
            continue
        session_id = str(session_id)
        thread_ref = f"thread:{source_ref}:{session_id}"
        atoms, timestamps = _build_atoms(source_ref, thread_ref, batch_ref,
                                         spec.get("messages") or [], default_rank)
        if not atoms:
            continue  # no text content -> not a listable conversation
        all_atoms.extend(atoms)
        # Subtitle = newest UTTERANCE body: reaction/tombstone atoms carry no text
        # and may be appended after the last utterance, so pick the last atom that
        # actually has text rather than blindly indexing atoms[-1]. Started/last
        # activity are min/max of parseable timestamps (ISO-8601 UTC sorts
        # lexically) — robust to reactions whose time predates the last utterance.
        with_text = [a for a in atoms if (a.get("content") or {}).get("text")]
        text_atoms = [a for a in with_text if a["kind"] == "utterance"] or with_text
        subtitle = text_atoms[-1]["content"]["text"][:PREVIEW_CHARS] if text_atoms else ""
        sorted_ts = sorted(t for t in timestamps if t)
        # WHOLE-THREAD totals as data (optional). A source that projects a BOUNDED
        # sidebar summary hands over only the newest tail of a long thread (to avoid
        # an O(all-messages) full-scan that would monopolise the serial workflow
        # slot and starve interactive transcript reads), but declares the true
        # thread-wide totals explicitly: total_count / started_at / last_activity_at
        # describe the WHOLE conversation even though `messages` carried only the
        # tail. Absent -> every other source hands over the complete thread, so we
        # derive from the atoms we just built and behaviour is byte-identical.
        spec_total = spec.get("total_count")
        atom_count = spec_total if isinstance(spec_total, int) and spec_total >= 0 else len(atoms)
        started_at = spec.get("started_at") or (sorted_ts[0] if sorted_ts else None)
        last_activity_at = spec.get("last_activity_at") or (sorted_ts[-1] if sorted_ts else None)
        thread = {
            "thread_ref": thread_ref,
            "session_id": session_id,  # canonical thread id; the mapper owns format
            "source_ref": source_ref,
            "native_ref": spec.get("native_ref", observation.get("native_ref")),
            "presentation": {
                "mark_ref": mark_ref,
                "title": spec.get("title") or session_id,
                "subtitle": subtitle,
                "at": last_activity_at or observed_at,
            },
            "atom_count": atom_count,
            "started_at": started_at,
            "last_activity_at": last_activity_at,
        }
        # Opaque per-thread outbound routing handle: if the source adapter
        # resolved a single-recipient send handle (e.g. iMessage buddy address),
        # carry it verbatim. The mapper never interprets it — a source that omits
        # it yields a read-only thread. Keeps thread identity source-neutral while
        # letting sendable sources declare their reply address as data.
        if spec.get("send_ref"):
            thread["send_ref"] = spec["send_ref"]
        threads.append(thread)
    return {"threads": threads, "atoms": all_atoms, "rejections": rejections}


def map_page(observation, descriptor, session_id, title, page_messages,
             start_index, total_count):
    """Bounded transcript page for ONE thread. The ADAPTER already fetched and
    paged the thread (SQL LIMIT/OFFSET for iMessage, `amount` for instagrapi) —
    it owns efficient paging over its store — and hands the mapper:
      - `page_messages`: the ordered (oldest->newest) normalized messages of the
        page, each with `index` = its ABSOLUTE position in the full filtered
        thread (so atom identity is stable across pages),
      - `start_index`: index of the page's first message in the full thread,
      - `total_count`: total messages in the thread.
    The mapper maps the page to atoms and derives the window metadata. Mirrors
    the iMessage decode_window contract (older_cursor/has_older/has_newer)."""
    source_ref = observation["source_ref"]
    descriptor = descriptor or {}
    if not session_id:
        return {"atoms": [], "older_cursor": None, "has_older": False, "has_newer": False,
                "total_count": None, "session_id": session_id, "started_at": None,
                "last_activity_at": None, "title": title,
                "mark_ref": descriptor.get("display_mark_ref")}
    session_id = str(session_id)
    thread_ref = f"thread:{source_ref}:{session_id}"
    atoms, timestamps = _build_atoms(source_ref, thread_ref, observation.get("batch_ref"),
                                     page_messages or [])
    # `end` counts only the utterance page window (reaction riders are appended
    # after and don't consume the page budget), so paging cursors stay stable.
    end = int(start_index) + len([m for m in (page_messages or [])
                                  if (m.get("kind") or "utterance") == "utterance"])
    sorted_ts = sorted(t for t in timestamps if t)
    return {
        "atoms": atoms,
        "older_cursor": int(start_index) if int(start_index) > 0 else None,
        "has_older": int(start_index) > 0,
        "has_newer": total_count is not None and end < int(total_count),
        "total_count": total_count,
        "session_id": session_id,
        "started_at": sorted_ts[0] if sorted_ts else None,
        "last_activity_at": sorted_ts[-1] if sorted_ts else None,
        "title": title or session_id,
        "mark_ref": descriptor.get("display_mark_ref"),
    }


def main(argv):
    if len(argv) < 3:
        print("usage: transcript_mapper.py <request.json> <out.json>", file=sys.stderr)
        return 2
    request = json.loads(pathlib.Path(argv[1]).read_text(encoding="utf-8"))
    mode = request.get("mode")
    if mode == "converge":
        # Convergence is source-neutral and observation-free: a caller (the
        # transcript materializer) hands an already-merged atom list from N
        # observations and gets the converged list back. Same SSOT, no 2nd impl.
        # `window_seconds` is optional DATA; absent -> the fail-safe default.
        result = {"atoms": converge_atoms(request.get("atoms") or [],
                                          request.get("window_seconds"))}
        pathlib.Path(argv[2]).write_text(json.dumps(result), encoding="utf-8")
        return 0
    observation = request["observation"]
    descriptor = request.get("descriptor")
    if mode == "page":
        result = map_page(observation, descriptor,
                          request.get("session_id"), request.get("title"),
                          request.get("page_messages") or [],
                          request.get("start_index", 0),
                          request.get("total_count"))
    else:
        result = map_transcript(observation, descriptor, request.get("thread_specs") or [])
    pathlib.Path(argv[2]).write_text(json.dumps(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
