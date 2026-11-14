'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useProgramLandingData } from './ProgramLandingData';

const ACCENT = '#008652';
const INK = '#0f172a';
const MUTED = '#64748b';
const HAIR = '1px solid rgba(15,23,42,0.10)';
type StrategySequence = ReturnType<typeof useProgramLandingData>['strategySequence'];

function useSequenceBeat(shotCount: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      const reducedTimer = window.setTimeout(() => setStep(shotCount), 0);
      return () => window.clearTimeout(reducedTimer);
    }
    let visible = true;
    const node = ref.current;
    const observer = node && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => { visible = entries.some((entry) => entry.isIntersecting); }, { threshold: 0.25 })
      : null;
    if (node && observer) observer.observe(node);
    const timer = window.setInterval(() => {
      if (visible) setStep((value) => (value + 1) % (shotCount + 3));
    }, 1050);
    return () => { window.clearInterval(timer); observer?.disconnect(); };
  }, [shotCount]);

  return { ref, step };
}

type ArrowState = 'future' | 'current' | 'past';

// Each shot is a curved arc (not a straight line) that bows to alternating
// sides, so five crossing shots no longer stack into one unreadable X. Only
// the CURRENT shot is bold; earlier shots dim back and future shots stay
// nearly hidden, so the eye follows the point one shot at a time (U4).
function Arrow({ shot, index, state, actors }: { shot: StrategySequence['shots'][number]; index: number; state: ArrowState; actors: Record<string, any> }) {
  const [x1, y1] = shot.from;
  const [x2, y2] = shot.to;
  const actor = actors[shot.actor];
  const color = actor.color;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = (index % 2 === 0 ? 1 : -1) * 9;
  const cx = (x1 + x2) / 2 + (-dy / len) * bow;
  const cy = (y1 + y2) / 2 + (dx / len) * bow;
  const d = `M ${x1} ${y1} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${x2} ${y2}`;
  const opacity = state === 'current' ? 1 : state === 'past' ? 0.4 : 0.07;
  const width = (actor.emphasis ? 2 : 1.4) * (state === 'current' ? 1.3 : 1);
  return (
    <g opacity={opacity} style={{ transition: 'opacity 380ms ease' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={actor.dashed ? '4 3' : undefined} markerEnd={`url(#arrow-${shot.actor})`} />
      {state === 'future' ? null : (
        <>
          <circle cx={x2} cy={y2} r={state === 'current' ? 5 : 4.2} fill="#fff" stroke={color} strokeWidth="1.5" />
          <text x={x2} y={y2 + 1.6} textAnchor="middle" fontSize="4.5" fontWeight="800" fill={color}>{shot.number}</text>
        </>
      )}
    </g>
  );
}

function FieldPrimitive({ primitive }: { primitive: Record<string, any> }) {
  if (primitive.type === 'rect') return <rect {...primitive.attributes} />;
  if (primitive.type === 'line') return <line {...primitive.attributes} />;
  if (primitive.type === 'circle') return <circle {...primitive.attributes} />;
  if (primitive.type === 'path') return <path {...primitive.attributes} />;
  throw new Error(`unsupported strategy field primitive: ${String(primitive.type)}`);
}

function StrategyField({ sequence, step }: { sequence: StrategySequence; step: number }) {
  const shotCount = sequence.shots.length;
  return (
    <div style={{ position: 'relative', aspectRatio: sequence.field.aspectRatio, minHeight: 380, borderRadius: 12, overflow: 'hidden', background: sequence.field.background, boxShadow: 'inset 0 0 0 1px rgba(15,23,42,0.10)' }}>
      <svg viewBox={sequence.field.viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label={sequence.fieldAriaLabel.replace('{count}', String(shotCount))} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <defs>
          {Object.entries(sequence.actors).map(([id, actor]: [string, any]) => <marker id={`arrow-${id}`} key={id} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill={actor.color} /></marker>)}
        </defs>
        {sequence.field.primitives.map((primitive: Record<string, any>, index: number) => <FieldPrimitive key={index} primitive={primitive} />)}
        {sequence.shots.map((shot, index) => {
          const state: ArrowState = step < index + 1 ? 'future' : step === index + 1 ? 'current' : 'past';
          return <Arrow key={shot.number} shot={shot} index={index} state={state} actors={sequence.actors} />;
        })}
      </svg>
      <div style={{ position: 'absolute', left: 12, right: 12, bottom: 12, display: 'flex', gap: 9, flexWrap: 'wrap' }}>
        {sequence.shots.map((shot, index) => {
          const active = index < step;
          const actor = sequence.actors[shot.actor];
          const badgeBg = active ? actor.color : 'rgba(100,116,139,.18)';
          return (
              <span key={shot.number} style={{ flex: '1 1 140px', minWidth: 128, display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 10, border: active ? `1px solid ${actor.color}` : HAIR, background: 'rgba(255,255,255,0.9)', color: active ? INK : MUTED, transition: 'all 300ms ease' }}>
              <span aria-hidden="true" style={{ flex: '0 0 auto', width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', background: badgeBg, color: '#fff', fontSize: 12.5, fontWeight: 800, lineHeight: 1 }}>{shot.number}</span>
              <span style={{ fontSize: 15.5, lineHeight: 1.3, fontWeight: 650, overflowWrap: 'anywhere' }}>{shot.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function StrategySequenceSection() {
  const sequence = useProgramLandingData().strategySequence;
  const shotCount = sequence.shots.length;
  const { ref, step } = useSequenceBeat(shotCount);
  const solved = step >= shotCount;

  return (
    <div ref={ref} data-testid="program-strategy-sequence" style={{ maxWidth: '100%', border: HAIR, borderRadius: 16, overflow: 'visible', background: '#fff', boxShadow: '0 20px 50px -28px rgba(15,23,42,0.4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: '12px 16px', borderBottom: HAIR, background: 'rgba(15,23,42,0.035)', borderRadius: '16px 16px 0 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: ACCENT }} />
          <span style={{ fontSize: 15, lineHeight: 1.4, fontWeight: 750, color: INK }}>{sequence.headerLabel}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(205px, .72fr) minmax(0, 1.45fr)', gap: 0 }} className="program-sequence-grid">
        <div style={{ minWidth: 0, padding: 16, borderRight: HAIR, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <div style={{ marginTop: 6, fontSize: 17, lineHeight: 1.35, fontWeight: 760, color: INK, overflowWrap: 'anywhere' }}>{sequence.instructionTitle}</div>
            <div style={{ marginTop: 7, fontSize: 15, lineHeight: 1.5, color: MUTED, overflowWrap: 'anywhere' }}>{sequence.situation}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sequence.choices.map((choice: string, index: number) => {
              const selected = index === sequence.selectedChoice;
              return (
                <div key={choice} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 11px', borderRadius: 8, border: selected ? `1.5px solid ${ACCENT}` : HAIR, background: selected ? 'rgba(0,134,82,0.06)' : '#fff', color: INK, fontSize: 15, lineHeight: 1.5, fontWeight: selected ? 700 : 550, overflowWrap: 'anywhere' }}>
                  <span style={{ width: 20, height: 20, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: 5, background: selected ? ACCENT : 'rgba(15,23,42,0.06)', color: selected ? '#fff' : MUTED, fontSize: 13, lineHeight: 1 }}>{String.fromCharCode(65 + index)}</span>
                  {choice}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 'auto', padding: '10px 11px', borderRadius: 10, background: solved ? 'rgba(0,134,82,0.08)' : 'rgba(15,23,42,0.035)', border: solved ? '1px solid rgba(0,134,82,0.22)' : HAIR, transition: 'all 350ms ease' }}>
            <div style={{ marginTop: 5, fontSize: 15, lineHeight: 1.5, color: INK, overflowWrap: 'anywhere' }}>{solved ? sequence.solvedTemplate.replace('{count}', String(shotCount)) : sequence.pendingText}</div>
          </div>
        </div>
        <div style={{ minWidth: 0, padding: 16, background: 'linear-gradient(145deg,rgba(0,134,82,0.025),rgba(15,23,42,0.02))' }}>
          <StrategyField sequence={sequence} step={step} />
        </div>
      </div>
      <style>{`
        @media (max-width: 700px) { .program-sequence-grid { grid-template-columns: 1fr !important; } .program-sequence-grid > :first-child { border-right: 0 !important; border-bottom: ${HAIR}; } }
        @media (prefers-reduced-motion: reduce) { .program-sequence-grid * { transition: none !important; } }
      `}</style>
    </div>
  );
}
