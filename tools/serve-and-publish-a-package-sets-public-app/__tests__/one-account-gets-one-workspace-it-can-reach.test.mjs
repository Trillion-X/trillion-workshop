// Two failures this covers, both of which are silent.
//
// A workspace name that collides puts two customers in ONE log, which looks
// like a working product right up until one of them reads the other's chat.
//
// A ready file read optimistically hands the front door a URL that nothing is
// listening on, or one belonging to a shell that has not finished booting. The
// shell writes that file with `runner_state: "starting"` BEFORE it can answer,
// so "the file exists" is not "the workspace is reachable".
//
// Every non-ASCII case below is written as an escape rather than as a literal
// character. A literal astral glyph made git classify this whole file as
// binary on its first commit attempt, and a test nobody can diff is a test
// nobody reviews.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  workspaceNameForPrincipal,
  workspaceLaunchPlan,
  workspaceStateFromReadyFile,
  openTheWorkspaceForOneAccount,
  openTheWorkspaceForVerifiedSession,
  launcherArguments,
  environmentForOneWorkspace,
} from '../processes/open-the-workspace-for-one-account.mjs';

// `ready_file` is a template the DEPLOY declares, because where the opener puts
// that file is the opener's fact. The shape below is one real layout; the point
// of the tests is that this server reads it rather than knowing it.
const WORKSPACE = {
  root_directory: '/var/lib/bitfield/workspaces',
  ready_file: '{install_root}/runtime-kit/running-now/open-this-bitfield-app/this-bitfield-shell-is-ready.json',
};

// The same word to a reader, two different byte strings to a filesystem:
// precomposed U+00E9, then "e" followed by a combining acute U+0301.
const PRECOMPOSED = 'principal:adé';
const DECOMPOSED = 'principal:adé';

test('two principals never get the same workspace name', () => {
  const principals = [
    'principal:ada',
    'principal:bo',
    'principal:Ada',
    'principal:ada/../bo',
    'principal:ada~3abo',
    'principal:ada:bo',
    'principal:ada bo',
    PRECOMPOSED,
    DECOMPOSED,
    'x'.repeat(200),
    'x'.repeat(201),
    'principal:' + 'y'.repeat(300),
  ];
  const names = principals.map((principal) => workspaceNameForPrincipal(principal));
  assert.equal(new Set(names).size, principals.length,
    'a collision here puts two customers in one log');
});

test('a padded principal is refused instead of selecting another account workspace', () => {
  assert.throws(() => workspaceNameForPrincipal('principal:ada '), /surrounding whitespace/);
  assert.throws(() => workspaceNameForPrincipal(' principal:ada'), /surrounding whitespace/);
  assert.throws(() => workspaceLaunchPlan({ principalRef: 'principal:ada ', workspace: WORKSPACE }),
    /surrounding whitespace/);
});

test('a workspace name is safe to use as a directory component', () => {
  const principals = [
    'principal:ada',
    '../../etc/passwd',
    '.',
    '..',
    'a/b\\c',
    'a b',
    'a\nb',
    'émoji\u{1F600}',
  ];
  for (const principal of principals) {
    const name = workspaceNameForPrincipal(principal);
    assert.match(name, /^[A-Za-z0-9._~-]+$/, `${JSON.stringify(principal)} produced an unsafe name`);
    assert.equal(name.includes('/'), false);
    assert.equal(name.includes('\\'), false);
    assert.notEqual(name, '.');
    assert.notEqual(name, '..');
  }
});

test('dot-only principal refs stay inside their own child directory', () => {
  for (const principalRef of ['.', '..']) {
    const plan = workspaceLaunchPlan({ principalRef, workspace: WORKSPACE });
    assert.ok(plan.installRoot.startsWith(`${WORKSPACE.root_directory}/~2e`));
    assert.notEqual(plan.installRoot, WORKSPACE.root_directory);
    assert.notEqual(plan.installRoot, '/var/lib/bitfield');
  }
});

test('a principal too long to spell out is named by its digest, still uniquely', () => {
  const long = 'principal:' + 'z'.repeat(400);
  const alsoLong = 'principal:' + 'z'.repeat(401);
  assert.match(workspaceNameForPrincipal(long), /^~digest~[0-9a-f]{64}$/);
  assert.notEqual(workspaceNameForPrincipal(long), workspaceNameForPrincipal(alsoLong));
});

