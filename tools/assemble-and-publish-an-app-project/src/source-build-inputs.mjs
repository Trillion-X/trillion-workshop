// The source repository's build lock names every sibling repository needed to recreate its output.
// This describes source identity; it does not grant bindings or execute the source in Sites.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MOUNT = /^[a-z][a-z0-9-]{0,63}$/;
const PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

export function checkedSourceBuildInputs(value) {
  if (!object(value) || Object.keys(value).some(key => !['schema', 'inputs'].includes(key)) ||
      value.schema !== 'trillion.source-build-inputs/v1' || !Array.isArray(value.inputs) ||
      !value.inputs.length || value.inputs.length > 8) throw new Error('The source build lock is invalid.');
  const mounts = new Set();
  const repositories = new Set();
  const inputs = value.inputs.map(input => {
    if (!object(input) || Object.keys(input).some(key => !['repository', 'commit', 'mount', 'paths'].includes(key)) ||
        !REPOSITORY.test(input.repository ?? '') || !SHA.test(input.commit ?? '') ||
        !MOUNT.test(input.mount ?? '') || mounts.has(input.mount) ||
        repositories.has(input.repository.toLowerCase()) || !Array.isArray(input.paths) ||
        !input.paths.length || input.paths.length > 100 ||
        input.paths.some(path => typeof path !== 'string' || !PATH.test(path) ||
          path.split('/').some(part => part === '.' || part === '..'))) {
      throw new Error('The source build lock has an invalid repository, commit, mount or path.');
    }
    mounts.add(input.mount);
    repositories.add(input.repository.toLowerCase());
    return { repository: input.repository, commit: input.commit, mount: input.mount, paths: [...input.paths] };
  });
  return { schema: value.schema, inputs };
}
