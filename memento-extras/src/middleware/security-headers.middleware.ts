import type { ServerResponse } from "node:http";

// Safe defaults for every response: never sniffed as another type, never cached, never
// framed, never readable by other sites.
export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("referrer-policy", "no-referrer");
}
