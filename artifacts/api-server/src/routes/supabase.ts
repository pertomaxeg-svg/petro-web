import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";
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

function sanitizeSupabaseError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Supabase returned an error; details redacted.";
  }

  const errorFields = error as Record<string, unknown>;
  const upstreamText = [
    errorFields.message,
    errorFields.code,
    errorFields.details,
    errorFields.hint,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");

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
  if (/fetch failed|network|timed out|timeout|aborted/.test(upstreamText)) {
    return "The SDK request failed before receiving an HTTP response.";
  }
  return "Supabase returned an error response; details redacted.";
}

function findReadableRelation(spec: unknown): string | undefined {
  if (!spec || typeof spec !== "object" || !("paths" in spec)) return undefined;

  const paths = (spec as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object") return undefined;

  const readableRelations = Object.entries(paths as Record<string, unknown>)
    .filter(([path, operations]) => {
      if (!/^\/[A-Za-z_][A-Za-z0-9_$-]{0,127}$/.test(path) || path === "/rpc") {
        return false;
      }
      return (
        !!operations &&
        typeof operations === "object" &&
        Object.prototype.hasOwnProperty.call(operations, "get")
      );
    })
    .map(([path]) => path.slice(1))
    .sort((left, right) => left.localeCompare(right));

  return readableRelations[0];
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
        message:
          "Only Supabase project msvgzsfzrqlrfpstthhe is approved for this Pertomax EG Repl.",
      });
      res.status(503).json(data);
      return;
    }
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

  try {
    const supabase = createClient(projectUrl.origin, apiKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      db: {
        retry: false,
        schema: "public",
        timeout: 8_000,
      },
    });

    let sessionSummary = "auth.getSession could not be completed.";
    try {
      const { data, error } = await supabase.auth.getSession();
      sessionSummary = error
        ? "auth.getSession returned an error."
        : data.session
          ? "auth.getSession found an existing user session."
          : "auth.getSession found no stored user session.";
    } catch {
      // No session details or thrown error text are returned or logged.
    }

    // This SDK GET validates the API key and lists only resources whose
    // privileges are exposed to this key's role. It does not read table rows.
    const openApiResult = await supabase.schema("public").getOpenApiSpec();
    if (openApiResult.error || !openApiResult.data) {
      const upstreamStatus = openApiResult.status > 0 ? openApiResult.status : null;
      const upstreamMessage = sanitizeSupabaseError(openApiResult.error);
      req.log.warn(
        { upstreamStatus, upstreamMessage },
        "Supabase SDK authentication check failed",
      );
      const status =
        openApiResult.status === 401 || openApiResult.status === 403
          ? "unauthorized"
          : "unavailable";
      const statusText =
        upstreamStatus === null ? "no HTTP response" : `HTTP ${upstreamStatus}`;

      res.status(503).json(
        SupabaseHealthCheckResponse.parse({
          status,
          message: `Supabase SDK REST authentication check returned ${statusText}: ${upstreamMessage}`,
        }),
      );
      return;
    }

    req.log.info(
      {
        upstreamStatus: openApiResult.status,
        upstreamMessage: "Supabase SDK REST authentication check succeeded.",
      },
      "Supabase SDK authentication check succeeded",
    );

    const relation = findReadableRelation(openApiResult.data);
    let tableReadSummary =
      "No GET-permitted public relation was exposed; no table read was performed.";

    if (relation) {
      try {
        const readResult = await supabase
          .from(relation)
          .select("*", { head: true })
          .limit(1);
        const readMessage = readResult.error
          ? sanitizeSupabaseError(readResult.error)
          : "Read-only HEAD check succeeded; no row data was returned.";
        req.log.info(
          {
            upstreamStatus: readResult.status,
            upstreamMessage: readMessage,
          },
          "Supabase permitted relation read check completed",
        );
        tableReadSummary =
          `Read-only permitted relation check returned HTTP ${readResult.status}: ${readMessage}`;
      } catch {
        tableReadSummary =
          "A permitted relation was listed, but its read-only check did not complete; details redacted.";
        req.log.warn(
          {
            upstreamStatus: null,
            upstreamMessage: tableReadSummary,
          },
          "Supabase permitted relation read check failed",
        );
      }
    }

    const data = SupabaseHealthCheckResponse.parse({
      status: "connected",
      message: `Supabase SDK REST authentication returned HTTP ${openApiResult.status}. ${sessionSummary} ${tableReadSummary}`,
    });
    res.status(200).json(data);
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
