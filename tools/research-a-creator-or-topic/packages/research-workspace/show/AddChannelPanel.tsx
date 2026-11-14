// package-set://bitfield-studio/packages/research-workspace/show/AddChannelPanel.tsx
//
// "Add a channel" control — paste a source URL/id, press Add, and GATHER pulls that
// source's latest items into the research feed. Grounded in Substack's "Add RSS feed" /
// Podia "Import blog posts" pattern (title + single URL input + primary Add button +
// inline pending/error).
//
// GENERIC + BLIND (L090) + no workflow state-read (see memory
// reference_state_reads_from_workflow_deadlock): the panel forwards an OPAQUE
// `gatherTemplate` (the connector's endpoint/parser/feed, resolved at BUILD time from the
// connector record — the authoring SSOT) and injects the pasted value under the connector's
// own `paramKey`, then dispatches GATHER directly. The panel names no YouTube/RSS specifics —
// ALL source-specific wording (title/placeholder AND every feedback line: empty/error/unconfigured)
// is config DATA with source-agnostic code defaults, so a blog/podcast source is a different
// gatherTemplate/paramKey/copy DATA row through the SAME panel. GATHER is leaf-only (fetch/parse/
// write) so it never deadlocks — unlike a definition that would `find`/`read` the connector
// inside the workflow (that deadlocks the workflow slot).
import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { Button, Card, Inline, Input, Text } from '@/packages/ui';

/** DATA config carried on the placeable-surface `surfaceInput`. All optional — a missing
 *  field disables Add with a configuration message rather than dispatching a broken call. */
export type AddChannelConfig = {
  /** Envelope target that runs GATHER — e.g. "slot::workflow". */
  gatherTarget?: string;
  /** Entity id of the leaf-only GATHER definition (e.g. "action:research-gather"). */
  definitionId?: string;
  /** Opaque connector-derived GATHER input (endpoint_template/parser/feed_address, …),
   *  resolved at build time from the connector record. The panel forwards it verbatim and
   *  never inspects its fields. */
  gatherTemplate?: Record<string, unknown>;
  /** The connector's required-param name the pasted value fills (e.g. its first required_param). */
  paramKey?: string;
  /** Human copy (user language, no internal vocabulary). ALL source-specific wording — "channel",
   *  "videos", "episodes" — lives HERE as DATA, never in the panel code, so the SAME blind panel
   *  serves a YouTube channel, a podcast, or a blog by swapping the surfaceInput copy (L090). The
   *  code-level defaults below are deliberately source-agnostic fallbacks. */
  title?: string;
  placeholder?: string;
  addLabel?: string;
  /** Shown when the gather structurally succeeds but returns zero items (bad link / nothing there). */
  emptyLabel?: string;
  /** Shown when the gather itself fails (dispatch error / ok:false). */
  errorLabel?: string;
  /** Shown when the surface isn't wired with a runnable GATHER config. */
  unconfiguredLabel?: string;
};

function isConfigured(cfg: AddChannelConfig): boolean {
  return Boolean(cfg.gatherTarget && cfg.definitionId && cfg.gatherTemplate && cfg.paramKey);
}

export function AddChannelPanel({ config = {} }: { config?: AddChannelConfig }) {
  const [value, setValue] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const configured = isConfigured(config);
  const trimmed = value.trim();

  async function add() {
    if (!configured) {
      setError(config.unconfiguredLabel ?? 'Adding a source is not set up here yet.');
      return;
    }
    if (trimmed.length === 0) return;
    setPending(true);
    setError(null);
    try {
      // Build GATHER input = the opaque template + the pasted value injected under paramKey.
      // The panel stays blind to what the template contains.
      const input = {
        ...(config.gatherTemplate as Record<string, unknown>),
        params: { [config.paramKey as string]: trimmed },
      };
      const reply = await sendRequestToBitfieldTarget({
        target: config.gatherTarget as string,
        payload: {
          operation: 'execute_definition',
          definition_id: config.definitionId,
          input,
          include_output: true,
        },
      });
      const r = reply as { ok?: boolean; output?: { count?: number }; count?: number } | null;
      const ok = r && typeof r === 'object' ? r.ok !== false : true;
      if (!ok) throw new Error(config.errorLabel ?? 'That could not be added. Check the link and try again.');
      // A gather can SUCCEED structurally yet return zero items (bad link / no videos). `count` is
      // the generic gather-result the blind handler is allowed to read (it never inspects WHAT was
      // gathered). Surface the empty case instead of silently looking like success.
      const count =
        r && typeof r === 'object'
          ? typeof r.output?.count === 'number'
            ? r.output.count
            : typeof r.count === 'number'
              ? r.count
              : undefined
          : undefined;
      if (count === 0) {
        setError(config.emptyLabel ?? 'Nothing found. Check the link and try again.');
        return; // keep the pasted value so the user can fix it
      }
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : config.errorLabel ?? 'That could not be added.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card variant="ghost" padding="md" layout="stack">
      <Text variant="heading-md">{config.title ?? 'Add a source'}</Text>
      <Inline gap="sm" align="center">
        <Input
          value={value}
          placeholder={config.placeholder ?? 'Paste a link or ID'}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <Button
          variant="primary"
          size="md"
          disabled={pending || trimmed.length === 0}
          onClick={() => void add()}
        >
          {config.addLabel ?? 'Add'}
        </Button>
      </Inline>
      {error ? (
        <Text variant="caption" color="error">
          {error}
        </Text>
      ) : null}
    </Card>
  );
}
