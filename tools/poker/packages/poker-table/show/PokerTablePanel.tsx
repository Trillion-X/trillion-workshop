// package-set://bitfield-studio/packages/poker-table/show/PokerTablePanel.tsx

import React, { useEffect, useState } from 'react';
import { CircleDollarSign, Club, Crown, Eye, EyeOff } from 'lucide-react';
import { Badge, Button, Card, Container, Icon, ScrollableSurface, Text, cn } from '@/packages/ui';
import { POKER_RULES_STATE_MACHINE } from '@/packages/poker-rules/read-data/poker-rules';
import type { PlayerAction, PokerCard, PokerHandState, PokerSuit } from '@/packages/poker-rules/read-data/poker-rules';
import {
  derivePokerTableViewModel,
  type PokerPrivateHandView,
  type PokerSeatView,
  type PokerTableProjectionInput,
} from '@/packages/poker-table/read-data/poker-table';

type PokerTableView = ReturnType<typeof derivePokerTableViewModel>;

export interface PokerTablePanelControls {
  canAdvanceStreet?: boolean;
  nextStreetLabel?: string;
  onAction?: (action: PlayerAction, amount?: number) => void;
  onAdvanceStreet?: () => void;
  onKickPlayer?: (playerId: string) => void;
  onNextHand?: () => void;
  tableTools?: React.ReactNode;
}

