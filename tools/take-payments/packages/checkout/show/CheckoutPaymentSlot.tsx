'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  CheckoutCustomer,
  CheckoutMaterialResponse,
  CheckoutStartPayload,
} from '../../../read-data/checkout-contract';

export type CheckoutPaymentSubmitState = {
  ready: boolean;
  submit: (() => void) | null;
  submitting: boolean;
};

const PAYMENT_MATERIAL_MISSING =
  'Payment material is not available for this checkout.';

function readPaymentMaterialTarget(checkout: CheckoutMaterialResponse) {
  return typeof checkout.paymentMaterialTarget === 'string'
    ? checkout.paymentMaterialTarget.trim()
    : '';
}

export function CheckoutPaymentSlot({
  checkout,
  checkoutRequest,
  customer,
  disabled,
  flat,
  onComplete,
  onSubmitStateChange,
  startTarget,
}: {
  checkout: CheckoutMaterialResponse;
  checkoutRequest: CheckoutStartPayload;
  customer: CheckoutCustomer;
  disabled: boolean;
  flat?: boolean;
  onComplete: () => void;
  onSubmitStateChange: (state: CheckoutPaymentSubmitState) => void;
  startTarget: string;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const latestRenderRef = useRef({
    checkout,
    checkoutRequest,
    customer,
    disabled,
    flat: Boolean(flat),
    onComplete,
    startTarget,
  });
  const submitStateChangeRef = useRef(onSubmitStateChange);
  const [status, setStatus] = useState('Loading payment provider...');
  const materialTarget = readPaymentMaterialTarget(checkout);

  latestRenderRef.current = {
    checkout,
    checkoutRequest,
    customer,
    disabled,
    flat: Boolean(flat),
    onComplete,
    startTarget,
  };

  useEffect(() => {
    submitStateChangeRef.current = onSubmitStateChange;
  }, [onSubmitStateChange]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const mountElement: HTMLElement = mount;

    let disposed = false;
    let handled = false;
    let retryTimer: number | null = null;
    if (!materialTarget) {
      setStatus(PAYMENT_MATERIAL_MISSING);
      return undefined;
    }

    function requestRender() {
      if (disposed) return;
      const latest = latestRenderRef.current;

      window.dispatchEvent(new CustomEvent(materialTarget, {
        detail: {
          checkout: latest.checkout,
          checkoutRequest: latest.checkoutRequest,
          customer: latest.customer,
          disabled: latest.disabled,
          fail(message: string) {
            if (!disposed) setStatus(message);
          },
          flat: latest.flat,
          handled() {
            handled = true;
            if (!disposed) setStatus('');
          },
          materialTarget,
          mount: mountElement,
          onComplete: latest.onComplete,
          onSubmitStateChange: submitStateChangeRef.current,
          startTarget: latest.startTarget,
        },
      }));
    }

    function requestClear() {
      window.dispatchEvent(
        new CustomEvent(materialTarget, { detail: { mount: mountElement } }),
      );
    }

    requestRender();
    retryTimer = window.setInterval(() => {
      if (handled || disposed) {
        if (retryTimer !== null) window.clearInterval(retryTimer);
        retryTimer = null;
        return;
      }
      requestRender();
    }, 80);
    const missingTimer = window.setTimeout(() => {
      if (retryTimer !== null) window.clearInterval(retryTimer);
      retryTimer = null;
      if (!disposed && !handled) setStatus(PAYMENT_MATERIAL_MISSING);
    }, 1000);

    return () => {
      disposed = true;
      window.clearTimeout(missingTimer);
      if (retryTimer !== null) window.clearInterval(retryTimer);
      submitStateChangeRef.current({
        ready: false,
        submit: null,
        submitting: false,
      });
      requestClear();
    };
  }, [materialTarget]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !materialTarget) return;
    const latest = latestRenderRef.current;
    window.dispatchEvent(
      new CustomEvent(materialTarget, {
        detail: {
          checkout: latest.checkout,
          checkoutRequest: latest.checkoutRequest,
          customer: latest.customer,
          disabled: latest.disabled,
          fail(message: string) {
            setStatus(message);
          },
          flat: latest.flat,
          handled() {
            setStatus('');
          },
          materialTarget,
          mount,
          onComplete: latest.onComplete,
          onSubmitStateChange: submitStateChangeRef.current,
          startTarget: latest.startTarget,
        },
      }),
    );
  }, [
    checkout,
    checkoutRequest,
    customer,
    disabled,
    flat,
    materialTarget,
    onComplete,
    startTarget,
  ]);

  return (
    <div className="pricing-provider-payment-slot" ref={mountRef}>
      {status ? (
        <p className="pricing-checkout-error" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
