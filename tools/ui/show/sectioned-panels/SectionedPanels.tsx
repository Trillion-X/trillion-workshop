import * as React from 'react';
import { Button } from '../coss/ui/button';
import { Kbd } from '../kbd';
import { NamedIcon } from '../icon/NamedIcon';

export interface PanelNavigationItem {
  id: string;
  label: string;
  icon?: string;
  /** An item with an action is not a page: pressing it hands the item to `onAction` and the page stays. */
  action?: string;
}

export interface PanelNavigationGroup {
  id: string;
  label: string;
  items: readonly PanelNavigationItem[];
}

/** The caller's words for the shell's own controls. */
export interface PanelShellWords {
  close: string;
  previous: string;
  next: string;
}

/** Caller-owned pages in grouped navigation. A page mounts on first visit and
 * stays mounted while hidden, so switching pages never discards pending work.
 * With `onClose` the shell is an overlay: a close button with its key sits above
 * the page and Escape (not taken by a control inside) closes it. Under the page,
 * a Previous and a Next card name the pages either side of this one in rail order. */
export function SectionedPanels({ groups, value, onValueChange, renderPanel, label, onClose, onAction, words }: {
  groups: readonly PanelNavigationGroup[];
  value: string;
  onValueChange: (id: string) => void;
  renderPanel: (id: string) => React.ReactNode;
  label: string;
  onClose?: () => void;
  onAction?: (item: PanelNavigationItem) => void;
  words?: PanelShellWords;
}) {
  const items = groups.flatMap(group => group.items);
  const pages = items.filter(item => !item.action);
  const [visited, setVisited] = React.useState(() => new Set([value]));
  React.useEffect(() => {
    setVisited(previous => previous.has(value) ? previous : new Set([...previous, value]));
  }, [value]);
  const at = pages.findIndex(item => item.id === value);
  const before = at > 0 ? pages[at - 1] : null;
  const after = at >= 0 && at < pages.length - 1 ? pages[at + 1] : null;
  const press = (item: PanelNavigationItem) => item.action ? onAction?.(item) : onValueChange(item.id);
  return <div className="sectioned-panels-host" onKeyDown={event => {
    if (onClose && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); }
  }}><div className="sectioned-panels" data-sectioned-panels>
    <nav className="sectioned-panels-navigation" aria-label={label}>
      {groups.map(group => <div key={group.id} className="sectioned-panels-group">
        <p className="sectioned-panels-group-name">{group.label}</p>
        {group.items.map(item => <Button key={item.id} size="sm" variant="ghost"
          className="sectioned-panels-link" aria-current={value === item.id ? 'page' : undefined}
          onClick={() => press(item)}>
          {item.icon ? <NamedIcon name={item.icon} size={16} /> : null}{item.label}
        </Button>)}
      </div>)}
    </nav>
    <div className="sectioned-panels-main">
      {onClose && words ? <div className="sectioned-panels-close">
        <Button size="sm" variant="ghost" aria-label={words.close} onClick={onClose}><NamedIcon name="X" size={16} /><Kbd>Esc</Kbd></Button>
      </div> : null}
      <div className="sectioned-panels-pages">
        {pages.filter(item => visited.has(item.id) || item.id === value).map(item =>
          <section key={item.id} className="sectioned-panels-page" hidden={item.id !== value}
            aria-label={item.label} data-panel-id={item.id}>{renderPanel(item.id)}</section>)}
      </div>
      {words && (before || after) ? <nav className="sectioned-panels-steps" aria-label={label}>
        {before ? <Button variant="outline" className="sectioned-panels-step" data-step="previous" onClick={() => onValueChange(before.id)}>
          <span className="sectioned-panels-step-direction">{words.previous}</span>
          <span className="sectioned-panels-step-name">{before.label}</span>
        </Button> : <span />}
        {after ? <Button variant="outline" className="sectioned-panels-step" data-step="next" onClick={() => onValueChange(after.id)}>
          <span className="sectioned-panels-step-direction">{words.next}</span>
          <span className="sectioned-panels-step-name">{after.label}</span>
        </Button> : <span />}
      </nav> : null}
    </div>
  </div></div>;
}
