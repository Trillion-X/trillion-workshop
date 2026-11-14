#!/usr/bin/env python3
# packages/service-connections/do-work/follow-one-written-note-now.py
#
# PURPOSE: Follow ONE `how-to-ask-something-else-to-do-things` note, right now,
# from a terminal, when no engine is serving.
#
# WHY THIS EXISTS: the notes already say everything — how to reach the thing,
# what to say, where the secret goes, how to read the answer. When an engine is
# serving, the workflow runner follows a note and this file is not involved.
# When no engine is serving, the alternative that actually happened was one
# hand-written script per thing reached, kept in a cache folder, which was the
# only record of how to operate four outside things. This is the ONE door that
# replaces all of them: it names no outside thing, no endpoint, no header, and
# no secret. Everything it needs comes from the note.
#
# NON-NEGOTIABLE INVARIANTS
# 1. No outside thing, url, method, header, field, or secret appears below.
#    ONE path to THIS MACHINE does appear, and it is not an exception to that:
#    the file recording which sockets this computer answers on. A socket path is
#    a fact about this machine, never about the thing being reached, so a note
#    names the ROLE it needs and the machine says which connection fills it and
#    where that is. A connection's NAME is equally a fact about this machine,
#    which is why the note does not carry one. Same split as a secret.
#    Adding a thing to reach is a note; this file never changes.
# 2. The request is built by the SHARED builder the workflow runner uses, and
#    the answer is read by the SHARED reader. There is no second grammar here.
# 3. A note declaring a way of reaching this door cannot perform is REFUSED,
#    never half-followed as if it were the way everyone happened to write first.
# 4. A secret is read at the moment of the request, placed as the note says, and
#    never printed, logged, or written anywhere. NEVER print one to confirm it
#    worked either: on 2026-09-03 a key printed to a terminal landed in a session
#    log and could not be revoked, because that company has no revoke path at all.
#    Verify a secret by making a real request, which proves it either way.
# 5. WHICH ENGINE holds the vault and the classifier is NAMED, never found. Nothing here
#    scans for one. That engine hands out secrets and decides what gets destroyed, and
#    this used to take the first listening port on the computer that answered /boot in a
#    familiar shape, which on a machine running several apps is whichever bound the lower
#    port. Reaching a running app has one owner on this machine and it is asked.
#
# NAMED EXCEPTION, honestly: performing the request here uses the standard
# library, not `slot::http-client`, because that slot is WASM and only callable
# inside a running engine. It is ONE performer for every note, not one per thing
# reached, and it disappears the moment an engine is serving.
#
# Run:
#   follow-one-written-note-now.py --note <name> --ask <operation> [--fact k=v]...
#   follow-one-written-note-now.py --note <name> --list
#   follow-one-written-note-now.py --note <name> --go-over-everything-it-is-holding [--fact k=v]...
#   follow-one-written-note-now.py --note <name> --really-act-on-them [--fact k=v]...
#
# The last two answer a different question from the first two. --list and --ask are about what the
# note can be ASKED; going over is about what the other end is HOLDING and what is still waiting on
# a person. One row per kind the note declares in kinds_it_holds, each an answer or the reason there
# is none, and for every kind whose rule can tell an idle one from a busy one, a row per thing found
# and the act on the idle ones.
#
# It is ONE walk and it used to be two, one that reported and one that acted. Both walked the same
# DATA and each computed its own idea of a clean run, so the same connection could be called clean
# by one and not by the other, on the one question where that disagreement costs money. The single
# predicate replacing both: a run is clean when NOTHING ABOUT THIS CONNECTION IS WAITING ON A
# PERSON. A kind nothing enumerates is waiting on a person. So is a kind nobody wrote an idle rule
# for. So is a thing found idle and left standing, whatever stopped it, because "idle, reported,
# still there" is precisely the state a weekly reminder leaves everything in, and that state once
# cost a month of storage billing while a script marked it correctly every Monday.
#
# --really-act-on-them is the same walk and performs the act: it MEANS the flag above plus the
# authority, so no combination of the two says nothing.

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGES = os.path.dirname(os.path.dirname(HERE))
NOTES = os.path.join(PACKAGES, "service-connections", "things-to-store-and-run.json")
SHARED_SCRIPTS = os.path.join(PACKAGES, "trade-order", "do-work")
WHAT_A_WRITTEN_NOTE_IS_CALLED = "how-to-ask-something-else-to-do-things"

# The ways of reaching this door can perform. A note asking for anything else
# is refused, which is how a new way of reaching announces that it needs a
# capability rather than silently producing a wrong request.
WAYS_OF_REACHING_THIS_DOOR_CAN_DO = {"http-request", "unix-socket-http-request"}
# How much of an answer a terminal should be handed unasked. Only ever a PRINTING
# limit: nothing here shortens what was received, and shortening is always declared.
ANSWER_LENGTH_A_TERMINAL_CAN_HOLD = 8000

