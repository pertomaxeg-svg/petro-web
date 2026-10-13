import { Buffer } from "node:buffer";
import { Router, type IRouter } from "express";
import { SupabaseHealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const APPROVED_PROJECT_REF = "msvgzsfzrqlrfpstthhe";

type SupabaseKeyKind = "publishable" | "legacy_anon" | "private" | "unsupported";

function inspectSupabaseKey(apiKey: string): {
  kind: SupabaseKeyKind;
  projectRef?: string;
} {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(apiKey)) {
    return { kind: "publishable" };
  }
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(apiKey)) {
    return { kind: "private" };
  }

  const segments = apiKey.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    return { kind: "unsupported" };
  }

  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as { role?: unknown; ref?: unknown };

    if (payload.role === "anon") {
      return {
        kind: "legacy_anon",
        projectRef: typeof payload.ref === "string" ? payload.ref : undefined,
      };
    }
    if (payload.role === "service_role") {
      return { kind: "private" };
    }
  } catch {
    return { kind: "unsupported" };
  }

  return { kind: "unsupported" };
}

async function getSanitizedUpstreamMessage(response: Response): Promise<string> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    return "Supabase returned a non-JSON error response; details redacted.";
  }

  let body: unknown = bodyText;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // Some API gateways return plain text; classify it without returning it.
  }

  const strings: string[] = [];
  const collectStrings = (value: unknown, depth: number): void => {
    if (depth > 3 || strings.length >= 24) return;
    if (typeof value === "string") {
      strings.push(value.slice(0, 512));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectStrings(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) collectStrings(item, depth + 1);
    }
  };
  collectStrings(body, 0);

  const upstreamText = strings.join(" ").toLowerCase().replace(/[_-]+/g, " ");
  if (/invalid.{0,32}(api )?key|(?:api )?key.{0,32}invalid/.test(upstreamText)) {
    return "Supabase rejected the API key as invalid.";
  }
  if (/no.{0,20}(api )?key|missing.{0,20}(api )?key/.test(upstreamText)) {
    return "Supabase reported that no API key was received.";
  }
  if (/invalid.{0,20}jwt|jwt.{0,20}invalid|signature.{0,20}invalid/.test(upstreamText)) {
    return "Supabase rejected the JWT as invalid.";
  }
  if (/jwt.{0,20}expir|expir.{0,20}jwt/.test(upstreamText)) {
    return "Supabase rejected an expired JWT.";
  }
  if (/permission.{0,20}denied|not allowed|forbidden/.test(upstreamText)) {
    return "Supabase denied access to the REST endpoint.";
  }
  if (/unauthori[sz]ed|unauthenticated|authentication.{0,20}(fail|reject|invalid)/.test(upstreamText)) {
    return "Supabase rejected authentication; the detailed reason is redacted.";
  }
  if (/project.{0,30}(not found|invalid|mismatch)|invalid project/.test(upstreamText)) {
    return "Supabase could not resolve the requested project.";
  }
  return "Supabase returned an error response; details redacted.";
}

router.get("/supabase/health", async (req, res): Promise<void> => {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const apiKey = process.env["SUPABASE_ANON_KEY"]?.trim();

  if (!supabaseUrl) {
    const data = SupabaseHealthCheckResponse.parse({
      status: "not_configured",
      message:
        "Set SUPABASE_URL to the approved Pertomax EG Supabase project in Replit Secrets.",
    });
    res.status(503).json(data);
    return;
  }

  let restUrl: URL;
  try {
    const projectUrl = new URL(supabaseUrl);
    if (projectUrl.protocol !== "https:" || projectUrl.hostname !== "msvgzsfzrqlrfpstthhe.supabase.co") {
      const data = SupabaseHealthCheckResponse.parse({
        status: "project_mismatch",
        message:
          "Only Supabase project msvgzsfzrqlrfpstthhe is approved for this Pertomax EG Repl.",
      });
      res.status(503).json(data);
      return;
    }
    restUrl = new URL("/rest/v1/", projectUrl);
  } catch {
    const data = SupabaseHealthCheckResponse.parse({
      status: "unavailable",
      message: "SUPABASE_URL must be a valid HTTPS URL.",
    });
    res.status(503).json(data);
    return;
  }

  if (!apiKey) {
    const data = SupabaseHealthCheckResponse.parse({
      status: "not_configured",
      message:
        "Add this project's SUPABASE_ANON_KEY (or publishable key) in Pertomax EG Replit Secrets. Do not paste it into the app or chat.",
    });
    res.status(503).json(data);
    return;
  }

  const keyInfo = inspectSupabaseKey(apiKey);
  if (keyInfo.kind === "private" || keyInfo.kind === "unsupported") {
    const message =
      keyInfo.kind === "private"
        ? "The configured key is a private/service-role key. Use a public anon or publishable key; no request was sent."
        : "The configured key format is not a supported public anon or publishable key; no request was sent.";
    req.log.warn(
      { upstreamStatus: null, upstreamMessage: message },
      "Supabase connectivity check stopped before the upstream request",
    );
    const data = SupabaseHealthCheckResponse.parse({
      status: "unauthorized",
      message,
    });
    res.status(503).json(data);
    return;
  }

  if (
    keyInfo.kind === "legacy_anon" &&
    keyInfo.projectRef &&
    keyInfo.projectRef !== APPROVED_PROJECT_REF
  ) {
    const message =
      "The legacy anon key identifies a different Supabase project; no request was sent.";
    req.log.warn(
      { upstreamStatus: null, upstreamMessage: message },
      "Supabase connectivity check stopped before the upstream request",
    );
    const data = SupabaseHealthCheckResponse.parse({
      status: "project_mismatch",
      message,
    });
    res.status(503).json(data);
    return;
  }

  const headers: Record<string, string> = {
    apikey: apiKey,
    Accept: "application/openapi+json",
  };

  // Legacy anon JWTs need a bearer header. Publishable keys use only apikey.
  if (keyInfo.kind === "legacy_anon") {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(restUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) {
      const keyType =
        keyInfo.kind === "publishable" ? "publishable key" : "legacy anon key";
      const data = SupabaseHealthCheckResponse.parse({
        status: "connected",
        message:
          `The approved project's REST API is reachable using a public ${keyType}. Database schema compatibility still requires review.`,
      });
      res.status(200).json(data);
      return;
    }

    const upstreamMessage = await getSanitizedUpstreamMessage(response);
    req.log.warn(
      { upstreamStatus: response.status, upstreamMessage },
      "Supabase REST connectivity check failed",
    );
    const keyType =
      keyInfo.kind === "publishable" ? "publishable key" : "legacy anon key";
    const status =
      response.status === 401 || response.status === 403
        ? "unauthorized"
        : "unavailable";

    const data = SupabaseHealthCheckResponse.parse({
      status,
      message: `Configured public ${keyType}; Supabase returned HTTP ${response.status}: ${upstreamMessage}`,
    });
    res.status(503).json(data);
    return;
  } catch {
    const message = "No HTTP response was received from the Supabase REST API.";
    req.log.warn(
      { upstreamStatus: null, upstreamMessage: message },
      "Supabase REST connectivity check failed before receiving a response",
    );
    const data = SupabaseHealthCheckResponse.parse({
      status: "unavailable",
      message,
    });
    res.status(503).json(data);
  }
});

export default router;
