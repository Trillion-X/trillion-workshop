import { assembleEditableAppProject, appProjectForTarget } from '../app-project-assembly.mjs';

const targets = ['web', 'ios', 'macos'];

export function sourceProjectKey(name, sources) {
  const base = String(name || 'source').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'source';
  const used = new Set(sources.map(source => source.key));
  let key = `${base}-source`;
  for (let suffix = 2; used.has(key); suffix += 1) key = `${base.slice(0, 61 - String(suffix).length)}-${suffix}`;
  return key;
}

export function addCheckedSource(assembly, key, project) {
  if (!assembly || assembly.sources.some(source => source.key === key)) throw new Error('This source is already in the app.');
  return assembleEditableAppProject({ id: assembly.id, name: assembly.name,
    sources: [...assembly.sources.map(({ key: sourceKey, project: sourceProject, targets: sourceTargets }) => ({
      key: sourceKey, project: sourceProject, targets: sourceTargets,
    })), { key, project, targets: ['web'] }] });
}

export function changeSourceTargets(assembly, key, nextTargets) {
  if (!Array.isArray(nextTargets) || !nextTargets.length || nextTargets.some(target => !targets.includes(target)) || new Set(nextTargets).size !== nextTargets.length) {
    throw new Error('Choose at least one supported app target.');
  }
  const source = assembly?.sources.find(row => row.key === key);
  if (!source) throw new Error('This source is no longer in the app.');
  if (key === 'site' && !nextTargets.includes('web')) {
    throw new Error('The installed site must stay connected to the web target.');
  }
  return assembleEditableAppProject({ id: assembly.id, name: assembly.name,
    sources: assembly.sources.map(row => ({ key: row.key, project: row.project, targets: row.key === key ? nextTargets : row.targets })) });
}

export function removeCheckedSource(assembly, key) {
  if (key === 'site') throw new Error('The installed web source cannot be removed.');
  if (!assembly?.sources.some(source => source.key === key)) throw new Error('This source is no longer in the app.');
  return assembleEditableAppProject({ id: assembly.id, name: assembly.name,
    sources: assembly.sources.filter(source => source.key !== key).map(({ key: sourceKey, project, targets: sourceTargets }) => ({
      key: sourceKey, project, targets: sourceTargets,
    })) });
}

export function checkedProjectForTarget(assembly, target) {
  // The endpoint also returns editor and uploaded file data. Only the saved
  // project contract belongs in the target selector.
  const project = Object.fromEntries(Object.entries(assembly)
    .filter(([key]) => !['source_files', 'source_files_revision', 'editor_files'].includes(key)));
  return appProjectForTarget(project, target);
}
