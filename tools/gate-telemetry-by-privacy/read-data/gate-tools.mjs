// tools/gate-telemetry-by-privacy/read-data/gate-tools.mjs
//
// The row over the telemetry gate (telemetry-gate.mjs, moved unchanged): the privacy class of what a surface served at
// a path, the sinks that class may feed, and, when a sink is named, whether that sink may send or keep anything.
// Every class, sink and route is a row of telemetry-privacy.json; a route not named there is the unknown class.
import { TELEMETRY_PRIVACY, classOf, sends } from './telemetry-gate.mjs';

const SINK_IDS = TELEMETRY_PRIVACY.sinks.map(sink => sink.id);

/** tool:gate-telemetry-by-privacy: { surface, path, declared?, sink? } -> { class, sinks, sink?, may_send? }. */
export function gateTelemetryRow(input) {
  const { surface, path, declared = null, sink } = input ?? {};
  const id = classOf({ surface, path, declared });
  const sinks = SINK_IDS.filter(name => sends(id, name));
  if (sink == null) return { class: id, sinks };
  if (!SINK_IDS.includes(sink)) throw new Error(`${sink} is not a telemetry sink; the sinks are ${SINK_IDS.join(', ')}.`);
  return { class: id, sinks, sink, may_send: sends(id, sink) };
}
