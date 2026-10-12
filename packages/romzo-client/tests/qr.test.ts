import { afterEach, expect, test, vi } from "vitest";
import encodeQR from "qr";
import { renderInviteQr, readInviteQr, scanInviteCamera, type QrVideo } from "../src/qr.js";
import { parseInviteText } from "../src/invite.js";

const link = "https://romzo.net/play.html#ABCD123XYZ/romzo.net";
function pixels(text = link) {
  const matrix = encodeQR(text, "raw", { border: 4, scale: 1 });
  const width = matrix.length * 4, data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4, white = matrix[Math.floor(y / 4)][Math.floor(x / 4)] ? 0 : 255;
    data[p] = data[p + 1] = data[p + 2] = white; data[p + 3] = 255;
  }
  return { width, height: width, data };
}
function camera(image = pixels(), getUserMedia?: () => Promise<unknown>) {
  const stop = vi.fn(), stream = { getTracks: () => [{ stop }] };
  const video = { srcObject: null as unknown, muted: false, playsInline: false, readyState: 2, videoWidth: image.width, videoHeight: image.height,
    play: vi.fn(async () => {}), pause: vi.fn() } satisfies QrVideo;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: getUserMedia ?? vi.fn(async () => stream) } });
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ drawImage: vi.fn(), getImageData: () => image }) }) });
  vi.stubGlobal("BarcodeDetector", undefined);
  return { video, stop, stream };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("invitation QR round-trips real RGBA pixels, preserving room and relay", async () => {
  expect(renderInviteQr(link)).toContain("<svg");
  expect(await readInviteQr(pixels())).toEqual({ code: "ABCD123XYZ", origin: "https://romzo.net" });
  const local = "http://127.0.0.1:7100/play.html#ABCD123XYZ/127.0.0.1:9224";
  expect(await readInviteQr(pixels(local), { allowLoopbackHttp: true })).toEqual({ code: "ABCD123XYZ", origin: "http://127.0.0.1:9224" });
});
test("non-invitation QR and malformed pixels are rejected rather than navigated", async () => {
  for (const input of ["javascript:alert(1)", "https://" + "user:pass@romzo.net/play.html#ABCD123XYZ/romzo.net", "https://romzo.net/?token=secret#ABCD123XYZ/romzo.net", "http://remote.example/#ABCD123XYZ/romzo.net"])
    expect(() => renderInviteQr(input)).toThrow("not_an_invite");
  await expect(readInviteQr(pixels("https://example.com/not-a-room"))).rejects.toThrow("not_an_invite");
  await expect(readInviteQr({ width: 100, height: 100, data: new Uint8Array(10) })).rejects.toThrow("invalid_image");
  await expect(readInviteQr({ width: 40, height: 40, data: new Uint8Array(40 * 40 * 4) })).rejects.toThrow("qr_not_found");
});
test("native camera detection returns an address and releases tracks and video", async () => {
  const { video, stop } = camera();
  vi.stubGlobal("BarcodeDetector", class { static async getSupportedFormats() { return ["qr_code"]; } async detect() { return [{ rawValue: link }]; } });
  expect(await scanInviteCamera(video)).toEqual(parseInviteText(link));
  expect(stop).toHaveBeenCalledTimes(1); expect(video.srcObject).toBeNull(); expect(video.muted).toBe(false); expect(video.playsInline).toBe(false);
});
test("software camera fallback scans real image data when native detection is absent", async () => {
  const { video, stop } = camera();
  expect(await scanInviteCamera(video)).toEqual(parseInviteText(link)); expect(stop).toHaveBeenCalledTimes(1);
});
test("permission denied and unsupported environments produce actionable errors", async () => {
  const { video } = camera(undefined, async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); });
  await expect(scanInviteCamera(video)).rejects.toThrow("camera_denied");
  vi.stubGlobal("navigator", {}); await expect(scanInviteCamera(video)).rejects.toThrow("camera_unavailable");
});
test("cancellation during pending permission releases a camera that arrives late", async () => {
  let acquire!: (s: unknown) => void;
  const { video, stop, stream } = camera(undefined, () => new Promise(resolve => { acquire = resolve; }));
  const controller = new AbortController(), result = scanInviteCamera(video, { signal: controller.signal });
  controller.abort(); await expect(result).rejects.toThrow("aborted");
  acquire(stream); await Promise.resolve(); expect(stop).toHaveBeenCalledTimes(1); expect(video.srcObject).toBeNull();
});
test("aborted and timed-out scans do not retain owned resources", async () => {
  const { video, stop } = camera();
  video.readyState = 0; // No usable frame: timeout must release the stream.
  await expect(scanInviteCamera(video, { timeoutMs: 20 })).rejects.toThrow("scan_timeout"); expect(stop).toHaveBeenCalledTimes(1);
  const controller = new AbortController(); controller.abort();
  await expect(scanInviteCamera(video, { signal: controller.signal })).rejects.toThrow("aborted");
  video.srcObject = {}; await expect(scanInviteCamera(video)).rejects.toThrow("video_in_use");
});
