// parts/ui/show/scan-code/ScanCode.tsx
//
// NO PRIOR: searched "qr", "scan code" and "qrcode" in ~/dev/bitfield-packages/packages/*/show (no display of one) and
// the 21st.dev MCP "QR code scan to download app card" (1706, 6171, 12249, 35184, 6838 all generate the code in the
// browser; here the code's owner draws it as an SVG route, so only its frame is shared).
//
// Purpose
//   A code another device scans to open an address (an app that goes on a phone, offered on a computer): the code's
//   picture and the words under it. The picture is drawn by whoever owns the address (an SVG route), never here.
//
// Non-negotiable invariants
//   - The picture's words are its label, so a screen reader says what scanning it does.
//   - It never draws the code itself: `src` is a picture address its owner answers.
import * as React from 'react';

export type ScanCodeProps = { src: string; label: string; size?: number; className?: string };

export function ScanCode({ src, label, size = 112, className }: ScanCodeProps) {
  return (
    <figure className={['scan-code', className].filter(Boolean).join(' ')}>
      <img className="scan-code-picture" src={src} alt={label} width={size} height={size} loading="lazy" decoding="async" />
      <figcaption className="scan-code-label">{label}</figcaption>
    </figure>
  );
}