export const POKER_TABLE_SURFACE_CSS = `
.casino-night,
.casino-setup {
  --casino-ink: #fffdfa;
  --casino-muted: rgba(255, 253, 250, 0.66);
  --casino-faint: rgba(255, 253, 250, 0.42);
  --casino-green: #053f2d;
  --casino-green-bright: #0ea36f;
  --casino-neon: #20ffc2;
  --casino-gold: #ffbe3d;
  --casino-red: #ff4242;
  --casino-rail: #19110a;
  color: var(--casino-ink);
  font-family: "Avenir Next", "Trebuchet MS", Verdana, sans-serif;
  font-variant-numeric: tabular-nums;
}

.casino-night {
  position: relative;
  min-height: 0;
  overflow: visible !important;
  border: 1px solid rgba(32, 255, 194, 0.22) !important;
  border-radius: 34px !important;
  background:
    radial-gradient(circle at 15% 8%, rgba(32, 255, 194, 0.18), transparent 30%),
    radial-gradient(circle at 88% 12%, rgba(255, 190, 61, 0.18), transparent 26%),
    linear-gradient(145deg, #06271f, #010806 72%) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10), 0 36px 110px rgba(0, 0, 0, 0.42) !important;
}

.casino-setup {
  position: relative;
  width: min(100%, 1280px);
  margin: 0 auto;
  overflow: visible;
  border: 1px solid rgba(32, 255, 194, 0.22) !important;
  border-radius: 34px !important;
  background:
    radial-gradient(circle at 14% 6%, rgba(32, 255, 194, 0.20), transparent 28%),
    radial-gradient(circle at 84% 10%, rgba(255, 190, 61, 0.18), transparent 30%),
    linear-gradient(145deg, #06271f, #010806 72%) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10), 0 36px 110px rgba(0, 0, 0, 0.36) !important;
}

.casino-setup-hero {
  display: grid;
  width: 100%;
  gap: 10px;
  align-items: center;
  justify-content: center;
  justify-items: center;
  margin-inline: auto;
  text-align: center;
}

.casino-setup-mark {
  display: grid;
  width: 72px;
  height: 72px;
  place-items: center;
  border: 1px solid rgba(32, 255, 194, 0.36);
  border-radius: 24px;
  background: linear-gradient(145deg, rgba(32, 255, 194, 0.18), rgba(255, 190, 61, 0.12));
  color: #d1fae5;
  font-size: 36px;
  font-weight: 1000;
  margin-inline: auto;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 22px 54px rgba(32, 255, 194, 0.12);
}

.casino-setup-title {
  display: block;
  margin: 0;
  width: min(100%, 980px);
  color: white;
  font-size: clamp(42px, 7vw, 88px);
  font-weight: 1000;
  letter-spacing: -0.065em;
  line-height: 0.9;
  text-align: center;
  text-wrap: balance;
  text-transform: uppercase;
  text-shadow: 0 4px 0 #00130e, 0 16px 30px rgba(0,0,0,0.62);
}

.casino-setup-copy {
  max-width: 720px;
  color: var(--casino-muted);
  line-height: 1.5;
  text-align: center;
}

.casino-table-list {
  display: grid;
  gap: 8px;
}

.casino-table-list-button {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(32, 255, 194, 0.24);
  border-radius: 18px;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.12), rgba(255,255,255,0.035)),
    rgba(2, 18, 13, 0.78);
  color: white;
  cursor: pointer;
  font: inherit;
  min-height: 58px;
  padding: 12px 16px;
  text-align: left;
  touch-action: manipulation;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 14px 32px rgba(0,0,0,0.18);
}

.casino-table-list-button:hover {
  border-color: rgba(32, 255, 194, 0.52);
  background:
    linear-gradient(145deg, rgba(32, 255, 194, 0.18), rgba(255, 190, 61, 0.06)),
    rgba(2, 18, 13, 0.9);
}

.casino-table-list-button span:first-child {
  overflow: hidden;
  font-size: 16px;
  font-weight: 1000;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.casino-table-list-button span:last-child {
  color: var(--casino-muted);
  font-size: 12px;
  font-weight: 900;
}

.casino-setup-roster {
  border: 1px solid rgba(255,255,255,0.11) !important;
  border-radius: 24px !important;
  background: rgba(2, 12, 9, 0.56) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 18px 42px rgba(0,0,0,0.20) !important;
}

.casino-join-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 280px);
  gap: clamp(12px, 2vw, 18px);
  align-items: stretch;
}

.casino-join-card,
.casino-qr-card {
  border: 1px solid rgba(32, 255, 194, 0.18) !important;
  border-radius: 28px !important;
  background:
    radial-gradient(circle at 18% 0%, rgba(32, 255, 194, 0.13), transparent 30%),
    rgba(2, 12, 9, 0.70) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.13), 0 24px 54px rgba(0,0,0,0.24) !important;
}

.casino-join-help,
.casino-qr-caption {
  max-width: 38rem;
  color: var(--casino-muted);
}

.casino-join-url {
  display: block;
  min-width: 0;
  width: 100%;
  overflow-wrap: anywhere;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 18px;
  background: rgba(0, 19, 14, 0.72);
  color: #d1fae5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: clamp(12px, 1.6vw, 15px);
  font-weight: 850;
  line-height: 1.35;
  padding: 13px 14px;
  white-space: normal;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.10);
}

.casino-join-warning {
  border: 1px solid rgba(245, 176, 46, 0.36);
  border-radius: 16px;
  background: rgba(245, 176, 46, 0.10);
  color: #ffd67a;
  font-size: 13px;
  font-weight: 800;
  line-height: 1.35;
  padding: 11px 13px;
}

.casino-join-actions {
  margin-top: 2px;
}

.casino-qr-card {
  display: grid !important;
  place-items: center;
  text-align: center;
}

.casino-qr-frame {
  display: grid;
  width: min(100%, 216px);
  aspect-ratio: 1;
  place-items: center;
  border: 10px solid rgba(255,255,255,0.94);
  border-radius: 24px;
  background: #fffefa;
  box-shadow: 0 22px 48px rgba(0,0,0,0.36);
}

.casino-qr-svg {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 12px;
}

.casino-qr-fallback {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  color: #00130e;
  font-weight: 1000;
}

.casino-setup label {
  color: rgba(209, 250, 229, 0.76);
  font-size: 12px;
  font-weight: 850;
  letter-spacing: 0.02em;
}

.casino-setup input {
  min-height: 54px;
  border: 1px solid rgba(32, 255, 194, 0.16) !important;
  border-radius: 18px !important;
  background: rgba(2, 16, 12, 0.58) !important;
  color: white !important;
  font-size: 16px;
  font-weight: 850;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 12px 28px rgba(0,0,0,0.12);
}

.casino-setup input::placeholder {
  color: rgba(255, 255, 255, 0.38);
}

.casino-setup input:focus {
  border-color: rgba(32, 255, 194, 0.62) !important;
  box-shadow: 0 0 0 3px rgba(32, 255, 194, 0.14), 0 18px 34px rgba(0,0,0,0.16);
  outline: none;
}

.casino-night::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(135deg, rgba(255,255,255,0.035) 25%, transparent 25%),
    linear-gradient(225deg, rgba(255,255,255,0.035) 25%, transparent 25%);
  background-position: 0 0, 18px 18px;
  background-size: 36px 36px;
  opacity: 0.28;
  pointer-events: none;
}

.casino-shell {
  position: relative;
  z-index: 1;
  display: grid;
  gap: clamp(10px, 1.5vw, 16px);
  min-height: 0;
  padding: clamp(12px, 2vw, 20px);
}

.casino-scoreboard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 8px 2px 0;
}

.casino-title-lockup {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.casino-title-mark {
  display: grid;
  width: clamp(38px, 6vw, 58px);
  height: clamp(38px, 6vw, 58px);
  place-items: center;
  border: 1px solid rgba(32, 255, 194, 0.40);
  border-radius: 18px;
  background: linear-gradient(145deg, rgba(32, 255, 194, 0.20), rgba(255, 190, 61, 0.08));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 36px rgba(32, 255, 194, 0.12);
}

.casino-title {
  color: white;
  background: transparent !important;
  font-size: clamp(22px, 4vw, 44px);
  font-weight: 1000;
  letter-spacing: -0.055em;
  line-height: 1;
  text-shadow: 0 3px 0 rgba(0,19,14,0.72), 0 14px 24px rgba(0,0,0,0.34);
  text-transform: uppercase;
}

.casino-meta {
  display: flex;
  justify-content: end;
  gap: 8px;
  flex-wrap: wrap;
}

.casino-felt {
  position: relative;
  display: grid;
  min-height: clamp(470px, 62vw, 780px);
  overflow: visible;
  border: clamp(12px, 2vw, 22px) solid var(--casino-rail);
  border-radius: 999px;
  background:
    radial-gradient(ellipse at 50% 44%, rgba(255,255,255,0.15), transparent 25%),
    radial-gradient(ellipse at 50% 54%, #159368 0%, var(--casino-green) 58%, #021611 100%);
  box-shadow:
    inset 0 0 0 2px rgba(255,255,255,0.11),
    inset 0 -44px 90px rgba(0,0,0,0.38),
    0 28px 70px rgba(0,0,0,0.50);
}

.casino-felt::before {
  content: "";
  position: absolute;
  inset: clamp(22px, 4vw, 40px);
  border: 1px solid rgba(255,255,255,0.26);
  border-radius: inherit;
  box-shadow: inset 0 0 70px rgba(0,0,0,0.36);
  pointer-events: none;
}

.casino-center {
  position: absolute !important;
  left: 50% !important;
  top: 50% !important;
  z-index: 8;
  width: min(78vw, 520px) !important;
  transform: translate(-50%, -50%) !important;
  overflow: visible !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  text-align: center;
}

.casino-pot-label {
  color: var(--casino-gold);
  font-size: clamp(20px, 4vw, 44px);
  font-weight: 1000;
  letter-spacing: -0.055em;
  line-height: 1;
  text-shadow: 0 4px 0 #281302, 0 16px 26px rgba(0,0,0,0.55);
  text-transform: uppercase;
}

.casino-board {
  display: flex;
  justify-content: center;
  gap: clamp(5px, 1vw, 10px);
  margin: clamp(10px, 2vw, 18px) auto;
  perspective: 900px;
}

.casino-turn-line {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 999px;
  background: rgba(2, 16, 12, 0.44);
  padding: 8px 12px;
  color: rgba(255,255,255,0.76);
  font-size: 12px;
  font-weight: 850;
  backdrop-filter: blur(10px);
}

.casino-winner-callout {
  display: grid;
  justify-items: center;
  gap: 4px;
  margin: 0 auto clamp(8px, 1.4vw, 14px);
  animation: casino-winner-drop 260ms cubic-bezier(0.2, 0.9, 0.2, 1);
}

.casino-winner-callout span {
  color: var(--casino-gold);
  font-size: 12px;
  font-weight: 1000;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

.casino-winner-callout strong {
  color: white;
  font-size: clamp(22px, 4vw, 48px);
  font-weight: 1000;
  letter-spacing: -0.055em;
  line-height: 0.95;
  text-transform: uppercase;
  text-shadow: 0 4px 0 #281302, 0 18px 34px rgba(255,190,61,0.24), 0 20px 38px rgba(0,0,0,0.48);
}

.casino-winner-callout em {
  color: rgba(255,255,255,0.72);
  font-size: 12px;
  font-style: normal;
  font-weight: 900;
}

.casino-seat {
  position: absolute !important;
  z-index: 12;
  display: grid;
  width: clamp(88px, 11vw, 132px) !important;
  gap: 5px;
  transform: translate(-50%, -50%) !important;
  overflow: visible !important;
  border: 1px solid rgba(255,255,255,0.18) !important;
  border-radius: 18px !important;
  background:
    radial-gradient(circle at 80% 0%, rgba(255,255,255,0.18), transparent 34%),
    linear-gradient(150deg, rgba(255,255,255,0.13), rgba(255,255,255,0.03)),
    rgba(6, 22, 18, 0.80) !important;
  padding: 8px !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 34px rgba(0,0,0,0.28) !important;
  backdrop-filter: blur(12px);
}

.casino-seat.is-dimmed {
  opacity: 0.48;
  filter: saturate(0.48) brightness(0.72);
}

.casino-seat.is-turn {
  border-color: rgba(255,190,61,0.86) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 3px rgba(255,190,61,0.12), 0 22px 44px rgba(255,190,61,0.18) !important;
}

.casino-seat.is-winner {
  z-index: 20;
  border-color: rgba(255,190,61,0.94) !important;
  transform: translate(-50%, -50%) scale(1.08) !important;
  opacity: 1;
  filter: saturate(1.2) brightness(1.08);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.28),
    0 0 0 4px rgba(255,190,61,0.18),
    0 0 48px rgba(255,190,61,0.42),
    0 28px 58px rgba(0,0,0,0.42) !important;
  animation: casino-winner-pulse 900ms ease-out 2;
}

.casino-seat.is-out {
  opacity: 0.42;
  filter: grayscale(0.7);
}

.casino-seat-name {
  color: white;
  font-size: 13px;
  font-weight: 1000;
  letter-spacing: -0.04em;
  line-height: 1;
  text-transform: uppercase;
}

.casino-seat-bank {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 8px;
}

.casino-seat-chips {
  color: white;
  font-size: 18px;
  font-weight: 1000;
  letter-spacing: -0.06em;
  line-height: 1;
}

.casino-seat-sub {
  color: var(--casino-faint);
  font-size: var(--font-size-caption);
  font-weight: 850;
  text-transform: uppercase;
}

.casino-card-wrap {
  flex: 0 0 auto;
  perspective: 760px;
}

.casino-card-wrap.size-hero {
  width: clamp(48px, 7vw, 74px);
  height: clamp(68px, 10vw, 106px);
}

.casino-card-wrap.size-board {
  width: clamp(42px, 6vw, 78px);
  height: clamp(60px, 8.7vw, 110px);
}

.casino-card-wrap.size-mini {
  width: 22px;
  height: 31px;
}

.casino-card-inner {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transition: transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.casino-card-inner.is-face-up {
  transform: rotateY(180deg);
}

.casino-card-back,
.casino-card-face {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: 10px;
  backface-visibility: hidden;
}

.casino-card-back {
  display: grid;
  place-items: center;
  border: 1px solid rgba(32,255,194,0.34);
  background:
    linear-gradient(135deg, transparent 44%, rgba(255,255,255,0.12) 44% 56%, transparent 56%),
    radial-gradient(circle at 50% 50%, rgba(255,190,61,0.24), transparent 22%),
    linear-gradient(145deg, #064f3a, #031813);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.30), 0 10px 20px rgba(0,0,0,0.28);
}

.casino-card-face {
  display: grid;
  grid-template-rows: 1fr 1.25fr;
  align-items: center;
  justify-items: center;
  transform: rotateY(180deg) rotateX(6deg) rotateZ(-0.6deg);
  border: 1px solid rgba(0,0,0,0.16);
  background: linear-gradient(145deg, #ffffff, #fffaf0 54%, #e9e2d8);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.82),
    inset 0 -8px 14px rgba(15,23,42,0.08),
    0 14px 28px rgba(0,0,0,0.22);
}

.casino-card-rank,
.casino-card-suit {
  position: relative;
  z-index: 2;
  color: var(--casino-suit-color);
  font-weight: 1000;
  line-height: 0.9;
}

.casino-card-rank {
  align-self: start;
  justify-self: start;
  padding: 8px 8px 0;
  font-size: clamp(18px, 2.2vw, 28px);
  letter-spacing: -0.08em;
}

.casino-card-suit {
  font-size: clamp(24px, 3.4vw, 42px);
  filter: drop-shadow(0 1px 0 rgba(255,255,255,0.9));
}

.size-mini .casino-card-rank {
  padding: 2px 3px 0;
  font-size: var(--font-size-micro);
}

.size-mini .casino-card-suit {
  font-size: 12px;
}

.casino-hand {
  display: flex;
  justify-content: center;
  gap: 0;
  perspective: 760px;
}

.casino-dock-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
  gap: clamp(10px, 1.5vw, 16px);
}

.casino-dock-card {
  overflow: hidden !important;
  border: 1px solid rgba(255,255,255,0.12) !important;
  border-radius: 24px !important;
  background: rgba(2, 12, 9, 0.56) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 20px 48px rgba(0,0,0,0.26) !important;
  backdrop-filter: blur(14px);
}

.casino-player-dock {
  min-height: 100%;
}

.casino-player-dock-main {
  display: grid;
  grid-template-columns: minmax(170px, 0.8fr) minmax(0, 1.2fr);
  gap: clamp(12px, 1.8vw, 18px);
  align-items: stretch;
}

.casino-pocket-panel,
.casino-command-panel {
  display: grid;
  align-content: center;
  gap: 12px;
  min-width: 0;
}

.casino-pocket-panel {
  justify-items: center;
  border: 1px solid rgba(32, 255, 194, 0.14);
  border-radius: 20px;
  background:
    radial-gradient(circle at 50% 0%, rgba(32,255,194,0.12), transparent 36%),
    rgba(0, 19, 14, 0.40);
  padding: 14px;
}

.casino-pocket-label {
  color: rgba(209, 250, 229, 0.80);
  font-size: 12px;
  font-weight: 950;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.casino-side-dock {
  display: grid;
  gap: clamp(10px, 1.5vw, 16px);
  min-width: 0;
}

.casino-tools-dock {
  display: grid;
  gap: 10px;
}

.casino-tools-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.casino-share-drawer {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms ease-out;
}

.casino-share-drawer.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.casino-share-drawer > div {
  overflow: hidden;
}

.casino-tools-dock .casino-join-panel {
  grid-template-columns: 1fr;
}

.casino-tools-dock .casino-qr-frame {
  width: min(100%, 180px);
}

.casino-action-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.casino-action-grid button,
.casino-setup button {
  min-height: 46px;
  border-radius: 16px !important;
  cursor: pointer;
  font-weight: 1000 !important;
  letter-spacing: -0.04em;
  touch-action: manipulation;
}

.casino-action-button {
  justify-content: space-between !important;
  min-height: 50px !important;
  padding-inline: 16px !important;
  border: 1px solid rgba(255,255,255,0.12) !important;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.94), rgba(209,250,229,0.88)) !important;
  color: #00130e !important;
  box-shadow: inset 0 2px 0 rgba(255,255,255,0.92), 0 15px 30px rgba(0,0,0,0.20) !important;
}

.casino-action-button:not(:disabled):hover {
  transform: translateY(-1px);
}

.casino-action-button.is-raise {
  background:
    linear-gradient(145deg, rgba(32,255,194,0.23), rgba(255,255,255,0.08)),
    rgba(2, 18, 13, 0.88) !important;
  color: #d1fae5 !important;
}

.casino-action-button.is-all-in {
  background:
    linear-gradient(145deg, rgba(255,190,61,0.28), rgba(255,255,255,0.08)),
    rgba(26, 15, 2, 0.88) !important;
  color: var(--casino-gold) !important;
}

.casino-action-button:disabled {
  transform: none !important;
}

.casino-raise-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  border: 1px solid rgba(255,190,61,0.24);
  border-radius: 18px;
  background: rgba(26, 15, 2, 0.42);
  padding: 8px;
}

.casino-raise-input {
  min-width: 0;
  min-height: 42px;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 14px;
  background: rgba(0, 19, 14, 0.70);
  color: white;
  font: inherit;
  font-size: 16px;
  font-weight: 950;
  padding: 8px 12px;
}

.casino-next-hand-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.casino-next-hand-button {
  min-width: 180px;
  border: 1px solid rgba(32,255,194,0.50) !important;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.95), rgba(209,250,229,0.88)) !important;
  color: #00130e !important;
  box-shadow: inset 0 2px 0 rgba(255,255,255,0.92), 0 16px 34px rgba(32,255,194,0.16) !important;
}

.casino-action-grid button:disabled,
.casino-setup button:disabled {
  cursor: not-allowed;
}

.casino-setup .casino-primary-action {
  min-width: min(100%, 240px);
  border: 1px solid rgba(32, 255, 194, 0.50) !important;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.95), rgba(209, 250, 229, 0.88)) !important;
  color: #00130e !important;
  box-shadow: inset 0 2px 0 rgba(255,255,255,0.9), 0 18px 38px rgba(32,255,194,0.18) !important;
}

.casino-setup .casino-primary-action:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: inset 0 2px 0 rgba(255,255,255,0.95), 0 22px 48px rgba(32,255,194,0.26) !important;
}

.casino-create-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.casino-create-helper {
  display: inline-flex;
  min-height: 46px;
  align-items: center;
  border: 1px solid rgba(32, 255, 194, 0.12);
  border-radius: 16px;
  background: rgba(2, 18, 13, 0.48);
  color: rgba(209, 250, 229, 0.76) !important;
  font-size: 15px !important;
  font-weight: 800 !important;
  line-height: 1.25;
  padding: 0 16px;
}

.casino-crew-grid {
  display: grid;
  gap: 9px;
}

.casino-crew-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  border: 1px solid rgba(32, 255, 194, 0.15);
  border-radius: 16px;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025)),
    rgba(0, 19, 14, 0.46);
  padding: 10px 12px;
}

.casino-crew-name {
  color: white;
  font-size: 16px;
  font-weight: 950;
  letter-spacing: -0.02em;
}

.casino-stake-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.casino-stake-summary div {
  display: grid;
  min-height: 64px;
  align-content: center;
  gap: 4px;
  border: 1px solid rgba(32, 255, 194, 0.15);
  border-radius: 18px;
  background:
    linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025)),
    rgba(0, 19, 14, 0.46);
  padding: 10px 12px;
}

.casino-stake-summary span {
  color: var(--casino-muted);
  font-size: var(--font-size-caption);
  font-weight: 850;
  text-transform: uppercase;
}

.casino-stake-summary strong {
  color: white;
  font-size: clamp(18px, 3vw, 26px);
  font-weight: 1000;
  letter-spacing: -0.055em;
}

.casino-chip {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.32);
  background:
    radial-gradient(circle at 32% 24%, rgba(255,255,255,0.92), transparent 23%),
    linear-gradient(135deg,#ffd86b,#b65f13 58%,#3a1703);
  box-shadow: inset 0 0 0 4px rgba(0,0,0,0.14), 0 7px 15px rgba(0,0,0,0.32);
}

@media (max-width: 1060px) {
  .casino-dock-grid {
    grid-template-columns: 1fr;
  }

  .casino-player-dock-main {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .casino-setup {
    border-radius: 26px !important;
  }

  .casino-setup-title {
    font-size: clamp(44px, 14vw, 74px);
    letter-spacing: -0.07em;
  }

  .casino-join-panel {
    grid-template-columns: 1fr;
  }

  .casino-stake-summary {
    grid-template-columns: 1fr;
  }

  .casino-qr-frame {
    width: min(72vw, 260px);
  }

  .casino-night {
    min-height: auto;
    border-radius: 22px !important;
  }

  .casino-shell {
    padding: 10px;
  }

  .casino-scoreboard {
    align-items: start;
    flex-direction: column;
  }

  .casino-meta {
    justify-content: start;
  }

  .casino-felt {
    min-height: min(112vw, 520px);
    border-width: 10px;
  }

  .casino-seat {
    width: 80px !important;
    padding: 5px !important;
    border-radius: 14px !important;
  }

  .casino-seat-name {
    font-size: var(--font-size-caption);
  }

  .casino-seat-chips {
    font-size: 14px;
  }

  .casino-action-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@keyframes casino-winner-drop {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes casino-winner-pulse {
  0% {
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.28),
      0 0 0 0 rgba(255,190,61,0.36),
      0 0 36px rgba(255,190,61,0.30),
      0 28px 58px rgba(0,0,0,0.42);
  }
  100% {
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.28),
      0 0 0 12px rgba(255,190,61,0),
      0 0 48px rgba(255,190,61,0.42),
      0 28px 58px rgba(0,0,0,0.42);
  }
}

@media (prefers-reduced-motion: reduce) {
  .casino-winner-callout,
  .casino-seat.is-winner {
    animation: none;
  }
}
`;

