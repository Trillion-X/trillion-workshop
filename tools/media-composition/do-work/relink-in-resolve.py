# tools/media-composition/do-work/relink-in-resolve.py
#
# Purpose: relink clips in the project DaVinci Resolve has open, through Resolve's own scripting API, from each moved
# clip's old full path to its new one; then save the project. Run by relink-editor-projects.mjs on the person's own
# computer (ported from the Mac app's resolve-relink.py).
#
# Input (stdin):  {"moves": [{"from": "/Volumes/Card/CLIP/C1.MP4", "to": "/Volumes/Drive/Recordings/C1.MP4"}]}
# Output (stdout, one JSON line):
#   {"state": "not-running"}                                   Resolve is closed or its scripting module is missing
#   {"state": "running", "project": name, "relinked": [from], "failed": [from]}
#
# Non-negotiable invariants:
# - Only clips whose "File Path" is exactly a move's `from` are touched; each gets MediaPoolItem.ReplaceClip(to).
# - Only the open project is changed.
# - Nothing here knows a card, drive, camera, service or person.

import json
import os
import sys

# Where Resolve installs its scripting module on each operating system (Blackmagic's documented places).
DEFAULT_MODULES = {
    "darwin": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules",
    "win32": os.path.join(os.environ.get("PROGRAMDATA", ""), "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting", "Modules"),
    "linux": "/opt/resolve/Developer/Scripting/Modules",
}


def resolve_app():
    modules = os.environ.get("RESOLVE_SCRIPT_API_MODULES") or DEFAULT_MODULES.get(sys.platform)
    if modules and modules not in sys.path:
        sys.path.append(modules)
    try:
        import DaVinciResolveScript as script
    except Exception:
        return None
    try:
        return script.scriptapp("Resolve")
    except Exception:
        return None


def clips(folder):
    for clip in folder.GetClipList() or []:
        yield clip
    for child in folder.GetSubFolderList() or []:
        yield from clips(child)


def main():
    moves = {move["from"]: move["to"] for move in json.load(sys.stdin).get("moves", []) if move.get("from") and move.get("to")}
    resolve = resolve_app()
    project = resolve.GetProjectManager().GetCurrentProject() if resolve else None
    if not project:
        print(json.dumps({"state": "not-running"}))
        return
    relinked, failed = [], []
    for clip in clips(project.GetMediaPool().GetRootFolder()):
        where = clip.GetClipProperty("File Path")
        if where in moves:
            (relinked if clip.ReplaceClip(moves[where]) else failed).append(where)
    if relinked:
        resolve.GetProjectManager().SaveProject()
    print(json.dumps({"state": "running", "project": project.GetName(), "relinked": relinked, "failed": failed}))


if __name__ == "__main__":
    main()
