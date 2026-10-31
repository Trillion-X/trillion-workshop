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
  each              optional, "commit": every commit after the one read last, up to the mark's commit, is an entry of its own (named by
                    its first 12 characters, at its own time, its subject alone), for a branch whose every landing is a change
                    shipped; without it, one entry per release
  after             with each "commit", the commit the first read starts after (without it, the first read notes the mark's commit only)
  skip_subjects     with each "commit", regular expressions: a commit whose subject matches one is read but gets no entry (a regenerated
                    file, say)

The staged file: { _generated, releases: [{ id, name, commit, at, previous, subject?, subjects }] }, oldest first. `previous` is the commit of the
release before it (null for the first one read), and `subjects` are the subjects of the commits after `previous` up to `commit` (the
released commit's own subject alone when there is no previous release, or when the previous commit is not its ancestor). With each
"commit", each entry also has `subject` (the commit's own subject) and the file holds `read_to`, the mark's commit at the last read, which the next read starts after (the newest commit read may
have been skipped); a mark that moved to a commit `read_to` is not an ancestor of adds that commit alone.
"""
from __future__ import annotations

import json
import re
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


def commits_after(repository: Path, previous: str | None, commit: str) -> list[dict]:
    """{ commit, at, subject } of each commit after previous up to commit, oldest first; commit alone when previous is absent or not its
    ancestor."""
    if previous and git(repository, 'merge-base', '--is-ancestor', previous, commit).returncode == 0:
        span = ['--reverse', f'{previous}..{commit}']
    else:
        span = ['-1', commit]
    lines = git(repository, 'log', '--format=%H%x00%cI%x00%s', *span).stdout.splitlines()
    return [dict(zip(('commit', 'at', 'subject'), line.split('\0', 2))) for line in lines if line.strip()]


def each_commit(repository: Path, settings: dict, held: dict) -> tuple[list[dict], str]:
    """The entries of the commits not read yet, and the mark's commit they were read up to."""
    tip = newest_release(repository, settings)['commit']
    releases = held['releases']
    previous = held.get('read_to') or (releases[-1]['commit'] if releases else None)
    if previous is None and settings.get('after'):
        previous = commit_of(repository, settings['after'])
    if previous == tip:
        return [], tip
    skip = [re.compile(pattern) for pattern in settings.get('skip_subjects', [])]
    entries, before = [], previous
    for one in commits_after(repository, previous, tip):
        if not any(pattern.search(one['subject']) for pattern in skip):
            name = one['commit'][:12]
            entries.append({'id': f"{settings.get('id_prefix', '')}{name}", 'name': name, 'commit': one['commit'], 'at': one['at'],
                            'previous': before, 'subject': one['subject'], 'subjects': [one['subject']]})
        before = one['commit']
    return entries, tip


def read(repository: Path, settings: dict, staged: Path, now: datetime | None = None) -> dict:
    """Add what is new to the staged file: the newest release, or with each "commit" every commit not read yet.
    Returns { releases, added, added_count }, added being the name of the newest entry added (null when none was)."""
    if git(repository, 'rev-parse', '--git-dir').returncode != 0:
        raise ValueError(f'{repository} is not a git repository.')
    if settings.get('each') not in (None, 'commit'):
        raise ValueError('each is "commit" or left out.')
    held = json.loads(staged.read_text()) if staged.is_file() else {}
    held = {**held, 'releases': held.get('releases', [])}
    releases = held['releases']
    if settings.get('each') == 'commit':
        added, tip = each_commit(repository, settings, held)
        if tip == held.get('read_to'):
            return {'releases': len(releases), 'added': None, 'added_count': 0}
        held['read_to'] = tip
    else:
        newest = newest_release(repository, settings)
        if releases and releases[-1]['commit'] == newest['commit']:
            return {'releases': len(releases), 'added': None, 'added_count': 0}
        previous = releases[-1]['commit'] if releases else None
        added = [{'id': f"{settings.get('id_prefix', '')}{newest['name']}", **newest, 'previous': previous,
                  'subjects': subjects_between(repository, previous, newest['commit'], int(settings.get('most_subjects', 60)))}]
    releases.extend(added)
    held['_generated'] = (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(json.dumps(held, ensure_ascii=False, indent=1) + '\n')
    return {'releases': len(releases), 'added': added[-1]['name'] if added else None, 'added_count': len(added)}
