"""Read what a person's repository shipped into a staged file the records builder turns into rows: one entry per release, with the
commit released, its name and time, and the subjects of the commits since the release before it. Run it on a schedule; each run adds
the release it finds when that release is new, so the staged file holds every release seen so far.

Nothing about any product, list or road is known here. The person's settings name:

  mark              where the newest release is read, one of:
                    { "command": [argv...] }: a program run in the repository that prints JSON naming the release (for example a
                      release script's `read` verb)
                    { "ref": "<git ref>" }: a git ref whose commit is the newest release (a branch or tag the person moves)
  fields            for a command mark, the keys of its JSON holding the released `commit`, the release's `name` and its `at` time
                    (only `commit` is required; a name defaults to the commit's first 12 characters, a time to the commit's own)
  most_subjects     at most this many commit subjects per release (newest first)
  id_prefix         optional text put before the release name to make each entry's `id` (the id of its row)

The staged file: { _generated, releases: [{ id, name, commit, at, previous, subjects }] }, oldest first. `previous` is the commit of the
release before it (null for the first one read), and `subjects` are the subjects of the commits after `previous` up to `commit` (the
released commit's own subject alone when there is no previous release, or when the previous commit is not its ancestor).
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

GIT_SECONDS = 60


def git(repository: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', '-C', str(repository), *args], capture_output=True, text=True, timeout=GIT_SECONDS)


def commit_of(repository: Path, name: str) -> str:
    done = git(repository, 'rev-parse', '--verify', '--quiet', f'{name}^{{commit}}')
    if done.returncode != 0:
        raise ValueError(f'The repository has no commit {name}.')
    return done.stdout.strip()


def newest_release(repository: Path, settings: dict) -> dict:
    """The release the mark names now: { name, commit, at }."""
    mark = settings.get('mark') or {}
    if isinstance(mark.get('ref'), str):
        commit = commit_of(repository, mark['ref'])
        return {'name': commit[:12], 'commit': commit, 'at': git(repository, 'log', '-1', '--format=%cI', commit).stdout.strip()}
    argv = mark.get('command')
    if not isinstance(argv, list) or not argv or not all(isinstance(part, str) for part in argv):
        raise ValueError('mark is { "command": [argv...] } or { "ref": "<git ref>" }.')
    done = subprocess.run(argv, cwd=repository, capture_output=True, text=True, timeout=GIT_SECONDS * 2)
    if done.returncode != 0:
        raise ValueError(f'The mark command answered exit {done.returncode}: {done.stderr.strip()[-300:]}')
    said = json.loads(done.stdout.strip().splitlines()[-1])
    fields = settings.get('fields') or {}
    commit = said.get(fields.get('commit', 'commit')) if isinstance(said, dict) else None
    if not isinstance(commit, str):
        raise ValueError(f'The mark names no commit under "{fields.get("commit", "commit")}".')
    commit = commit_of(repository, commit)
    name = said.get(fields['name']) if fields.get('name') else None
    at = said.get(fields['at']) if fields.get('at') else None
    return {'name': str(name) if name else commit[:12], 'commit': commit,
            'at': at or git(repository, 'log', '-1', '--format=%cI', commit).stdout.strip()}


def subjects_between(repository: Path, previous: str | None, commit: str, most: int) -> list[str]:
    """The subjects after previous up to commit, newest first; the commit's own subject when previous is absent or not its ancestor."""
    if previous and git(repository, 'merge-base', '--is-ancestor', previous, commit).returncode == 0:
        lines = git(repository, 'log', '--format=%s', f'-{most}', f'{previous}..{commit}').stdout.splitlines()
    else:
        lines = git(repository, 'log', '--format=%s', '-1', commit).stdout.splitlines()
    return [line for line in lines if line.strip()]


def read(repository: Path, settings: dict, staged: Path, now: datetime | None = None) -> dict:
    """Add the newest release to the staged file when it is new. Returns { releases, added }."""
    if git(repository, 'rev-parse', '--git-dir').returncode != 0:
        raise ValueError(f'{repository} is not a git repository.')
    held = json.loads(staged.read_text()) if staged.is_file() else {'releases': []}
    releases = held.get('releases', [])
    newest = newest_release(repository, settings)
    if releases and releases[-1]['commit'] == newest['commit']:
        return {'releases': len(releases), 'added': None}
    previous = releases[-1]['commit'] if releases else None
    entry = {'id': f"{settings.get('id_prefix', '')}{newest['name']}", **newest, 'previous': previous,
             'subjects': subjects_between(repository, previous, newest['commit'], int(settings.get('most_subjects', 60)))}
    releases.append(entry)
    stamp = (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(json.dumps({'_generated': stamp, 'releases': releases}, ensure_ascii=False, indent=1) + '\n')
    return {'releases': len(releases), 'added': entry['name']}
