// src/workspace/plain-preview.ts
//
// A line's words as plain text for a conversation's list preview: quote, heading and list markers come off, links keep
// their words, and emphasis marks go. The line itself is shown as it was written, in the conversation.

export const plainPreview = (words: string): string => words
  .split('\n')
  .map(line => line
    .replace(/^\s*(?:>\s*)+|^\s{0,3}#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+[.)]\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`|\*)(.+?)\1/g, '$2')
    .trim())
  .filter(Boolean)
  .join(' ');
