import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";
import {
  clearSignInAttempts,
  consumeSignInAttempt,
  createSignInRateLimitKey,
} from "../lib/signInRateLimit";
import {
  createSupabaseServerClient,
  isRecord,
  readString,
  setNoStore,
} from "../lib/supabaseServer";
import {
  clearPasswordChangeRequired,
  passwordChangeRequired,
} from "../lib/platformPasswordGate";

const router: IRouter = Router();

type Limit = { count: number; resetAt: number };
const limits = new Map<string, Limit>();

function consumeInMemoryLimit(req: Request, action: string, maximum: number, windowMs: number): boolean {
  const now = Date.now();
  const key = `${action}:${req.ip ?? "unknown"}`;
  const current = limits.get(key);
  if (!current || current.resetAt <= now) {
    limits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= maximum) return false;
  current.count += 1;
  return true;
}

function responseMessage(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function readPassword(value: unknown, key: string, maxLength = 128): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= maxLength
    ? candidate
    : null;
}

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(value.toLowerCase());
}

function validSameOriginCallback(req: Request, redirectTo: string | null): string | null {
  const origin = req.get("origin");
  if (!origin || !redirectTo) return null;

  try {
    const expectedOrigin = new URL(origin).origin;
    const target = new URL(redirectTo);
    if (
      target.origin !== expectedOrigin ||
      !target.pathname.endsWith("/api/auth/callback")
    ) {
      return null;
    }
    const next = target.searchParams.get("next");
    if (next && (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.includes(".."))) {
      return null;
    }
    return target.toString();
  } catch {
    return null;
  }
}

async function resolveLoginEmail(username: string): Promise<string | null> {
  const normalizedUsername = username.toLowerCase();
  if (!isUsername(normalizedUsername)) return null;
  const result = await pool.query<{ email: string }>(
    `select u.email
     from public.petro_profiles p
     join auth.users u on u.id = p.user_id
     where p.username = $1
       and p.login_identifier_type = 'username'
       and u.email is not null
     limit 1`,
    [normalizedUsername],
  );
  return result.rows[0]?.email ?? null;
}

async function resolveRecoveryEmail(identifier: string): Promise<string | null> {
  if (isEmail(identifier)) {
    const result = await pool.query<{ email: string }>(
      `select u.email
       from auth.users u
       join public.petro_profiles p on p.user_id = u.id
       where lower(u.email) = lower($1)
         and u.email is not null
         and p.login_identifier_type = 'username'
       limit 1`,
      [identifier],
    );
    return result.rows[0]?.email ?? null;
  }

  if (!isUsername(identifier.toLowerCase())) return null;
  const result = await pool.query<{ email: string }>(
    `select u.email
     from public.petro_profiles p
     join auth.users u on u.id = p.user_id
     where p.username = $1
       and p.login_identifier_type = 'username'
       and u.email is not null
     limit 1`,
    [identifier.toLowerCase()],
  );
  return result.rows[0]?.email ?? null;
}

function safeErrorMessage(): string {
  return "تعذر إتمام الطلب حاليًا. حاول مرة أخرى بعد قليل.";
}

function ownerBootstrapConfig(): { token: string; username: string } | null {
  const token = process.env["PERTOMAX_OWNER_BOOTSTRAP_TOKEN"];
  const username = process.env["PERTOMAX_OWNER_BOOTSTRAP_USERNAME"]
    ?.trim()
    .toLowerCase();
  if (!token || token.length < 32 || !username || !isUsername(username)) {
    return null;
  }
  return { token, username };
}

