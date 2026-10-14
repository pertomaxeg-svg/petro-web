import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { Request, Response } from "express";
import { Buffer } from "node:buffer";

const APPROVED_SUPABASE_ORIGIN =
  "https://msvgzsfzrqlrfpstthhe.supabase.co";

export function assertApprovedSupabaseConfig(): {
  url: string;
  publicKey: string;
} {
  const url = process.env["SUPABASE_URL"]?.trim();
  const publicKey = process.env["SUPABASE_ANON_KEY"]?.trim();

  if (!url || !publicKey) {
    throw new Error("Supabase Auth is not configured for this project.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("The configured Supabase URL is invalid.");
  }

  if (
    parsedUrl.origin !== APPROVED_SUPABASE_ORIGIN ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("The configured Supabase project is not approved.");
  }

  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey)) {
    return { url: parsedUrl.origin, publicKey };
  }

  if (publicKey.startsWith("sb_secret_")) {
    throw new Error("A public Supabase key is required.");
  }

  const parts = publicKey.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8"),
      ) as { role?: unknown; ref?: unknown };
      if (payload.role !== "anon" || payload.ref !== "msvgzsfzrqlrfpstthhe") {
        throw new Error("A public key for the approved Supabase project is required.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("A public key")) {
        throw error;
      }
      throw new Error("The configured public Supabase key is invalid.");
    }
  } else {
    throw new Error("The configured public Supabase key is unsupported.");
  }

  return { url: parsedUrl.origin, publicKey };
}

export function createSupabaseServerClient(req: Request, res: Response) {
  const { url, publicKey } = assertApprovedSupabaseConfig();

  return createServerClient(url, publicKey, {
    cookies: {
      getAll() {
        return Object.entries(req.cookies ?? {}).flatMap(([name, value]) =>
          typeof value === "string" ? [{ name, value }] : [],
        );
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          const responseOptions: CookieOptions = {
            ...options,
            httpOnly: true,
            secure: req.secure || process.env["NODE_ENV"] === "production",
            sameSite: "lax",
            path: options.path ?? "/",
          };
          res.cookie(name, value, responseOptions);
        }
      },
    },
  });
}

export function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(
  value: unknown,
  key: string,
  maxLength: number,
): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

export function readStringArray(
  value: unknown,
  key: string,
  maxItems: number,
): string[] | null {
  if (!isRecord(value) || !Array.isArray(value[key])) return null;
  const items = value[key];
  if (
    items.length > maxItems ||
    items.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0 ||
        item.length > 100,
    )
  ) {
    return null;
  }
  return items.map((item) => (item as string).trim());
}
