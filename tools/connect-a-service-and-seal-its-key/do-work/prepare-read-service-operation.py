#!/usr/bin/env python3
"""Prepare one read-only request from a canonical service-operation note.

The request grammar remains owned by trade-order's shared assembler.  This
adapter only supplies the selected operation as the generic instrument kind and
refuses any method that could mutate the provider.
"""

import importlib.util
import json
import sys
from pathlib import Path


def load_assembler():
    path = Path(__file__).with_name("assemble-order-request.py")
    spec = importlib.util.spec_from_file_location("assemble_order_request", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare(note, operation, facts):
    if not isinstance(note, dict) or note.get("kind") != "how-to-ask-something-else-to-do-things":
        raise ValueError("The saved connection details are not readable.")
    if note.get("how_to_reach_it") != "http-request":
        raise ValueError("This connected service does not support reading current information here.")
    operations = note.get("instrument_requests")
    if not isinstance(operations, dict) or operation not in operations:
        raise ValueError("The requested read is not available for this connected service.")
    if not isinstance(facts, dict):
        raise ValueError("The details for this read are incomplete.")

    order = dict(facts)
    order["instrument"] = {"kind": operation}
    request = load_assembler().assemble(order, note)["submit"]
    method = str(request.get("method") or "GET").upper()
    if method not in {"GET", "HEAD"}:
        raise ValueError("This action can only read information. " + method + " is not allowed.")

    return {
        "url": request["url"],
        "method": method,
        "headers": request.get("headers") or {},
        "body": request.get("body_bytes"),
        "credential_injections": request.get("injections") or [],
        "timeout_ms": request.get("timeout_ms") or 30000,
    }


def main(argv):
    if len(argv) != 4:
        raise SystemExit("Required connected-service details are missing.")
    prepared = prepare(json.loads(argv[1]), argv[2], json.loads(argv[3]))
    print(json.dumps(prepared, separators=(",", ":")))


if __name__ == "__main__":
    main(sys.argv)
