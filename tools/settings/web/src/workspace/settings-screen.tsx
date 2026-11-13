// Settings composes existing feature screens; each keeps its own reads, writes,
// authority and persistence. Navigation membership and copy are DATA. A page whose row names a `panel` draws that
// panel from the list below instead of a screen (settings-pages.tsx), and one that names a `tool` draws that tool's own
// screen. The shell is an overlay: it closes with Escape or its button, and steps to the pages either side of this one.
// Input `page` opens on that page; with `alone` that page is drawn by itself, without the shell.
import * as React from 'react';
import { SectionedPanels, type PanelNavigationItem } from '../../parts/ui/show/sectioned-panels/SectionedPanels';
import { closeOwnScreen } from '../../parts/ui/show/placeable-surface-intent/open-choices';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { PlaceInPlace, ScreenInPlace } from './screen-in-place';
import { PAGES } from './settings-pages';
import { answerSettingsPageRequests } from './settings-page-request';
import data from './settings-panels.json';

type Item = PanelNavigationItem & { address?: string; panel?: string; tool?: string; href?: string };
const PANELS: Record<string, () => React.ReactElement> = { ...PAGES };

export function mountSettingsScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}) {
  const items: Item[] = data.groups.flatMap(group => group.items);
  const pages = items.filter(item => !item.action);
  const requested = props.surfaceInput?.page;
  const initial = pages.some(item => item.id === requested) ? String(requested) : data.default;
  const leave = (item: Item) => { if (item.action === 'navigate' && item.href) window.location.assign(item.href); };
  // Asked for `alone` (an address's query, `?page=menubar&alone=1`, as the Mac menu bar panel opens its own settings),
  // the page is drawn by itself, with no rail and no shell.
  if (props.surfaceInput?.alone) return mountReactSurface(element, <Page item={pages.find(item => item.id === initial)!} />);
  function Page({ item }: { item: Item }) {
    const Panel = item.panel ? PANELS[item.panel] : undefined;
    if (Panel) return <Panel />;
    if (item.tool) return <PlaceInPlace entry="tool-screen" input={{ tool_id: item.tool }} placeKey={`settings:${item.id}`} className="h-full min-h-0" />;
    return <ScreenInPlace address={item.address!} className="h-full min-h-0" />;
  }
  function Settings() {
    const [page, setPage] = React.useState(initial);
    React.useEffect(() => answerSettingsPageRequests(id => { const found = pages.some(item => item.id === id); if (found) setPage(id); return found; }), []);
    return <SectionedPanels label={data.title} groups={data.groups} value={page} onValueChange={setPage}
      onClose={() => closeOwnScreen(element)} onAction={item => leave(item as Item)} words={data.words}
      renderPanel={id => <Page item={items.find(one => one.id === id)!} />} />;
  }
  return mountReactSurface(element, <Settings />);
}
