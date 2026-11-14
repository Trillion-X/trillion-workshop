"""Serve a locally downloaded classifier over the shared decision contract.

Why this exists rather than the runtime's own server
    The downloaded runtime ships a server whose engine takes `device="cuda"` as
    a default and never offers the choice, so on a machine with no NVIDIA card
    it fails at startup with "Torch not compiled with CUDA enabled" before it
    binds a port. The underlying class already supports other devices and even
    turns off the CUDA-only graph path by itself when the device is not a CUDA
    one. Only the server hardcodes it.

    So the fix is not to edit the runtime. That lives in a cache directory and
    the next download would silently undo it, which is the worst kind of repair:
    one that works until it vanishes. This is a small server of our own that
    asks the same class for the same answers and passes the device through.

What it speaks
    POST /v1/systemone with {"state": ..., "questions": {...}}, the same shape
    the hosted service takes, so the one adapter drives either and which one
    answers is decided by calibration rather than by a branch in the code.
"""

import json
import os
import sys
import time

# The runtime lives beside its weights, so its own package directory has to be
# importable before anything from it can be asked for.
MODEL_PATH = os.environ.get("SERVE_MODEL_PATH", "")
if MODEL_PATH and MODEL_PATH not in sys.path:
    sys.path.insert(0, MODEL_PATH)

import torch  # noqa: E402
from decider.infer import Decider  # noqa: E402


def pick_device(asked):
    """The device the caller asked for, or the best one this machine has."""
    if asked:
        return asked
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load():
    device = pick_device(os.environ.get("DECIDER_DEVICE", ""))
    # bfloat16 is the published weight format, but not every backend implements
    # every operation in it. Falling back to float32 costs memory and keeps the
    # answers; failing to load costs everything.
    for dtype in (torch.bfloat16, torch.float32):
        try:
            started = time.time()
            decider = Decider(MODEL_PATH, device=device, dtype=dtype)
            print(
                f"[classifier] ready on {device} as {dtype} in {time.time() - started:.1f}s",
                flush=True,
            )
            return decider
        except Exception as error:  # noqa: BLE001
            print(f"[classifier] {dtype} did not load on {device}: {error}", flush=True)
    raise SystemExit("the classifier could not be loaded on any supported number format")


DECIDER = load()

import asyncio  # noqa: E402

from fastapi import FastAPI, HTTPException, Request  # noqa: E402

from decider.infer import Example, Q, neutralize_options  # noqa: E402
from decider.model import collate  # noqa: E402
from decider.prompt import MAX_OPTIONS, build  # noqa: E402
from decider.systemone import assemble, plan_rows, render_question, render_state, unique_tokens  # noqa: E402

app = FastAPI()

# A request that has waited longer than its caller said it would wait (the
# `x-answer-within-seconds` header, else this default) is answered with a
# refusal instead of a verdict. Every caller here is a hook with a deadline of
# a few seconds; computing answers nobody is waiting for is what turned a busy
# minute into a queue that never drained (about twelve agents, each asking on
# every tool call).
STALE_SECONDS = float(os.environ.get("SERVE_STALE_SECONDS", "4"))
# Most tokens in one forward pass. Measured on Apple's GPU without the fast
# attention kernels: eight long requests together took 19.3 s, slower than the
# same eight one at a time, so only short requests share a pass.
MAX_FORWARD_TOKENS = int(os.environ.get("SERVE_MAX_FORWARD_TOKENS", "4096"))


class _Keep:
    def shuffle(self, x):
        pass

    def sample(self, xs, k):
        return xs[:k]


def planned(state, questions):
    """One request's rows, built exactly as Decider.system_one builds them (independent questions)."""
    ctx = render_state(state)
    rqs = {key: render_question(value) for key, value in questions.items()}
    opts = (lambda row: neutralize_options(row["options"])[0]) if DECIDER.neutralize_none else (lambda row: list(row["options"]))
    flat, index = plan_rows(rqs, DECIDER.isolated_levels)
    items = [build(Example(ctx, [Q(row["question"], opts(row), 0)]), DECIDER.m.tok, _Keep(), max_options=MAX_OPTIONS,
                   max_ctx_tokens=32768, layout="state_first") for row in flat]
    return rqs, index, items


