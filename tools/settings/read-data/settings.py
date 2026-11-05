"""tools/settings/read-data/settings.py: the Python side of the one settings reader.

A Python tool never reads the records door itself. Its row runs it under do-work/run-with-settings.mjs, which reads
the row named by the request's `settings_record` and hands the program the request with `settings` already merged
(defaults < record < the request's own settings) and `settings_from` naming the record. This module only lays the
program's own defaults under what it was handed, with the same merge as read-data/settings.mjs layOver.
"""
from __future__ import annotations

import copy
from typing import Any


def lay_over(under: Any, over: Any) -> Any:
    """Plain objects merge key by key; anything else is replaced whole."""
    if not isinstance(under, dict) or not isinstance(over, dict):
        return under if over is None else over
    out = dict(under)
    for key, value in over.items():
        out[key] = lay_over(under[key], value) if key in under else value
    return out


def settings_of(request: dict, defaults: dict) -> dict:
    """The settings a program runs with: its defaults under the request's (already merged) settings."""
    given = request.get('settings')
    if given is not None and not isinstance(given, dict):
        raise ValueError('settings, when given, must be a JSON object.')
    return lay_over(copy.deepcopy(defaults), given or {})