# A second way of reaching, added 2026-09-04 the way this file said one would be:
# a note declared it, this door refused it, and the refusal was the request for a
# capability rather than a bug. Some things answer HTTP on a unix socket instead
# of a host, a container engine being the one that forced it. Everything above the
# transport is unchanged, so a note reaching one of these is the same note shape.
#
# The socket PATH is deliberately NOT in the note. It is a fact about this
# machine, not about the thing being reached, and machine-wide host DATA already
# owns it: a note names the ROLE it needs through
# reach_through_a_connection_that_fills, and this machine says which of its
# connections fills that and where it is. That keeps invariant 1 true, since no
# url, host or path for any outside thing appears in a note or here, and it also
# keeps one machine's connection NAME out of a note, which the first version of
# this did not (see socket_this_machine_answers_on).
# Who knows how to reach a running app on this computer. It is the ONE owner of that
# question, it refuses to guess when nothing names an app, and it is asked rather than
# copied so this file holds no second idea of where an app's published address lives.
HOW_THIS_MACHINE_REACHES_A_RUNNING_APP = os.path.join(
    PACKAGES, "send-requests-to-an-engine", "do-work", "ask-the-running-app-what-it-can-do.mjs",
)
# Which running app THIS invocation asks, named once when the arguments are read. It is a
# fact about the run and not about any note, ask or thing, so it is held once rather than
# threaded through every signature between the argument and the one function that needs it,
# where four of the five layers would only be carrying it. Nothing else may write it.
THE_APP_THIS_RUN_ASKS = [None]

WHERE_THIS_MACHINE_KEEPS_ITS_PROVIDER_CONNECTIONS = os.path.join(
    os.path.expanduser("~"),
    ".bitfield/runtime-kit/apps-this-computer-can-open/process-provider-connections.json",
)

# Where a secret comes from: the credentials-vault SLOT on the serving engine.
#
# It used to be a folder of plain JSON files, protected by nothing but file
# permissions, so any code running as this user could read every key. That folder
# existed only because no engine was serving. One serves now, so this asks the slot,
# which hands back an opaque handle and then resolves it for exactly one use. The
# secret never sits on disk in the clear for this path again.
#
# There is deliberately NO fallback to the old folder. A fallback would keep the
# plaintext alive forever and quietly re-create the thing this replaced, and a
# missing secret must fail loudly rather than be silently read from a weaker place.
#
# The convention is unchanged and still the note's own: connection_id
# "service_connection:X" with field_id F means the value of F inside X. No name is
# hardcoded here.
VAULT_TARGET = "credentials-vault"

# Who decides whether a thing is idle. NOT a predicate vocabulary written here: `absent`,
# `present`, `gte` and the rest already have one implementation in this system and a rule deciding
# what gets destroyed is the last place a second one may disagree with it. A note carries a
# classify_by_rules request and this hands it over unchanged.
CLASSIFIER_TARGET = "formula-engine"


def serving_engine(app=None):
    """How to reach the engine holding the vault and the classifier, NAMED, never guessed.

    ⛔ IT USED TO SCAN. When nothing in the environment said where the engine was, this
    listed every TCP port this computer was listening on, asked each one for /boot, and
    took the FIRST that answered in a shape it recognised. That engine then handed out
    SECRETS and decided WHAT GETS DESTROYED. On a machine running more than one Bitfield
    app, which is the normal case here, "the first one that answered" is whichever
    happened to bind a lower port, so a sweep could read one app's credentials and destroy
    resources on a decision taken by another app's rule engine, silently and with no way
    to tell afterwards which had answered.

    The machine already has ONE owner for this question and it refuses to guess in exactly
    these words: "Select one running app with statusFile or appId DATA; do not guess an
    app". Reaching a running app is that owner's job, so this asks it rather than keeping
    a second idea of where apps live. Doing the lookup here instead would mean a second
    copy of the machine's layout, including how an app id becomes a folder name, and two
    copies of one fact drift and then disagree, which is the same reason a note carries no
    socket path.

    The precedence above the owner is unchanged and every step of it NAMES one engine: an
    explicit url, the file a runtime publishes its own address into, and the address the
    shell that launched this process published. What is gone is the step that named none.
    """
    explicit = os.environ.get("BITFIELD_TARGET_CARRIER_URL")
    if explicit:
        return {"url": explicit.rstrip("/")}
    published_file = os.environ.get("BITFIELD_TARGET_CARRIER_URL_FILE")
    if published_file and os.path.exists(published_file):
        found = open(published_file).read().strip()
        if found:
            return {"url": found.rstrip("/")}
    ambient = os.environ.get("BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS")
    if ambient:
        return {"url": ("http://" + ambient if "://" not in ambient else ambient).rstrip("/")}

    chosen = app or THE_APP_THIS_RUN_ASKS[0] or os.environ.get("RUNNING_APP_APP_ID")
    status_file = os.environ.get("RUNNING_APP_STATUS_FILE")
    if not chosen and not status_file:
        raise SystemExit(
            "nothing here says WHICH running app holds the vault and the classifier, and "
            "picking one would mean reading one app's secrets and destroying things on "
            "another app's judgement. Name it with --the-running-app-to-ask <id>, or set "
            "RUNNING_APP_APP_ID or RUNNING_APP_STATUS_FILE, or set "
            "BITFIELD_TARGET_CARRIER_URL to an engine address directly."
        )
    return {"app_id": chosen} if chosen else {"status_file": status_file}


