// package-set://bitfield-studio/packages/product-access/read-data/read-product-access.ts

import packageData from '@/packages/product-access/things-to-store-and-run.json';
import { decodeAccessControlRecords, type PackageThing } from './access-control-records';
import { projectAccessControlRecords, type ProductAccessView } from './access-control-projection';

function packageThings(): PackageThing[] {
  return Array.isArray(packageData.things) ? packageData.things as PackageThing[] : [];
}

export function readProductAccessView(rawThings: readonly PackageThing[] = packageThings()): ProductAccessView {
  return projectAccessControlRecords(decodeAccessControlRecords(rawThings));
}

export type {
  AccessItemStatus,
  ProductAccessActionDescriptor,
  ProductAccessItem,
  ProductAccessLine,
  ProductAccessProofRow,
  ProductAccessView,
} from './access-control-projection';

