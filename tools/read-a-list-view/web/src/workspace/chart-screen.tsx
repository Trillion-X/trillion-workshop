// src/workspace/chart-screen.tsx
//
// PURPOSE
//   Chart (entry `chart`): any reading or list drawn as one chart that can be placed anywhere and sized like any other
//   piece (Home, a screen's own arrangement, a pane beside Files). The placement's input names where the records are
//   read (`records_url`, any answer that describes itself, the same answers record-set-screen.tsx draws) and which
//   chart (`chart`: the id of one of the answer's own `view.charts`; `placement`: a whole chart placement row). With
//   neither, the answer's first chart is drawn, or a starting chart made from its fields.
//   What the person changes there (which chart, the bucket, how far it drilled) is kept in the placement itself
//   (parts/ui/show/placement-kept, input `kept`), so each placed chart reopens where it was left and an AI can place one
//   already drilled with save_layout.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No reading is named here: what to read comes from the placement, how to chart it from the answer or the input.
//   2. Only what the store answered is drawn; a chart with nothing counted says so in its own words.
//   3. The chart follows the store: a change to the person's records reads it again.
//   4. Every element is a shared part (Container, Dropdown, ChartPlacements, which draws the chart in the same card as
//      Spend's charts); this file writes no markup.
//   5. In a pane that fits its content the chart is drawn at its own height; in a pane given a length it fills it.

import * as React from 'react';
import { ChartPlacements, type ChartKept } from '../../parts/ui/show/chart/ChartPlacement';
import type { ChartPlacement as Placement } from '../../parts/ui/show/chart/chart-types';
import { startingPlacement } from '../../parts/ui/show/chart/chart-from-records';
import { Container } from '../../parts/ui/show/container';
import { Dropdown } from '../../parts/ui/show/dropdown';
import { fieldsFromRows, type RecordSetAnswer } from '../../parts/ui/show/record-views/record-set';
import { ScreenState, mountScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { keepInPlacement, keptIn } from '../../parts/ui/show/placement-kept/placement-kept';
import { readJson } from './api';
import { refusal } from './failure';
import { goTo } from './open-screen';
import { AI_WORK, onStoreChange } from './store-changes';
import type { ScreenProps } from './lazy-screen';

type ChartAnswer = RecordSetAnswer & { view: RecordSetAnswer['view'] & { charts?: Placement[] } };
type Kept = ChartKept & { chart?: string };

const DRAWN_HEIGHT = 240;
const FEWEST = 120;
// The card, heading, controls and legend around the plot, so a filled pane's plot is the pane less these.
const AROUND_PLOT = 150;

/** How tall the plot is: its own height while the pane fits its content, the pane's length less what is around the
 *  plot once the pane is given one. */
function usePlotHeight(host: HTMLElement): number {
  const [height, setHeight] = React.useState(DRAWN_HEIGHT);
  React.useLayoutEffect(() => {
    const pane = host.parentElement;
    if (!pane || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => {
      const given = pane.clientHeight;
      setHeight(given > DRAWN_HEIGHT + AROUND_PLOT ? Math.max(FEWEST, given - AROUND_PLOT) : DRAWN_HEIGHT);
    };
    const watch = new ResizeObserver(measure);
    watch.observe(pane);
    measure();
    return () => watch.disconnect();
  }, [host]);
  return height;
}

function ChartRoot({ host, url, chosen, given, loading, failed, kept: first, keep }: {
  host: HTMLElement; url: string; chosen?: string; given?: Placement; loading: string; failed: string; kept: Kept; keep: (kept: Kept) => void;
}) {
  const [kept, setKept] = React.useState(first);
  const change = (next: Kept) => { setKept(next); keep(next); };
  const height = usePlotHeight(host);
  const loaded = useScreenLoad(url, {
    loading: { label: loading, layout: 'rows' },
    read: () => readJson<ChartAnswer>(url),
    empty: () => null,
    failed: refusal(failed),
  });
  const { reload } = loaded;
  React.useEffect(() => onStoreChange(() => reload(), AI_WORK), [reload]);
  const answer = loaded.value;
  const fields = React.useMemo(() => (answer ? fieldsFromRows(answer.view.fields ?? [], answer) : []), [answer]);
  const readField = React.useCallback((record: unknown, id: string) => {
    const field = fields.find(one => one.id === id);
    if (!field) return (record as Record<string, unknown> | null)?.[id];
    return field.factValue ? field.factValue(record) : field.read ? field.read(record) : (record as Record<string, unknown> | null)?.[id];
  }, [fields]);
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const offered: Placement[] = [...(given ? [given] : []), ...(answer.view.charts ?? [])];
  if (!offered.length) offered.push({ ...startingPlacement(fields, answer.view.label ?? 'Chart'), title: answer.view.label });
  const placement = offered.find(one => one.id === (kept.chart ?? chosen)) ?? offered[0];
  const ownRecords = !placement.records_path;
  const choose = offered.length > 1 ? (
    <Dropdown size="sm" label="Chart" value={placement.id}
      items={offered.map(one => ({ value: one.id, label: one.title ?? one.id }))}
      onValueChange={id => change({ chart: id })} />
  ) : null;
  return (
    <Container layout="vertical" padding="sm" minHeight="0">
      <ChartPlacements
        key={placement.id}
        placements={[{ ...placement, wide: true }]}
        records={ownRecords ? answer.items : []}
        answer={answer}
        readField={ownRecords ? readField : undefined}
        height={height}
        controls={choose}
        kept={{ bucket: kept.bucket, drills: kept.drills }}
        onKeep={next => change({ ...next, ...(kept.chart ? { chart: kept.chart } : {}) })}
      />
    </Container>
  );
}

export function mountChartScreen(element: HTMLElement, props: ScreenProps): () => void {
  const input = props.surfaceInput ?? {};
  const url = typeof input.records_url === 'string' ? input.records_url : '';
  if (!url) {
    mountScreenState(element, { status: 'empty', icon: 'ChartColumn', title: 'No reading was named', description: 'Place a chart of a list or a reading, such as Spend.', action: goTo('Open Spend', 'trillion.spend') });
    return () => element.replaceChildren();
  }
  // A chart draws at its own height, so a pane that fits its content takes the chart's height.
  element.setAttribute('data-fits-content', '');
  const given = input.placement && typeof input.placement === 'object' && typeof (input.placement as Placement).mark === 'string' ? input.placement as Placement : undefined;
  const chosen = typeof input.chart === 'string' ? input.chart : undefined;
  const loading = typeof input.loading === 'string' ? input.loading : 'Reading';
  const failed = typeof input.failed === 'string' ? input.failed : 'This chart could not be read';
  const keep = (kept: Kept) => keepInPlacement(element, kept as Record<string, unknown>);
  return mountReactSurface(element, (
    <ChartRoot host={element} url={url} chosen={chosen} given={given} loading={loading} failed={failed} kept={keptIn(input) as Kept} keep={keep} />
  ));
}
