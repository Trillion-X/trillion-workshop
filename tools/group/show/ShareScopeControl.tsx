// Share-scope picker: a Dropdown to choose WHAT to share from a board.

import { Button, Dropdown, Icon } from '../../ui';
import { ChevronDown } from 'lucide-react';
import { DEFAULT_SCOPE_RESOLVERS } from 'trillion-workshop/tools/organize-the-sidebar/read-data/share-scope.ts';
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of';

function titleCase(key: string): string {
  if (key.length === 0) return key;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function shareScopeItems(
  resolvers: Readonly<Record<string, unknown>> = DEFAULT_SCOPE_RESOLVERS,
): Array<{ value: string; label: string; icon?: string }> {
  return Object.keys(resolvers).map((key) => ({
    value: key,
    label: titleCase(key),
  }));
}

export interface ShareScopeControlProps {
  readonly onShare: (kind: string) => void;
  readonly resolvers?: Readonly<Record<string, unknown>>;
  readonly disabled?: boolean;
}

export function ShareScopeControl(props: ShareScopeControlProps): JSX.Element | null {
  useShowChange();
  if (!controlShown('sharing')) return null;
  return (
    <Dropdown
      items={shareScopeItems(props.resolvers)}
      value=""
      onValueChange={(kind) => props.onShare(kind)}
      align="start"
      aria-label="Share scope"
      customTrigger={
        <Button variant="ghost" size="sm" aria-label="Share scope" disabled={props.disabled}>
          Share
          <Icon icon={ChevronDown} size="sm" />
        </Button>
      }
    />
  );
}
