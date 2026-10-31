#!/usr/bin/env python3
# tools/conversations/read-data/for_recording.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# What decoded threads and atoms are, said the way the person's message-keeping owner takes a conversation read off
# its own page:
#
#   { conversation_id, title, app, messages: [{ id, speaker, text, at }] }
#
# where `speaker` is "person" for the person's own words, "ai" for an assistant's, and otherwise the name the source
# showed; `id` is the message's place in the conversation it came from (the source's own id, else the atom's), so
# bringing the same export in again adds nothing twice; and `at` is the time the source gave, left out when it gave
# none (a time is never invented). Only what was SAID is a message: a reaction, a tool call, a thought, a status or an
# error is not, and a message with no words is not.
#
# This file keeps nothing and writes nothing. It turns the one canonical contract of the mapper (threads and atoms)
# into the contract of the owner that keeps messages; that owner alone splits a very long message into parts and
# decides what is already kept.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

PERSON = "person"
AI = "ai"


def _speaker_of(atom):
    """The speaker as the source named them: the part of `speaker_ref` after `speaker:<source_ref>:`."""
    prefix = f"speaker:{atom.get('source_ref')}:"
    reference = atom.get("speaker_ref") or ""
    return reference[len(prefix):] if reference.startswith(prefix) else reference.rsplit(":", 1)[-1]


def _spoken_as(name, recording):
    if name == "me" or name in (recording.get("person_speakers") or []):
        return PERSON
    if name in (recording.get("ai_speakers") or []):
        return AI
    return name


def conversations_for_recording(threads, atoms, row, descriptor=None):
    """[{conversation_id, title, app, messages}] of the threads that hold at least one message, in the threads'
    order, each message in the atoms' order."""
    descriptor = descriptor or {}
    recording = row.get("recording") or {}
    app = descriptor.get("app") or recording.get("app") or row.get("label")
    said = {}
    for atom in atoms:
        text = (atom.get("content") or {}).get("text")
        if atom.get("kind") != "utterance" or not isinstance(text, str) or not text.strip():
            continue
        message = {"id": atom.get("native_ref") or atom["atom_ref"],
                   "speaker": _spoken_as(_speaker_of(atom), recording), "text": text}
        if atom.get("at"):
            message["at"] = atom["at"]
        said.setdefault(atom["thread_ref"], []).append(message)
    return [{"conversation_id": thread["thread_ref"], "title": (thread.get("presentation") or {}).get("title"),
             "app": app, "messages": said[thread["thread_ref"]]}
            for thread in threads if thread["thread_ref"] in said]
