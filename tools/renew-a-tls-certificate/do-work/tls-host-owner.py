#!/usr/bin/python3
"""Public TLS host-owner entry point; the installed core lives beside it."""
import importlib.util
from pathlib import Path


_core_path = Path(__file__).with_name(Path(__file__).stem + '-core.py')
_spec = importlib.util.spec_from_file_location('tls_host_owner_core', _core_path)
_core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_core)
globals().update({name: value for name, value in vars(_core).items() if not name.startswith('__')})

if __name__ == '__main__':
    _core.run_cli()