export function PokerTableStyles() {
  return <style>{POKER_TABLE_SURFACE_CSS}</style>;
}

const SUIT_VIEW = Object.freeze(Object.fromEntries(
  POKER_RULES_STATE_MACHINE.suitAppearance.map((appearance) => [appearance.suit, appearance]),
));

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function seatStatus(seat: PokerSeatView): { label: string; variant: 'success' | 'warning' | 'error' | 'info' | 'accent' | 'muted' | 'neutral' } {
  if (seat.isEliminated) return { label: 'out', variant: 'muted' };
  if (seat.isFolded) return { label: 'folded', variant: 'neutral' };
  if (seat.isAllIn) return { label: 'all-in', variant: 'warning' };
  if (seat.isActive) return { label: 'turn', variant: 'success' };
  return { label: 'in', variant: 'muted' };
}

function PlayingCard({
  card,
  hidden,
  empty,
  tilt = 0,
  size = 'board',
}: {
  card?: PokerCard;
  hidden?: boolean;
  empty?: boolean;
  tilt?: number;
  size?: 'hero' | 'board' | 'mini';
}) {
  const suit = card ? SUIT_VIEW[card.suit] : null;
  const isFaceUp = Boolean(card && !hidden);
  const cardBackSymbol = POKER_RULES_STATE_MACHINE.suitAppearance[0]?.symbol ?? '';

  return (
    <div className={cn('casino-card-wrap', `size-${size}`)} style={{ transform: `rotate(${tilt}deg)` }}>
      <div className={cn('casino-card-inner', isFaceUp && 'is-face-up')}>
        <div className="casino-card-back">
          <Text as="span" variant="caption" weight="bold" className="text-white">
            {empty ? '' : cardBackSymbol}
          </Text>
        </div>
        {card && (
          <div
            aria-label={`${card.rank} of ${suit?.label}`}
            className="casino-card-face"
            style={{ '--casino-suit-color': suit?.color } as React.CSSProperties}
          >
            <Text as="span" weight="bold" className="casino-card-rank">
              {card.rank}
            </Text>
            <Text as="span" weight="bold" className="casino-card-suit">
              {suit?.symbol}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}

function CardDeck({
  cards,
  count,
  revealed,
  size = 'board',
  onClick,
  label,
}: {
  cards?: readonly PokerCard[];
  count?: number;
  revealed?: boolean;
  size?: 'hero' | 'board' | 'mini';
  onClick?: () => void;
  label?: string;
}) {
  const visibleCount = Math.max(0, Math.min(2, count ?? cards?.length ?? 2));
  const Wrapper = onClick ? 'button' : 'div';

  if (visibleCount === 0) return null;

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'casino-hand',
        onClick && 'rounded-2xl outline-none transition-transform active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[#20ffc2]',
      )}
    >
      {Array.from({ length: visibleCount }).map((_, index) => (
        <div
          key={index}
          className={cn(index > 0 && (size === 'mini' ? '-ml-4' : '-ml-5'))}
          style={{ transform: `translateY(${index % 2}px) rotate(${index === 0 ? -5 : 4}deg)` }}
        >
          <PlayingCard
            card={cards?.[index]}
            hidden={!revealed || !cards?.[index]}
            empty={!cards?.[index]}
            size={size}
          />
        </div>
      ))}
    </Wrapper>
  );
}

