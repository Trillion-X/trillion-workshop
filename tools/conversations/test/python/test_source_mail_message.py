# tools/conversations/test/python/test_source_mail_message.py
#
# Proves the `mail-message` source row (read_mail.py, wire `rfc5322`): one message file -> the canonical
# {threads, atoms, rejections} through the shared mapper. Bounded: a size ceiling and an attachment ceiling the
# descriptor may only lower. Fully offline: messages built in memory and written to a file.
import json
import os
import tempfile
from email.message import EmailMessage

import support  # noqa: E402

dec = support.source("mail-message")

MAILBOX = "researcher@agents.example.com"
DESC = {"mailbox_address": MAILBOX}


def _write(message_or_bytes):
    raw = message_or_bytes if isinstance(message_or_bytes, bytes) else message_or_bytes.as_bytes()
    path = os.path.join(tempfile.mkdtemp(), "message.eml")
    with open(path, "wb") as handle:
        handle.write(raw)
    return path


def _observation(message_or_bytes, observed_at="2026-08-10T12:00:00Z"):
    return {"source_ref": "source:mail-file", "native_ref": _write(message_or_bytes), "batch_ref": "batch:test",
            "observed_at": observed_at}


def _message(mid="root@example.com", sender="Alice <alice@example.com>", to=MAILBOX,
             subject="Research request", body="Please investigate this."):
    message = EmailMessage()
    message["From"] = sender
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = "Mon, 10 Aug 2026 12:00:00 +0000"
    if mid:
        message["Message-ID"] = f"<{mid}>"
    message.set_content(body)
    return message


def test_plain_inbound_becomes_one_thread_and_atom():
    result = dec.decode(_observation(_message()), DESC)
    assert result["rejections"] == []
    assert result["next_cursor"] is None
    assert len(result["threads"]) == len(result["atoms"]) == 1
    assert result["threads"][0]["session_id"] == "root@example.com"
    assert result["threads"][0]["send_ref"] == "alice@example.com"
    assert result["atoms"][0]["content"]["text"].strip() == "Please investigate this."
    assert result["atoms"][0]["native_ref"] == "root@example.com"
    assert result["atoms"][0]["at"] == "2026-08-10T12:00:00.000000Z"


def test_reference_header_stitches_reply_to_original_thread():
    original = dec.decode(_observation(_message()), DESC)
    reply = _message(mid="reply@example.com", subject="Re: Research request", body="More detail")
    reply["In-Reply-To"] = "<root@example.com>"
    reply["References"] = "<root@example.com>"
    decoded_reply = dec.decode(_observation(reply, "2026-08-10T12:01:00Z"), DESC)
    assert original["threads"][0]["session_id"] == decoded_reply["threads"][0]["session_id"]
    assert decoded_reply["atoms"][0]["relations"][0] == {
        "role": "mail_thread_headers",
        "message_id": "reply@example.com",
        "in_reply_to": "root@example.com",
        "references": ["root@example.com"],
    }


def test_html_projection_encoded_subject_and_attachment_refs_have_no_bytes():
    message = _message(subject="Résumé review", body="fallback")
    message.clear_content()
    message.add_alternative("<style>x{}</style><div>Hello <b>world</b><br>line two</div>", subtype="html")
    message.add_attachment(b"PDF-BYTES", maintype="application", subtype="pdf", filename="résumé.pdf")
    result = dec.decode(_observation(message), DESC)
    atom = result["atoms"][0]
    assert atom["content"]["text"] == "Hello world\nline two"
    assert result["threads"][0]["presentation"]["title"] == "Résumé review"
    attachment = [r for r in atom["relations"] if r["role"] == "attachment"][0]["attachment_ref"]
    assert attachment["filename"] == "résumé.pdf"
    assert attachment["size"] == len(b"PDF-BYTES")
    assert attachment["content_hash"].startswith("1f:") and len(attachment["content_hash"]) == 67
    serialized = json.dumps(attachment).lower()
    assert "pdf-bytes" not in serialized and "base64" not in serialized and "content_bytes" not in serialized


def test_group_mail_has_no_send_ref():
    result = dec.decode(_observation(_message(to=f"{MAILBOX}, bob@example.net")), DESC)
    assert "send_ref" not in result["threads"][0]


def test_oversized_and_unreadable_inputs_are_structured_rejections():
    result = dec.decode(_observation(_message()), {**DESC, "max_message_bytes": 12})
    assert result["threads"] == [] and result["atoms"] == []
    assert result["rejections"][0]["violation_path"] == "message_bytes"
    missing = {"source_ref": "source:mail-file", "native_ref": "/not/found.eml", "batch_ref": "b", "observed_at": None}
    assert dec.decode(missing, DESC)["rejections"][0]["violation_path"] == "native_ref"


def test_a_descriptor_may_lower_the_ceilings_never_raise_them():
    huge = {**DESC, "max_message_bytes": 10 ** 12, "max_attachment_count": 10 ** 6}
    assert dec.decode(_observation(_message()), huge)["rejections"] == []
    message = _message()
    for number in range(3):
        message.add_attachment(b"x", maintype="application", subtype="octet-stream", filename=f"f{number}.bin")
    result = dec.decode(_observation(message), {**DESC, "max_attachment_count": 2})
    assert result["rejections"][0]["violation_path"] == "message.attachments"


def test_the_person_s_own_address_is_required():
    result = dec.decode(_observation(_message()), {})
    assert result["threads"] == []
    assert result["rejections"][0]["violation_path"] == "descriptor.mailbox_address"


def test_malformed_multipart_is_rejected_without_crash():
    raw = (b"From: a@example.com\r\nTo: researcher@agents.example.com\r\n"
           b"Message-ID: <bad@example.com>\r\nContent-Type: multipart/mixed; boundary=missing\r\n\r\n"
           b"--different\r\ntext")
    result = dec.decode(_observation(raw), DESC)
    assert result["threads"] == []
    assert result["rejections"][0]["violation_path"] == "message.defects"


def test_missing_message_id_uses_the_deterministic_blake3_identity_of_the_bytes():
    message = _message(mid=None)
    first = dec.decode(_observation(message), DESC)
    second = dec.decode(_observation(message), DESC)
    session = first["threads"][0]["session_id"]
    assert session.startswith("1f:") and session == second["threads"][0]["session_id"]
    assert first["atoms"][0]["atom_ref"] == second["atoms"][0]["atom_ref"]
