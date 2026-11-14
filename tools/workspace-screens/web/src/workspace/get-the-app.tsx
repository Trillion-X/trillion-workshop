// src/workspace/get-the-app.tsx
//
// NO PRIOR: new for the owner's 2026-10-04 ask ("if they forget to do it during the onboarding ... scan this QR code"):
// a screen that needs something only a Trillion app brings offers that app right there.
//
// PURPOSE
//   The apps that bring one thing this page cannot do (`thing`, such as listen), drawn where it is needed: the Worker
//   answers which of them this account does not have yet, with each one's download button and, on a computer, the code
//   a phone scans (GET /work/api/screens/get-the-app?for=<thing>: the get-the-app catalogue screen, records/marketplace-screens.json, drawn by src/screen-host.mjs; DATA src/devices.json
//   brings). When there is none to offer it draws nothing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No app, system or link is named here; which apps bring what is DATA (src/devices.json), and the drawing is the
//      shared guide (parts/ui Guide), so this file writes no markup of its own.
//   2. A read that fails draws nothing: the screen it sits on goes on working without the offer.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Guide, type GuideDescription } from '../../parts/ui/show/coss/guide';
import { readJson } from './api';

export function GetTheApp({ thing }: { thing: string }) {
  const [offer, setOffer] = React.useState<GuideDescription | null>(null);
  React.useEffect(() => {
    let live = true;
    readJson<GuideDescription>(`/work/api/screens/get-the-app?for=${encodeURIComponent(thing)}`)
      .then(description => { if (live) setOffer(description); })
      .catch(() => { if (live) setOffer(null); });
    return () => { live = false; };
  }, [thing]);
  if (!offer?.sections.length) return null;
  // Every action here is a link (a download or a store page), which the guide opens itself.
  return <Guide description={offer} onAction={() => undefined} />;
}
