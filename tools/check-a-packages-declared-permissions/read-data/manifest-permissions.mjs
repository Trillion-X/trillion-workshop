// src/manifest-permissions.mjs
//
// Purpose
//   A declared permission list is worth something only if the HOST enforces it at the API the package calls. This is the
//   shared owner of that: manifests are validated against permission rows (DATA), a package's entry file is confined to its
//   own folder, and the host API handed to package code is wrapped so each privileged call checks the manifest first.
//
//     checkManifest({ permissions }, settings)      -> { ok, unknown: [ids], needs: [rows] }
//     confinedEntry(root, entry)                    -> the absolute path, or throws when it leaves `root`
//     guardApi(api, manifest, settings)             -> a copy of `api` where every gated call is checked
//
// Non-negotiable invariants
//   1. The permission rows are DATA (src/manifest-permissions.json); a permission nobody wrote a row for is refused, never
//      ignored.
//   2. A call that no row gates is not exposed to package code at all (the guarded API has only gated calls and the ones
//      listed in `open`), so forgetting to list a new privileged call fails closed.
//   3. The guard runs where the call is made (in the host's function), not in the package's code or the screen.
//   4. An entry that resolves outside its package folder (.., absolute, a symlink target elsewhere) is refused.
//
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import data from './manifest-permissions.json' with { type: 'json' };

export const permissionSettings = () => data;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const fail = (message, status = 403) => Object.assign(new Error(message), { status });

export function checkManifest(manifest, settings = data) {
  const asked = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  const known = new Map(settings.permissions.map(row => [row.id, row]));
  const unknown = asked.filter(id => !known.has(id));
  return { ok: unknown.length === 0, unknown, needs: asked.filter(id => known.has(id)).map(id => known.get(id)),
    ...(unknown.length ? { why: fill(settings.words.unknown_permission, { names: unknown.join(', ') }) } : {}) };
}

export function confinedEntry(root, entry, settings = data) {
  const base = resolve(root);
  const target = resolve(base, String(entry));
  const outside = (from, to) => { const rel = relative(from, to); return rel === '' || rel.startsWith('..') || isAbsolute(rel); };
  if (outside(base, target)) throw fail(fill(settings.words.escapes, { entry }));
  // A symlink inside the folder that points elsewhere is outside too; a file not on disk yet keeps only the lexical check.
  try { if (outside(realpathSync(base), realpathSync(target))) throw fail(fill(settings.words.escapes, { entry })); } catch (error) { if (error.status === 403) throw error; }
  return target;
}

/**
 * `api` ({ name: function }) as package code sees it: only the gated calls, each refusing unless the manifest declared the
 * permission whose row gates it; `open` names calls that need no permission.
 */
export function guardApi(api, manifest, { settings = data, open = [] } = {}) {
  const declared = new Set(manifest?.permissions ?? []);
  const guarded = {};
  for (const row of settings.permissions) {
    for (const call of row.calls) {
      if (typeof api[call] !== 'function') continue;
      guarded[call] = (...args) => {
        if (!declared.has(row.id)) throw fail(fill(settings.words.not_granted, { call, permission: row.id }));
        return api[call](...args);
      };
    }
  }
  for (const call of open) if (typeof api[call] === 'function') guarded[call] = api[call];
  return Object.freeze(guarded);
}
