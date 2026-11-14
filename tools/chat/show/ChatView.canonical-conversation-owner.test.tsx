// PORTED FROM: bitfield-packages/packages/chat/show/ChatView.canonical-conversation-owner.test.tsx @ e99ac5976
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatView } from './ChatView';

describe('ChatView canonical conversation ownership', () => {
  const RETIRED_CHAT_LEDGER_SYMBOLS = [
    'package::chat::conversation-ledger',
    'package::chat::stored-bytes::decode-addressed-exchange-script',
    'write-addressed-exchange-ledger',
    'readAddressedExchangeLedger',
    'decodeLedgerObservationsRows',
    'ledgerObservationsToAgentMessages',
    'buildLedgerObservationsBundle',
    'ledger-observations',
    'live-chat-observations.json',
    'decode-addressed-exchange-script',
  ] as const;

  it('compiles the production surface with the canonical owner seams', () => {
    expect(typeof ChatView).toBe('function');
  });

  it('uses canonical Conversations writes and projections without a durable Chat ledger', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/chat/show/ChatView.tsx'), 'utf8');
    const readerSource = readFileSync(
      resolve(process.cwd(), 'packages/chat/read-data/use-chat-conversation-records.ts'),
      'utf8',
    );

    expect(source).toContain('writeAddressedExchangeThroughConversations');
    expect(source).toContain('useChatConversationProjections');
    expect(source).not.toContain('write-addressed-exchange-ledger');
    expect(source).not.toContain("useBitfieldData('ledger-observations')");
    expect(readerSource).toContain('useChatConversationProjections');
    expect(readerSource).not.toContain('decodeLedgerObservationsRows');
  });

  it('republishes complete pages with one assistant identity', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/chat/show/ChatView.tsx'), 'utf8');

    expect(source.match(/writeAddressedExchangeThroughConversations\(\{/g) ?? []).toHaveLength(2);
    expect(source).toContain('[...existingCanonicalTurnDrafts, newUserTurnDraft]');
    expect(source).toContain('const assistantTurnRef = `${producerTurn.userTurnId}:reply`');
    expect(source).toContain('id: assistantTurnRef');
    expect(source).toContain('turnId: assistantTurnRef');
    expect(source).toContain('[...producerTurn.canonicalTurnDrafts, assistantTurnDraft]');
    expect(source).toContain('mergeAddressedExchangeTurnDrafts');
    // A returning conversation can still be represented by pending state while
    // its owner projection arrives. Its acknowledged turns must survive send.
    expect(source).toContain('const existingCanonicalTurnDrafts = ledgerConversationId');
    expect(source).toContain('...existingCanonicalTurnDrafts.flatMap');
    expect(source).toContain('timestamp: completedAt');
    expect(source).not.toContain('turns: [');
    expect(source.indexOf('const emptyReplyMessage')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('const emptyReplyMessage'))
      .toBeLessThan(source.indexOf('const assistantTurnRef'));
  });

  it('retires the private Chat ledger from production package DATA', () => {
    const packageData = JSON.parse(readFileSync(
      resolve(process.cwd(), 'packages/chat/things-to-store-and-run.json'),
      'utf8',
    )) as { things: Array<{ type?: string; address?: string; name?: string; source_path?: string; payload?: Record<string, unknown> }> };
    const serialized = JSON.stringify(packageData);
    expect(serialized).not.toContain('package::chat::conversation-ledger');
    expect(serialized).not.toContain('package::chat::stored-bytes::decode-addressed-exchange-script');

    const materialize = packageData.things.find((thing) =>
      thing.address === 'package::chat::workflow-action::materialize-chat-session-window');
    const decodeOne = packageData.things.find((thing) =>
      thing.address === 'package::chat::workflow-action::decode-one-source');
    const observeAcquiredSource = packageData.things.find((thing) =>
      thing.type === 'stored_bytes' && thing.name === 'observe-inline-script');
    const refreshTrigger = packageData.things.find((thing) =>
      thing.address === 'package::chat::trigger-rule::refresh-live-on-tick');
    expect(refreshTrigger?.payload?.is_active).toBe(false);
    expect(materialize).toBeDefined();
    expect(decodeOne).toBeDefined();
    expect(observeAcquiredSource).toMatchObject({
      type: 'stored_bytes',
      name: 'observe-inline-script',
      source_path: 'do-work/process-scripts/observe-inline.py',
    });
    expect(JSON.stringify(decodeOne)).toContain('package::chat::stored-bytes::observe-inline-script');
    expect(JSON.stringify(materialize)).not.toContain('ledger_observations');
    expect(JSON.stringify(decodeOne)).not.toContain('live-chat-observations.json');
  });

  it('mounts the current package entry instead of a duplicate retired Chat bundle', () => {
    const packageData = JSON.parse(readFileSync(
      resolve(process.cwd(), 'packages/chat/things-to-store-and-run.json'),
      'utf8',
    )) as {
      things: Array<{
        address?: string;
        name?: string;
        source_path?: string;
        payload?: { kind?: string; checks?: string[] };
        payload_template?: { replacements?: Array<{ value?: { name?: string } }> };
      }>;
    };
    const extension = packageData.things.find((thing) =>
      thing.address === 'attribute_fact|component:chat|prop:extension:things_to_put_on_screen|type:extension');
    const activeMountNames = (extension?.payload_template?.replacements ?? [])
      .map((replacement) => replacement.value?.name)
      .filter((name): name is string => typeof name === 'string');

    expect(activeMountNames).toContain('entry-bytes-chat');
    expect(packageData.things.some((thing) =>
      thing.name === 'built-show-mount-chat')).toBe(false);
    expect(existsSync(resolve(
      process.cwd(),
      'packages/chat/built-stored-bytes/built-show-mount-chat',
    ))).toBe(false);

    for (const mountName of activeMountNames) {
      const mount = packageData.things.find((thing) =>
        thing.name === mountName && thing.source_path);
      expect(mount?.source_path).toBeDefined();
      const mountBytes = readFileSync(resolve(
        process.cwd(),
        'packages/chat',
        mount?.source_path ?? '',
      ), 'utf8');
      // Package DATA includes the declared check inventory. Historical test
      // filenames are evidence, not executable imports of a retired ledger.
      // Exclude only complete quoted check paths; every runtime symbol and
      // address remains subject to the retirement guard.
      const declaredChecks = packageData.things
        .filter((thing) => thing.payload?.kind === 'package-checks-descriptor')
        .flatMap((thing) => thing.payload?.checks ?? []);
      const executableBytes = declaredChecks.reduce(
        (bytes, check) => bytes.replaceAll(JSON.stringify(check), '""'), mountBytes,
      );
      for (const retiredSymbol of RETIRED_CHAT_LEDGER_SYMBOLS) {
        expect(executableBytes).not.toContain(retiredSymbol);
      }
    }
  });
});
