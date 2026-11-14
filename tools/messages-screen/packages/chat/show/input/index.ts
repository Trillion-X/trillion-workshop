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
export { ChatComposer, chatInputPlaceholderForMode } from '@/packages/chat/show/input/chat-composer';
export type { ChatComposerProps } from '@/packages/chat/show/input/chat-composer';

// SendButton — send/stop toggle
export { SendButton } from '@/packages/chat/show/input/send-button';
export type { SendButtonProps } from '@/packages/chat/show/input/send-button';

// SlashCommandMenu — slash command dropdown
export { SlashCommandMenu } from '@/packages/chat/show/input/slash-command-menu';
export type { SlashCommandMenuProps } from '@/packages/chat/show/input/slash-command-menu';
