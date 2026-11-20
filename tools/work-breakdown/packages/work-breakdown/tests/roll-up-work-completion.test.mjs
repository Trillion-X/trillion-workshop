// Proof for roll-up-work-completion.mjs.
//
// The tests that carry the weight are the refusals and the unverified case. A
// roll-up that reports a cheerful percentage for any tree it is handed is
// indistinguishable from one that never looked, so the first thing proven here
// is what it turns away.

import { tempFolder } from '../../../../../test-helpers/temp-folder.mjs';
import {test} from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm } from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  DEFAULT_STATES,
  measure,
  renderChecklist,
  shareFinished,
  load,
  run,
} from '../do-work/roll-up-work-completion.mjs'

const withTree = async (document, body) => {
  const directory = tempFolder(join(tmpdir(), 'work-breakdown-'))
  const path = join(directory, 'tree.json')
  await writeFile(path, JSON.stringify(document), 'utf8')
  try {
    return await body(path)
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
}

const leaf = (id, extra = {}) => ({id, title: id, ...extra})

test('a tree that writes its own completion down is refused, not quietly corrected', async () => {
  await withTree(
    {title: 'T', children: [{id: 'a', title: 'a', percent: 80, children: [leaf('a1')]}]},
    async path => {
      await assert.rejects(() => load(path), /cannot also be written down/)
      await assert.rejects(() => load(path), /a\.percent/)
    },
  )
})

test('every authored completion spelling is caught, not just the one word', async () => {
  for (const field of ['completion', 'percent', 'percentage', 'progress', 'done_count']) {
    await withTree({title: 'T', children: [leaf('a', {[field]: 1})]}, async path => {
      await assert.rejects(() => load(path), new RegExp(`a\\.${field}`))
    })
  }
})

test('a leaf in a state the tree never declared is refused rather than guessed at', async () => {
  await withTree({title: 'T', children: [leaf('a', {state: 'nearly'})]}, async path => {
    await assert.rejects(() => load(path), /never declared/)
    await assert.rejects(() => load(path), /a=nearly/)
  })
})

test('done with nothing to point at is counted apart and never as finished', () => {
  const totals = measure(leaf('a', {state: 'done'}), DEFAULT_STATES)
  assert.equal(totals.finished, 0, 'an unverified claim must not count as finished')
  assert.equal(totals.claimed, 1)
  assert.equal(totals.claimed_without_verification, true)
})

test('done with verification counts, and the two cases give different shares', () => {
  const claimed = measure(
    {id: 'r', children: [leaf('a', {state: 'done'}), leaf('b', {state: 'open'})]},
    DEFAULT_STATES,
  )
  const proven = measure(
    {
      id: 'r',
      children: [leaf('a', {state: 'done', verified_by: 'screenshot.png'}), leaf('b', {state: 'open'})],
    },
    DEFAULT_STATES,
  )
  assert.equal(shareFinished(claimed), 0)
  assert.equal(shareFinished(proven), 50)
  assert.notEqual(shareFinished(claimed), shareFinished(proven))
})

test('a parent cannot be marked done to make its branch look finished', () => {
  const totals = measure(
    {id: 'p', state: 'done', verified_by: 'x', children: [leaf('a'), leaf('b')]},
    DEFAULT_STATES,
  )
  assert.equal(totals.finished, 0)
  assert.equal(totals.leaves, 2)
})

test('nesting is unbounded and a deep leaf still reaches the top-level count', () => {
  let node = leaf('deepest', {state: 'done', verified_by: 'proof'})
  for (let depth = 0; depth < 12; depth += 1) node = {id: `d${depth}`, children: [node]}
  const totals = measure(node, DEFAULT_STATES)
  assert.equal(totals.leaves, 1)
  assert.equal(totals.finished, 1)
  assert.equal(shareFinished(totals), 100)
})

test('a state map is DATA, so a tree can name states this file has never heard of', () => {
  const states = {
    shipped: {label: 'shipped', counts_as_finished: true, needs_verification: false},
    thinking: {label: 'thinking', counts_as_finished: false, needs_verification: false},
  }
  const totals = measure(
    {id: 'r', children: [leaf('a', {state: 'shipped'}), leaf('b', {state: 'thinking'})]},
    states,
  )
  assert.equal(totals.finished, 1, 'a state that needs no verification counts on its own')
  assert.equal(totals.claimed, 0)
})

test('the checklist marks the three outcomes differently', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [
        leaf('proven', {state: 'done', verified_by: 'shot.png'}),
        leaf('claimed', {state: 'done'}),
        leaf('open', {state: 'open'}),
      ],
    },
    DEFAULT_STATES,
  )
  const lines = checklist.split('\n')
  assert.match(lines[0], /^- \[x\] proven/)
  assert.match(lines[1], /^- \[~\] claimed/)
  assert.match(lines[2], /^- \[ \] open/)
  assert.match(lines[0], /proof: shot\.png/)
})

