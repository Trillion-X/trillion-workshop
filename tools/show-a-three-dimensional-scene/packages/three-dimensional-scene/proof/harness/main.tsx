import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ThreeDimensionalSceneSurface } from '../../show/ThreeDimensionalSceneSurface';

const fixture = new URLSearchParams(location.search).get('fixture') ?? 'landing-page';
const descriptor = await fetch(`../fixtures/${fixture}.json`).then((response) => response.json());
createRoot(document.getElementById('proof')!).render(<ThreeDimensionalSceneSurface descriptorSource={descriptor} resolveAddress={async (ref, signal) => (await fetch(ref.address, { signal })).arrayBuffer()} />);