function ChipLine({ amount }: { amount: number }) {
  return (
    <Container layout="horizontal" alignItems="center" gap="xs">
      <div className="casino-chip" />
      <Text as="span" variant="body-xs" weight="bold" tabular>{formatNumber(amount)}</Text>
    </Container>
  );
}

function SeatMarker({ seat, index, total, resultVisible }: { seat: PokerSeatView; index: number; total: number; resultVisible: boolean }) {
  const angle = -90 + (360 / Math.max(total, 1)) * index;
  const radiusX = total > 6 ? 39 : 40;
  const radiusY = total > 6 ? 34 : 35;
  const x = 50 + radiusX * Math.cos((angle * Math.PI) / 180);
  const y = 50 + radiusY * Math.sin((angle * Math.PI) / 180);
  const status = seatStatus(seat);

  return (
    <Card
      variant="nested"
      padding="none"
      className={cn(
        'casino-seat',
        seat.isActive && 'is-turn',
        seat.isEliminated && 'is-out',
        resultVisible && !seat.isWinner && 'is-dimmed',
        seat.isWinner && 'is-winner',
      )}
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      <Container layout="horizontal" justifyContent="between" alignItems="center" gap="xs" className="min-w-0">
        <Text variant="body-xs" weight="bold" truncate title={seat.name} className="casino-seat-name">
          {seat.name}
        </Text>
        <div className={cn('h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_10px_currentColor]', seat.isConnected ? 'bg-status-success text-status-success' : 'bg-status-error text-status-error')} />
      </Container>
      <div className="casino-seat-bank">
        <div>
          <div className="casino-seat-sub">stack</div>
          <div className="casino-seat-chips">{formatNumber(seat.chips)}</div>
        </div>
        <CardDeck cards={seat.publicCards} count={seat.cardCount} revealed={seat.cardsVisible} size="mini" />
      </div>
      <Container layout="horizontal" justifyContent="between" alignItems="center" gap="xs" wrap>
        <Badge variant={status.variant} size="sm" weight="bold">{status.label}</Badge>
        {seat.currentBet > 0 && <Badge variant="success" size="sm" weight="bold">bet {formatNumber(seat.currentBet)}</Badge>}
        {seat.roles.map((role) => <Badge key={role} variant="info" size="sm" weight="bold">{role}</Badge>)}
      </Container>
    </Card>
  );
}

