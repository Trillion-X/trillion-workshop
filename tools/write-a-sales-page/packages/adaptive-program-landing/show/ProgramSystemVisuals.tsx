'use client';

import React from 'react';
import { Check, Headphones, RotateCw, Target } from 'lucide-react';
import { useProgramLandingData } from './ProgramLandingData';

const CSS = `
.program-system-surface{--es-green:#008652;--es-ink:#101814;--es-line:rgba(16,24,20,.12);position:relative;width:min(1100px,100%);margin:16px auto 0;border:1px solid var(--es-line);border-radius:28px;background:rgba(250,250,247,.82);box-shadow:0 24px 80px rgba(18,34,25,.08),inset 0 1px 0 rgba(255,255,255,.9);overflow:visible;color:var(--es-ink)}
.program-system-surface *{box-sizing:border-box}.es-topbar{height:46px;padding:0 18px;border-bottom:1px solid var(--es-line);display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,.58)}
.es-grid{min-height:560px}
.es-video{position:relative;min-height:560px;background:#0b110d;overflow:hidden}.es-video video{width:100%;height:100%;position:absolute;inset:0;object-fit:cover;filter:saturate(.94) contrast(1.04)}
.es-video:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(3,11,7,.08),transparent 48%,rgba(3,11,7,.28)),linear-gradient(180deg,transparent 62%,rgba(3,11,7,.54))}
.es-score{position:absolute;z-index:3;left:18px;top:18px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;width:min(310px,calc(100% - 36px));padding:11px 13px;border:1px solid rgba(255,255,255,.22);border-radius:14px;background:rgba(8,17,12,.58);backdrop-filter:blur(16px);color:#fff}.es-score-center{text-align:center}.es-score strong{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.es-chat{position:absolute;z-index:4;right:clamp(16px,3vw,32px);top:clamp(82px,14vw,128px);width:min(40%,410px);height:min(59%,380px);padding:16px;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.34);border-radius:20px;background:linear-gradient(145deg,rgba(8,17,12,.54),rgba(20,39,29,.28));box-shadow:0 24px 70px rgba(0,0,0,.31),inset 0 1px 0 rgba(255,255,255,.25),inset 0 0 0 1px rgba(255,255,255,.06);backdrop-filter:blur(18px) saturate(1.18);-webkit-backdrop-filter:blur(18px) saturate(1.18);color:#fff;overflow:hidden}.es-chat:before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,rgba(255,255,255,.13),transparent 38%);opacity:.72}.es-chat>*{position:relative}.es-chat-head{display:flex;align-items:center;gap:10px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.18)}.es-avatar{width:34px;height:34px;border-radius:12px;display:grid;place-items:center;color:#fff;background:var(--es-green);box-shadow:0 8px 20px rgba(0,134,82,.24)}
.es-chat-head strong{display:block;font-size:15px;line-height:1.4}.es-messages{flex:1;display:flex;flex-direction:column;gap:9px;padding-top:13px;overflow:auto;scrollbar-width:none}.es-message{max-width:90%;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.42;overflow-wrap:anywhere;animation:esBubble .36s cubic-bezier(.2,.8,.2,1) both}.es-message.coach{align-self:flex-start;color:#101814;background:rgba(255,255,255,.9);border:1px solid rgba(255,255,255,.35);border-bottom-left-radius:4px}.es-message.player{align-self:flex-end;color:#fff;background:rgba(0,134,82,.9);border:1px solid rgba(255,255,255,.14);border-bottom-right-radius:4px}.es-typing{align-self:flex-start;display:flex;gap:4px;padding:10px 12px;border:1px solid rgba(255,255,255,.28);border-radius:14px;background:rgba(255,255,255,.86)}.es-typing i{width:5px;height:5px;border-radius:50%;background:rgba(16,24,20,.35);animation:esTyping 1s infinite}.es-typing i:nth-child(2){animation-delay:.16s}.es-typing i:nth-child(3){animation-delay:.32s}
.es-mental{padding:24px;background:radial-gradient(circle at 50% 18%,rgba(0,134,82,.13),transparent 40%),linear-gradient(145deg,#f3f8f2,#fbf7ec 60%,#f8efe8)}.es-pressure{display:flex;align-items:center;justify-content:center;gap:28px;padding:16px;border:1px solid var(--es-line);border-radius:18px;background:#101814;color:#fff;box-shadow:0 18px 40px rgba(16,24,20,.16)}.es-pressure-score{text-align:center}.es-pressure-score span{display:block;margin-bottom:5px;font-size:11px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:rgba(255,255,255,.58)}.es-pressure-score strong{display:block;font:600 clamp(32px,5vw,58px)/1 var(--font-display,serif);font-variant-numeric:tabular-nums}.es-break-point{border-radius:999px;background:#b3261e;color:#fff;font-size:12px;font-weight:850;letter-spacing:.08em;padding:7px 10px;text-transform:uppercase}
.es-readout{display:grid;grid-template-columns:220px 1fr;gap:22px;align-items:center;margin-top:18px}.es-ring{width:190px;aspect-ratio:1;border-radius:50%;display:grid;place-items:center;margin:auto;background:conic-gradient(var(--es-green) 78%,rgba(0,134,82,.1) 0);position:relative;box-shadow:0 18px 50px rgba(0,134,82,.13)}.es-ring:before{content:"";position:absolute;inset:13px;border-radius:50%;background:#f7faf5}.es-ring-copy{position:relative;text-align:center}.es-ring-copy strong{display:block;font:600 51px/1 var(--font-display,serif)}.es-ring-copy span{font-size:15px;line-height:1.4;font-weight:750;color:var(--es-green)}.es-coach-cue{padding:22px;border:1px solid rgba(0,134,82,.16);border-radius:20px;background:rgba(255,255,255,.72)}.es-coach-cue h3{font:600 25px/1.15 var(--font-display,serif);margin:6px 0 11px;overflow-wrap:anywhere}.es-coach-cue p{font-size:15px;line-height:1.5;color:rgba(16,24,20,.7)}.es-execution{display:grid;gap:8px;margin-top:14px}.es-execution-step{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--es-line);border-radius:12px;background:rgba(255,255,255,.68)}.es-execution-step i{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:rgba(0,134,82,.1);color:var(--es-green);font-style:normal;font-size:12px;font-weight:850}.es-execution-step strong{display:block;font-size:14px;line-height:1.35}.es-execution-step span{display:block;margin-top:2px;font-size:13px;line-height:1.4;color:rgba(16,24,20,.62)}.es-composed-play{margin-top:12px;padding:13px 14px;border-radius:13px;background:var(--es-green);color:#fff;font-size:15px;font-weight:800;line-height:1.4}
.es-learning{display:grid;grid-template-columns:minmax(280px,.9fr) minmax(0,1.1fr);min-height:520px}.es-learning-media{position:relative;min-height:420px;background:#0a100c}.es-learning-media video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.es-learning-media:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 45%,rgba(4,12,7,.78))}.es-success{position:absolute;z-index:2;left:18px;right:18px;bottom:18px;color:#fff}.es-success-row{display:flex;justify-content:space-between;align-items:end}.es-success strong{font-size:33px}.es-progress{height:6px;margin-top:9px;border-radius:999px;background:rgba(255,255,255,.2);overflow:hidden}.es-progress i{display:block;width:84%;height:100%;background:#6ee7a9;border-radius:inherit;animation:esGrow 2s ease-out both}
.es-protocol{padding:20px;background:linear-gradient(150deg,rgba(255,255,255,.7),rgba(234,246,238,.56))}.es-coach-note{padding:16px;border:1px solid var(--es-line);border-radius:15px;background:white;animation:esBubble .45s both}.es-coach-note+.es-coach-note{margin-top:9px}.es-coach-note strong{display:block;color:var(--es-green);font-size:11px;font-weight:850;letter-spacing:.09em;text-transform:uppercase}.es-coach-note p{margin:6px 0 0;font-size:15px;line-height:1.5;overflow-wrap:anywhere}.es-protocol-shift{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0 9px;padding:10px 12px;border:1px solid rgba(0,134,82,.2);border-radius:12px;background:rgba(0,134,82,.08);color:var(--es-green);font-size:12px;font-weight:850;letter-spacing:.06em;text-transform:uppercase}.es-protocol-shift span:last-child{color:rgba(16,24,20,.55)}.es-plan-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:16px 0 9px}.es-plan-head strong{font:600 20px/1.2 var(--font-display,serif)}.es-plan-list{display:flex;flex-direction:column;gap:9px}.es-plan-row{display:grid;grid-template-columns:29px minmax(0,1fr) auto;gap:10px;align-items:center;padding:14px 16px;border:1px solid var(--es-line);border-radius:13px;background:rgba(255,255,255,.72);transition:transform .5s ease,background .5s ease}.es-plan-row>div{min-width:0}.es-rank{font-size:13px;line-height:1.35;font-weight:800;color:rgba(16,24,20,.48)}.es-plan-row strong{display:block;font-size:15px;line-height:1.4;overflow-wrap:anywhere}.es-plan-row small{display:block;margin-top:3px;font-size:15px;line-height:1.4;color:rgba(16,24,20,.62);overflow-wrap:anywhere}.es-status{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;color:rgba(16,24,20,.25);border:1px solid var(--es-line)}.es-status.current{color:#fff;background:var(--es-green);border-color:var(--es-green);box-shadow:0 0 0 5px rgba(0,134,82,.09)}.es-status.complete{color:var(--es-green);background:rgba(0,134,82,.08);border-color:rgba(0,134,82,.2)}
.es-recalculate{padding:24px;background:linear-gradient(145deg,rgba(255,255,255,.78),rgba(239,246,241,.7))}.es-recalc-live{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;margin-bottom:16px;padding:16px 18px;border-radius:16px;background:#101814;color:#fff}.es-recalc-live small{display:block;color:rgba(255,255,255,.58);font-size:11px;font-weight:850;letter-spacing:.1em;text-transform:uppercase}.es-recalc-live strong{display:block;margin-top:4px;font:600 clamp(21px,3vw,30px)/1.18 var(--font-display,serif)}.es-recalc-version{border-radius:999px;background:rgba(255,255,255,.12);padding:8px 11px;font-size:12px;font-weight:800;white-space:nowrap}.es-recalc-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:18px}.es-timeline,.es-ladder{display:flex;flex-direction:column;gap:10px}.es-trigger{position:relative;min-width:0;padding:15px 16px;border:1px solid var(--es-line);border-radius:15px;background:rgba(255,255,255,.74);animation:esBubble .4s both;transition:border-color .3s ease,box-shadow .3s ease,transform .3s ease}.es-trigger[data-active="true"]{border-color:rgba(0,134,82,.46);box-shadow:0 16px 36px rgba(0,134,82,.11),inset 0 0 0 1px rgba(0,134,82,.12);transform:translateY(-1px)}.es-trigger p{margin:0 0 9px;font-size:14px;line-height:1.45;overflow-wrap:anywhere}.es-recalc-action{display:inline-flex;align-items:center;gap:6px;font:700 18px/1.25 var(--font-display,serif);color:var(--es-green);filter:url(#headline-inner-shadow-dark);white-space:normal;overflow-wrap:anywhere}.es-plan-rewrite{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:stretch;margin-top:10px}.es-plan-state{padding:10px 11px;border-radius:11px;background:rgba(15,23,42,.045)}.es-plan-state[data-next="true"]{background:rgba(0,134,82,.09)}.es-plan-state small{display:block;margin-bottom:3px;color:rgba(16,24,20,.48);font-size:10px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.es-plan-state strong{display:block;font-size:13px;line-height:1.35}.es-plan-arrow{align-self:center;color:var(--es-green);font-size:18px;font-weight:900}.es-change{display:block;margin-top:8px;font-size:13px;line-height:1.4;color:rgba(16,24,20,.62);overflow-wrap:anywhere}.es-ladder{padding:14px;border:1px solid var(--es-line);border-radius:15px;background:rgba(255,255,255,.56)}.es-ladder-title{font-size:12px;font-weight:850;letter-spacing:.08em;text-transform:uppercase;color:rgba(16,24,20,.52)}.es-question{display:grid;grid-template-columns:30px minmax(0,1fr);gap:9px;align-items:center;padding:9px 0;border-bottom:1px solid var(--es-line);animation:esSlide .45s both}.es-question:last-child{border-bottom:0}.es-question span{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:rgba(0,134,82,.09);color:var(--es-green);font-size:11px;font-weight:850}.es-question p{margin:0;font-size:13px;line-height:1.4;overflow-wrap:anywhere}.es-final{grid-column:1/-1;margin-top:2px;padding:20px;text-align:center;border:1px solid rgba(0,134,82,.18);border-radius:18px;background:rgba(0,134,82,.06);font:600 clamp(20px,3vw,31px)/1.2 var(--font-display,serif)}
.es-plan-list[data-adjusted="true"] .es-plan-row{border-color:rgba(0,134,82,.19)}.es-plan-list[data-adjusted="true"] .es-plan-row.current{background:rgba(0,134,82,.1);box-shadow:0 12px 25px rgba(0,134,82,.09)}
.es-learning-chat{right:clamp(16px,3vw,32px);top:clamp(20px,4vw,32px);height:auto;max-height:calc(100% - clamp(40px,8vw,64px));width:min(46%,430px)}
.es-learning-success{position:absolute;z-index:3;left:18px;bottom:18px;width:min(280px,calc(54% - 36px));padding:11px 13px;border:1px solid rgba(255,255,255,.22);border-radius:14px;background:rgba(8,17,12,.58);backdrop-filter:blur(16px);color:#fff}
.es-learning-state{display:block;font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#6ee7a9}
.es-note-label{display:block;margin-bottom:3px;color:var(--es-green);font-size:10px;font-weight:850;letter-spacing:.09em;text-transform:uppercase}
.es-plan-head-glass{margin:8px 0 0}.es-plan-head-glass strong{color:#fff;font:600 17px/1.2 var(--font-display,serif)}
.es-learning-chat .es-plan-row{background:rgba(255,255,255,.92);border-color:rgba(255,255,255,.35);color:#101814}.es-learning-chat .es-plan-row strong{color:#101814}.es-learning-chat .es-plan-row small{color:rgba(16,24,20,.62)}
.es-learning-chat .es-plan-list[data-adjusted="true"] .es-plan-row.current{background:rgba(224,247,235,.96)}
@media(max-width:760px){.es-video[data-protocol-adjusted]{min-height:780px}.es-learning-chat{left:12px;right:12px;top:auto;bottom:14px;width:auto;height:auto !important;max-height:min(76%,600px)}.es-learning-success{left:12px;bottom:auto;top:12px;width:min(240px,calc(100% - 24px))}}
@keyframes esPulse{50%{transform:scale(.68);opacity:.55}}@keyframes esBubble{from{opacity:0;transform:translateY(8px) scale(.985)}}@keyframes esTyping{50%{transform:translateY(-3px);opacity:.9}}@keyframes esGrow{from{width:0}}@keyframes esSlide{from{opacity:0;transform:translateX(10px)}}
@media(max-width:760px){.program-system-surface{border-radius:20px;margin-top:16px}.es-learning{grid-template-columns:1fr}.es-video{min-height:720px}.es-learning-media{min-height:360px}.es-chat{left:12px;right:12px;top:auto;bottom:12px;width:auto;height:455px}.es-score{left:12px;top:12px}.es-readout{grid-template-columns:1fr}.es-ring{width:170px}.es-recalc-grid{grid-template-columns:1fr}.es-final{grid-column:auto}.es-pressure{gap:14px}.es-pressure-score strong{font-size:38px}}
@media(max-width:430px){.es-topbar{height:auto;min-height:52px;padding:9px 13px;gap:10px;flex-wrap:wrap}.es-mental,.es-recalculate,.es-protocol{padding:16px}.es-score{padding:10px}.es-score strong{font-size:18px}.es-pressure{padding:12px;gap:10px}.es-chat{padding:13px;height:485px}.es-message{font-size:13px}.es-plan-rewrite{grid-template-columns:1fr}.es-plan-arrow{text-align:center;transform:rotate(90deg)}.es-recalc-live{grid-template-columns:1fr}.es-recalc-version{justify-self:start}.es-question{grid-template-columns:28px minmax(0,1fr)}}
@media(max-width:760px){.es-video{min-height:640px}.es-chat{left:12px;right:12px;top:auto;bottom:14px;width:auto;height:min(55%,352px)}}
@media(max-width:430px){.es-chat{height:min(55%,330px)}}
@media(prefers-reduced-motion:reduce){.program-system-surface *{animation:none!important;transition:none!important}}
`;

