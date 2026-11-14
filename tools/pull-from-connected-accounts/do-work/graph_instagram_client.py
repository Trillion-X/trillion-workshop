#!/usr/bin/env python3
# packages/instagram-dm-connector/do-work/graph_instagram_client.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# A Meta GRAPH-API Instagram DM client that presents the SAME duck-typed surface
# the connector's pull path already speaks:  `.user_id`  and
# `.direct_threads(amount, thread_message_limit)`  returning canonical thread
# dicts.  Because `connect-instagram.py::run_pull` reads ONLY those two members
# and folds the result through the PURE `ig_snapshot_store`, swapping this client
# in for the instagrapi `Client` reuses the ENTIRE snapshot/merge/decode pipeline
# with ZERO changes downstream.  Choosing instagrapi vs Graph is therefore a DATA
# decision (which producer the transcript-source spec names), never a code branch
# (L069 / L090 / enum-dissolution): this file adds a CONFIGURATION of the existing
# pull primitive, it does not fork it.
#
# The Graph token is obtained through the service-connections package (the user's
# Meta connect flow) and injected as an already-authenticated capability — there
# is no login/session/2FA step here (that boundary lives in the connect surface +
# credentials-vault).  TWO Meta messaging surfaces exist and this ONE client speaks
# BOTH, selected by SELF-DESCRIBING DATA (no named-profile enum, L090):
#   * Instagram-Login  (IGAA... token, host graph.instagram.com): self id via
#     `me?fields=user_id`; conversations edge `me/conversations`.
#   * Facebook-Login    (EAA... token, host graph.facebook.com): self id IS the
#     supplied IG Business id (`ig_user_id`); conversations edge is user-scoped
#     `{ig_user_id}/conversations` and REQUIRES `platform=instagram`.
# Presence of `ig_user_id` (and `platform`) — supplied by the transcript-source
# spec DATA — is what selects the surface; ZERO code branch names either "profile".
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
# 1. STDLIB ONLY (urllib) — the producer runs from ANY cwd with system python, no
#    vendored deps, no pip.  The HTTP getter is injectable so the client is fully
#    offline-testable (tests pass a fake getter; nothing hits the network).
# 2. NO SECRET LEAK — the token never appears in a returned dict, a summary, an
#    exception message, a URL, or a log line.  It rides ONLY in the
#    `Authorization: Bearer` HEADER of the outbound HTTPS request, NEVER the URL
#    query string — so a urllib error (which echoes the URL) can never surface the
#    token to captured stdout.  Network errors are re-raised as a fixed, token-free
#    message (`_scrubbed_http_error`); the raw urllib error (which may embed the
#    full request URL) is dropped.
# 3. CANONICAL SHAPE, BRANCH ON SHAPE NOT NAME — output dicts match the decoder +
#    snapshot-store contract VERBATIM so no consumer learns the word "graph":
#      thread = { "id", "thread_v2_id", "viewer_id", "thread_title",
#                 "users":[{"pk","username"}],
#                 "messages":[{"item_id","user_id","username","text","timestamp"}] }
#    Graph JSON is remapped at THIS boundary (L098): from.id->user_id,
#    message->text, id->item_id, created_time(ISO)->epoch MICROSECONDS int (the
#    instagrapi timestamp convention, so the store's numeric sort AND the decoder's
#    micros branch both work unchanged).
# 4. PAGE TO FILL — Graph returns pages; we follow `paging.next` until we have the
#    requested `amount` threads / `thread_message_limit` messages or run out, so a
#    sidebar window is never silently truncated to one page.
import datetime
import json
import time
import urllib.error
import urllib.parse
import urllib.request

# Default host is what the service-connections connect flow actually verifies a
# pasted token against (graph.facebook.com/v21.0/me) — i.e. the Facebook-Login
# surface. Instagram-Login tokens override `base` via DATA; no code branch.
GRAPH_BASE = "https://graph.facebook.com"
GRAPH_VERSION = "v21.0"