function TableCore({ view }: { view: PokerTableView }) {
  const activeSeat = view.seats.find((seat) => seat.isActive);
  const communitySlots = Array.from({ length: 5 });
  const winnerText = view.handResult?.label;

  return (
    <div className="casino-felt" aria-label="Poker felt">
      <Card variant="nested" padding="none" className="casino-center">
        <Container layout="horizontal" justifyContent="center" alignItems="center" gap="xs">
          <Icon icon={CircleDollarSign} size="sm" color="success" />
          <Text variant="caption" weight="bold" color="faint">MAIN</Text>
        </Container>
        {view.handResult && (
          <div className="casino-winner-callout" aria-live="polite">
            <span>Winner</span>
            <strong>{winnerText}</strong>
            {view.handResult.pot > 0 && <em>{formatNumber(view.handResult.pot)} chips</em>}
          </div>
        )}
        <Text as="div" className="casino-pot-label" tabular>
          {view.handResult ? 'Hand over' : `Pot ${formatNumber(view.pot)}`}
        </Text>
        <div className="casino-board">
          {communitySlots.map((_, index) => (
            <PlayingCard
              key={index}
              card={view.communityCards[index]}
              hidden={!view.communityCards[index]}
              empty={!view.communityCards[index]}
              size="board"
              tilt={(index - 2) * 1.35}
            />
          ))}
        </div>
        <div className="casino-turn-line">
          <span>{winnerText ?? (activeSeat ? `${activeSeat.name} to act` : 'waiting for action')}</span>
          <span>hand {view.handNumber}</span>
        </div>
      </Card>
      {view.seats.map((seat, index) => (
        <SeatMarker key={seat.id} seat={seat} index={index} total={view.seats.length} resultVisible={Boolean(view.handResult)} />
      ))}
    </div>
  );
}