def one_request(where, method, at, headers, data, waiting):
    """One request to the engine, over whichever transport it published.

    Both shapes already existed in this file for the OUTSIDE things a note reaches, and
    the engine had only the url one, so an engine publishing a socket, which is every
    local app, was unreachable for a secret. Same request, same answer, and nothing above
    this can tell which carried it.
    """
    request = urllib.request.Request(where["url"] + at, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=waiting) as answer:
        return answer.read()


def ask_a_target(where, target, request):
    """One request to one target on the serving engine. Its own basis, never another target's.

    This was `ask_the_vault` with the name written into it four times, which made asking any other
    target look like new work when it is the same six lines. The vault is one caller of this now
    and the classifier is another; neither is special and a third costs nothing.
    """
    if where.get("app_id") or where.get("status_file"):
        asking = ["node", HOW_THIS_MACHINE_REACHES_A_RUNNING_APP, "request-target", "--target", target]
        asking += ["--app-id", where["app_id"]] if where.get("app_id") else ["--status-file", where["status_file"]]
        answer = subprocess.run(asking, input=json.dumps(request), capture_output=True, text=True, timeout=45)
        if answer.returncode != 0:
            raise RuntimeError((answer.stderr or answer.stdout).strip() or "running-app request failed")
        return json.loads(answer.stdout)
    targets = json.loads(one_request(where, "GET", "/boot", {}, None, 10))
    mine = [t for t in targets if t.get("name") == target]
    if not mine:
        raise SystemExit("the serving engine has no " + target + " to ask")
    return json.loads(one_request(
        where, "POST", "/target/" + target,
        {
            "Content-Type": "application/json",
            "X-Bitfield-Running-Command-List-Basis": mine[0]["running_command_list_basis"],
        },
        json.dumps(request).encode(), 40,
    ))


