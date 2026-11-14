import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui/show/react-surface-mount';
import { CustomerFollowUpSurface } from '@/packages/customer-follow-up/show/CustomerFollowUpSurface';

type MountProps = {
  actor_id?: string;
  actorId?: string;
  product_id?: string;
  productId?: string;
};

export function mountCustomerFollowUp({ el, props = {} }: ReactMaterialMountArgs) {
  const mountProps = props as MountProps;
  return mountReactMaterial(
    el,
    React.createElement(CustomerFollowUpSurface, {
      actorId: mountProps.actor_id ?? mountProps.actorId,
      productId: mountProps.product_id ?? mountProps.productId,
    }),
    props,
    'Customer Follow-Up',
  );
}

export default mountCustomerFollowUp;