router.post("/auth/sign-up", async (req, res): Promise<void> => {
  setNoStore(res);
  if (!consumeInMemoryLimit(req, "signup", 4, 15 * 60_000)) {
    responseMessage(res, 429, "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.");
    return;
  }

  if (!isRecord(req.body)) {
    responseMessage(res, 400, "تحقق من بيانات التسجيل.");
    return;
  }

  const password = readPassword(req.body, "password");
  const displayName = readString(req.body, "displayName", 120);
  const username = readString(req.body, "username", 32)?.toLowerCase();
  const recoveryEmail = readString(req.body, "recoveryEmail", 254)?.toLowerCase();
  const redirectTo = validSameOriginCallback(
    req,
    readString(req.body, "redirectTo", 2048),
  );

  if (
    !username ||
    !isUsername(username) ||
    !recoveryEmail ||
    !isEmail(recoveryEmail) ||
    !displayName ||
    displayName.toLowerCase() === recoveryEmail ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128 ||
    !redirectTo
  ) {
    responseMessage(res, 400, "تحقق من اسم المستخدم وبريد الاستعادة والاسم وكلمة المرور.");
    return;
  }

  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data, error } = await supabase.auth.signUp({
      email: recoveryEmail,
      password,
      options: {
        emailRedirectTo: redirectTo,
        data: {
          login_identifier_type: "username",
          username,
          display_name: displayName,
        },
      },
    });

    if (error || !data.user) {
      res.status(202).json({
        status: "confirmation_required",
        message: "تم استلام الطلب. إذا كان التسجيل صالحًا، فستصل رسالة التأكيد إلى بريد الاستعادة المُدخل.",
      });
      return;
    }

    if (data.session) await supabase.auth.signOut({ scope: "local" });
    res.status(202).json({
      status: "confirmation_required",
      message: "تم استلام الطلب. إذا كان التسجيل صالحًا، فستصل رسالة التأكيد إلى بريد الاستعادة المُدخل.",
    });
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.post("/auth/sign-in", async (req, res): Promise<void> => {
  setNoStore(res);
  const rawUsername =
    readString(req.body, "username", 320)?.trim().normalize("NFKC").toLowerCase() ?? "";
  const rateLimitKey = (() => {
    try {
      return createSignInRateLimitKey(req.ip ?? "unknown", rawUsername);
    } catch {
      return null;
    }
  })();
  if (!rateLimitKey) {
    responseMessage(res, 503, safeErrorMessage());
    return;
  }

  try {
    const limit = await consumeSignInAttempt(rateLimitKey);
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      responseMessage(res, 429, "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.");
      return;
    }
  } catch {
    responseMessage(res, 503, safeErrorMessage());
    return;
  }

  const username = rawUsername;
  const password = readPassword(req.body, "password");
  const genericFailure = "تعذر تسجيل الدخول بالبيانات المقدمة.";
  if (!username || !isUsername(username) || !password) {
    responseMessage(res, 401, genericFailure);
    return;
  }

  let supabase: ReturnType<typeof createSupabaseServerClient> | undefined;
  try {
    const email = await resolveLoginEmail(username);
    if (!email) {
      responseMessage(res, 401, genericFailure);
      return;
    }

    supabase = createSupabaseServerClient(req, res);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.user || !data.user.email_confirmed_at) {
      if (data.user) await supabase.auth.signOut({ scope: "local" });
      responseMessage(res, 401, genericFailure);
      return;
    }

    const profile = await pool.query<{
      active: boolean;
      account_status: string | null;
      login_identifier_type: string | null;
    }>(
      `select active, account_status, login_identifier_type
       from public.petro_profiles
       where user_id = $1
       limit 1`,
      [data.user.id],
    );
    const account = profile.rows[0];
    if (
      !account ||
      account.login_identifier_type !== "username" ||
      account.account_status === "suspended" ||
      (!account.active && account.account_status !== "pending")
    ) {
      await supabase.auth.signOut({ scope: "local" });
      responseMessage(res, 401, genericFailure);
      return;
    }

    const mustChangePassword = await passwordChangeRequired(data.user.id);
    await clearSignInAttempts(rateLimitKey);
    res.json({
      status: account?.active ? "active" : "pending",
      message: account?.active
        ? "تم تسجيل الدخول."
        : "تم تسجيل الدخول. الحساب بانتظار اعتماد الصلاحيات.",
      passwordChangeRequired: mustChangePassword,
    });
  } catch {
    if (supabase) await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.post("/auth/sign-out", async (req, res): Promise<void> => {
  setNoStore(res);
  try {
    const supabase = createSupabaseServerClient(req, res);
    await supabase.auth.signOut({ scope: "local" });
    res.status(204).end();
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.post("/auth/recovery", async (req, res): Promise<void> => {
  setNoStore(res);
  if (!consumeInMemoryLimit(req, "recovery", 4, 60 * 60_000)) {
    responseMessage(res, 429, "طلبات استعادة كثيرة. انتظر قبل المحاولة مجددًا.");
    return;
  }

  const identifier = readString(req.body, "identifier", 254);
  const redirectTo = validSameOriginCallback(
    req,
    readString(req.body, "redirectTo", 2048),
  );
  if (!identifier || !redirectTo) {
    responseMessage(res, 400, "أدخل البريد أو اسم المستخدم ورابط الاستعادة.");
    return;
  }

  try {
    const email = await resolveRecoveryEmail(identifier);
    const supabase = createSupabaseServerClient(req, res);
    try {
      await supabase.auth.resetPasswordForEmail(
        email ?? "unmatched-account@invalid.invalid",
        { redirectTo },
      );
    } catch {
      // Return the same response for known and unknown accounts; never log the address.
    }

    res.status(202).json({
      message: "إذا كانت البيانات مرتبطة بحساب، فستصل تعليمات الاستعادة إلى البريد المسجل.",
    });
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.post("/auth/password", async (req, res): Promise<void> => {
  setNoStore(res);
  const password = readPassword(req.body, "password");
  if (!password || password.length < 12) {
    responseMessage(res, 400, "استخدم كلمة مرور لا تقل عن 12 خانة.");
    return;
  }

  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data, error: userError } = await supabase.auth.getUser();
    if (userError || !data.user) {
      responseMessage(res, 401, "انتهت جلسة الاستعادة. افتح رابطًا جديدًا.");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      responseMessage(res, 400, "تعذر تحديث كلمة المرور. افتح رابط استعادة جديدًا.");
      return;
    }
    await clearPasswordChangeRequired(data.user.id);
    res.json({ message: "تم تحديث كلمة المرور." });
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.get("/auth/callback", async (req, res): Promise<void> => {
  setNoStore(res);
  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  const nextValue = typeof req.query["next"] === "string" ? req.query["next"] : "/";
  const safeNext =
    nextValue.startsWith("/") &&
    !nextValue.startsWith("//") &&
    !nextValue.includes("\\") &&
    !nextValue.includes("..")
      ? nextValue
      : "/";

  if (!code) {
    res.redirect(303, `${safeNext}?authError=callback`);
    return;
  }

  try {
    const supabase = createSupabaseServerClient(req, res);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      res.redirect(303, `${safeNext}?authError=callback`);
      return;
    }
    res.redirect(303, safeNext);
  } catch {
    res.redirect(303, `${safeNext}?authError=callback`);
  }
});

router.get("/auth/me", async (req, res): Promise<void> => {
  setNoStore(res);
  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      responseMessage(res, 401, "يلزم تسجيل الدخول.");
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from("petro_profiles")
      .select("user_id,display_name,username,active,account_status,login_identifier_type")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    if (profileError || !profile) {
      responseMessage(res, 503, "تعذر قراءة حالة الحساب. حاول مرة أخرى.");
      return;
    }

    if (
      profile.login_identifier_type !== "username" ||
      profile.account_status === "suspended" ||
      (!profile.active && profile.account_status !== "pending")
    ) {
      await supabase.auth.signOut({ scope: "local" });
      responseMessage(res, 403, "هذا الحساب معطل. تواصل مع مسؤول المنصة.");
      return;
    }

    const mustChangePassword = await passwordChangeRequired(authData.user.id);
    let accessContext: unknown = null;
    if (profile.active && !mustChangePassword) {
      const { data, error } = await supabase.rpc("petro_access_context");
      if (error) {
        responseMessage(res, 503, "تعذر تحميل صلاحيات الحساب.");
        return;
      }
      accessContext = data;
    }

    res.json({
      id: profile.user_id,
      displayName: profile.display_name,
      username: profile.username,
      loginIdentifierType: profile.login_identifier_type,
      state: profile.active ? "active" : "pending",
      passwordChangeRequired: mustChangePassword,
      accessContext,
    });
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.get("/auth/bootstrap-status", async (req, res): Promise<void> => {
  setNoStore(res);
  const config = ownerBootstrapConfig();
  if (!config) {
    res.json({ available: false });
    return;
  }

  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      res.json({ available: false });
      return;
    }

    const result = await pool.query<{
      owner_role_exists: boolean;
      bootstrap_used: boolean;
      target_eligible: boolean;
    }>(
      `select
         exists(
           select 1 from public.petro_platform_roles r
           where r.role = 'owner'
         ) as owner_role_exists,
         exists(
           select 1 from public.petro_audit_events e
           where e.action = 'platform.owner_bootstrapped'
         ) as bootstrap_used,
         exists(
           select 1
           from public.petro_profiles p
           join auth.users u on u.id = p.user_id
           where p.user_id = $1
             and p.username = $2
             and p.login_identifier_type = 'username'
             and p.active = false
             and p.account_status = 'pending'
             and u.email_confirmed_at is not null
             and not exists (
               select 1 from public.petro_platform_roles r
               where r.user_id = p.user_id
             )
             and not exists (
               select 1 from public.petro_memberships m
               where m.user_id = p.user_id and m.active
             )
         ) as target_eligible`,
      [authData.user.id, config.username],
    );
    const state = result.rows[0];
    res.json({
      available:
        !!state &&
        !state.owner_role_exists &&
        !state.bootstrap_used &&
        state.target_eligible,
    });
  } catch {
    responseMessage(res, 503, "تعذر التحقق من حالة الإعداد.");
  }
});

router.post("/auth/bootstrap-owner", async (req, res): Promise<void> => {
  setNoStore(res);
  if (!consumeInMemoryLimit(req, "owner-bootstrap", 5, 60 * 60_000)) {
    responseMessage(res, 429, "محاولات كثيرة. انتظر قبل المحاولة مجددًا.");
    return;
  }

  const config = ownerBootstrapConfig();
  const providedToken = readString(req.body, "token", 256);
  if (!config || !providedToken) {
    responseMessage(res, 403, "إعداد مالك المنصة غير متاح أو غير مصرح به.");
    return;
  }

  const expected = Buffer.from(config.token);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    responseMessage(res, 403, "إعداد مالك المنصة غير متاح أو غير مصرح به.");
    return;
  }

  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      responseMessage(res, 401, "سجّل الدخول بحسابك أولًا.");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("select pg_advisory_xact_lock(hashtext('pertomax-eg-owner-bootstrap'))");
      const stateResult = await client.query<{
        owner_role_exists: boolean;
        bootstrap_used: boolean;
      }>(
        `select
           exists(
             select 1 from public.petro_platform_roles r
             where r.role = 'owner'
           ) as owner_role_exists,
           exists(
             select 1 from public.petro_audit_events e
             where e.action = 'platform.owner_bootstrapped'
           ) as bootstrap_used`,
      );
      const state = stateResult.rows[0];
      if (state?.owner_role_exists || state?.bootstrap_used) {
        await client.query("ROLLBACK");
        responseMessage(res, 403, "إعداد مالك المنصة غير متاح أو غير مصرح به.");
        return;
      }

      const targetResult = await client.query<{
        username: string;
        login_identifier_type: string;
        active: boolean;
        account_status: string | null;
        verified: boolean;
        has_platform_role: boolean;
        has_active_membership: boolean;
      }>(
        `select
           p.username,
           p.login_identifier_type,
           p.active,
           p.account_status,
           u.email_confirmed_at is not null as verified,
           exists(
             select 1 from public.petro_platform_roles r
             where r.user_id = p.user_id
           ) as has_platform_role,
           exists(
             select 1 from public.petro_memberships m
             where m.user_id = p.user_id and m.active
           ) as has_active_membership
         from public.petro_profiles p
         join auth.users u on u.id = p.user_id
         where p.user_id = $1
         for update of p`,
        [authData.user.id],
      );
      const target = targetResult.rows[0];
      if (
        !target ||
        target.username !== config.username ||
        target.login_identifier_type !== "username" ||
        target.active ||
        target.account_status !== "pending" ||
        !target.verified ||
        target.has_platform_role ||
        target.has_active_membership
      ) {
        await client.query("ROLLBACK");
        responseMessage(res, 403, "إعداد مالك المنصة غير متاح أو غير مصرح به.");
        return;
      }

      const profileResult = await client.query(
        `update public.petro_profiles
         set active = true, account_status = 'active'
         where user_id = $1 and active = false and account_status = 'pending'`,
        [authData.user.id],
      );
      if (profileResult.rowCount !== 1) {
        await client.query("ROLLBACK");
        responseMessage(res, 403, "إعداد مالك المنصة غير متاح أو غير مصرح به.");
        return;
      }

      await client.query(
        `insert into public.petro_platform_roles (user_id, role, active)
         values ($1, 'owner', true)`,
        [authData.user.id],
      );
      await client.query(
        `insert into public.petro_audit_events (actor_id, organization_id, action, target_id, detail)
         values ($1, null, 'platform.owner_bootstrapped', $1, '{}'::jsonb)`,
        [authData.user.id],
      );
      await client.query("COMMIT");
      res.json({ status: "owner_initialized", message: "تم تهيئة مالك المنصة لهذا الحساب." });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      responseMessage(res, 503, "تعذر تهيئة مالك المنصة. لم يكتمل التغيير.");
    } finally {
      client.release();
    }
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

export default router;