test('the checklist carries provenance and the wall, because both are why an item sits there', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [
        leaf('a', {state: 'blocked', blocked_by: 'bash is not a declared verb', said: [{session: 's1', ordinal: 7}]}),
      ],
    },
    DEFAULT_STATES,
  )
  assert.match(checklist, /wall: bash is not a declared verb/)
  assert.match(checklist, /asked: s1#7/)
})

test('depth limits what is rendered without changing what is counted', () => {
  const tree = {
    id: 'r',
    children: [{id: 'a', title: 'a', children: [leaf('a1', {state: 'done', verified_by: 'p'})]}],
  }
  const shallow = renderChecklist(tree, DEFAULT_STATES, 0)
  assert.ok(!shallow.includes('a1'), 'a depth limit must actually cut the render')
  assert.match(shallow, /1\/1, 100%/, 'the count still comes from the whole subtree')
})

test('an empty parent reports no share rather than a made-up hundred per cent', () => {
  assert.equal(shareFinished(measure({id: 'r', children: []}, DEFAULT_STATES)), null)
})

test('the report names every unverified id, so a claim cannot hide inside an average', async () => {
  await withTree(
    {
      title: 'T',
      children: [
        leaf('honest', {state: 'done', verified_by: 'proof'}),
        leaf('hopeful', {state: 'done'}),
        leaf('stuck', {state: 'blocked', blocked_by: 'no key'}),
      ],
    },
    async path => {
      const result = await run(['--tree', path])
      assert.deepEqual(result.unverified_ids, ['hopeful'])
      assert.deepEqual(result.blocked_items, [{id: 'stuck', wall: 'no key'}])
      assert.equal(result.finished, 1)
      assert.equal(result.leaves, 3)
    },
  )
})

test('--only reports one branch, and an id nobody has is refused rather than answered', async () => {
  await withTree(
    {
      title: 'T',
      children: [
        {id: 'x', title: 'x', children: [leaf('x1', {state: 'done', verified_by: 'p'})]},
        {id: 'y', title: 'y', children: [leaf('y1')]},
      ],
    },
    async path => {
      const only = await run(['--tree', path, '--only', 'x'])
      assert.equal(only.leaves, 1)
      assert.equal(only.share_finished, 100)
      await assert.rejects(() => run(['--tree', path, '--only', 'nope']), /no item in this tree/)
    },
  )
})

test('no tree named at all is a usage error, never an empty pass', async () => {
  await assert.rejects(() => run([]), /usage:/)
})

