// PORTED FROM: bitfield-packages/packages/chat/show/input/index.ts @ e99ac5976
// frontends/web/src/packages/chat/show/input/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Barrel export for the chat input composition system. Consumers import from
// this single entry point — no direct subpath imports into this folder.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All public components and types exported here — no direct subpath imports
// 2. Type exports use `export type` for isolatedModules compatibility
//
// =============================================================================

// ChatComposer — full composed input (primary consumer entry point)
export { ChatComposer, chatInputPlaceholderForMode } from './chat-composer';
export type { ChatComposerProps } from './chat-composer';

// SendButton — send/stop toggle
export { SendButton } from './send-button';
export type { SendButtonProps } from './send-button';

// SlashCommandMenu — slash command dropdown
export { SlashCommandMenu } from './slash-command-menu';
export type { SlashCommandMenuProps } from './slash-command-menu';
