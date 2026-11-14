// src/workspace/tool-screen-guide.tsx
//
// PURPOSE
//   The tool screens the shared guide draws (tool-screen.tsx SHOWS): `described`, Trillion's own screen from the tool
//   (what it does, a box per input, Run and what it returned), and `web-address`, the tool's hosted frontend opened from
//   here. tool-screen.tsx fetches this the first time such a screen opens, so a module or workspace screen never
//   carries the guide.
//
// NON-NEGOTIABLE INVARIANTS
//   Those of tool-screen.tsx, whose screens these are.

import React from 'react';
import { SchemaValueView } from '../../parts/ui';
import { KeptFiles } from '../../parts/ui/show/file-preview/KeptFiles';
import type { GuideSection } from '../../parts/ui/show/coss/guide';
import { readJson } from './api';
import { openFile } from './open-screen';
import { baseName, bytesAddress } from './file-picture';
import { shownResult, splitKeptFiles } from './tool-results';
import { guideScreen, LOCAL } from './guide-screen';
import { filledInputs, givenInputs, inputFields, inputOf } from './tool-inputs';
import { referenceFiles, yourFiles } from './your-files';
import { recordSource } from './record-source';
import { toolScreenRequest } from './tool-screen-requests.mjs';
import { finishRun, newRunKey, TOOL_RUN_PATH, type BytePage, type Ran as DoorRan } from './workshop-tool-api';
import type { Unmount } from './lazy-screen';
import { aboutOf, nameOf, sameInput, type Show } from './tool-screen';

type Ran = { state: string; output?: unknown; error?: string | null; files?: unknown };

/** A personal run's finished answer in the shape this screen shows (a pursuit's run already answers in it). */
const shownRun = (ran: DoorRan): Ran => ran.exit_code === 0 ? { state: 'completed', output: ran.result, files: ran.files } : { state: 'failed', error: ran.error ?? null };

const described: Show = (element, tool, screen, props) => {
  // An input the place it opened in already gives (a space's tool opens with its space_id) is filled, not asked.
  let latestProps = props;
  let given = givenInputs(tool.input_schema, props.surfaceInput);
  const fileSources = { references: referenceFiles(props.surfaceInput?.space_id) };
  let last: Ran | null = null;
  // What it returned, drawn inside the guide under its heading by the shared value view (the guide lends it as a part).
  // A file the run kept shows as the file itself (it plays, or shows, and opens); what is left shows as values.
  const Returned = () => {
    if (!last) return null;
    if (last.error) return <SchemaValueView value={{ what_went_wrong: last.error }} />;
    const { files: returned, rest } = splitKeptFiles(shownResult(last.output ?? { state: last.state }, screen.shows));
    const files = [...returned, ...splitKeptFiles(last.files).files];
    return (
      <>
        <KeptFiles files={files.map(file => ({ key: file.identity, name: baseName(file.name), url: bytesAddress(file.identity), contentType: file.media_type ?? '' }))}
          openLabel="Open" onOpen={file => openFile({ id: file.key, name: file.name, type: file.contentType })} />
        {rest === undefined ? null : <SchemaValueView value={rest} schema={screen.shows || files.length ? undefined : tool.output_schema} />}
      </>
    );
  };
  const guide = guideScreen(element, 'Loading the tool', async act => {
    const fields = inputFields(tool.input_schema, screen.inputs, { includeComplex: screen.kind === 'described', given, prefilled: filledInputs(latestProps.surfaceInput) });
    const run = act({ label: screen.run?.label ?? 'Run', tone: 'primary', icon: screen.run?.icon ?? 'Play', busy_label: screen.run?.busy_label ?? 'Running', send: { path: 'run', with_fields: true } }, async values => {
      const input = { ...inputOf(tool.input_schema, values), ...given };
      const key = newRunKey('screen');
      const request = toolScreenRequest(tool.id, latestProps.surfaceInput, 'run', { input, request_key: key });
      // The key identifies this press; busy retries keep the exact company grant-bound job.
      const answer = await readJson<Ran | DoorRan | BytePage>(request.path, request.init, true);
      last = request.path === TOOL_RUN_PATH ? shownRun(await finishRun(tool.id, input, key, answer as DoorRan | BytePage)) : answer as Ran;
      return LOCAL;
    });
    const sections: GuideSection[] = [
      { profile: { name: nameOf(tool, screen), detail: aboutOf(tool, screen) } },
      { rows: [{ id: 'run', title: fields.length ? screen.run?.asks ?? 'What to give it' : 'Run it', ...(fields.length ? {} : { detail: 'It needs nothing to run.' }), fields, starts_open: true, actions: [run] }] },
      ...(last ? [{ heading: last.state === 'working' ? 'Still running: it shows in Runs when it finishes' : screen.run?.returned ?? 'What it returned', part: 'returned' }] : []),
    ];
    return { title: nameOf(tool, screen), hide_header: true, sections };
  }, { parts: { returned: Returned }, files: yourFiles, fileSources, records: recordSource });
  const dispose: Unmount = () => guide.unmount();
  dispose.update = next => {
    if (sameInput(latestProps.surfaceInput, next.surfaceInput)) return;
    latestProps = next;
    given = givenInputs(tool.input_schema, next.surfaceInput);
    fileSources.references = referenceFiles(next.surfaceInput?.space_id);
    void guide.redraw();
  };
  return dispose;
};

const webAddress: Show = (element, tool, screen) => {
  const guide = guideScreen(element, 'Loading the tool', async () => ({
    title: nameOf(tool, screen),
    hide_header: true,
    sections: [{ profile: { name: nameOf(tool, screen), detail: aboutOf(tool, screen), action: { label: 'Open', tone: 'primary', icon: 'ArrowUpRight', href: screen.url } } }],
  }));
  return () => guide.unmount();
};

export const GUIDED: Record<'described' | 'web-address', Show> = { described, 'web-address': webAddress };