def load_shared(name):
    path = os.path.join(SHARED_SCRIPTS, name)
    spec = importlib.util.spec_from_file_location(name.replace("-", "_")[:-3], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def notes():
    document = json.load(open(NOTES))
    out = {}
    for thing in document.get("things", []):
        payload = thing.get("payload")
        if isinstance(payload, dict) and payload.get("kind") == WHAT_A_WRITTEN_NOTE_IS_CALLED:
            out[str(thing.get("address", "")).rsplit("::", 1)[-1]] = payload
    return out


def secret_for(note, injection, app=None):
    """Read one secret the way the note says to find it, and only that one."""
    explicit = injection.get("secret_name") or injection.get("vault_key")
    field_id = injection.get("field_id", "")
    if explicit:
        holder, field = explicit, field_id or "value"
    else:
        holder = str(note.get("connection_id", "")).split(":", 1)[-1]
        field = field_id
    base = serving_engine(app)
    minted = ask_a_target(
        base, VAULT_TARGET, {"operation": "read", "key": holder, "handle_ttl_seconds": 60}
    )
    if not minted.get("success") or not minted.get("handle"):
        raise SystemExit("the vault holds no secret for " + holder)
    opened = ask_a_target(
        base,
        VAULT_TARGET,
        {"operation": "resolve_handle", "handle": minted["handle"], "actor_id": "slot::http-client"},
    )
    if not opened.get("success"):
        raise SystemExit("the vault would not resolve the handle for " + holder)
    held = json.loads(opened["value"])
    if field not in held:
        raise SystemExit(holder + " holds no " + field + ", it holds: " + ", ".join(sorted(held)))
    return held[field]


def place(injection, secret, headers, url):
    """Put the secret exactly where the note says. Nothing else may place it."""
    where = injection.get("placement") or {}
    kind = where.get("kind")
    name = where.get("name")
    value = (where.get("prefix") or "") + str(secret) + (where.get("suffix") or "")
    if kind == "header":
        headers[name] = value
        return url
    if kind == "query":
        joiner = "&" if "?" in url else "?"
        return url + joiner + urllib.parse.quote(str(name)) + "=" + urllib.parse.quote(value)
    raise SystemExit("this note wants its secret in a " + str(kind) + ", which nothing here can do")


def socket_this_machine_answers_on(role):
    """Where this machine keeps the socket for whatever fills one role.

    The note names WHAT it needs to reach; this machine says WHICH of its
    connections fills that and WHERE that one is. Neither the note nor this file
    holds a path to anything outside, which is the same split that keeps a
    secret out of a note.

    IT USED TO NAME THE CONNECTION ITSELF, and that was the same defect one
    level up from the one the note already avoided. The socket PATH was kept out
    of the note because it is a fact about this machine; the connection's ID is
    equally a fact about this machine, and a note carrying
    `package::service-connections::connection::local-oci-engine` required every
    machine that ever runs that note to hold a connection under that exact name.
    The customer-set text prohibition caught it on the ship path: a note is
    universal DATA and that string is one Mac's OrbStack. The role was already
    sitting in the same note as `connection_id`, so nothing had to be invented,
    only used.

    THE KEY IS THE ROLE, and no new field was added to hold it. The engine type
    that owns this file (`process-engine`, `ProcessExternalProviderConnection`)
    declares `deny_unknown_fields` and carries only `socket_path` and
    `api_version`, so a `fills` key beside them would have been refused on
    decode, which is the same shape as the receipt field that broke the ship
    path an hour earlier. It did not need one: that type's own doc already says
    package DATA "carries only a portable connection reference" and this
    registry "maps that reference to a host-private socket or endpoint". The
    reference is the role. Keying by it is what the design already asked for,
    and the package-scoped key was the thing out of line."""
    if not os.path.exists(WHERE_THIS_MACHINE_KEEPS_ITS_PROVIDER_CONNECTIONS):
        raise SystemExit(
            "this machine has no record of what it can reach on a socket, so "
            "nothing filling " + str(role) + " can be reached. Expected it at "
            + WHERE_THIS_MACHINE_KEEPS_ITS_PROVIDER_CONNECTIONS
        )
    held = json.load(open(WHERE_THIS_MACHINE_KEEPS_ITS_PROVIDER_CONNECTIONS))
    known = held.get("connections") or {}
    found = known.get(role)
    if not found:
        raise SystemExit(
            "this machine has no connection filling the role " + str(role)
            + ". It fills: " + (", ".join(sorted(known)) or "nothing")
            + ". The key of an entry in that file IS the role it fills."
        )
    where = found.get("socket_path")
    if not where:
        raise SystemExit(str(role) + " is recorded without a socket_path")
    if not os.path.exists(where):
        raise SystemExit(
            str(role) + " names a socket that is not there, so whatever "
            "answers it is not running: " + where
        )
    return where


def ask_over_a_socket(where, method, url, headers, data, timeout_seconds):
    """One request to something answering HTTP on a unix socket.

    Same request, same answer shape as the host case, so everything above the
    transport stays identical and a note cannot tell which one carried it."""
    import http.client
    import socket as socket_module

    class OverThisSocket(http.client.HTTPConnection):
        def connect(self):
            opened = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
            opened.settimeout(timeout_seconds)
            opened.connect(where)
            self.sock = opened

    # Only the path and beyond travel on the wire; the host part of the address
    # is a placeholder because a socket has no host to resolve.
    parsed = urllib.parse.urlsplit(url)
    on_the_wire = parsed.path + (("?" + parsed.query) if parsed.query else "")
    reaching = OverThisSocket("localhost", timeout=timeout_seconds)
    try:
        reaching.request(method, on_the_wire, body=data, headers=headers)
        answered = reaching.getresponse()
        return {
            "status_code": answered.status,
            "body": answered.read().decode("utf-8", "replace"),
        }
    finally:
        reaching.close()


def what_came_back(text):
    """Read an answer whatever shape it arrived in, and never lose it.

    Three shapes, all common and none announced in advance. One document is the
    usual case. MANY documents, one per line, is what anything reporting progress
    sends, a build being the one that forced this. Plain text is everything else.

    This used to assume that a body starting with a brace was one document, so a
    build's progress stream raised "Extra data" and threw away an answer that had
    already arrived, turning a finished piece of work into a crash. An answer that
    arrived must always be shown; the worst case is showing it as text."""
    body = (text or "").strip()
    if not body.startswith(("{", "[")):
        return text
    try:
        return json.loads(body)
    except ValueError:
        pass
    lines = []
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            lines.append(json.loads(line))
        except ValueError:
            return text
    return lines or text


def silence_is_an_answer(which, seconds):
    """Say that nothing answered in time, in the same voice as every other refusal here.

    Silence is a FINDING about the thing being reached, not a fault in this file, and
    it has to read that way or it gets read the other way. A machine that accepts the
    connection and then never replies raises TimeoutError during the response, which
    is not a URLError and so fell through every catch and printed a stack trace. An
    agent reading that trace learns about urllib; the true statement is that a target
    is listening for its address and nothing behind it is serving.

    Both ways of reaching share this sentence rather than each phrasing its own,
    because two copies of one fact drift and then disagree about what silence means."""
    return (
        "nothing answered from " + str(which) + " within " + str(seconds) + "s. "
        "That is an answer about it, not a failure here: something holds the address "
        "and nothing behind it is serving."
    )


class CouldNotAsk(Exception):
    """One ask did not produce an answer, carrying the reason it did not.

    A sweep over several kinds must not end at the first one it cannot reach, because the run then
    reports nothing about the kinds after it and reads exactly like a run that found nothing. The
    single-ask path turns this back into a SystemExit, so nothing about that path changes.
    """


def ask_once(note, note_name, ask, asks, facts):
    """Perform one declared ask and return what the note said to read from the answer.

    Extracted from `main` unchanged so the sweep below cannot drift from the single ask: one code
    path reaches the network, applies the credential injections, and parses through the note's own
    response map. A second copy would be a second set of rules about secrets.
    """
    reach = note.get("how_to_reach_it")
    if reach not in WAYS_OF_REACHING_THIS_DOOR_CAN_DO:
        raise CouldNotAsk("this note is reached by " + str(reach) + ", which this door cannot do. "
                          "It can do: " + ", ".join(sorted(WAYS_OF_REACHING_THIS_DOOR_CAN_DO)))

    facts = dict(facts)
    # The shared builder selects the operation the same way it always has: by the
    # kind named in the thing being asked about. The facts sit alongside it.
    facts["instrument"] = {"kind": ask}

    builder = load_shared("assemble-order-request.py")
    reader = load_shared("parse-broker-order.py")
    built = builder.assemble(facts, note)["submit"]

    # This process has no durable Envelope log. A descriptor-marked external
    # effect therefore cannot be made safely here: after a transport timeout it
    # could not distinguish "provider acted, reply lost" from "never acted",
    # and rerunning this command would redial/resend. Runtime execution goes
    # through service-connections.external-effect-attempt, whose durable
    # effect_ref is written before dispatch. Reads remain available here.
    external_effect = asks[ask].get("external_effect")
    if isinstance(external_effect, dict) and external_effect.get("offline_policy") == "refuse":
        raise CouldNotAsk(
            "this ask can create an outside effect and the offline door has no durable "
            "effect ledger, so it refuses before dispatch. Run it through the declared "
            "service-connections external-effect owner with the task's standing authorization_ref "
            "and effect_ref; a timeout there becomes reconcile-without-retry."
        )

    url = built["url"]
    headers = dict(built.get("headers") or {})
    if "{" in url:
        raise CouldNotAsk("the note's address still has a hole in it: " + url
                          + ", so give the missing fact with --fact")

    # Some things you ask happen BEFORE you have a secret: opening the account,
    # asking for the code, handing the code back. An operation says so about
    # itself, so nothing here has to know which ones they are.
    if not asks[ask].get("before_you_have_a_secret"):
        for injection in (note.get("credential_injections") or []):
            url = place(injection, secret_for(note, injection), headers, url)

    body = built.get("body_bytes")
    data = bytes(body) if body else None
    waiting = (built.get("timeout_ms") or 30000) / 1000.0
    if reach == "unix-socket-http-request":
        named = note.get("reach_through_a_connection_that_fills")
        if not named:
            raise CouldNotAsk(
                "a note reached on a socket must say "
                "reach_through_a_connection_that_fills, naming the ROLE it needs "
                "rather than one machine's connection"
            )
        try:
            answer = ask_over_a_socket(
                socket_this_machine_answers_on(named),
                built["method"], url, headers, data, waiting,
            )
        except TimeoutError:
            raise CouldNotAsk(silence_is_an_answer(named, waiting))
        except OSError as e:
            raise CouldNotAsk("could not reach it on its socket: " + str(e))
    else:
        request = urllib.request.Request(url, data=data, headers=headers, method=built["method"])
        try:
            with urllib.request.urlopen(request, timeout=waiting) as r:
                answer = {"status_code": r.status, "body": r.read().decode("utf-8", "replace")}
        except urllib.error.HTTPError as e:
            answer = {"status_code": e.code, "body": e.read().decode("utf-8", "replace")}
        except urllib.error.URLError as e:
            raise CouldNotAsk("could not reach it: " + str(e.reason))
        except TimeoutError:
            # The HOSTNAME, never the url. An injection can place a secret into an
            # address, so a url is not safe to print and a hostname always is.
            raise CouldNotAsk(silence_is_an_answer(urllib.parse.urlsplit(url).hostname, waiting))

    read = reader.parse(answer, note)
    return {
        "asked": note_name + " " + ask,
        "what_the_answer_means": read.get("status"),
        "answer_code": answer["status_code"],
        "what_the_note_said_to_read": {k: read.get(k) for k in (note.get("response_map") or {})},
        "the_whole_answer": what_came_back(answer["body"]),
    }


def read_at(value, path):
    """Follow a path of names into an answer, or say nothing is there.

    A path of no steps means the answer itself, which is what a provider replying with a bare list
    needs, and a provider that wraps its list in a field is the same DATA with one step in it.
    """
    for step in path or []:
        if isinstance(value, dict):
            if step not in value:
                return None
            value = value[step]
        elif isinstance(value, list):
            try:
                value = value[int(step)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return value


def the_engine_when_something_needs_it():
    """Resolve the serving engine at most once, and only if something actually asks for it.

    Resolving it up front costs a walk its whole report when no engine is serving, which is the
    defect this file already fixed once at the level of a single kind: a run that cannot reach the
    engine must still say so per kind rather than exit with one line. Resolving it per thing instead
    would rescan ports for every row. So it is resolved on first use and remembered.
    """
    found = {}

    def engine():
        if "base" not in found:
            found["base"] = serving_engine()
        return found["base"]

    return engine


def what_the_rule_says_about_one(engine, decide_with, one):
    """Ask the declared classifier, never a copy of its vocabulary living here.

    `absent`, `present`, `gte` and the rest already have exactly one implementation in this system,
    in the formula engine, and a rule deciding what gets DESTROYED is the last place a second
    implementation may be allowed to disagree with the first about what an empty string means. So
    the note carries a classify_by_rules request verbatim and this hands it over unchanged.
    """
    answer = ask_a_target(engine(), CLASSIFIER_TARGET,
                          {"classify_by_rules": dict(decide_with, record=one)})
    if not isinstance(answer, dict):
        raise CouldNotAsk("the classifier answered something that is not a report")
    if "result" not in answer:
        raise CouldNotAsk("the classifier answered without a result, so nothing was decided")
    return answer["result"]


def decide_about_one(note, note_name, asks, facts, rule, one, engine, really):
    """Decide about ONE thing the provider reported, and act only once everything is proven.

    Four ways this ends and every one of them is a row: it could not be named, nobody is using it,
    somebody is, or it is idle and something stopped the act. The last is the one worth care,
    because "idle, and still there" is the exact state the old weekly report left everything in, so
    it is never silent and never counted as clean.
    """
    naming = rule.get("name_one_by") or {}
    name = read_at(one, naming.get("at"))
    if name in (None, ""):
        return {"named": None, "decided": False,
                "why_not": "the note says one of these is named at " + str(naming.get("at"))
                           + " and this one carries nothing there, so nothing can address it"}
    said = {"named": name}
    try:
        matched = what_the_rule_says_about_one(engine, rule.get("decide_with") or {}, one)
    except (CouldNotAsk, SystemExit) as e:
        return dict(said, decided=False, why_not=str(e))
    if not matched:
        return dict(said, decided=True, nobody_is_using_it=False, acted=False)
    said["decided"] = True
    said["nobody_is_using_it"] = True
    said["the_rule_that_matched"] = matched.get("label") if isinstance(matched, dict) else matched

    addressed = dict(facts)
    addressed[naming.get("fact")] = name

    proof = rule.get("only_when_this_is_readable_first")
    if proof:
        proving = proof.get("by_asking")
        if proving not in asks:
            return dict(said, acted=False, eligible=False,
                        why_not="the note says to read " + str(proving) + " first and has no such ask")
        try:
            read = ask_once(note, note_name, proving, asks, addressed)
        except (CouldNotAsk, SystemExit) as e:
            return dict(said, acted=False, eligible=False,
                        why_not="could not read what makes this recoverable: " + str(e))
        carried = read.get("the_whole_answer")
        if not isinstance(carried, dict):
            return dict(said, acted=False, eligible=False,
                        why_not="the fresh read of this one did not come back as a record of it, so "
                                "there is nothing to judge it by")
        # The fresh read has to BE this one. An envelope, an error body, or a listing that moved
        # all decode as a dict and would otherwise be judged as though they were the thing.
        if read_at(carried, naming.get("at")) != name:
            return dict(said, acted=False, eligible=False,
                        why_not="the fresh read does not name " + str(name) + " at "
                                + str(naming.get("at")) + ", so it is not a read of this one")
        # THE LISTING IS A SNAPSHOT AND THE ACT IS NOT. Everything above decided from the
        # enumerating answer, which was true whenever the provider assembled it; something can be
        # picked up in between, and the destroying ask does not check. So the same rule runs again
        # against the read taken moments before the act, and only that one authorizes it.
        try:
            still = what_the_rule_says_about_one(engine, rule.get("decide_with") or {}, carried)
        except (CouldNotAsk, SystemExit) as e:
            return dict(said, acted=False, eligible=False,
                        why_not="could not decide again from the fresh read: " + str(e))
        if not still:
            return dict(said, decided=True, nobody_is_using_it=False, acted=False,
                        named=name,
                        why_not="the listing said nobody was using this and its own fresh read says "
                                "somebody is, so the listing was stale and nothing is done to it")
        # WHAT MAKES THIS RECOVERABLE IS A RULE, NOT A FIELD BEING THERE. This used to accept the
        # mere presence of a named field, so a retention of 0, which means the provider keeps
        # nothing, and a retention of "not-a-duration", which means nobody can tell, both read as
        # proof and authorized destruction. It is judged by the same classifier that judges
        # idleness, so `absent`, `gte` and the rest have one implementation deciding both halves.
        proving_with = proof.get("must_prove")
        if not proving_with:
            return dict(said, acted=False, eligible=False,
                        why_not="the note says to read " + str(proving) + " first without saying "
                                "what the answer must PROVE, and a field that merely arrived proves "
                                "nothing. Give this proof block a must_prove rule set")
        try:
            proven = what_the_rule_says_about_one(engine, proving_with, carried)
        except (CouldNotAsk, SystemExit) as e:
            return dict(said, acted=False, eligible=False,
                        why_not="could not judge what makes this recoverable: " + str(e))
        if not proven:
            # NAME WHAT HAD TO BE TRUE. "It is not eligible" sends a reader to this file; the
            # note's own label for the thing that had to hold sends them to the provider's
            # answer, which is where the reason actually is.
            return dict(said, acted=False, eligible=False,
                        why_not="this one's own answer does not establish "
                                + " or ".join(str(r.get("label") or r.get("key"))
                                              for r in (proving_with.get("rules") or []))
                                + ", and the note requires reading that off the thing itself "
                                  "before acting, because what makes this recoverable is the "
                                  "provider's fact and not ours")
        said["proven_recoverable_by"] = (
            proven.get("label") if isinstance(proven, dict) else proven
        )
    said["eligible"] = True

    acting = rule.get("act_on_one_by_asking")
    if acting not in asks:
        return dict(said, acted=False,
                    why_not="the note says to act by " + str(acting) + " and has no such ask")
    if not really:
        return dict(said, acted=False,
                    why_not="this run was not told to act, so this is still costing money and "
                            "still waiting on somebody. Ask again with --really-act-on-them")
    try:
        return dict(said, acted=True, act=ask_once(note, note_name, acting, asks, addressed))
    except (CouldNotAsk, SystemExit) as e:
        return dict(said, acted=False, why_not=str(e))


def go_over_everything_it_is_holding(note, note_name, asks, facts, really):
    """Walk everything this note says it HOLDS, settle each one, and act rather than report.

    ONE walk, and it used to be two. The first reported what a connection holds; the second decided
    which of those nobody is using and removed them. Both walked kinds_it_holds, both built rows,
    and both computed their own idea of a clean run, so the same connection could be called clean by
    one and not by the other, on the one question where that disagreement costs money.

    THE POINT, in one sentence: a run is clean when NOTHING ABOUT THIS CONNECTION IS WAITING ON A
    PERSON. That single predicate replaces both, and every way of failing lands in one list. A kind
    with no ask that enumerates it is waiting on a person. So is a kind nobody wrote an idle rule
    for. So is a thing found idle and left standing, whatever stopped it, because "idle, reported,
    still there" is exactly the state a weekly reminder leaves everything in, and that state let
    500 GB bill for a month while a script marked it correctly every Monday.

    Acting sits behind `really` because removing something a customer can see is a reserved act.
    That is a boundary, never a hedge: the default proves the entire chain including the
    recoverability read, so the only step left for a person is the one they are actually deciding.
    """
    held = note.get("kinds_it_holds") or {}
    kinds = held.get("kinds") or []
    if not kinds:
        raise SystemExit(
            note_name + " does not say what kinds it holds, so a walk over it would report a clean "
            "bill it cannot support. Add kinds_it_holds to the note first."
        )

    engine = the_engine_when_something_needs_it()
    rows = []
    for kind in kinds:
        what = kind.get("what")
        row = {"what": what}
        rows.append(row)
        enumerating = kind.get("enumerated_by")
        if not enumerating:
            row["answered"] = False
            row["why_not"] = ("no declared ask enumerates this kind, so nothing here can see one "
                              "even when it exists and is being billed for")
            continue
        if enumerating not in asks:
            row["answered"] = False
            row["why_not"] = ("the note names " + enumerating + " for this kind and has no such ask")
            continue
        try:
            found = ask_once(note, note_name, enumerating, asks, facts)
        except (CouldNotAsk, SystemExit) as e:
            # SystemExit as well, and deliberately. The shared vault helpers report an unreachable
            # engine or a missing secret by EXITING, which is right for a single ask and fatal for a
            # walk: uncaught, the first version of this stopped at the first kind and printed one
            # line, so the report shape vanished exactly when it was most needed and the remaining
            # kinds went unmentioned rather than unanswered. A reason that applies to every kind
            # should produce a row for every kind, because the row count is then still true.
            row["answered"] = False
            row["why_not"] = str(e)
            continue
        row["answered"] = True
        row["answer"] = found

        rule = kind.get("when_nobody_is_using_one")
        if not rule:
            row["why_nothing_was_settled"] = (
                "the note does not say when nobody is using one of these, so nothing here can tell "
                "an idle one from a busy one and every judgement about them lands on a person"
            )
            continue
        each = read_at(found.get("the_whole_answer"), rule.get("where_each_one_is_in_the_answer"))
        if not isinstance(each, list):
            row["why_nothing_was_settled"] = (
                "the note says each one is at " + str(rule.get("where_each_one_is_in_the_answer"))
                + " and nothing there is a list of them, so an empty report here would mean the "
                  "answer moved, not that there are none"
            )
            continue
        row["how_many_it_is_holding"] = len(each)
        row["each_one"] = [
            decide_about_one(note, note_name, asks, facts, rule, one, engine, really)
            for one in each
        ]

    # ONE list, because one predicate. A kind nothing could answer about, a kind nothing could
    # judge, and a thing found idle and left standing are three shapes of the same fact: money is
    # still going out and a person still owns the next move. Splitting them into separate headline
    # fields invites a caller to read one and not the other, which is how a partial answer becomes
    # an all-clear.
    waiting_on_a_person = [
        {"what": row["what"], "why": row.get("why_not") or row["why_nothing_was_settled"]}
        for row in rows if not row["answered"] or "why_nothing_was_settled" in row
    ] + [
        {"what": row["what"], "named": one.get("named"), "why": one.get("why_not")}
        for row in rows for one in row.get("each_one", [])
        # EXACTLY TWO THINGS END A THING'S ROW WITHOUT A PERSON: somebody is using it, or it was
        # acted on. Everything else is waiting, and this used to ask only whether a thing was found
        # IDLE and left standing, which reads as the whole question and is not. A thing that could
        # not be NAMED, or whose rule could not be reached, never gets `nobody_is_using_it` at all,
        # so it was silently neither idle nor busy and the run called itself clean while a resource
        # sat unclassified. An unanswerable thing is the strongest reason to send for a person, and
        # it was the one shape that could not.
        if not one.get("acted")
        and not (one.get("decided") and one.get("nobody_is_using_it") is False)
    ]
    return {
        "swept": note_name,
        "kinds_it_says_it_holds": len(kinds),
        "waiting_on_a_person": waiting_on_a_person,
        "this_run_is_clean": not waiting_on_a_person,
        "where_this_kind_list_came_from": held.get("where_this_list_came_from"),
        "per_kind": rows,
    }, waiting_on_a_person


def main():
    ap = argparse.ArgumentParser(description="Follow one written note, right now.")
    ap.add_argument("--note", required=True, help="which written note, by its own last name")
    # One decision, so one place to make it. These name the same choice, what to ask, and a run
    # carrying both says nothing about which was wanted. The first version caught that with a
    # runtime check, which is a guard standing where a structure belongs: argparse refuses the pair
    # before any of this runs, so the meaningless combination is unrepresentable rather than
    # detected.
    what_to_ask = ap.add_mutually_exclusive_group()
    what_to_ask.add_argument("--ask", help="which of the things you can ask for")
    ap.add_argument("--fact", action="append", default=[], metavar="key=value",
                    help="a fact the note's template asks for; repeatable")
    ap.add_argument("--text-fact", action="append", default=[], metavar="key=value",
                    help="a fact that must stay text even when it looks like a number, such as a "
                         "one-time code with a leading zero; repeatable")
    ap.add_argument("--list", action="store_true", help="say what this note can be asked for")
    what_to_ask.add_argument("--go-over-everything-it-is-holding", action="store_true",
                    help="one row per kind this note says it HOLDS, each an answer or a reason "
                         "there is none, and for every kind whose rule can tell idle from busy, a "
                         "row per thing found. A kind with no declared ask, a kind with no rule, "
                         "and a thing found idle and left standing all mean the same thing, that "
                         "somebody still has to go and do it, so all three keep the run unclean")
    # This IMPLIES the mode above rather than qualifying it, so no combination of the two says
    # nothing. A pair where one is meaningless alone is a runtime check waiting to be written, and
    # the check is unnecessary the moment the second one simply means the first plus authority.
    ap.add_argument("--really-act-on-them", action="store_true",
                    help="the same walk, and it performs the act the note declares for each idle "
                         "thing. That removes things a customer can see, which is the one step "
                         "here a person decides")
    ap.add_argument("--the-running-app-to-ask", metavar="app-id",
                    help="which running app's engine holds the vault and the classifier. Only "
                         "needed when nothing in the environment already names one engine. This "
                         "used to be found by asking every listening port on the computer and "
                         "taking the first that answered, which on a machine running more than "
                         "one app read one app's secrets and destroyed things on another app's "
                         "judgement")
    ap.add_argument("--whole-answer", action="store_true",
                    help="print the answer entire, however long. The default keeps the terminal "
                         "readable and SAYS when it shortened something; use this before "
                         "concluding anything from what an answer does not contain")
    args = ap.parse_args()
    THE_APP_THIS_RUN_ASKS[0] = args.the_running_app_to_ask

    held = notes()
    if args.note not in held:
        raise SystemExit("no written note called " + args.note + ". There are notes for: "
                         + ", ".join(sorted(held)))
    note = held[args.note]

    asks = note.get("instrument_requests") or {}
    going_over = args.go_over_everything_it_is_holding or args.really_act_on_them
    if args.list or (not args.ask and not going_over):
        print(args.note + " can be asked for: " + ", ".join(sorted(asks)))
        return 0
    if args.ask and args.ask not in asks:
        raise SystemExit(args.note + " cannot be asked for " + args.ask
                         + ". It can be asked for: " + ", ".join(sorted(asks)))

    facts = {}
    for pair in args.fact:
        if "=" not in pair:
            raise SystemExit("a fact is written key=value, not " + pair)
        key, value = pair.split("=", 1)
        try:
            facts[key] = json.loads(value)
        except ValueError:
            facts[key] = value
    # A one-time code is text that happens to look like a number, and a leading
    # zero disappears the moment anything treats it as one. Saying so is the
    # caller's job because only the caller knows.
    for pair in args.text_fact:
        if "=" not in pair:
            raise SystemExit("a fact is written key=value, not " + pair)
        key, value = pair.split("=", 1)
        facts[key] = value
    if going_over:
        said, waiting = go_over_everything_it_is_holding(
            note, args.note, asks, facts, args.really_act_on_them
        )
        print(json.dumps(said, indent=1))
        # ONE predicate, and the exit code is the only part of this a caller reads without deciding
        # to. Anything left for a person exits non-zero, whether that is a kind nothing could answer
        # about, a kind nothing could judge, or an idle thing still standing. A run that could not
        # answer has not established that a kind is empty, and a run that reported an idle thing has
        # not removed it.
        return 1 if waiting else 0

    try:
        said = ask_once(note, args.note, args.ask, asks, facts)
    except CouldNotAsk as e:
        raise SystemExit(str(e))
    read_status = said["what_the_answer_means"]
    # A shortened answer must SAY it was shortened. This used to slice the rendered JSON
    # at 8000 characters with no marker, which is the worst of both: the output was not
    # valid JSON any more, and an answer that arrived whole was displayed as if it were
    # complete. Everything downstream then reasons about a fragment. A route list read
    # that way says a target is ABSENT when it was merely past the cut, and absence is
    # exactly what these reads get used to establish.
    whole = json.dumps(said, indent=1)
    if args.whole_answer or len(whole) <= ANSWER_LENGTH_A_TERMINAL_CAN_HOLD:
        print(whole)
    else:
        said["the_whole_answer"] = {
            "shortened": True,
            "why": "the answer is longer than this terminal should print",
            "how_to_see_all_of_it": "ask again with --whole-answer",
            "how_long_it_really_is": len(whole),
            "the_start_of_it": whole[:ANSWER_LENGTH_A_TERMINAL_CAN_HOLD],
        }
        print(json.dumps(said, indent=1))
    return 0 if read_status == "succeeded" else 1


if __name__ == "__main__":
    sys.exit(main())
