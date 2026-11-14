// WHERE A FILE NAMED BY A PAGE DESCRIPTION ACTUALLY IS.
//
// A page description names files: `fallback_body_file`, `shell_css_file`, `chrome_css_file`,
// `fallback_pages_file`, and whatever is named next, since the `_file` suffix is the convention and
// not a list anybody maintains.
//
// The rule has ONE owner because it has THREE readers, and they must agree or each one lies about
// the others. The server reads these paths to answer a request; the build reads them to warn about a
// file that never got copied; the suite reads them to check a set is deployable. Two of those three
// once did `existsSync(named)` raw, which is right only while every path is absolute.
//
// THE RULE. An absolute path is passed through untouched, because a deploy that means an absolute
// path should get one. Anything else is relative to the folder the DESCRIPTION is in, which is the
// folder a container `COPY` puts its files in and the folder a package set keeps them in.
//
// WHY NOT ABSOLUTE EVERYWHERE, which is what both installed descriptions did until 2026-09-10. They
// named their files under `/Users/<a person>/.bitfield/runtime-kit/package-sets/<set>/deploy/`, the
// path whoever wrote them happened to have. A description TRAVELS: copied into an image, published
// as a record, kept as a last-good copy on a volume. An absolute host path survives none of those,
// and it fails quietly, because a missing stylesheet is one log line on a page that still answers
// 200, so an unstyled page is the whole visible symptom.
//
// WHY NOT THE PROCESS WORKING DIRECTORY, which is what `resolve()` uses when nothing is passed. It
// is whatever directory somebody happened to start the server in, so on a developer's machine it is
// usually a folder that does contain the file. That makes the wrong implementation pass locally and
// serve the wrong bytes in a container, which is the failure with no error message at all.

import { dirname, isAbsolute, resolve } from 'node:path';

// `named` is the value the description gave. `descriptionFile` is the file that description was
// deployed as, and an empty one means the caller has no base, which is reported rather than guessed:
// the caller decides whether that is a log line or a failed check.
export function describedFileAt(named, descriptionFile) {
  if (typeof named !== 'string' || !named) return { path: '', reason: 'no file was named' };
  if (isAbsolute(named)) return { path: named, reason: '' };
  if (!descriptionFile) {
    return {
      path: '',
      reason: `${named} is relative and nothing says what it is relative to`
        + ' (BITFIELD_PUBLIC_PAGE_DESCRIPTION_FILE, whose folder is that base, is unset)',
    };
  }
  return { path: resolve(dirname(descriptionFile), named), reason: '' };
}

// Every `_file` key of one page, resolved. The `_file` suffix IS the rule: a description that names
// a fifth kind of file gets it resolved the day it is named, with no edit here. Keys that are not
// paths (`chrome_css_export` and its siblings) are excluded by the same rule rather than by a list.
export function describedFilesResolvedIn(page, descriptionFile, reportProblem) {
  const resolved = { ...page };
  for (const [key, named] of Object.entries(page ?? {})) {
    if (!key.endsWith('_file') || typeof named !== 'string' || !named) continue;
    const { path, reason } = describedFileAt(named, descriptionFile);
    if (path) resolved[key] = path;
    else reportProblem?.(`${key}: ${reason}`);
  }
  return resolved;
}
