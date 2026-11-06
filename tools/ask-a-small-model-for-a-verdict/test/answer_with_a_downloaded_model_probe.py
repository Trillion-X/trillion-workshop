"""Runs one probe of do-work/answer_with_a_downloaded_model.py for test/answer-with-a-downloaded-model.test.mjs: one JSON
request on standard input ({ probe, settings, line_sets?, env?, ... }), one JSON answer on standard output. Every value a
test sends is made up."""
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("answerer", HERE.parent / "do-work" / "answer_with_a_downloaded_model.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

request = json.loads(sys.stdin.read())
for name, value in (request.get("env") or {}).items():
    if value is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = value


def answer():
    probe = request["probe"]
    m.configure(request.get("settings", {}), request.get("line_sets"))
    if probe == "context":
        return [m.context_of(ask) for ask in request["asks"]]
    if probe == "engine":
        return [m.engine_of(ask) for ask in request["asks"]]
    if probe == "place":
        cpu_only = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False), backends=types.SimpleNamespace())
        try:
            route = str(m.consult_route())
        except m.Refused as refused:
            route = {"refused": str(refused)}
        return {"model": str(m.MODEL) if m.MODEL else None, "cache": str(m.CACHE) if m.CACHE else None, "device": m.device(cpu_only), "route": route}
    if probe == "parts":
        sizes = request["sizes"]
        return m.consult_parts(list(range(len(sizes))), lambda i: sizes[i])
    if probe == "consult-table":
        return m.consult_table(request["answer"], request["options"], request["count"])
    if probe == "consult-prompt":
        return m.consult_prompt(request["question"], request["options"], request["texts"])
    if probe == "adapter":
        return str(m.adapter_path(request["adapter"]))
    if probe == "sentences":
        return [m.sentences(text) for text in request["texts"]]
    if probe == "mlx-prompt":
        return m.mlx_prompt(request["context"], request["ask"])
    raise SystemExit(f"no probe {probe}")


try:
    print(json.dumps({"result": answer()}))
except m.Refused as refused:
    print(json.dumps({"error": str(refused)}))