function PocketCards({ hand }: { hand: PokerPrivateHandView }) {
  const [isPeeked, setIsPeeked] = useState(!hand.hidden);
  const canPeek = hand.canToggle && hand.cards.length > 0;
  const revealed = canPeek ? isPeeked : !hand.hidden;

  useEffect(() => {
    setIsPeeked(!hand.hidden);
  }, [hand.hidden, hand.ownerId, hand.cards.map((card) => card.code).join('|')]);

  return (
    <div className="casino-pocket-panel">
      <Container layout="horizontal" alignItems="center" gap="xs">
        <Icon icon={revealed ? Eye : EyeOff} size="sm" color={revealed ? 'success' : 'muted'} />
        <span className="casino-pocket-label">Hand</span>
      </Container>
      <CardDeck
        cards={hand.cards}
        count={2}
        revealed={revealed}
        size="hero"
        label={revealed ? 'Hide your hand' : 'Reveal your hand'}
        onClick={canPeek ? () => setIsPeeked((value) => !value) : undefined}
      />
    </div>
  );
}

function CommandPanel({ controls, view }: { controls?: PokerTablePanelControls; view: PokerTableView }) {
  const phases = POKER_RULES_STATE_MACHINE.phaseRoles;
  const actions = POKER_RULES_STATE_MACHINE.playerActionRoles;
  const canAdvanceHand = view.phase === phases.showdown || view.phase === phases.finished;
  const raiseControl = view.controls.find((control) => control.action === actions.raise);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseAmount, setRaiseAmount] = useState(() => raiseControl?.minAmount ?? view.bigBlind);

  useEffect(() => {
    setRaiseAmount(raiseControl?.minAmount ?? view.bigBlind);
  }, [raiseControl?.minAmount, view.bigBlind, view.handNumber, view.currentBet]);

  return (
    <div className="casino-command-panel">
      <div className="casino-action-grid">
        {view.controls.map((control) => {
          const isRaise = control.action === actions.raise;
          const isAllIn = control.action === actions.allIn;
          return (
            <Button
              key={control.action}
              type="button"
              size="sm"
              variant="secondary"
              disabled={!control.enabled}
              className={cn('casino-action-button', isRaise && 'is-raise', isAllIn && 'is-all-in')}
              onClick={() => {
                if (isRaise) {
                  setRaiseOpen((open) => !open);
                  return;
                }
                controls?.onAction?.(control.action);
              }}
            >
              <span>{control.label}</span>
              {control.amountRequired ? <span>{formatNumber(control.amountRequired)}</span> : null}
            </Button>
          );
        })}
      </div>
      {raiseOpen && raiseControl?.enabled && (
        <div className="casino-raise-panel">
          <input
            aria-label="Raise amount"
            className="casino-raise-input"
            min={raiseControl.minAmount ?? 1}
            step={Math.max(1, raiseControl.minAmount ?? 1)}
            type="number"
            value={raiseAmount}
            onChange={(event) => setRaiseAmount(Math.max(1, Math.round(Number(event.target.value) || 1)))}
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => setRaiseOpen(false)}>
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            variant="success"
            onClick={() => {
              controls?.onAction?.(actions.raise, Math.max(raiseControl.minAmount ?? 1, raiseAmount));
              setRaiseOpen(false);
            }}
          >
            Raise
          </Button>
        </div>
      )}
      <Container layout="horizontal" gap="sm" wrap>
        {controls?.onAdvanceStreet && (
          <Button type="button" size="sm" variant={controls.canAdvanceStreet ? 'success' : 'secondary'} disabled={!controls.canAdvanceStreet} onClick={controls.onAdvanceStreet}>
            {controls.nextStreetLabel ?? 'Next street'}
          </Button>
        )}
      </Container>
      {canAdvanceHand && controls?.onNextHand && (
        <div className="casino-next-hand-row">
          <Button type="button" size="lg" variant="success" className="casino-next-hand-button" onClick={controls.onNextHand}>
            Next hand
          </Button>
        </div>
      )}
    </div>
  );
}

