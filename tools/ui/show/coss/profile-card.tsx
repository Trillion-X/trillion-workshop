// parts/ui/show/coss/profile-card.tsx
//
// PURPOSE
//   A person at a glance, drawn from a guide section's `profile` DATA: their mark when the profile gives one (`mark`: a person's picture or initials through show/display-mark, a thing's icon), never a made-up face, the name with a
//   small tag badge beside it, a quiet line under it, a bar toward something (its label in the accent colour, a thin
//   bar, the words at its two ends under it), labelled facts as rows with an icon, one highlighted fact in its own inner
//   tile (icon, a title, a value at the right, a line under it), and one action along the foot as
//   a quiet full-width row with an arrow. Anatomy follows the Promethee profile card from the community captures: avatar, name and tag, level line in the accent with its bar
//   and the two end words, uppercase fact rows with the value right, the "this week" tile, and the "view full profile"
//   foot row. Checked against 21st.dev's "Profile-Card" (waleedkibhen, id 2593: avatar over name, a quiet line, one
//   action along the foot) and "Progress Card" (lavikatiyar, id 7793: a labelled bar with its words under it). Dropped
//   from them: the cover banner, photo avatars the caller does not have, hover tilt and glow, and the dark palette.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: every name, label, value and end word is the caller's DATA; the meter's
//      progress is 0..1 and is clamped.
//   2. Nothing is shown that the caller did not send: no invented picture, count or rank.
//   3. Controls are the licensed Coss sources (Badge, Button through press-action.tsx) and NamedIcon;
//      appearance lives in screen-look/show/guide.css (`.profile-*`).

import { ArrowRight } from 'lucide-react';
import { Badge } from './ui/badge';
import { DisplayMark } from '../display-mark';
import { NamedIcon } from '../icon/NamedIcon';
import { PressAction } from './press-action';
import type { GuideActionHandler, GuideProfile } from './guide';

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

export function ProfileCard({ profile, onAction }: { profile: GuideProfile; onAction: GuideActionHandler }) {
  const { meter, highlight } = profile;
  const share = meter ? clamp(meter.progress) : 0;
  return (
    <div className="profile-card">
      <div className="profile-top">
        {profile.mark ? <DisplayMark key={profile.mark.picture ?? ''} spec={{ name: profile.name, ...(profile.mark.picture ? { image: profile.mark.picture } : {}), ...(profile.mark.icon ? { glyph: profile.mark.icon, shape: 'tile' as const } : {}) }} size="xl" /> : null}
        <div className="profile-names">
          <p className="profile-name">
            <span className="profile-name-text">{profile.name}</span>
            {profile.tag ? <Badge variant="outline" className="profile-tag">{profile.tag}</Badge> : null}
          </p>
          {profile.detail ? <p className="profile-detail">{profile.detail}</p> : null}
        </div>
      </div>
      {meter ? (
        <div className="profile-meter">
          <p className="profile-meter-label">{meter.label}</p>
          <span className="profile-meter-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={meter.label}>
            <span className="profile-meter-fill" style={{ width: `${share * 100}%` }} />
          </span>
          {meter.start || meter.end ? (
            <p className="profile-meter-ends"><span>{meter.start ?? ''}</span><span>{meter.end ?? ''}</span></p>
          ) : null}
        </div>
      ) : null}
      {profile.facts?.length ? (
        <dl className="profile-facts">
          {profile.facts.map(fact => (
            <div key={fact.label} className="profile-fact">
              <dt className="profile-fact-label">{fact.icon ? <NamedIcon name={fact.icon} aria-hidden className="profile-fact-icon" /> : null}{fact.label}</dt>
              <dd className="profile-fact-value">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {highlight ? (
        <div className="profile-highlight">
          {highlight.icon ? <span className="profile-highlight-icon" aria-hidden><NamedIcon name={highlight.icon} /></span> : null}
          <div className="profile-highlight-text">
            <p className="profile-highlight-title">{highlight.title}</p>
          </div>
          {highlight.value || highlight.detail ? (
            <div className="profile-highlight-end">
              {highlight.value ? <p className="profile-highlight-value">{highlight.value}</p> : null}
              {highlight.detail ? <p className="profile-highlight-detail">{highlight.detail}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {profile.action ? (
        <PressAction action={profile.action} onAction={onAction} className="profile-foot">
          <span className="profile-foot-label">{profile.action.label}</span>
          <ArrowRight aria-hidden className="profile-foot-arrow" />
        </PressAction>
      ) : null}
    </div>
  );
}