test('a plan puts each account under its own root and reuses it on return', () => {
  const ada = workspaceLaunchPlan({ principalRef: 'principal:ada', workspace: WORKSPACE });
  const bo = workspaceLaunchPlan({ principalRef: 'principal:bo', workspace: WORKSPACE });
  assert.notEqual(ada.installRoot, bo.installRoot);
  assert.notEqual(ada.readyFilePath, bo.readyFilePath);
  assert.ok(ada.installRoot.startsWith('/var/lib/bitfield/workspaces/'));
  assert.equal(ada.reuseKey,
    workspaceLaunchPlan({ principalRef: 'principal:ada', workspace: WORKSPACE }).reuseKey);
  assert.notEqual(ada.reuseKey, bo.reuseKey);
});

test('a private volume family and the socket use the same digest child', () => {
  const workspace = {
    ...WORKSPACE,
    root_component: 'principal_digest',
    socket_path: '/run/bitfield-workspaces/{principal_digest}.sock',
  };
  const ada = workspaceLaunchPlan({ principalRef: 'principal:ada', workspace });
  const bo = workspaceLaunchPlan({ principalRef: 'principal:bo', workspace });
  assert.equal(ada.name, ada.principalDigest);
  assert.equal(ada.installRoot, `${WORKSPACE.root_directory}/${ada.principalDigest}`);
  assert.equal(ada.socketPath, `/run/bitfield-workspaces/${ada.principalDigest}.sock`);
  assert.notEqual(ada.installRoot, bo.installRoot);
  assert.throws(() => workspaceLaunchPlan({
    principalRef: 'principal:ada', workspace: { ...workspace, root_component: '../other' },
  }), /root_component/);
});

test('a plan refuses to guess where workspaces live', () => {
  assert.throws(() => workspaceLaunchPlan({ principalRef: 'principal:ada', workspace: {} }),
    /root_directory/);
  assert.throws(() => workspaceLaunchPlan({ principalRef: '', workspace: WORKSPACE }),
    /principal/);
});

test('a plan refuses to guess where the opener puts its ready file', () => {
  // The failure a default would cause is the one that hides best: every
  // customer sits on "Opening your workspace" while this server polls a path
  // nothing ever writes, with every other check green.
  assert.throws(
    () => workspaceLaunchPlan({
      principalRef: 'principal:ada',
      workspace: { root_directory: '/var/lib/bitfield/workspaces' },
    }),
    /ready_file/);
});

test('the ready-file template is filled from the plan, not from a layout in this file', () => {
  const plan = workspaceLaunchPlan({
    principalRef: 'principal:ada',
    workspace: { root_directory: '/srv/w', ready_file: '{install_root}/deep/{name}/ready.json' },
  });
  const name = workspaceNameForPrincipal('principal:ada');
  assert.equal(plan.readyFilePath, `/srv/w/${name}/deep/${name}/ready.json`);
  // An unrecognized placeholder is left verbatim so a typo surfaces as a path
  // nobody wrote, rather than as an empty segment that silently resolves.
  const typo = workspaceLaunchPlan({
    principalRef: 'principal:ada',
    workspace: { root_directory: '/srv/w', ready_file: '{install_root}/{instal_root}/ready.json' },
  });
  assert.ok(typo.readyFilePath.includes('{instal_root}'));
});

// The exact shape the shell publishes, from its own writer: a `status`, and an
// `attachments` object whose contents depend on the transport it bound.
function readyFile(extra = {}) {
  return JSON.stringify({
    schema: 'this-bitfield-shell-is-ready/v1',
    status: 'ready',
    attachments: {
      actual_http_listen_address: '0.0.0.0:8231',
      presentation_entry: 'http://127.0.0.1:8231',
      http_url: 'http://127.0.0.1:8231',
      websocket_url: 'ws://127.0.0.1:8231/ws',
    },
    runner_state: 'ready',
    ...extra,
  });
}

test('a ready workspace reports where it listens', () => {
  assert.deepEqual(workspaceStateFromReadyFile(readyFile()),
    { state: 'ready', shellUrl: 'http://127.0.0.1:8231' });
});

test('a shell that is still booting is opening, not ready and not absent', () => {
  // This is the exact file the shell writes before it can serve anything.
  const booting = JSON.stringify({
    schema: 'this-bitfield-shell-is-ready/v1',
    status: 'starting',
    attachments: { http_url: 'http://127.0.0.1:8231' },
    runner_state: 'starting',
  });
  assert.deepEqual(workspaceStateFromReadyFile(booting), { state: 'opening' });
});

