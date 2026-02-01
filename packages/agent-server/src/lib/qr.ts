import { PNG } from "pngjs";
import * as QRCode from "qrcode";
import { createRequire } from "module";

// jsQR uses CJS exports that don't work well with ESM default imports
const require = createRequire(import.meta.url);
const jsQR = require("jsqr") as (
  data: Uint8ClampedArray,
  width: number,
  height: number
) => { data: string } | null;

/**
 * QR code utilities for encoding and decoding QR codes
 */

/**
 * Decode QR code from base64-encoded PNG image
 */
export async function decodeQrFromBase64(base64: string): Promise<string | null> {
  try {
    const buffer = Buffer.from(base64, "base64");
    const png = PNG.sync.read(buffer);
    const data = new Uint8ClampedArray(
      png.data.buffer,
      png.data.byteOffset,
      png.data.byteLength
    );

    const result = jsQR(data, png.width, png.height);
    return result?.data ?? null;
  } catch {
    return null;
  }
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
