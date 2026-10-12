import { afterEach, expect, test, vi } from 'vitest';
import { generateKeyPair, importKeyPair, exportPrivateKey, sign, verify } from '../src/crypto.js';

afterEach(() => vi.restoreAllMocks());

function disableNativeEd25519() {
  for (const method of ['generateKey', 'importKey'] as const) {
    const original = crypto.subtle[method].bind(crypto.subtle);
    vi.spyOn(crypto.subtle, method).mockImplementation((...args: any[]) => {
      const algorithm = args[method === 'generateKey' ? 0 : 2];
      if ((typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'Ed25519')
        return Promise.reject(new DOMException('Unsupported algorithm', 'NotSupportedError'));
      return (original as Function)(...args);
    });
  }
}

test('fallback signatures and persisted keys interoperate with native Web Crypto', async () => {
  const native = await generateKeyPair();
  const exported = await exportPrivateKey(native.privateKey);
  const nativeSignature = await sign(native, { move: 1 }, 'test/domain');
  disableNativeEd25519();
  const imported = await importKeyPair(native.publicKey, exported);
  expect(await sign(imported, { move: 1 }, 'test/domain')).toBe(nativeSignature);
  expect(await verify(native.publicKey, { move: 1 }, 'test/domain', nativeSignature)).toBe(true);
  expect(await verify(native.publicKey, { move: 2 }, 'test/domain', nativeSignature)).toBe(false);
  expect(await verify(native.publicKey, { move: 1 }, 'other/domain', nativeSignature)).toBe(false);
  await expect(importKeyPair('00'.repeat(32), exported)).rejects.toThrow('key pair mismatch');
  await expect(importKeyPair(native.publicKey, '00')).rejects.toThrow();
  const fallback = await generateKeyPair();
  const saved = await exportPrivateKey(fallback.privateKey);
  const signature = await sign(fallback, { move: 3 }, 'test/domain');
  expect(await exportPrivateKey((await importKeyPair(fallback.publicKey, saved)).privateKey)).toBe(saved);
  vi.restoreAllMocks();
  const restored = await importKeyPair(fallback.publicKey, saved);
  expect(await sign(restored, { move: 3 }, 'test/domain')).toBe(signature);
  expect(await verify(fallback.publicKey, { move: 3 }, 'test/domain', signature)).toBe(true);
});

test('other native errors do not silently fall back', async () => {
  vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new DOMException('denied', 'OperationError'));
  await expect(generateKeyPair()).rejects.toThrow('denied');
});
