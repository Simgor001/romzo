import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

// Deploy the current SDK with the website; no import maps or third-party CDN.
const result = await build({
  entryPoints: {
    romzo: fileURLToPath(new URL('../packages/romzo-client/src/index.ts', import.meta.url)),
    storage: fileURLToPath(new URL('../packages/romzo-client/src/storage.ts', import.meta.url)),
    qr: fileURLToPath(new URL('../packages/romzo-client/src/qr.ts', import.meta.url)),
  },
  outdir: fileURLToPath(new URL('../website/sdk/', import.meta.url)),
  bundle: true, format: 'esm', platform: 'browser',
  splitting: true, chunkNames: 'chunks/[name]-[hash]',
  metafile: true,
  target: 'es2020', minify: true,
  legalComments: 'eof',
});
// Remove only obsolete esbuild-named chunks in this generated directory.
const chunks = fileURLToPath(new URL('../website/sdk/chunks/', import.meta.url));
const emitted = new Set(Object.keys(result.metafile.outputs).map(path => resolve(path)));
for (const item of await readdir(chunks, { withFileTypes: true })) {
  if (!item.isFile() || !/^(chunk|decode)-[A-Z0-9]{8}\.js$/.test(item.name)) continue;
  const file = resolve(chunks, item.name);
  if (!emitted.has(file)) await unlink(file);
}
await copyFile(new URL('../node_modules/qr/LICENSE-MIT', import.meta.url), new URL('../website/sdk/qr-LICENSE.txt', import.meta.url));