test('absent means nothing has been launched, and only absent means that', () => {
  assert.deepEqual(workspaceStateFromReadyFile(null), { state: 'absent' });
  assert.deepEqual(workspaceStateFromReadyFile(undefined), { state: 'absent' });
  // A half-written or unreadable file is a workspace mid-boot. Calling it
  // absent would launch a second one for the same account.
  for (const contents of ['', '{', '[]', '"ready"', JSON.stringify({ status: 'ready' })]) {
    assert.deepEqual(workspaceStateFromReadyFile(contents), { state: 'opening' },
      `${JSON.stringify(contents)} must not read as absent`);
  }
});

test('a socket-only shell exposes its socket as a distinct transport', () => {
  const socketOnly = JSON.stringify({
    status: 'ready',
    attachments: { forwarding_socket: '/var/run/bitfield/ada.sock' },
  });
  assert.deepEqual(workspaceStateFromReadyFile(socketOnly),
    { state: 'ready', socketPath: '/var/run/bitfield/ada.sock' });
});

test('each account gets a distinct declared socket and a forged ready path is refused', async () => {
  const workspace = { ...WORKSPACE, socket_path: '/run/bitfield/{principal_digest}.sock' };
  const ada = workspaceLaunchPlan({ principalRef: 'principal:ada', workspace });
  const bo = workspaceLaunchPlan({ principalRef: 'principal:bo', workspace });
  assert.notEqual(ada.socketPath, bo.socketPath);
  assert.ok(ada.socketPath.startsWith('/run/bitfield/'));
  assert.throws(() => workspaceLaunchPlan({
    principalRef: 'principal:ada', workspace: { ...workspace, socket_path: '/run/bitfield/shared.sock' },
  }), /principal_digest/);
  const ready = (socket) => JSON.stringify({ status: 'ready', attachments: { forwarding_socket: socket } });
  const opened = await openTheWorkspaceForOneAccount({
    principalRef: 'principal:ada', workspace, launch: async () => { throw new Error('unexpected launch'); },
    readFile: async () => ready(ada.socketPath),
  });
  assert.equal(opened.socket_path, ada.socketPath);
  await assert.rejects(() => openTheWorkspaceForOneAccount({
    principalRef: 'principal:ada', workspace, launch: async () => {},
    readFile: async () => ready(bo.socketPath),
  }), /does not match/);
});

test('a customer-writable root cannot own a front-door socket', () => {
  const workspace = { ...WORKSPACE, socket_path: '/var/lib/bitfield/workspaces/{name}/s' };
  assert.throws(() => workspaceLaunchPlan({ principalRef: 'principal:ada', workspace }),
    /customer-writable root/);
  assert.throws(() => workspaceLaunchPlan({
    principalRef: 'principal:ada',
    workspace: { ...workspace, socket_path: '/var/lib/bitfield/workspaces/{name}/{unknown}' },
  }), /complete absolute path/);
  assert.throws(() => workspaceLaunchPlan({
    principalRef: 'principal:ada',
    workspace: { ...workspace, socket_path: '/var/lib/bitfield/workspaces/' + 'x'.repeat(100) + '/s/{name}' },
  }), /complete absolute path/);
});

test('a non-HTTP url in the ready file is refused rather than proxied', () => {
  for (const value of ['ws://127.0.0.1:8231', 'file:///etc/passwd', 'not a url', '  ']) {
    const contents = JSON.stringify({ status: 'ready', attachments: { http_url: value } });
    assert.equal(workspaceStateFromReadyFile(contents).state, 'opening',
      `${value} must not become an upstream`);
  }
});

test('a second entry is still read when the first is malformed', () => {
  const contents = JSON.stringify({
    status: 'ready',
    attachments: { http_url: 'nonsense', presentation_entry: 'http://127.0.0.1:8231' },
  });
  assert.deepEqual(workspaceStateFromReadyFile(contents),
    { state: 'ready', shellUrl: 'http://127.0.0.1:8231' });
});

