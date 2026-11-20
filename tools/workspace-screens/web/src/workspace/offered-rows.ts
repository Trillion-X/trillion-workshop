// src/workspace/offered-rows.ts
//
// PURPOSE
//   The screen rows tools offer in their part.json `offers`, as the page that offers them was given them (a page served
//   from files reads them when it is built: account-workspace.ts, scripts/build-workspace.mjs `offered-screen-rows`).
//   A tool's own screen (tool-screen.tsx) opens such a row from here: a screen a tool offers is not one of the account's
//   catalogue tools, so the account's door does not describe it. A page given none (the Mac release's page, whose
//   screen rows come with it) finds none here.

export type OfferedRow = { id: string; label?: string; description?: string; job?: string; screen?: { kind: string } & Record<string, unknown> };

let given: OfferedRow[] = [];

/** The rows the page offers; mounted once at its entry. */
export function setOfferedRows(rows: OfferedRow[]): void { given = rows; }

export function offeredRow(id: string): OfferedRow | undefined { return given.find(row => row.id === id); }
