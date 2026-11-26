// Encrypts small secrets (e.g. the per-user Immich API keys live albums use) before they go into the database; a copy of the database is useless without MEMENTO_SECRET.
// Opening fails loudly (throws) if the value was changed, belongs elsewhere, or the secret is different.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../config.ts";
import { SECRET_BOX_VERSION } from "../constants/http.constants.ts";

export function secretConfigured(): boolean {
  return config.secret !== null;
}

function keyFor(purpose: string): Buffer {
  if (!config.secret) throw new Error("MEMENTO_SECRET isn't set");
  return Buffer.from(hkdfSync("sha256", config.secret, Buffer.alloc(0), `memento-extras ${purpose} v${SECRET_BOX_VERSION}`, 32));
}

export function seal(purpose: string, boundTo: string, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), nonce);
  cipher.setAAD(Buffer.from(boundTo, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([SECRET_BOX_VERSION]), nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function open(purpose: string, boundTo: string, sealed: string): string {
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < 1 + 12 + 16 + 1 || bytes[0] !== SECRET_BOX_VERSION) throw new Error("not a sealed value");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), bytes.subarray(1, 13));
  decipher.setAAD(Buffer.from(boundTo, "utf8"));
  decipher.setAuthTag(bytes.subarray(13, 29));
  return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8");
}
