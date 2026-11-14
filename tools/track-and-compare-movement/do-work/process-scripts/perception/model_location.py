"""Where the perception models are found, at run time.

The .onnx models are large binaries that are never committed. A host provides them as DATA: the folder named by
MATCH_VENDOR_ROOT. Without it, a model is looked for beside these scripts, then in the build-time `onnx/` folder
that the package build reads. Nothing is linked into this folder, so no tracked link stands in for a model."""
import os
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_BUILD_TIME = _HERE.parent / "onnx"


def model_path(name: str) -> str:
    """The first existing `name` under MATCH_VENDOR_ROOT, beside these scripts, then the build-time folder."""
    vendor = os.environ.get("MATCH_VENDOR_ROOT")
    for root in ([Path(vendor)] if vendor else []) + [_HERE, _BUILD_TIME]:
        if (root / name).exists():
            return str(root / name)
    return str(_BUILD_TIME / name)
