import { execFileSync } from 'node:child_process';

const IMAGE = /^registry\.fly\.io\/[a-z0-9][a-z0-9-]*:release-[a-z0-9]+$/;

export function dockerfileForCurrentImage(image, inspected) {
  if (!IMAGE.test(image)) throw new Error('current container image is not a Fly release image');
  const platform = `${inspected?.Os}/${inspected?.Architecture}`;
  if (!/^linux\/(?:amd64|arm64)$/.test(platform)) throw new Error('current container platform is unsupported');
  const config = inspected?.Config;
  if (!config || !Array.isArray(config.Env) || !Array.isArray(config.Entrypoint)
    || !config.Entrypoint.length || typeof config.WorkingDir !== 'string') {
    throw new Error('current container config is incomplete');
  }
  if (config.Healthcheck || config.OnBuild?.length) throw new Error('current container has build settings that cannot be carried forward');
  const lines = [
    `FROM --platform=${platform} ${image} AS current`,
    `FROM --platform=${platform} scratch`,
    'COPY --from=current / /',
  ];
  for (const entry of config.Env) {
    const split = entry.indexOf('=');
    const name = entry.slice(0, split);
    if (split <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('current container environment is invalid');
    lines.push(`ENV ${name}=${JSON.stringify(entry.slice(split + 1))}`);
  }
  if (config.User) lines.push(`USER ${JSON.stringify(config.User)}`);
  if (config.WorkingDir) lines.push(`WORKDIR ${JSON.stringify(config.WorkingDir)}`);
  if (config.Shell?.length) lines.push(`SHELL ${JSON.stringify(config.Shell)}`);
  if (config.ExposedPorts) lines.push(`EXPOSE ${Object.keys(config.ExposedPorts).join(' ')}`);
  if (config.Volumes) lines.push(`VOLUME ${JSON.stringify(Object.keys(config.Volumes))}`);
  if (config.Labels) {
    for (const [name, value] of Object.entries(config.Labels)) {
      lines.push(`LABEL ${JSON.stringify(name)}=${JSON.stringify(value)}`);
    }
  }
  if (config.StopSignal) lines.push(`STOPSIGNAL ${config.StopSignal}`);
  lines.push(`ENTRYPOINT ${JSON.stringify(config.Entrypoint)}`);
  if (config.Cmd?.length) lines.push(`CMD ${JSON.stringify(config.Cmd)}`);
  return lines;
}

export function inspectCurrentContainerImage(image, run = execFileSync) {
  if (!IMAGE.test(image)) throw new Error('current container image is not a Fly release image');
  // Fly's local builder cannot add a layer after the registry image reaches
  // Docker's depth limit. Pull the exact serving image and copy its filesystem
  // into one scratch layer while carrying its container config forward.
  run('fly', ['auth', 'docker'], { stdio: 'ignore', timeout: 30_000 });
  run('docker', ['pull', image], { stdio: 'ignore', timeout: 120_000 });
  const answer = run('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 30_000 });
  const inspected = JSON.parse(answer)?.[0];
  if (!inspected || inspected.RepoTags?.includes(image) !== true) throw new Error('current container image inspection did not match the requested image');
  return inspected;
}