function Frame({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return <section className="program-system-surface" data-testid={testId} aria-label={label}><style>{CSS}</style>{children}</section>;
}

function useTypewriter<T extends { text: string; role: string }>(messages: readonly T[]) {
  const [index, setIndex] = React.useState(0);
  const [typed, setTyped] = React.useState('');
  const [waiting, setWaiting] = React.useState(true);
  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const settle = window.setTimeout(() => setIndex(messages.length), 0);
      return () => window.clearTimeout(settle);
    }
    if (index >= messages.length) return;
    if (waiting) {
      const pause = window.setTimeout(() => setWaiting(false), messages[index].role === 'coach' ? 320 : 140);
      return () => window.clearTimeout(pause);
    }
    if (typed.length < messages[index].text.length) {
      const tick = window.setTimeout(() => setTyped(messages[index].text.slice(0, typed.length + 3)), 16);
      return () => window.clearTimeout(tick);
    }
    const hold = window.setTimeout(() => { setIndex((value) => value + 1); setTyped(''); setWaiting(true); }, 260);
    return () => window.clearTimeout(hold);
  }, [index, messages, typed, waiting]);
  return { index, typed, waiting };
}

export function ObservedDialogueVisual() {
  const data = useProgramLandingData().systemVisuals.liveCoaching;
  const dialogue = useTypewriter(data.messages);
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [dialogue.index, dialogue.typed]);
  return <Frame label={data.frameLabel} testId="program-observed-dialogue">
    <div className="es-grid"><div className="es-video" data-chat-overlay="on-video">
      <video src={data.videoSrc} aria-label={data.videoLabel} autoPlay muted loop playsInline preload="auto" />
      <div className="es-score"><div><strong>{data.match.score.split(' - ')[0]}</strong></div><div className="es-score-center"><strong>{data.match.point}</strong></div><div style={{ textAlign: 'right' }}><strong>{data.match.score.split(' - ')[1]}</strong></div></div>
      <div className="es-chat" data-testid="program-match-chat-overlay">
        <div className="es-chat-head"><div className="es-avatar"><Headphones size={17} /></div><div><strong>{data.headerLabel}</strong></div></div>
        <div className="es-messages" ref={listRef} aria-live="polite">
          {data.messages.slice(0, dialogue.index).map((message) => <div key={message.id} className={`es-message ${message.role}`}>{message.text}</div>)}
          {dialogue.index < data.messages.length && !dialogue.waiting ? <div className={`es-message ${data.messages[dialogue.index].role}`}>{dialogue.typed}<span aria-hidden="true">▋</span></div> : null}
          {dialogue.index < data.messages.length && dialogue.waiting && data.messages[dialogue.index].role === 'coach' ? <div className="es-typing" aria-label={data.typingLabel}><i /><i /><i /></div> : null}
        </div>
      </div>
    </div></div>
  </Frame>;
}

