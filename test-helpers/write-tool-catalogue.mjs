// Rewrites the README's tool catalogue from every folder's what-this-tool-does-and-how-to-run-it.json. Run after a tool row is added, changed or removed:
//   node test-helpers/write-tool-catalogue.mjs
import { catalogueBlock, readReadme, spliceCatalogue, writeReadme, readmePath } from './tool-catalogue.mjs';

writeReadme(spliceCatalogue(readReadme(), catalogueBlock()));
console.log(`Wrote the tool catalogue to ${readmePath}`);
