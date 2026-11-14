// The host supplies one rule store and path resolver to every shared list.
// The signed-in workspace installs its existing recursive account owner; a
// public viewer has no stored rules and cannot write account filter state.
// Earlier label-backed migration lives with that account owner, not this UI.
import type {NodeRuleStore, NodeRules} from './focus-chain'

const noRules: NodeRules = Object.freeze({})
let defaultNodeRules: NodeRuleStore = {
  read: () => noRules,
  write: () => { throw new Error('Saving account filters is unavailable here.') },
  subscribe: () => () => {},
}
export const nodeRuleStore = () => defaultNodeRules
export const setNodeRuleStore = (store: NodeRuleStore) => { defaultNodeRules = store }
let resolveNodePath: ((nodes: string[], own: string) => string[]) | null = null
export const nodeRulePath = (nodes: string[], own: string) => resolveNodePath?.(nodes, own) ?? ['app', ...nodes, own]
export const setNodeRulePath = (resolve: (nodes: string[], own: string) => string[]) => { resolveNodePath = resolve }
