import { Router, type IRouter } from "express";
import { SupabaseHealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/supabase/health", async (_req, res) => {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const apiKey = process.env["SUPABASE_ANON_KEY"];

  if (!supabaseUrl) {
    const data = SupabaseHealthCheckResponse.parse({
      status: "not_configured",
      message:
        "Set SUPABASE_URL to the approved Pertomax EG Supabase project in Replit Secrets.",
    });
    return res.status(503).json(data);
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
      return res.status(503).json(data);
    }
    restUrl = new URL("/rest/v1/", projectUrl);
  } catch {
    const data = SupabaseHealthCheckResponse.parse({
      status: "unavailable",
      message: "SUPABASE_URL must be a valid HTTPS URL.",
    });
    return res.status(503).json(data);
  }

  if (!apiKey) {
    const data = SupabaseHealthCheckResponse.parse({
      status: "not_configured",
      message:
        "Add this project's SUPABASE_ANON_KEY (or publishable key) in Pertomax EG Replit Secrets. Do not paste it into the app or chat.",
    });
    return res.status(503).json(data);
  }

  const headers: Record<string, string> = {
    apikey: apiKey,
    Accept: "application/openapi+json",
  };

  // Legacy anon keys are JWTs and can be sent as bearer tokens. New publishable
  // keys are opaque strings, so they must only be sent in the apikey header.
  if (apiKey.split(".").length === 3) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(restUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) {
      const data = SupabaseHealthCheckResponse.parse({
        status: "connected",
        message:
          "The approved project's REST API is reachable. Database schema compatibility still requires review.",
      });
      return res.status(200).json(data);
    }

    if (response.status === 401 || response.status === 403) {
      const data = SupabaseHealthCheckResponse.parse({
        status: "unauthorized",
        message:
          "Supabase rejected the key. Check that it belongs to this project and is a publishable or anon key.",
      });
      return res.status(503).json(data);
    }

    const data = SupabaseHealthCheckResponse.parse({
      status: "unavailable",
      message: `Supabase returned HTTP ${response.status}.`,
    });
    return res.status(503).json(data);
  } catch {
    const data = SupabaseHealthCheckResponse.parse({
      status: "unavailable",
      message: "Could not reach the Supabase API.",
    });
    return res.status(503).json(data);
  }
});

export default router;
