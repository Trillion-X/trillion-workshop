// parts/ui/show/provider-mark/shipped-provider-icons.ts
//
// PURPOSE
//   The provider-icon rows this part ships in things-to-store-and-run.json,
//   read once. Every mark that draws a channel or service logo reads this one
//   list, so adding a logo is one DATA row and no caller has to remember to
//   pass it (a card that was handed an empty list drew a plain letter where
//   the logo belonged).
import uiManifest from 'trillion-workshop/tools/ui/things-to-store-and-run.json';
import type {ProviderIconRegistryRow} from './provider-icon-registry';

export const providerIconRegistry: ProviderIconRegistryRow[] = (uiManifest.things as any[]).filter(row => row.payload?.kind === 'provider-icon');
