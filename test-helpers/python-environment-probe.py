"""Read-only identity/readiness for the owned Python test environment. No installs or model downloads."""
import importlib
import importlib.metadata
import json
import os
import sys
import sysconfig


def identity():
    return {"executable": os.path.realpath(sys.executable), "version": list(sys.version_info[:3]),
            "platform": sysconfig.get_platform(), "implementation": sys.implementation.cache_tag}


def verify(configuration, prefix):
    wrong, versions = [], {}
    root = os.path.realpath(prefix)
    if os.path.realpath(sys.prefix) != root:
        wrong.append("the interpreter is not in the requested environment")
    for item in configuration["packages"]:
        name = item["name"]
        try:
            version = importlib.metadata.version(name)
            versions[name] = version
            if version != item["version"]:
                wrong.append(f"{name}: expected {item['version']}, found {version}")
            module = importlib.import_module(item["module"])
            source = os.path.realpath(module.__file__)
            if os.path.commonpath([root, source]) != root:
                wrong.append(f"{name}: imported outside the requested environment")
        except Exception as error:
            wrong.append(f"{name}: {type(error).__name__}")
    return {"ok": not wrong, "wrong": wrong, "versions": versions}


if __name__ == "__main__":
    if sys.argv[1:] == ["identity"]:
        print(json.dumps(identity()))
    elif len(sys.argv) == 4 and sys.argv[1] == "verify":
        with open(sys.argv[2], encoding="utf8") as stream:
            answer = verify(json.load(stream), sys.argv[3])
        print(json.dumps(answer))
        sys.exit(0 if answer["ok"] else 1)
    else:
        raise SystemExit("use identity, or verify CONFIGURATION ENVIRONMENT")