@torch.no_grad()
def answer_together(requests):
    """Every waiting request in as few forward passes as fit, instead of one pass each.

    Rows from different requests never see each other: each row is its own
    sequence, padded behind, exactly as the runtime already batches the several
    questions of one request. So an answer is the same whichever requests it
    happened to share a pass with.
    """
    plans = [planned(state, questions) for state, questions in requests]
    rows = [(plan_number, item) for plan_number, plan in enumerate(plans) for item in plan[2]]
    # Similar lengths together, so little of each pass is padding.
    order = sorted(range(len(rows)), key=lambda at: len(rows[at][1]["ids"]))
    found = [None] * len(rows)
    at = 0
    while at < len(order):
        longest = len(rows[order[at]][1]["ids"])
        take = [order[at]]
        while at + len(take) < len(order):
            nxt = order[at + len(take)]
            longest = max(longest, len(rows[nxt][1]["ids"]))
            if longest * (len(take) + 1) > MAX_FORWARD_TOKENS:
                break
            take.append(nxt)
        items = [rows[index][1] for index in take]
        batch = collate(items, DECIDER.m.tok.pad_token_id)
        logits = DECIDER.m.slot_logits(*[batch[key].to(DECIDER.dev) for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")])
        probs = torch.softmax(logits / DECIDER.T, -1).cpu()
        cursor = 0
        for index, item in zip(take, items):
            found[index] = probs[cursor:cursor + len(item["slots"])]
            cursor += len(item["slots"])
        at += len(take)
    answers, cursor = [], 0
    for rqs, index, items in plans:
        mine = found[cursor:cursor + len(items)]
        cursor += len(items)
        flat = [p.tolist() for ps in mine for p in ps]
        answers.append({"model": DECIDER.name, "answers": assemble(rqs, index, flat),
                        "usage": {"input_tokens": unique_tokens(items), "output_tokens": 0}})
    return answers


WAITING = []
ARRIVED = None


def settle(reply, result=None, error=None):
    """Answer a waiting request unless its caller already left.

    A caller that gives up cancels its own wait, and answering a cancelled
    wait raises. Before this check, the first caller to give up while its
    answer was being computed killed the loop that answers everyone, and the
    server went on accepting requests it would never answer.
    """
    if reply.done():
        return
    if error is not None:
        reply.set_exception(error)
    else:
        reply.set_result(result)


async def answer_what_is_waiting():
    """One loop owns the model: take everything waiting, drop what nobody waits for, answer the rest together."""
    while True:
        await ARRIVED.wait()
        ARRIVED.clear()
        taken = WAITING[:]
        WAITING.clear()
        try:
            live = []
            for one in taken:
                waited = time.monotonic() - one["arrived"]
                if one["reply"].done():
                    continue
                if waited > one["patience"] or await one["request"].is_disconnected():
                    settle(one["reply"], error=HTTPException(status_code=503, detail=f"not answered: it waited {waited:.1f} s behind other requests, and its caller had already stopped waiting"))
                else:
                    live.append(one)
            if not live:
                continue
            try:
                started = time.monotonic()
                results = await asyncio.to_thread(answer_together, [(one["state"], one["questions"]) for one in live])
                print(f"[classifier] answered {len(live)} together in {time.monotonic() - started:.2f} s; dropped {len(taken) - len(live)}", flush=True)
                for one, result in zip(live, results):
                    settle(one["reply"], result)
            except Exception:  # noqa: BLE001
                # One malformed request must not sink the others: answer each alone.
                for one in live:
                    try:
                        settle(one["reply"], (await asyncio.to_thread(answer_together, [(one["state"], one["questions"])]))[0])
                    except Exception as error:  # noqa: BLE001
                        settle(one["reply"], error=HTTPException(status_code=422, detail=str(error)))
        except Exception as error:  # noqa: BLE001
            # Whatever went wrong, the loop that answers everyone keeps going.
            print(f"[classifier] answering loop recovered from: {error!r}", flush=True)
            for one in taken:
                settle(one["reply"], error=HTTPException(status_code=500, detail="the classifier failed while answering"))


@app.on_event("startup")
async def start_answering():
    global ARRIVED
    # Made inside the server's own loop, so waiting on it can never belong to another one.
    ARRIVED = asyncio.Event()
    asyncio.get_running_loop().create_task(answer_what_is_waiting())


@app.post("/v1/systemone")
async def system_one(body: dict, request: Request):
    arrived = time.monotonic()
    state = body.get("state")
    questions = body.get("questions")
    if state is None or not isinstance(questions, dict) or not questions:
        # Saying which half is missing beats a generic rejection, because the
        # two have different causes and the caller can only fix the one it made.
        raise HTTPException(
            status_code=422,
            detail="a request needs a `state` to read and a non-empty `questions` map to answer",
        )
    try:
        patience = float(request.headers.get("x-answer-within-seconds", STALE_SECONDS))
    except ValueError:
        patience = STALE_SECONDS
    reply = asyncio.get_running_loop().create_future()
    WAITING.append({"state": state, "questions": questions, "arrived": arrived, "patience": patience, "request": request, "reply": reply})
    ARRIVED.set()
    return await reply


@app.get("/health")
async def health():
    return {"serving": MODEL_PATH, "device": DECIDER.dev}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SERVE_PORT", "8099")), log_level="warning")