function PlayerDock({ controls, view }: { controls?: PokerTablePanelControls; view: PokerTableView }) {
  return (
    <Card variant="nested" padding="sm" className="casino-dock-card casino-player-dock">
      <div className="casino-player-dock-main">
        <PocketCards hand={view.privateHand} />
        <CommandPanel controls={controls} view={view} />
      </div>
    </Card>
  );
}

function CrewDock({ controls, currentPlayerId, seats }: { controls?: PokerTablePanelControls; currentPlayerId: string | null; seats: PokerSeatView[] }) {
  const [confirmKickId, setConfirmKickId] = useState<string | null>(null);

  return (
    <Card variant="nested" padding="sm" className="casino-dock-card">
      <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm" className="mb-3">
        <Container layout="horizontal" alignItems="center" gap="sm">
          <Icon icon={Crown} size="sm" color="warning" />
          <Text variant="body-xs" weight="bold">Table crew</Text>
        </Container>
      </Container>
      <div className="casino-crew-grid">
        {seats.slice(0, 6).map((seat) => (
          <div key={seat.id} className="casino-crew-row">
            <Text variant="body-xs" weight="semibold" truncate>{seat.name}</Text>
            <Button
              type="button"
              size="sm"
              variant={confirmKickId === seat.id ? 'danger' : 'secondary'}
              disabled={seat.isEliminated || seat.id === currentPlayerId || !controls?.onKickPlayer}
              onClick={() => {
                if (confirmKickId === seat.id) {
                  controls?.onKickPlayer?.(seat.id);
                  setConfirmKickId(null);
                  return;
                }
                setConfirmKickId(seat.id);
              }}
            >
              {confirmKickId === seat.id ? 'Confirm' : 'Kick'}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Scoreboard({ view }: { view: PokerTableView }) {
  return (
    <div className="casino-scoreboard">
      <div className="casino-title-lockup">
        <div className="casino-title-mark">
          <Icon icon={Club} size="lg" color="success" />
        </div>
        <Text weight="bold" truncate className="casino-title">
          Poker Table
        </Text>
      </div>
    </div>
  );
}

export function PokerTablePanel({
  state,
  currentPlayerId,
  projection,
  controls,
}: {
  state: PokerHandState;
  currentPlayerId: string | null;
  projection?: PokerTableProjectionInput;
  controls?: PokerTablePanelControls;
}) {
  const view = derivePokerTableViewModel(state, currentPlayerId, projection);

  return (
    <ScrollableSurface>
      <PokerTableStyles />
      <Card
        variant="surface"
        padding="none"
        layout="stack"
        minHeight="0"
        width="full"
        aria-label="Poker table"
        className="w-full min-w-0 casino-night"
      >
        <div className="casino-shell">
          <Scoreboard view={view} />
          <TableCore view={view} />
          <div className="casino-dock-grid">
            <PlayerDock controls={controls} view={view} />
            <div className="casino-side-dock">
              {controls?.tableTools}
              <CrewDock controls={controls} seats={view.seats} currentPlayerId={currentPlayerId} />
            </div>
          </div>
        </div>
      </Card>
    </ScrollableSurface>
  );
}
