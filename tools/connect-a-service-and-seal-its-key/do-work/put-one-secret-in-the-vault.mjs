#!/usr/bin/env node
// packages/credentials-vault/do-work/put-one-secret-in-the-vault.mjs
//
// The one way a secret gets INTO the vault from this machine.
//
// Why it exists
//   There has been one reader beside this package for a long time, and no
//   writer. So every arriving credential had nowhere to go that was not a
//   file, and a credential with nowhere to go ends up in a file every single
//   time. A store you can only read from is a store people route around.
//
// Why it takes a PATH and never a value
//   The secret is read from a file the caller already has, so the value never
//   appears in argv, where every process on the machine can see it, and never
//   in a shell history, a log line, or this session's transcript. The path is
//   the only thing that travels.
//
// Why it reads back
//   Writing and believing you wrote are different things. The vault command
//   reads the secret back after sealing it and compares lengths, so "stored"
//   means stored. It compares length and not the value itself, because printing
//   the value to prove it arrived would undo the point of the whole exercise.
//
// Where it writes
//   The vault the reader asks (`credentialHome()` in ../read-data/): the native
//   engine's held-values vault, through its `held-values put` command.
//
// Usage
//   put-one-secret-in-the-vault.mjs --name <holder> --from-file <path> [--insert-only]

import {askTheVault} from '../read-data/ask-the-vault-for-one-secret.mjs'

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    if (argv[index] === '--insert-only') {
      values.set('insert-only', true)
      continue
    }
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  if (!values.get('name') || !values.get('from-file')) {
    throw new Error('usage: put-one-secret-in-the-vault.mjs --name <holder> --from-file <path> [--insert-only]')
  }
  return {name: values.get('name'), fromFile: values.get('from-file'), insertOnly: values.get('insert-only') === true}
}

export async function main(argv) {
  const {name, fromFile, insertOnly} = readArguments(argv)
  const {out} = askTheVault(['put', name, fromFile, ...(insertOnly ? ['--insert-only'] : [])])
  const answer = JSON.parse(out)
  // Named so a caller can wire it without ever seeing the value.
  process.stdout.write(`${JSON.stringify({...answer, use_it_by_name: name}, null, 2)}\n`)
  return answer.saved === name || answer.kept === true ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    },
  )
}
