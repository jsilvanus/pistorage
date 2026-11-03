import { createHmac, timingSafeEqual } from "node:crypto";

export type SignedMethod = "GET" | "PUT";

export const MAX_SIGNED_SECONDS = 7 * 24 * 3600;

function mac(secret: string, method: SignedMethod, key: string, expires: number): Buffer {
  return createHmac("sha256", secret).update(`${method}\n${key}\n${expires}`).digest();
}

/** A link for one key and one method that works until `expires` (epoch seconds), without the API key. */
export function signPath(secret: string, method: SignedMethod, key: string, expires: number): string {
  const sig = mac(secret, method, key, expires).toString("hex");
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `/signed/${encoded}?expires=${expires}&sig=${sig}`;
}

export type SignatureCheck = "ok" | "invalid" | "expired";

/** HEAD uses the GET signature. Expiry is only reported for a valid signature. */
export function checkSignature(
  secret: string,
  method: SignedMethod,
  key: string,
  expires: string | undefined,
  sig: string | undefined,
  nowMs: number
): SignatureCheck {
  if (!expires || !/^\d{1,12}$/.test(expires) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return "invalid";
  const expected = mac(secret, method, key, Number(expires));
  const presented = Buffer.from(sig, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return "invalid";
  return Number(expires) * 1000 <= nowMs ? "expired" : "ok";
}