export function ComposureReadoutVisual() {
  const data = useProgramLandingData().systemVisuals.mentalMastery;
  return <Frame label={data.frameLabel} testId="program-composure-readout">
    <div className="es-mental"><div className="es-pressure"><div className="es-pressure-score"><span>{data.gamesLabel}</span><strong>{data.pressure.games}</strong></div><span className="es-break-point">{data.pressure.label}</span><div className="es-pressure-score"><span>{data.pointLabel}</span><strong>{data.pressure.point}</strong></div></div>
      <div className="es-readout"><div><div className="es-ring"><div className="es-ring-copy"><strong>{data.flow.value}</strong><span>{data.flow.verdict}</span></div></div></div>
        <div className="es-coach-cue"><h3>{data.flow.caption}</h3><div className="es-execution">{data.execution.map((step, index) => <div className="es-execution-step" key={step.id}><i>{index + 1}</i><div><strong>{step.label}</strong><span>{step.detail}</span></div></div>)}</div><div className="es-composed-play">{data.composedPlayPrefix} {data.composedPlay}</div></div>
      </div></div>
  </Frame>;
}

export function AdaptivePriorityVisual() {
  const data = useProgramLandingData().systemVisuals.optimalLearning;
  const [adjusted, setAdjusted] = React.useState(false);
  const planRows = React.useRef(new Map<string, HTMLDivElement>());
  const priorPlanPositions = React.useRef(new Map<string, DOMRect>());
  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const settle = window.setTimeout(() => setAdjusted(true), 0);
      return () => window.clearTimeout(settle);
    }
    const timer = window.setTimeout(() => setAdjusted(true), 1800);
    return () => window.clearTimeout(timer);
  }, []);
  const plan = adjusted ? data.after : data.before;
  React.useLayoutEffect(() => {
    const nextPositions = new Map<string, DOMRect>();
    planRows.current.forEach((element, id) => nextPositions.set(id, element.getBoundingClientRect()));
    if (adjusted && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      nextPositions.forEach((nextPosition, id) => {
        const priorPosition = priorPlanPositions.current.get(id);
        const offset = priorPosition ? priorPosition.top - nextPosition.top : 0;
        if (offset) {
          planRows.current.get(id)?.animate(
            [{ transform: `translateY(${offset}px)`, boxShadow: '0 18px 34px rgba(0, 134, 82, .18)' }, { transform: 'translateY(0)', boxShadow: '0 0 0 rgba(0, 134, 82, 0)' }],
            { duration: 760, easing: 'cubic-bezier(.2,.8,.2,1)' },
          );
        }
      });
    }
    priorPlanPositions.current = nextPositions;
  }, [adjusted, plan]);
  return <Frame label={data.frameLabel} testId="program-adaptive-priority">
    <div className="es-video" data-protocol-adjusted={adjusted ? 'true' : 'false'}>
      <video src={data.videoSrc} aria-label={data.videoLabel} autoPlay muted loop playsInline preload="auto" />
      <div className="es-learning-success"><div className="es-success-row"><strong>{data.successValue}</strong><span>{data.successLabel}</span></div><div className="es-progress"><i /></div></div>
      <div className="es-chat es-learning-chat">
        <div className="es-chat-head"><span className="es-avatar"><Target size={16} /></span><div><strong>{data.guideLabel}</strong><span className="es-learning-state">{adjusted ? data.adjustedStateLabel : data.initialStateLabel}</span></div></div>
        <div className="es-messages">
          {data.messages.map((message) => <div className="es-message coach" key={message.id}><strong className="es-note-label">{message.label}</strong>{message.text}</div>)}
          <div className="es-message player">{adjusted ? data.adjustedReply : data.initialReply}</div>
          <div className="es-plan-head es-plan-head-glass"><strong>{data.planLabel}</strong></div>
          <div className="es-plan-list" data-adjusted={adjusted ? 'true' : 'false'} role="list" aria-live="polite">{plan.map((item) => <div className={`es-plan-row ${item.status}`} role="listitem" key={item.id} ref={(element) => { if (element) planRows.current.set(item.id, element); else planRows.current.delete(item.id); }}><span className="es-rank">{item.rank}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div><span className={`es-status ${item.status}`}>{item.status === 'complete' ? <Check size={12} /> : item.status === 'current' ? <Target size={11} /> : null}</span></div>)}</div>
        </div>
      </div>
    </div>
  </Frame>;
}

