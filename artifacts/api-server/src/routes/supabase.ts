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

function extractSafeErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const fields = payload as Record<string, unknown>;
  const candidate = fields.code ?? fields.error_code ?? fields.error;
  return typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : undefined;
}

function describeAuthFailure(status: number): string {
  if (status === 401) return "Supabase Auth لم يقبل المفتاح العام لهذا الطلب.";
  if (status === 403) return "Supabase Auth منع الوصول إلى إعداداته العامة.";
  return `تعذر الوصول إلى إعدادات Supabase Auth العامة (HTTP ${status}).`;
}

router.get("/supabase/health", async (req, res): Promise<void> => {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const apiKey = process.env["SUPABASE_ANON_KEY"]?.trim();

  if (!supabaseUrl) {
    const data = SupabaseHealthCheckResponse.parse({
      status: "not_configured",
      dataAccessStatus: "not_tested",
      message:
        "Set SUPABASE_URL to the approved Pertomax EG Supabase project in Replit Secrets.",
    });
    res.status(503).json(data);
    return;
  }

  let projectUrl: URL;
  try {
    projectUrl = new URL(supabaseUrl);
    if (
      projectUrl.origin !== "https://msvgzsfzrqlrfpstthhe.supabase.co" ||
      projectUrl.pathname !== "/" ||
      projectUrl.search ||
      projectUrl.hash
    ) {
      const data = SupabaseHealthCheckResponse.parse({
        status: "project_mismatch",
        dataAccessStatus: "not_tested",
        message:
          "Only Supabase project msvgzsfzrqlrfpstthhe is approved for this Pertomax EG Repl.",
      });
      res.status(503).json(data);
      return;
    }
  } catch {
    const data = SupabaseHealthCheckResponse.parse({
      status: "unavailable",
      dataAccessStatus: "not_tested",
      message: "SUPABASE_URL must be a valid HTTPS URL.",
    });
    res.status(503).json(data);
    return;
  }

  if (!apiKey) {
    const data = SupabaseHealthCheckResponse.parse({
      status: "not_configured",
      dataAccessStatus: "not_tested",
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
      dataAccessStatus: "not_tested",
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
      dataAccessStatus: "not_tested",
      message,
    });
    res.status(503).json(data);
    return;
  }

  try {
    const authSettingsResponse = await fetch(
      new URL("/auth/v1/settings", projectUrl.origin),
      {
        method: "GET",
        headers: {
          apikey: apiKey,
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      },
    );
    const responseText = await authSettingsResponse.text();
    let responsePayload: unknown;
    try {
      responsePayload = responseText ? JSON.parse(responseText) : undefined;
    } catch {
      responsePayload = undefined;
    }

    const dataAccessStatus = "not_tested" as const;
    const authHttpStatus = authSettingsResponse.status;
    if (!authSettingsResponse.ok) {
      const authErrorCode = extractSafeErrorCode(responsePayload);
      const upstreamMessage = describeAuthFailure(authHttpStatus);
      req.log.warn(
        { upstreamStatus: authHttpStatus, upstreamErrorCode: authErrorCode, upstreamMessage },
        "Supabase public Auth settings check failed",
      );
      const status =
        authHttpStatus === 401 || authHttpStatus === 403
          ? "unauthorized"
          : "unavailable";
      res.status(503).json(
        SupabaseHealthCheckResponse.parse({
          status,
          authHttpStatus,
          authErrorCode,
          dataAccessStatus,
          message: upstreamMessage,
        }),
      );
      return;
    }

    if (!responsePayload || typeof responsePayload !== "object" || Array.isArray(responsePayload)) {
      req.log.warn(
        { upstreamStatus: authHttpStatus, upstreamMessage: "Unexpected Auth settings response." },
        "Supabase public Auth settings check returned an unexpected body",
      );
      res.status(503).json(
        SupabaseHealthCheckResponse.parse({
          status: "unavailable",
          authHttpStatus,
          dataAccessStatus,
          message: "Supabase Auth responded, but its public settings response was not valid JSON.",
        }),
      );
      return;
    }

    req.log.info(
      {
        upstreamStatus: authHttpStatus,
        upstreamMessage: "Supabase public Auth settings check succeeded.",
      },
      "Supabase public Auth settings check succeeded",
    );

    const data = SupabaseHealthCheckResponse.parse({
      status: "connected",
      authHttpStatus,
      dataAccessStatus,
      message:
        "Supabase public Auth settings are reachable. This does not verify database table access; no table was read.",
    });
    res.status(200).json(data);
  } catch {
    const message = "No HTTP response was received from the Supabase Auth API.";
    req.log.warn(
      { upstreamStatus: null, upstreamMessage: message },
      "Supabase Auth connectivity check failed before receiving a response",
    );
    const data = SupabaseHealthCheckResponse.parse({
      status: "unavailable",
      dataAccessStatus: "not_tested",
      message,
    });
    res.status(503).json(data);
  }
});

export default router;
