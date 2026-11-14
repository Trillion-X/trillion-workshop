// Both signed-in entry points install the same account owner before any list
// draws, including lists shown alone in a chat card. Public shares never load it.
import { keepRecordViewPreferencesIn } from '../../parts/ui/show/record-views/record-view-preferences'
import { useWorkspacePreference, writeWorkspacePreference, sendRequestToBitfieldTarget } from './records'

keepRecordViewPreferencesIn({ use: useWorkspacePreference, write: writeWorkspacePreference })

// A chat may draw one list without mounting the whole workspace. It receives
// the same recursive account filter owner, including the legacy migration.
import { setNodeRuleStore, setNodeRulePath } from '../../parts/ui/show/rule-filter/focus-records'
import { APP_FOCUS_NODE, focusPathFor, loadScopeFocus, scopeFocus } from './scope-focus'
const loadFilters = () => { void loadScopeFocus().catch(() => {}) }
setNodeRuleStore({
  read: () => { loadFilters(); return scopeFocus.read() },
  write: scopeFocus.write,
  subscribe: listener => { loadFilters(); return scopeFocus.subscribe(listener) },
})
setNodeRulePath((nodes, own) => nodes.length ? [...focusPathFor(nodes[0], own).slice(0, -1), ...nodes.slice(1), own] : [APP_FOCUS_NODE, own])

import { setFileContentClassificationOwner } from '../../parts/file-content-renderer/show/classify-file-content'
setFileContentClassificationOwner(sendRequestToBitfieldTarget)

import { setVisualLayerArtifactReader } from '../../parts/screen-arrangement/show/visual-layer-subject-resolver'
import { readCanonicalArtifactObjectUrl } from '../../parts/screen-arrangement/do-work/read-canonical-artifact-object-url'
setVisualLayerArtifactReader(readCanonicalArtifactObjectUrl)