test('a cold account is launched once and answered as opening', async () => {
  const launched = [];
  const answer = await openTheWorkspaceForOneAccount({
    principalRef: 'principal:ada',
    workspace: WORKSPACE,
    launch: async (plan) => { launched.push(plan.reuseKey); },
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(answer,
    { opening: true, workspace_name: workspaceNameForPrincipal('principal:ada') });
  assert.deepEqual(launched, ['workspace:' + workspaceNameForPrincipal('principal:ada')]);
});

test('a ready-file access error does not launch a second workspace', async () => {
  let launched = false;
  await assert.rejects(() => openTheWorkspaceForOneAccount({
    principalRef: 'principal:ada',
    workspace: WORKSPACE,
    launch: async () => { launched = true; },
    readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  }), /denied/);
  assert.equal(launched, false);
});

test('the owner derives its workspace from session authority, never request fields', async () => {
  const launched = [];
  let evidence;
  const owner = {
    workspace: WORKSPACE,
    authorizeSession: async (input) => {
      evidence = input;
      return { authorized: true, principal_ref: 'principal:bo' };
    },
    launchConfined: async (plan) => { launched.push(plan); },
    readFile: async () => null,
  };
  const answer = await openTheWorkspaceForVerifiedSession({
    headers: [{ name: 'cookie', value: 'session=bo' }],
    principal_ref: 'principal:ada',
    workspace: { root_directory: '/var/lib/bitfield/workspaces/ada' },
  }, owner);
  assert.deepEqual(evidence, { headers: [{ name: 'cookie', value: 'session=bo' }] });
  assert.equal(answer.principal_ref, 'principal:bo');
  assert.equal(answer.workspace_name, workspaceNameForPrincipal('principal:bo'));
  assert.equal(launched.length, 1);
  assert.equal(launched[0].principalRef, 'principal:bo');
  assert.equal(launched[0].installRoot,
    `/var/lib/bitfield/workspaces/${workspaceNameForPrincipal('principal:bo')}`);
});

test('an unauthorized opener request cannot inspect or launch a workspace', async () => {
  let touched = false;
  await assert.rejects(() => openTheWorkspaceForVerifiedSession({
    headers: [{ name: 'cookie', value: 'forged' }],
    principal_ref: 'principal:ada',
  }, {
    workspace: WORKSPACE,
    authorizeSession: async () => ({ authorized: false }),
    launchConfined: async () => { touched = true; },
    readFile: async () => { touched = true; return null; },
  }), /not authorized/);
  assert.equal(touched, false);
});

test('an authorized but padded principal cannot inspect or launch a workspace', async () => {
  let touched = false;
  await assert.rejects(() => openTheWorkspaceForVerifiedSession({
    headers: [{ name: 'cookie', value: 'session=ada' }],
  }, {
    workspace: WORKSPACE,
    authorizeSession: async () => ({ authorized: true, principal_ref: 'principal:ada ' }),
    launchConfined: async () => { touched = true; },
    readFile: async () => { touched = true; return null; },
  }), /not authorized/);
  assert.equal(touched, false);
});

test('refreshing while it boots does NOT launch a second workspace', async () => {
  const launched = [];
  const booting = JSON.stringify({ status: 'starting', attachments: {} });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await openTheWorkspaceForOneAccount({
      principalRef: 'principal:ada',
      workspace: WORKSPACE,
      launch: async (plan) => { launched.push(plan.reuseKey); },
      readFile: async () => booting,
    });
    assert.equal(answer.opening, true);
  }
  assert.deepEqual(launched, [], 'a refreshing visitor must not start a workspace per refresh');
});

test('a warm account is answered with its shell and is not relaunched', async () => {
  const launched = [];
  const expectedPath = workspaceLaunchPlan({
    principalRef: 'principal:ada',
    workspace: WORKSPACE,
  }).readyFilePath;
  const answer = await openTheWorkspaceForOneAccount({
    principalRef: 'principal:ada',
    workspace: WORKSPACE,
    launch: async (plan) => { launched.push(plan.reuseKey); },
    readFile: async (path) => {
      assert.equal(path, expectedPath);
      return readyFile();
    },
  });
  assert.equal(answer.shell_url, 'http://127.0.0.1:8231');
  assert.deepEqual(launched, []);
});

// Which packages a customer gets is the product lever: one group gets the chat
// substrate, another gets that plus documents, on the same package set and the
// same source. That has to be a repeated launcher argument, and a list encoded
// into one string is not it, because something downstream would have to split
// it and the first name containing the separator installs a different set than
// the one declared.

test('a repeated launcher argument comes from a list the DATA names', () => {
  const argv = launcherArguments(
    [
      '--bitfield-root', '{install_root}',
      { for_each: 'packages', flag: '--package' },
      '--headless',
    ],
    {
      workspace: { packages: ['chat', 'conversations', 'sidebar'] },
      fill: (text) => String(text).replaceAll('{install_root}', '/w/ada'),
    },
  );
  assert.deepEqual(argv, [
    '--bitfield-root', '/w/ada',
    '--package', 'chat',
    '--package', 'conversations',
    '--package', 'sidebar',
    '--headless',
  ]);
});

test('the expansion never learns the word it expands', () => {
  // The same shape has to serve any list a workspace declares, or every future
  // repeatable argument comes back to this file.
  const argv = launcherArguments(
    [{ for_each: 'engines', flag: '--engine' }],
    { workspace: { engines: ['one', 'two'] }, fill: (text) => String(text) },
  );
  assert.deepEqual(argv, ['--engine', 'one', '--engine', 'two']);
});

test('an absent list expands to nothing, because that is a real answer', () => {
  const argv = launcherArguments(
    ['--headless', { for_each: 'packages', flag: '--package' }],
    { workspace: {}, fill: (text) => String(text) },
  );
  assert.deepEqual(argv, ['--headless']);
});

test('a list holding something that is not text is refused, never quietly dropped', () => {
  // Dropping the bad entry installs a DIFFERENT set than the one declared, and
  // every check upstream of it stays green.
  for (const bad of [['chat', 7], ['chat', null], ['chat', ''], ['chat', { name: 'x' }]]) {
    assert.throws(
      () => launcherArguments(
        [{ for_each: 'packages', flag: '--package' }],
        { workspace: { packages: bad }, fill: (text) => String(text) },
      ),
      /not text/,
    );
  }
  assert.throws(
    () => launcherArguments(
      [{ for_each: 'packages', flag: '--package' }],
      { workspace: { packages: 'chat' }, fill: (text) => String(text) },
    ),
    /not a list/,
  );
});

test('a launcher argument that is neither text nor an expansion is refused', () => {
  assert.throws(
    () => launcherArguments([{ flag: '--package' }], { workspace: {}, fill: (t) => String(t) }),
    /neither text nor a for_each/,
  );
});

// The environment a workspace starts with used to be every variable this
// server holds, copied wholesale. That is this server's credentials handed to
// every customer's process. I had called these workspaces unable to leak into
// each other because they are separate processes in separate directories,
// which is true of their FILES and was false here, because a credential is not
// a file.

test('a customer workspace does not inherit this server credentials', () => {
  const env = environmentForOneWorkspace({
    declared: { BITFIELD_ROOT: '/w/ada' },
    parentEnv: {
      PATH: '/usr/bin',
      STRIPE_SECRET_KEY: 'fake_key_do_not_share',
      ACCOUNT_SESSION_SIGNING_KEY: 'also-not',
    },
    fill: (text) => String(text),
  });

  assert.equal(env.STRIPE_SECRET_KEY, undefined);
  assert.equal(env.ACCOUNT_SESSION_SIGNING_KEY, undefined);
  assert.equal(env.BITFIELD_ROOT, '/w/ada');
});

test('a variable reaches a workspace only by being named', () => {
  // Naming it is the act of deciding to share it. Nothing arrives by accident.
  const env = environmentForOneWorkspace({
    declared: {},
    passThrough: ['PATH', 'SHARED_ON_PURPOSE'],
    parentEnv: { PATH: '/usr/bin', SHARED_ON_PURPOSE: 'yes', SECRET: 'no' },
  });

  assert.deepEqual(env, { PATH: '/usr/bin', SHARED_ON_PURPOSE: 'yes' });
});

test('a launcher can still find the program it was told to run', () => {
  // A workspace started with no PATH cannot find its own command, and one that
  // silently fails to start is worse than one that shares a search path.
  const env = environmentForOneWorkspace({ declared: {}, parentEnv: { PATH: '/usr/bin', SECRET: 'no' } });
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

test('a declared value wins over one passed through under the same name', () => {
  const env = environmentForOneWorkspace({
    declared: { PATH: '/opt/bitfield/bin' },
    passThrough: ['PATH'],
    parentEnv: { PATH: '/usr/bin' },
    fill: (text) => String(text),
  });
  assert.equal(env.PATH, '/opt/bitfield/bin');
});

test('the plan carries the whole workspace, so the expansion can reach its lists', () => {
  const plan = workspaceLaunchPlan({
    principalRef: 'principal:ada',
    workspace: { ...WORKSPACE, packages: ['chat'] },
  });
  assert.deepEqual(plan.workspace.packages, ['chat']);
});
