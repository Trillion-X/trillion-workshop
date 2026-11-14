import * as React from 'react';
import { Button, Container, NamedIcon } from '../../ui';
import { readStarterLayouts } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/starter-layouts.ts';
import { EmbeddedScreenArrangement } from './EmbeddedScreenArrangement';
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from '../../ui/show/coss/ui/menu';

interface ArrangementControlScope {
  id: string;
  label: string;
  arranging: boolean;
  change: React.Dispatch<React.SetStateAction<boolean>>;
}

interface ArrangementControlsOwner {
  set: (token: symbol, scope: ArrangementControlScope | null) => void;
}

const ArrangementControlsContext = React.createContext<ArrangementControlsOwner | null>(null);

/** One entry point exposes every nested scope; each scope still owns its own arrangement. */
function ArrangementControls({ scopes, words }: {
  scopes: readonly ArrangementControlScope[];
  words: { arrange: string; done: string };
}) {
  const active = scopes.some(scope => scope.arranging);
  if (scopes.length === 1) return <Button size="xs" variant="ghost" aria-pressed={active}
    onClick={() => scopes[0].change(value => !value)}>
    <NamedIcon name={active ? 'Check' : 'LayoutDashboard'} size="xs" />{active ? words.done : words.arrange}
  </Button>;
  return <>
    {active ? <Button size="xs" variant="ghost" onClick={() => scopes.forEach(scope => scope.change(false))}>
      <NamedIcon name="Check" size="xs" />{words.done}
    </Button> : null}
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" aria-label={words.arrange} />}>
        <NamedIcon name="LayoutDashboard" size="xs" />{active ? null : words.arrange}
        <NamedIcon name="ChevronDown" size="xs" />
      </MenuTrigger>
      <MenuPopup align="end">
        {scopes.map(scope => <MenuCheckboxItem key={scope.id} checked={scope.arranging}
          closeOnClick onCheckedChange={value => scope.change(value)}>{scope.label}</MenuCheckboxItem>)}
      </MenuPopup>
    </Menu>
  </>;
}

export interface ArrangedContentPiece {
  id: string;
  label: string;
  content: React.ReactNode;
  /** Keep the saved placement while absent; durable UI state belongs to the caller. */
  visible?: boolean;
}

/** Live caller-owned controls placed by the same engine as whole screens. */
export function ArrangedContents({ pieces, arrangement, keptAt, words, sizing = 'content' }: {
  pieces: readonly ArrangedContentPiece[];
  arrangement: unknown;
  keptAt: string;
  words: { arrange: string; done: string; layout: string };
  sizing?: 'fill' | 'content';
}) {
  const [arranging, setArranging] = React.useState(false);
  const parentControls = React.useContext(ArrangementControlsContext);
  const token = React.useRef(Symbol('arrangement-control-scope')).current;
  const scopeId = React.useId();
  const [nestedScopes, setNestedScopes] = React.useState<ReadonlyMap<symbol, ArrangementControlScope>>(() => new Map());
  const setScope = React.useCallback((key: symbol, scope: ArrangementControlScope | null) => {
    setNestedScopes(previous => {
      if (scope === null && !previous.has(key)) return previous;
      const next = new Map(previous);
      if (scope === null) next.delete(key); else next.set(key, scope);
      return next;
    });
  }, []);
  const ownControls = React.useMemo(() => ({ set: setScope }), [setScope]);
  const controls = parentControls ?? ownControls;
  const scope = React.useMemo(() => ({ id: scopeId, label: words.arrange, arranging, change: setArranging }),
    [scopeId, words.arrange, arranging]);
  React.useLayoutEffect(() => { parentControls?.set(token, scope); }, [parentControls, token, scope]);
  React.useLayoutEffect(() => () => parentControls?.set(token, null), [parentControls, token]);
  const catalogKey = JSON.stringify(pieces.map(({ id, label }) => ({ id, label })));
  const catalog = React.useMemo(() => JSON.parse(catalogKey).map(({ id, label }: { id: string; label: string }) => ({
    payload: { kind: 'placeable-surface', id, label, material_target: `local-content:${id}` },
  })), [catalogKey]);
  // DATA may be assembled afresh by a caller on each read or keystroke.
  // An equal declaration must retain its starter tabs and mounted drafts.
  const arrangementKey = JSON.stringify(arrangement ?? null);
  const starter = React.useMemo(() => readStarterLayouts([{ id: keptAt, name: words.layout, arrangement: JSON.parse(arrangementKey) }])[0] ?? null,
    [keptAt, words.layout, arrangementKey]);
  const localSurfaceContent = React.useMemo(() => ({
    hiddenSurfaceIds: new Set(arranging ? [] : pieces.filter(piece => piece.visible === false || piece.content == null || piece.content === false).map(piece => piece.id)),
    registry: Object.fromEntries(pieces.map(piece => [piece.id, () => (
    <Container data-fits-content data-arranged-content-piece={piece.id} hidden={!arranging && (piece.visible === false || piece.content == null || piece.content === false)}
      layout="vertical" gap="sm" width="full" minWidth="0" minHeight="0" overflow="y-auto">
      {/* Embedded surfaces can mount in another React root. Carry the same control owner explicitly. */}
      <ArrangementControlsContext.Provider value={controls}>{piece.content}</ArrangementControlsContext.Provider>
    </Container>
  )])) }), [pieces, arranging, controls]);
  const host = React.useMemo(() => ({ hostData: {
    tabsOutsideCatalog: 'close' as const, starterLayouts: starter ? [starter] : [],
  } }), [starter]);
  return <Container className="arranged-contents" layout="vertical" gap="sm" flex={sizing === 'fill' ? 1 : undefined} minHeight="0" minWidth="0" data-arranged-contents={keptAt} data-arranging={arranging}>
    {!parentControls ? <Container layout="horizontal" gap="xs" justifyContent="end" data-arrangement-controls>
      <ArrangementControls scopes={[scope, ...nestedScopes.values()]} words={words} />
    </Container> : null}
    <EmbeddedScreenArrangement initialState={{}} starter={starter} sizing={sizing}
      applicationRef={keptAt} layoutEntryInput={{ input: 'layout-state-by-address-label', params: { addressLabel: keptAt } }}
      persistence={{ valueAddressLabel: keptAt }} placeableSurfaceListAddressLabel={`local-content-catalog::${keptAt}`}
      placeableSurfaceListEntry={catalog} localSurfaceContent={localSurfaceContent} host={host}
      chrome={{ header: arranging, navigation: arranging, 'surface.frame': arranging, 'container.frame': arranging, 'container.resize': arranging }} />
  </Container>;
}
