// bitfield/packages/agent-work-gate-compliance/index.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Composition Engine entry point for agent work gate compliance analytics.
// Renders the existing owner-fed gate analytics surface directly.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Default export is a CE-compatible function component
// 2. Reads remain owned by AgentWorkGateCompliancePanel and its addressed feed decoder
// 3. This package does not invent a second gate analytics data owner
//
// =============================================================================

import React from 'react'
import { AgentWorkGateCompliancePanel } from './show/AgentWorkGateCompliancePanel'

export default function AgentWorkGateCompliance() {
  return <AgentWorkGateCompliancePanel />
}
