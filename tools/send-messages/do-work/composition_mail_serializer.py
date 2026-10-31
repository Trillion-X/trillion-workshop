#!/usr/bin/env python3
# tools/send-messages/do-work/composition_mail_serializer.py
#
# Purpose: THE send-boundary projection of a documents document into
# an outbound message body. Compose/reply IS a composition (one authoring SSOT);
# this pure leaf folds the document node subtree into
# {body_html, body_text, inline_refs, degraded} for the generic
# `action:send-via-connection` serialize step.
#
# Non-Negotiable Invariants:
# - PURE, zero I/O: takes plain dict nodes, returns plain dicts. Unit-testable
#   with fixtures; callable as a library AND a CLI (never a 2nd serializer).
# - ZERO mail-provider vocabulary. This leaf emits generic HTML + plaintext +
#   part refs; provider framing (base64url raw, endpoint fields) lives in the
#   egress route's request_template DATA (L090 / Physics-vs-Society).
# - Media blocks become inline_refs {cid, fetch_ref, mime} — the SEND ACTION
#   resolves CAS bytes into MIME parts; this leaf NEVER fetches.
# - Unknown block kinds fall OPEN to their text projection and are recorded in
#   `degraded` — never silently dropped (fail-open-to-text rule).
# - The kind→renderer mapping is an overridable DATA table (options
#   "kind_renderers": {<kind>: "paragraph"|"heading1..3"|"media"}), so a new
#   block kind is a DATA row, never a dispatcher edit (enum dissolution).
#
# CLI: composition_mail_serializer.py <request.json> <out.json>
#   request.json = {document_nodes: [SceneNode...] | SceneNode, options?}
import html
import json
import pathlib
import sys

# Default kind→renderer rows (DATA, overridable via options.kind_renderers).
# Renderer ids are the CLOSED-BY-PHYSICS set of output forms this leaf can emit
# (a mail body has paragraphs, headings, media parts); the KIND names mapping to
# them are open data.
_DEFAULT_KIND_RENDERERS = {
    "Text": "paragraph",
    "Paragraph": "paragraph",
    "Heading1": "heading1",
    "Heading2": "heading2",
    "Heading3": "heading3",
    "Image": "media",
    "Media": "media",
}

_HEADING_TAG = {"heading1": "h1", "heading2": "h2", "heading3": "h3"}


def _text_projection(node):
    """Best-effort text of a node: the first non-empty string prop among the
    conventional text-bearing names, else None."""
    props = node.get("props") or {}
    for key in ("text", "label", "title", "caption", "value"):
        value = props.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _media_ref(node):
    """CAS-backed media reference of a node, if its props carry one."""
    props = node.get("props") or {}
    fetch_ref = props.get("fetch_ref") or props.get("src") or props.get("content_ref")
    if not isinstance(fetch_ref, str) or not fetch_ref.strip():
        return None
    mime = props.get("mime") if isinstance(props.get("mime"), str) else "application/octet-stream"
    return {"fetch_ref": fetch_ref, "mime": mime}


def serialize_composition_to_mail(document_nodes, options=None):
    """Fold a composition document subtree into an outbound body.

    document_nodes: a list of SceneNodes ({id, kind, props, children, visible})
    or a single root node. Returns {body_html, body_text, inline_refs, degraded}.
    """
    options = options or {}
    renderers = dict(_DEFAULT_KIND_RENDERERS)
    overrides = options.get("kind_renderers")
    if isinstance(overrides, dict):
        for k, v in overrides.items():
            if isinstance(k, str) and isinstance(v, str):
                renderers[k] = v

    if isinstance(document_nodes, dict):
        document_nodes = [document_nodes]

    html_parts, text_lines, inline_refs, degraded = [], [], [], []
    cid_counter = [0]

    def emit(node):
        if not isinstance(node, dict):
            return
        if node.get("visible") is False:
            return
        kind = node.get("kind") or ""
        renderer = renderers.get(kind)
        quoted = bool((node.get("props") or {}).get("quote"))
        text = _text_projection(node)

        if renderer == "media" or (renderer is None and _media_ref(node)):
            ref = _media_ref(node)
            if ref is not None:
                cid_counter[0] += 1
                cid = f"part-{cid_counter[0]}"
                inline_refs.append({"cid": cid, **ref})
                alt = html.escape(text or "")
                html_parts.append((f'<img src="cid:{cid}" alt="{alt}">', quoted))
                if text:
                    text_lines.append((text, quoted))
            elif text:
                # A media block without a resolvable ref degrades to its text.
                degraded.append({"node_id": node.get("id"), "kind": kind,
                                 "reason": "media ref missing; text projection used"})
                html_parts.append((f"<p>{html.escape(text)}</p>", quoted))
                text_lines.append((text, quoted))
        elif renderer in _HEADING_TAG:
            if text:
                tag = _HEADING_TAG[renderer]
                html_parts.append((f"<{tag}>{html.escape(text)}</{tag}>", quoted))
                text_lines.append((text, quoted))
        elif renderer == "paragraph":
            if text:
                html_parts.append((f"<p>{html.escape(text)}</p>", quoted))
                text_lines.append((text, quoted))
        elif renderer is None and (text or not node.get("children")):
            # Unknown kind: fail OPEN to its text projection, record degradation.
            if text:
                degraded.append({"node_id": node.get("id"), "kind": kind,
                                 "reason": "unknown block kind; text projection used"})
                html_parts.append((f"<p>{html.escape(text)}</p>", quoted))
                text_lines.append((text, quoted))
            elif not node.get("children"):
                degraded.append({"node_id": node.get("id"), "kind": kind,
                                 "reason": "unknown block kind with no text projection; dropped from body, listed here"})
        for child in node.get("children") or []:
            emit(child)

    for node in document_nodes or []:
        emit(node)

    # Fold contiguous quoted runs into ONE blockquote (reply-with-quoting seed).
    body_html_chunks, quote_buffer = [], []

    def flush_quote():
        if quote_buffer:
            body_html_chunks.append("<blockquote>" + "".join(quote_buffer) + "</blockquote>")
            quote_buffer.clear()

    for fragment, quoted in html_parts:
        if quoted:
            quote_buffer.append(fragment)
        else:
            flush_quote()
            body_html_chunks.append(fragment)
    flush_quote()

    body_text = "\n".join(("> " + line if quoted else line)
                          for line, quoted in text_lines)
    return {
        "body_html": "".join(body_html_chunks),
        "body_text": body_text,
        "inline_refs": inline_refs,
        "degraded": degraded,
    }


def main(argv):
    if len(argv) < 3:
        print("usage: composition_mail_serializer.py <request.json> <out.json>",
              file=sys.stderr)
        return 2
    request = json.loads(pathlib.Path(argv[1]).read_text(encoding="utf-8"))
    result = serialize_composition_to_mail(
        request.get("document_nodes") or [], request.get("options"))
    pathlib.Path(argv[2]).write_text(json.dumps(result, separators=(",", ":")),
                                     encoding="utf-8")
    print(f"[composition-mail-serializer] html={len(result['body_html'])}B "
          f"text={len(result['body_text'])}B parts={len(result['inline_refs'])} "
          f"degraded={len(result['degraded'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
