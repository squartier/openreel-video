export interface LaunchSession {
  v: 1;
  app: string;
  label: string;
  returnUrl: string;
  token: string;
  backUrl?: string;
  maxBytes?: number;
  suggested?: { container?: "mp4" | "webm"; preset?: string };
  expiresAt?: string; // ISO
}

export type LaunchParseResult =
  | { ok: true; session: LaunchSession }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "unsupported-version"
        | "invalid-fields"
        | "origin-not-allowed"
        | "expired";
    };

const LOCALHOST_ORIGIN = /^http:\/\/localhost(:\d+)?$/;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const origin = originOf(trimmed);
    if (origin && origin !== "null") out.push(origin);
  }
  return out;
}

export function isOriginAllowed(url: string, allowed: string[]): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  const isHttps = origin.startsWith("https://");
  if (!isHttps && !LOCALHOST_ORIGIN.test(origin)) return false;
  return allowed.includes(origin);
}

export function decodeLaunchParam(raw: string): unknown {
  let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const text = new TextDecoder().decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  );
  return JSON.parse(text);
}

const isNonEmptyString = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0;

export function parseLaunchSession(
  search: string,
  opts: { allowedReturnOrigins: string[]; now?: Date },
): LaunchParseResult {
  const raw = new URLSearchParams(search).get("launch");
  if (!raw) return { ok: false, reason: "missing" };

  let data: unknown;
  try {
    data = decodeLaunchParam(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "malformed" };
  }
  const o = data as Record<string, unknown>;

  if (o.v !== 1) return { ok: false, reason: "unsupported-version" };

  if (
    !isNonEmptyString(o.app) ||
    !isNonEmptyString(o.label) ||
    !isNonEmptyString(o.returnUrl) ||
    !isNonEmptyString(o.token) ||
    (o.maxBytes !== undefined &&
      !(typeof o.maxBytes === "number" && Number.isInteger(o.maxBytes) && o.maxBytes > 0)) ||
    (o.backUrl !== undefined && typeof o.backUrl !== "string")
  ) {
    return { ok: false, reason: "invalid-fields" };
  }

  if (!isOriginAllowed(o.returnUrl, opts.allowedReturnOrigins)) {
    return { ok: false, reason: "origin-not-allowed" };
  }

  if (o.expiresAt !== undefined) {
    const t = typeof o.expiresAt === "string" ? Date.parse(o.expiresAt) : NaN;
    if (Number.isNaN(t)) return { ok: false, reason: "invalid-fields" };
    if (t <= (opts.now ?? new Date()).getTime()) {
      return { ok: false, reason: "expired" };
    }
  }

  return { ok: true, session: o as unknown as LaunchSession };
}

export function stripLaunchParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("launch");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
