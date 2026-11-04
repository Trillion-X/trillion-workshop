# computer/resident.py
#
# Purpose: keeps one model program of this computer running and answering, so a model is loaded once instead of once
# per request. A program that loads a model (hear-with-mlx-whisper.py, know-who.py, speak-with-mlx.py) passes its own
# `answer` to serve(); computer/keep-drive-files.mjs askResident() starts it when nothing answers on its socket and
# sends it one JSON line per request. A program whose work is `main(argv)` serves through answer_argv(main): each
# request is { "argv": [<program>, ...arguments] }, the same words it takes on its command line, and the value main
# returns comes back as { "ok": true, "value": ... }.
#
#   serve(<socket>, <idle_seconds>, answer)    answer(request) -> one JSON-able value per request
#
# Invariants:
#   1. One resident per socket: a second one started while the first answers ends at once, so two callers starting it
#      together never load the model twice.
#   2. Only this user can reach it: the socket is made readable and writable by its owner alone.
#   3. Requests run one at a time (models are not shared between threads); each connection waits its turn, so a
#      caller's time limit covers its wait.
#   4. It ends by itself once nothing has asked for `idle_seconds`, letting go of the model's memory.
#   5. Every failure goes back as words ({ "ok": false, "error" }), never as a dropped connection.
#
# AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import json
import os
import socket
import threading
import time

TURN = threading.Lock()


def answer_argv(main):
    """An `answer` for a program whose work is main(argv) -> value."""
    def answer(request):
        return {'ok': True, 'value': main(list(request['argv'][1:]))}
    return answer


def _answered(answer, request):
    try:
        with TURN:
            return answer(request)
    except BaseException as error:  # a model or file failure is an answer, so the caller can say why
        return {'ok': False, 'error': str(error) or type(error).__name__}


def serve(path, idle_seconds, answer):
    if os.path.exists(path):
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(path)
            return  # another resident already answers on this socket (invariant 1)
        except OSError:
            os.unlink(path)
        finally:
            probe.close()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(16)
    server.settimeout(5)
    state = {'last': time.time(), 'busy': 0}
    held = threading.Lock()

    def handle(connection):
        with connection:
            connection.settimeout(None)
            data = b''
            while not data.endswith(b'\n'):
                chunk = connection.recv(65536)
                if not chunk:
                    break
                data += chunk
            try:
                request = json.loads(data or b'{}')
            except ValueError:
                reply = {'ok': False, 'error': 'the request was not one JSON line'}
            else:
                reply = _answered(answer, request)
            try:
                connection.sendall((json.dumps(reply) + '\n').encode())
            except OSError:
                pass  # the caller gave up waiting; the next request is answered as usual
        with held:
            state['busy'] -= 1
            state['last'] = time.time()

    try:
        while True:
            with held:
                if not state['busy'] and time.time() - state['last'] >= idle_seconds:
                    break
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            with held:
                state['busy'] += 1
            threading.Thread(target=handle, args=(connection,), daemon=True).start()
    finally:
        server.close()
        if os.path.exists(path):
            os.unlink(path)
