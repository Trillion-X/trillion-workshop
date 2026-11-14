# Selected Agent

`selected-agent` reads and writes the person's current AI choice and exposes the
generic AI-readiness target used by onboarding and the running agent system.

When no runnable AI is selected, `AgentSelectionSurface` shows `Connect AI`. The
button opens the existing `service-connections.settings` surface with
`surfaceInput.initial_categories: ["AI"]`. Provider names remain catalog DATA;
this package chooses the category, not a fixed provider list.

The package declares five checks covering selection writes, readiness reads,
runnable-provider projection, and the visible selection surface.
