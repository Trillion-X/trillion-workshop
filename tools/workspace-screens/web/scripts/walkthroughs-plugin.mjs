import { join } from 'node:path';

// The esbuild plugin that gives the page `import('trillion-walkthroughs')`: the shipped tours, read from the content-named
// file the build writes. scripts/build-workspace.mjs and the browser tests that bundle the workspace both use it.
export function walkthroughsPlugin({ publicNamed, toursName, walkthroughFiles, root }) {
  return {
    name: 'trillion-walkthroughs',
    setup(builder) {
      builder.onResolve({ filter: /^trillion-walkthroughs$/ }, () => ({ path: 'trillion-walkthroughs', namespace: 'trillion-walkthroughs' }));
      builder.onLoad({ filter: /.*/, namespace: 'trillion-walkthroughs' }, () => ({
        contents: `export default fetch(${JSON.stringify(`${publicNamed}${toursName}`)}).then(answer => { if (!answer.ok) throw new Error('The tours could not be read.'); return answer.json(); });\n`,
        loader: 'js',
        watchFiles: walkthroughFiles.map(file => join(root, file)),
      }));
    },
  };
}
