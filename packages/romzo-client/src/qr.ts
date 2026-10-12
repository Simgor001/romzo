import encodeQR from "qr";
import { parseInviteText, type InviteAddress, type InviteOptions } from "./invite.js";

export interface QrImage { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
/** A real HTMLVideoElement satisfies this interface without exposing DOM types. */
export interface QrVideo {
  srcObject: unknown;
  muted: boolean;
  playsInline: boolean;
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  play(): Promise<void>;
  pause(): void;
}
export interface QrCameraOptions extends InviteOptions {
  signal?: AbortSignal;
  /** Maximum active scan time, including camera permission. Default 60000. */
  timeoutMs?: number;
}
export class InviteQrError extends Error {
  constructor(readonly code: string) { super(`invite QR: ${code}`); this.name = "InviteQrError"; }
}
function invitation(text: string, options: InviteOptions): InviteAddress {
  const address = parseInviteText(text, options);
  if (!address) throw new InviteQrError("not_an_invite");
  return address;
}
/** SVG with a four-module quiet zone. Encodes the entire validated invite. */
export function renderInviteQr(invite: string, options: InviteOptions = {}): string {
  invitation(invite, options);
  const svg = encodeQR(invite, "svg", { border: 4, ecc: "medium" });
  // Keep the quiet zone opaque when saved or rasterized outside our white UI.
  return svg.replace(/(<svg[^>]*>)/, '$1<rect width="100%" height="100%" fill="white"/>');
}
/** Decode local RGBA pixels. The software decoder loads only on first use. */
export async function readInviteQr(image: QrImage, options: InviteOptions = {}): Promise<InviteAddress> {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 ||
      image.width * image.height > 16 * 1024 * 1024 ||
      !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) || image.data.length !== image.width * image.height * 4)
    throw new InviteQrError("invalid_image");
  const { default: decodeQR } = await import("qr/decode.js");
  let text: string;
  try { text = decodeQR(image, { effort: 2, timeLimit: 100 }); }
  catch { throw new InviteQrError("qr_not_found"); }
  return invitation(text, options);
}
/** Browser image upload, decoded locally; nothing is uploaded or navigated. */
export async function readInviteQrFile(file: Blob, options: InviteOptions = {}): Promise<InviteAddress> {
  if (!globalThis.document || file.size > 20 * 1024 * 1024) throw new InviteQrError("invalid_image");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img); img.onerror = () => reject(new InviteQrError("invalid_image")); img.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new InviteQrError("invalid_image");
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new InviteQrError("invalid_image");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await readInviteQr(context.getImageData(0, 0, canvas.width, canvas.height), options);
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Request a rear camera on invocation, then resolve the first invitation.
 * Abort/timeout/success/error always stop owned tracks. Never opens a decoded URL.
 */
export function scanInviteCamera(video: QrVideo, options: QrCameraOptions = {}): Promise<InviteAddress> {
  const timeout = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) return Promise.reject(new RangeError("timeoutMs must be between 1 and 2147483647"));
  if (video.srcObject) return Promise.reject(new InviteQrError("video_in_use"));
  if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.document) return Promise.reject(new InviteQrError("camera_unavailable"));
  return new Promise((resolve, reject) => {
    let done = false, stream: MediaStream | undefined, poll: ReturnType<typeof setTimeout> | undefined;
    const originalMuted = video.muted, originalInline = video.playsInline;
    const finish = (result?: InviteAddress, error?: Error) => {
      if (done) return;
      done = true; clearTimeout(deadline); if (poll) clearTimeout(poll);
      options.signal?.removeEventListener("abort", abort);
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        video.pause(); video.srcObject = null; video.muted = originalMuted; video.playsInline = originalInline;
      }
      if (result) resolve(result); else reject(error ?? new InviteQrError("aborted"));
    };
    const abort = () => finish(undefined, new InviteQrError("aborted"));
    const deadline = setTimeout(() => finish(undefined, new InviteQrError("scan_timeout")), timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    type Detector = { detect(source: unknown): Promise<{ rawValue: string }[]> };
    type DetectorClass = { new(options: { formats: string[] }): Detector; getSupportedFormats?(): Promise<string[]> };
    const Native = (globalThis as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    let detector: Detector | undefined;
    const chooseDetector = async () => {
      try {
        if (Native && (!Native.getSupportedFormats || (await Native.getSupportedFormats()).includes("qr_code"))) detector = new Native({ formats: ["qr_code"] });
      } catch { /* Software fallback, loaded only when needed. */ }
    };
    const frame = async () => {
      if (done) return;
      try {
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          if (detector) {
            try {
              const codes = await detector.detect(video);
              if (done) return;
              if (codes.length) { finish(invitation(codes[0].rawValue, options)); return; }
            } catch (error) {
              if (error instanceof InviteQrError) throw error;
              detector = undefined;
            }
          } else {
            if (!context) throw new InviteQrError("camera_unavailable");
            const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            context.drawImage(video as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
            try {
              const result = await readInviteQr(context.getImageData(0, 0, canvas.width, canvas.height), options);
              if (!done) finish(result);
              return;
            } catch (error) { if (!(error instanceof InviteQrError) || error.code !== "qr_not_found") throw error; }
          }
        }
      } catch (error) { finish(undefined, error instanceof Error ? error : new InviteQrError("camera_error")); return; }
      if (!done) poll = setTimeout(() => void frame(), 250);
    };
    void navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } } }).then(async acquired => {
      if (done) { for (const track of acquired.getTracks()) track.stop(); return; }
      stream = acquired; video.srcObject = stream; video.muted = true; video.playsInline = true;
      await video.play(); if (done) return;
      await chooseDetector(); if (!done) void frame();
    }).catch(error => {
      finish(undefined, new InviteQrError(error?.name === "NotAllowedError" ? "camera_denied" : "camera_unavailable"));
    });
  });
}
