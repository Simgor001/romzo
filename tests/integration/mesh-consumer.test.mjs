import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync, existsSync, lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('published SDK surfaces load without RTC and typecheck without DOM', () => {
  const require = createRequire(import.meta.url);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const output = mkdtempSync(join(tmpdir(), 'romzo-mesh-consumer-'));
  try {
    const modules = join(output, 'node_modules'); mkdirSync(modules);
    // Consume the built package through its actual exports map, not src aliases.
    symlinkSync(resolve(root, 'packages/romzo-client'), join(modules, 'romzo'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(resolve(root, 'node_modules/@types'), join(modules, '@types'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module' }));
    const consumer = `import { attachMesh, MeshSession, type MeshOptions, type MeshPeerConnection, type MeshRtcConfiguration, type MeshDataChannel } from "romzo/mesh";
import { RelaySession, type Identity, type RoomBinding, type SignedDescriptor } from "romzo";
import { renderInviteQr, readInviteQr, scanInviteCamera, type QrVideo } from "romzo/qr";
declare const relay: RelaySession, identity: Identity, signedDescriptor: SignedDescriptor;
declare const factory: (config: MeshRtcConfiguration) => MeshPeerConnection;
const options: MeshOptions = { signedDescriptor, rtcPeerConnectionFactory: factory, rtcConfig: {iceServers:[{urls:"stun:example.test"}]} };
const binding: RoomBinding = relay.roomBinding;
const attached: Promise<MeshSession> = attachMesh(relay, identity, options);
void binding; void attached;
const svg: string = renderInviteQr("https://romzo.net/play.html#ABCD123XYZ/romzo.net");
void svg; void readInviteQr;
`;
    writeFileSync(join(output, 'consumer.ts'), consumer);
    const common = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true };
    for (const [name, lib, types] of [['node', ['ES2022'], ['node']], ['browser', ['ES2022', 'DOM'], []]]) {
      writeFileSync(join(output, 'consumer.ts'), consumer + (name === 'browser' ? `
const nativeOptions: MeshOptions = {signedDescriptor, rtcPeerConnectionFactory: config => new RTCPeerConnection(config)};
void nativeOptions;
void scanInviteCamera(document.createElement("video"));
` : ''));
      writeFileSync(join(output, `tsconfig.${name}.json`), JSON.stringify({ compilerOptions: { ...common, lib, types }, files: ['consumer.ts'] }));
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(output, `tsconfig.${name}.json`)], { stdio: 'pipe', windowsHide: true });
    }
    writeFileSync(join(output, 'runtime.mjs'), `import assert from 'node:assert/strict';
delete globalThis.RTCPeerConnection;
const root=await import('romzo'), mesh=await import('romzo/mesh');
const qr=await import('romzo/qr');
assert.equal(typeof root.renderInviteQr,'undefined');
assert.ok(qr.renderInviteQr('https://romzo.net/play.html#ABCD123XYZ/romzo.net').includes('<svg'));
assert.equal(root.MeshSession,mesh.MeshSession); assert.equal(root.attachMesh,mesh.attachMesh);
assert.equal(typeof mesh.attachMesh,'function');
`);
    execFileSync(process.execPath, [join(output, 'runtime.mjs')], { stdio: 'pipe', windowsHide: true });
    const manifest = JSON.parse(readFileSync(resolve(root, 'packages/romzo-client/package.json'), 'utf8'));
    assert.equal(manifest.exports['./mesh'].types, './dist/mesh.d.ts');
    assert.ok(manifest.files.includes('dist'));
  } catch (error) {
    if (error.stdout) console.error(error.stdout.toString());
    if (error.stderr) console.error(error.stderr.toString());
    throw error;
  } finally {
    if (dirname(resolve(output)) !== resolve(tmpdir())) throw Error('unexpected cleanup path');
    // Remove junctions explicitly before recursively cleaning the consumer temp directory.
    for (const name of ['romzo', '@types']) {
      const link = join(output, 'node_modules', name);
      if (!existsSync(link)) continue;
      if (!lstatSync(link).isSymbolicLink()) throw Error('consumer fixture link was replaced');
      // Never recursively walk a Windows junction: that can remove the target.
      if (process.platform === 'win32') rmdirSync(link); else unlinkSync(link);
    }
    rmSync(output, { force: true, recursive: true });
    assert.ok(existsSync(resolve(root, 'node_modules/@types/node/index.d.ts')), 'consumer cleanup removed installed Node types');
  }
});
