// tools/take-payments/web/src/workspace/checkout-screen-mount.tsx
//
// PURPOSE
//   The buyer checkout screen (tool:price-a-sale's screen) as a screen module: the one file the screen's row names
//   (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). The screen itself is ../../../packages/checkout/show/CheckoutFlow.tsx, moved
//   here byte for byte from bitfield-packages (moved-from.json) and edited only where it called the retired Bitfield
//   runtime (README.md lists each call). This file answers the targets that screen asks, for the seller connection and
//   the buyer the screen's input names, then mounts it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import mountCheckout from '../../../packages/checkout/show/mount-checkout';
import { answerCheckoutTargets } from './checkout-targets';

type CheckoutScreenInput = { seller_connection?: string; subject?: string; [key: string]: unknown };

export function mount(element: HTMLElement, props: CheckoutScreenInput = {}) {
  const { seller_connection: sellerConnection, subject, ...flow } = props;
  answerCheckoutTargets({ ...(sellerConnection ? { sellerConnection } : {}), ...(subject ? { subject } : {}) });
  return mountCheckout({ el: element, props: flow });
}
