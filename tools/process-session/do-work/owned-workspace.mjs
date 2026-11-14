import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runOwnedProcess } from './run-owned-process.mjs';

// An owner root holds only workspaces this module made. A workspace is
// assembled under a pending name carrying its creator's pid, then renamed to
// `work-*` once its owner record exists, so every other entry is either
// being assembled by a live creator or belongs to nobody.
const PENDING_WORKSPACE = /^\.pending-(\d+)-[A-Za-z0-9_-]+$/;

function processIdentity(pid) {
  const observed = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
  });
  return observed.status === 0 ? observed.stdout.trim() : '';
}

function processGroupIsLive(groupId) {
  if (process.platform === 'win32' || !Number.isSafeInteger(groupId) || groupId <= 0) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function readOwner(workspace) {
  try {
    const workspaceMetadata = lstatSync(workspace);
    const ownerMetadata = lstatSync(join(workspace, '.owner.json'));
    if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()
      || !ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.size > 4096) return null;
    return JSON.parse(readFileSync(join(workspace, '.owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function ownerRecordIsValid(owner) {
  return owner !== null
    && typeof owner === 'object'
    && !Array.isArray(owner)
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.process_identity === 'string'
    && owner.process_identity.length > 0
    && owner.process_identity.length <= 4096
    && typeof owner.token === 'string'
    && owner.token.length > 0
    && owner.token.length <= 128
    && (owner.process_group_id === undefined
      || (Number.isSafeInteger(owner.process_group_id) && owner.process_group_id > 0));
}

function writeOwner(workspace, owner) {
  const candidate = join(workspace, `.owner-${process.pid}-${randomUUID()}.json`);
  writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(candidate, join(workspace, '.owner.json'));
}

function entryHasLiveOwner(ownerRoot, name) {
  const pending = PENDING_WORKSPACE.exec(name);
  if (pending) return processIdentity(Number(pending[1])) !== '';
  const owner = readOwner(join(ownerRoot, name));
  if (!ownerRecordIsValid(owner)) return false;
  const parentIsLive = processIdentity(owner.pid) === owner.process_identity;
  return parentIsLive || processGroupIsLive(owner.process_group_id);
}

// Retires every entry in the owner root that no live owner holds: dead
// workspaces, entries with no owner record (anything placed here by hand or
// by another tool), and leftovers of an interrupted retirement.
export function retireDeadOwnedWorkspaces(ownerRoot) {
  let retired = 0;
  for (const name of readdirSync(ownerRoot)) {
    if (entryHasLiveOwner(ownerRoot, name)) continue;
    const workspace = join(ownerRoot, name);
    const retirement = join(ownerRoot, `.retired-${name}-${process.pid}-${randomUUID()}`);
    try {
      renameSync(workspace, retirement);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) continue;
      throw error;
    }
    rmSync(retirement, { recursive: true, force: true });
    retired += 1;
  }
  return retired;
}

export function createOwnedWorkspace(ownerRoot) {
  mkdirSync(ownerRoot, { recursive: true, mode: 0o700 });
  retireDeadOwnedWorkspaces(ownerRoot);
  const pending = mkdtempSync(join(ownerRoot, `.pending-${process.pid}-`));
  const token = randomUUID();
  const identity = processIdentity(process.pid);
  if (!identity) {
    rmSync(pending, { recursive: true, force: true });
    throw new Error('Could not establish the workspace owner process identity');
  }
  writeOwner(pending, {
    pid: process.pid,
    process_identity: identity,
    token,
  });
  const workspace = join(ownerRoot, `work-${token}`);
  renameSync(pending, workspace);
  let released = false;
  const bindProcessGroup = groupId => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return;
    const owner = readOwner(workspace);
    if (owner?.token !== token) throw new Error('The owned workspace identity changed');
    writeOwner(workspace, { ...owner, process_group_id: groupId });
  };
  const clearProcessGroup = groupId => {
    const owner = readOwner(workspace);
    if (owner?.token !== token || owner.process_group_id !== groupId) return;
    const { process_group_id: _removed, ...withoutGroup } = owner;
    writeOwner(workspace, withoutGroup);
  };
  return {
    path: workspace,
    run(command, args, options = {}) {
      let groupId = null;
      const { onStart, onTermination, ...processOptions } = options;
      return runOwnedProcess(command, args, {
        ...processOptions,
        onStart: started => {
          groupId = started.groupId;
          bindProcessGroup(groupId);
          onStart?.(started);
        },
        onTermination: (termination, ownership) => {
          if (ownership.processGroupStopped) clearProcessGroup(groupId);
          onTermination?.(termination, ownership);
        },
      });
    },
    release() {
      if (released) return true;
      const owner = readOwner(workspace);
      if (!ownerRecordIsValid(owner) || owner.token !== token || processGroupIsLive(owner.process_group_id)) return false;
      rmSync(workspace, { recursive: true, force: true });
      released = true;
      return true;
    },
  };
}