def _iso_to_micros(value):
    """Graph `created_time` is ISO-8601 with a numeric offset (e.g.
    '2026-07-11T00:00:23+0000'). Convert to epoch MICROSECONDS (int) so the value
    matches the instagrapi convention the whole pipeline was built for. Tolerant:
    already-numeric passes through; unparseable -> None (sorts stable, displays
    via the decoder's ISO branch if a raw string ever slips through)."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).strip()
    # Normalize '+0000' -> '+00:00' for %z on older pythons; fromisoformat handles both on 3.11+
    try:
        dt = datetime.datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp() * 1_000_000)


class GraphRequestError(Exception):
    """Token-free network error. Carries an HTTP status (if any) and a fixed
    message — NEVER the request URL (which would embed nothing sensitive now that
    the token is header-only, but we still scrub to keep the surface deterministic
    and to defend against a future getter that reintroduces a query token)."""

    def __init__(self, where, status=None):
        self.status = status
        super().__init__("graph request failed at {}{}".format(
            where, "" if status is None else " (http {})".format(status)))


def _default_http_get(base, version, token, path, params,
                      transport_retries=3, retry_sleep=time.sleep):
    """The real HTTPS getter (stdlib). Token rides the `Authorization: Bearer`
    HEADER only — never the URL — so no error/log line can leak it. Isolated +
    injectable so the client is offline-testable. Re-raises any urllib error as a
    scrubbed `GraphRequestError` (the raw error, which echoes the URL, is dropped).

    TRANSPORT vs PROTOCOL failure are different categories: an HTTPError is the
    server's answer (401/403/etc — retrying cannot change consent, so it fails
    immediately), while a URLError is the transport dropping BEFORE an answer
    (Meta's edge resets TLS transiently). Transport failures get a small bounded
    retry with linear backoff; without it a single reset aborts a valid pull."""
    q = dict(params or {})
    url = "{}/{}/{}?{}".format(base, version, path.lstrip("/"), urllib.parse.urlencode(q))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    for attempt in range(transport_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (https only, our host)
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise GraphRequestError(path, status=getattr(exc, "code", None)) from None
        except urllib.error.URLError:
            if attempt == transport_retries:
                raise GraphRequestError(path) from None
            retry_sleep(1 + attempt)


class GraphInstagramClient:
    """Duck-typed stand-in for instagrapi.Client used by run_pull. Exposes exactly
    `.user_id` and `.direct_threads(...)`. HTTP is injectable via `http_get` for
    tests: http_get(path, params) -> parsed dict."""

    def __init__(self, token, http_get=None, base=GRAPH_BASE, version=GRAPH_VERSION,
                 ig_user_id=None, platform=None):
        self._token = token
        self._base = base
        self._version = version
        self._http_get = http_get  # test injection: fn(path, params)->dict
        # Self-describing DATA selects the surface (L090): a supplied ig_user_id
        # IS the self id and scopes the conversations edge to that user; a
        # supplied platform rides every conversations request as a query param.
        # Absent both, the client speaks the `me`-scoped surface. No profile enum.
        self._ig_user_id = str(ig_user_id) if ig_user_id else None
        self._platform = str(platform) if platform else None
        self._user_id = self._ig_user_id

    # ---- transport -------------------------------------------------------------
    def _get(self, path, params=None):
        if self._http_get is not None:
            return self._http_get(path, params or {})
        return _default_http_get(self._base, self._version, self._token, path, params or {})

    def _paged(self, path, params, hard_limit):
        """Yield items from `data`, following `paging.next` (via `after` cursor)
        until `hard_limit` items or exhaustion. Bounded — never unbounded paging."""
        out = []
        after = None
        # generous page cap: enough pages to cover hard_limit at typical page sizes
        for _ in range(max(1, (hard_limit // 25) + 3)):
            p = dict(params)
            if after:
                p["after"] = after
            doc = self._get(path, p)
            out.extend(doc.get("data") or [])
            if len(out) >= hard_limit:
                return out[:hard_limit]
            cursors = ((doc.get("paging") or {}).get("cursors") or {})
            after = cursors.get("after")
            if not after or not (doc.get("paging") or {}).get("next"):
                break
        return out[:hard_limit]

    # ---- duck-typed surface run_pull consumes ---------------------------------
    @property
    def user_id(self):
        """Self IGSID (participant/from id space). Lazy, cached."""
        if self._user_id is None:
            me = self._get("me", {"fields": "user_id,username"})
            self._user_id = str(me.get("user_id") or me.get("id") or "") or None
        return self._user_id

    def direct_threads(self, amount=20, thread_message_limit=20):
        """Pull up to `amount` conversations, each with up to
        `thread_message_limit` newest messages, as canonical thread dicts."""
        self_pk = self.user_id
        conv_path = ("{}/conversations".format(self_pk)
                     if self._ig_user_id else "me/conversations")
        conv_params = {"fields": "participants,updated_time", "limit": min(amount, 50)}
        if self._platform:
            conv_params["platform"] = self._platform
        threads = self._paged(conv_path, conv_params, amount)
        out = []
        for t in threads:
            tid = t.get("id")
            if not tid:
                continue
            participants = ((t.get("participants") or {}).get("data")) or []
            users = [{"pk": str(p.get("id")), "username": p.get("username")}
                     for p in participants if p.get("id") is not None]
            others = [p.get("username") for p in participants
                      if str(p.get("id")) != str(self_pk) and p.get("username")]
            raw_msgs = self._paged(
                "{}/messages".format(tid),
                {"fields": "from,created_time,message", "limit": min(thread_message_limit, 50)},
                thread_message_limit,
            )
            messages = []
            for m in raw_msgs:
                frm = m.get("from") or {}
                messages.append({
                    "item_id": str(m.get("id")) if m.get("id") is not None else None,
                    "user_id": str(frm.get("id")) if frm.get("id") is not None else None,
                    "username": frm.get("username"),
                    "text": m.get("message") if isinstance(m.get("message"), str) else "",
                    "timestamp": _iso_to_micros(m.get("created_time")),
                })
            out.append({
                "id": str(tid),
                "thread_v2_id": str(tid),
                "viewer_id": str(self_pk) if self_pk else None,
                "thread_title": ", ".join(others) if others else None,
                "updated_time": t.get("updated_time"),
                "users": users,
                "messages": messages,
            })
        return out


def make_graph_client_from_token_file(token_file, http_get=None, ig_user_id=None,
                                       platform=None, base=GRAPH_BASE):
    """Build a client by reading the Graph token from a mounted file path (the
    credentials-vault credential_mount). The token stays out of argv/env/DATA.
    `ig_user_id`/`platform`/`base` are pass-through DATA from the transcript-source
    spec — their PRESENCE (not any profile name) selects the messaging surface."""
    import pathlib
    token = pathlib.Path(token_file).read_text(encoding="utf-8").strip()
    if not token:
        raise ValueError("empty instagram graph token file")
    return GraphInstagramClient(token, http_get=http_get, base=base,
                                ig_user_id=ig_user_id, platform=platform)