test('the checklist can be written out with its heading, ready for a section placer', async () => {
  await withTree(
    {
      title: 'A body of work',
      children: [
        {id: 'g', title: 'a group', children: [leaf('a', {state: 'done', verified_by: 'p'}), leaf('b')]},
      ],
    },
    async path => {
      const directory = tempFolder(join(tmpdir(), 'work-breakdown-out-'))
      const out = join(directory, 'section.md')
      try {
        const result = await run(['--tree', path, '--as', 'checklist', '--out', out, '--heading', '## Where this stands'])
        assert.equal(result.wrote, out)
        const written = await readFile(out, 'utf8')
        assert.match(written, /^## Where this stands\n/)
        assert.match(written, /1 of 2 finished, 50%/)
        assert.match(written, /- \[x\] a/)
        assert.match(written, /- \[ \] b/)
      } finally {
        await rm(directory, {recursive: true, force: true})
      }
    },
  )
})

test('the written summary names the claims and the walls, not only the share', async () => {
  await withTree(
    {
      title: 'T',
      children: [
        leaf('hopeful', {state: 'done'}),
        leaf('stuck', {state: 'blocked', blocked_by: 'no key'}),
      ],
    },
    async path => {
      const directory = tempFolder(join(tmpdir(), 'work-breakdown-out-'))
      const out = join(directory, 'section.md')
      try {
        const result = await run(['--tree', path, '--as', 'checklist', '--out', out])
        assert.match(result.summary, /said done with nothing to point at/)
        assert.match(result.summary, /1 blocked/)
        assert.match(await readFile(out, 'utf8'), /^## T\n/)
      } finally {
        await rm(directory, {recursive: true, force: true})
      }
    },
  )
})

test('a later decision that governs how an item is built is shown on its line', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [leaf('a', {through: 'the shared table, not a second filter form'})],
    },
    DEFAULT_STATES,
  )
  assert.match(checklist, /build it through: the shared table, not a second filter form/)
})

test('routing set on a branch reaches every leaf under it, at any depth', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [
        {
          id: 'branch',
          title: 'branch',
          through: 'the new substrate',
          children: [{id: 'mid', title: 'mid', children: [leaf('deep')]}],
        },
      ],
    },
    DEFAULT_STATES,
  )
  assert.match(checklist, /- \[ \] deep.*build it through: the new substrate/)
})

test('a leaf with its own routing keeps it, so a branch rule never overwrites a specific one', () => {
  const checklist = renderChecklist(
    {
      id: 'r',
      children: [
        {
          id: 'branch',
          title: 'branch',
          through: 'the branch rule',
          children: [leaf('special', {through: 'its own rule'})],
        },
      ],
    },
    DEFAULT_STATES,
  )
  assert.match(checklist, /- \[ \] special.*build it through: its own rule/)
  assert.ok(!/special.*the branch rule/.test(checklist), 'the branch rule must not also appear on the leaf')
})

test('open items nobody has decided how to build are named, and finished ones are not', async () => {
  await withTree(
    {
      title: 'T',
      children: [
        {
          id: 'governed',
          title: 'governed',
          through: 'the new way',
          children: [leaf('a'), leaf('b')],
        },
        leaf('nobody-decided'),
        leaf('already-built', {state: 'done', verified_by: 'proof'}),
      ],
    },
    async path => {
      const result = await run(['--tree', path])
      assert.deepEqual(result.unrouted_open_ids, ['nobody-decided'])
      assert.equal(result.routed_leaves, 2)
      assert.deepEqual(result.routings, [{through: 'the new way', leaves: 2}])
    },
  )
})

test('routings are reported most-used first, so the governing decision leads', async () => {
  await withTree(
    {
      title: 'T',
      children: [
        {id: 'big', title: 'big', through: 'decision X', children: [leaf('a'), leaf('b'), leaf('c')]},
        {id: 'small', title: 'small', through: 'decision Y', children: [leaf('d')]},
      ],
    },
    async path => {
      const result = await run(['--tree', path])
      assert.deepEqual(result.routings, [
        {through: 'decision X', leaves: 3},
        {through: 'decision Y', leaves: 1},
      ])
    },
  )
})

test('without --out nothing is written, so reporting stays a read', async () => {
  await withTree({title: 'T', children: [leaf('a')]}, async path => {
    const result = await run(['--tree', path, '--as', 'checklist'])
    assert.equal(result.wrote, null)
  })
})