export function RecalculateVisual() {
  const data = useProgramLandingData().systemVisuals.recalculate;
  const [activeBeat, setActiveBeat] = React.useState(0);
  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setActiveBeat((value) => (value + 1) % data.beats.length), 2400);
    return () => window.clearInterval(timer);
  }, [data.beats.length]);
  const active = data.beats[activeBeat];
  return <Frame label={data.frameLabel} testId="program-recalculate">
    <div className="es-recalculate"><div className="es-recalc-live"><div><small>{data.changedLabel}</small><strong>{active.after}</strong></div></div><div className="es-recalc-grid"><div className="es-timeline">{data.beats.map((beat, index) => <div className="es-trigger" data-active={activeBeat === index ? 'true' : 'false'} key={beat.id} style={{ animationDelay: `${index * 180}ms` }}><p>{beat.trigger}</p><span className="es-recalc-action"><RotateCw size={15} />{beat.action}</span><div className="es-plan-rewrite"><div className="es-plan-state"><small>{data.beforeLabel}</small><strong>{beat.before}</strong></div><span className="es-plan-arrow">→</span><div className="es-plan-state" data-next="true"><small>{data.afterLabel}</small><strong>{beat.after}</strong></div></div><span className="es-change">{data.changePrefix} {beat.why}</span></div>)}</div>
      <div className="es-ladder"><div className="es-ladder-title">{data.questionsLabel}</div>{data.questions.map((question, index) => <div className="es-question" key={question.id} style={{ animationDelay: `${index * 110}ms` }}><span>{index + 1}</span><p>{question.text}</p></div>)}</div><div className="es-final">{data.closer}</div></div></div>
  </Frame>;
}
