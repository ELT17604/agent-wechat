import { PNG } from "pngjs";
import * as QRCode from "qrcode";
import { createRequire } from "module";

// jsQR uses CJS exports that don't work well with ESM default imports
const require = createRequire(import.meta.url);
interface JsQRResult {
  data: string;
  binaryData: number[];
  chunks: Array<{ type: string; data: string | number[] }>;
  version: number;
  location: unknown;
}

const jsQR = require("jsqr") as (
  data: Uint8ClampedArray,
  width: number,
  height: number
) => JsQRResult | null;

/**
 * QR code utilities for encoding and decoding QR codes
 */

/**
 * Decode QR code from base64-encoded PNG image (sync version)
 */
export interface QrDecodeResult {
  data: string;
  binaryData: number[];
  version: number;
}

export function decodeQrFromBase64Sync(base64: string): string | null {
  const result = decodeQrFullSync(base64);
  return result?.data ?? null;
}

export function decodeQrFullSync(base64: string): QrDecodeResult | null {
  try {
    const buffer = Buffer.from(base64, "base64");
    const png = PNG.sync.read(buffer);
    const data = new Uint8ClampedArray(
      png.data.buffer,
      png.data.byteOffset,
      png.data.byteLength
    );

    const result = jsQR(data, png.width, png.height);
    if (!result) return null;

    // Log to see if binaryData differs from data
    const binaryAsString = Buffer.from(result.binaryData).toString("utf-8");
    if (binaryAsString !== result.data) {
      console.log("[QR] Data mismatch!");
      console.log("[QR] data:", result.data);
      console.log("[QR] binaryData as string:", binaryAsString);
      console.log("[QR] binaryData raw:", result.binaryData);
    }

    return {
      data: result.data,
      binaryData: result.binaryData,
      version: result.version,
    };
  } catch {
    return null;
  }
}

/**
 * Decode QR code from base64-encoded PNG image (async wrapper for compatibility)
 */
export async function decodeQrFromBase64(base64: string): Promise<string | null> {
  return decodeQrFromBase64Sync(base64);
}

/**
 * Convert QR data to data URL for display
 */
export async function toDataURL(data: string): Promise<string> {
  try {
    return await QRCode.toDataURL(data);
  } catch {
    return data;
  }
}
