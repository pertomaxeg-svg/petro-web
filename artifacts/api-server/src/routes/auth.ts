import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";
import {
  createSupabaseServerClient,
  isRecord,
  readString,
  setNoStore,
} from "../lib/supabaseServer";

const router: IRouter = Router();

type Limit = { count: number; resetAt: number };
const limits = new Map<string, Limit>();

function consumeLimit(req: Request, action: string, maximum: number, windowMs: number): boolean {
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

async function resolveLoginEmail(identifier: string): Promise<string | null> {
  if (isEmail(identifier)) {
    const result = await pool.query<{ email: string; login_identifier_type: string | null }>(
      `select u.email, p.login_identifier_type
       from auth.users u
       left join public.petro_profiles p on p.user_id = u.id
       where lower(u.email) = lower($1)
       limit 1`,
      [identifier],
    );
    const row = result.rows[0];
    if (!row || row.login_identifier_type === "username" || !row.email) return null;
    return row.email;
  }

  if (!isUsername(identifier.toLowerCase())) return null;

  const result = await pool.query<{ email: string }>(
    `select u.email
     from public.petro_profiles p
     join auth.users u on u.id = p.user_id
     where p.username = lower($1)
       and p.login_identifier_type = 'username'
       and u.email is not null
     limit 1`,
    [identifier],
  );
  return result.rows[0]?.email ?? null;
}

async function resolveRecoveryEmail(identifier: string): Promise<string | null> {
  if (isEmail(identifier)) {
    const result = await pool.query<{ email: string }>(
      `select email
       from auth.users
       where lower(email) = lower($1)
         and email is not null
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
     where p.username = lower($1)
       and p.login_identifier_type = 'username'
       and u.email is not null
     limit 1`,
    [identifier],
  );
  return result.rows[0]?.email ?? null;
}

function safeErrorMessage(): string {
  return "تعذر إتمام الطلب حاليًا. حاول مرة أخرى بعد قليل.";
}

router.post("/auth/sign-up", async (req, res): Promise<void> => {
  setNoStore(res);
  if (!consumeLimit(req, "signup", 4, 15 * 60_000)) {
    responseMessage(res, 429, "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.");
    return;
  }

  if (!isRecord(req.body)) {
    responseMessage(res, 400, "تحقق من بيانات التسجيل.");
    return;
  }

  const identifierType = req.body["identifierType"];
  const password = readPassword(req.body, "password");
  const displayName = readString(req.body, "displayName", 120);
  const redirectTo = validSameOriginCallback(
    req,
    readString(req.body, "redirectTo", 2048),
  );

  if (
    (identifierType !== "email" && identifierType !== "username") ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128 ||
    !redirectTo
  ) {
    responseMessage(res, 400, "تحقق من بيانات التسجيل وكلمة المرور ورابط التأكيد.");
    return;
  }

  let email: string;
  let username: string | undefined;
  if (identifierType === "email") {
    const suppliedEmail = readString(req.body, "email", 254);
    if (!suppliedEmail || !isEmail(suppliedEmail)) {
      responseMessage(res, 400, "أدخل بريدًا إلكترونيًا صالحًا.");
      return;
    }
    email = suppliedEmail.toLowerCase();
  } else {
    const suppliedUsername = readString(req.body, "username", 32)?.toLowerCase();
    const recoveryEmail = readString(req.body, "recoveryEmail", 254);
    if (
      !suppliedUsername ||
      !isUsername(suppliedUsername) ||
      !recoveryEmail ||
      !isEmail(recoveryEmail)
    ) {
      responseMessage(res, 400, "اسم المستخدم أو بريد الاستعادة غير صالح.");
      return;
    }
    username = suppliedUsername;
    email = recoveryEmail.toLowerCase();
  }

  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectTo,
        data: {
          login_identifier_type: identifierType,
          ...(username ? { username } : {}),
          ...(displayName ? { display_name: displayName } : {}),
        },
      },
    });

    if (error || !data.user) {
      responseMessage(res, 400, "تعذر إنشاء الحساب بالبيانات المقدمة. تحقق منها أو سجّل الدخول.");
      return;
    }

    res.status(202).json({
      status: data.session ? "created" : "confirmation_required",
      message: data.session
        ? "تم إنشاء الحساب. سيظل الوصول للجهات معلقًا حتى تعيين الصلاحيات."
        : "تم استلام التسجيل. افتح رسالة التأكيد لإكمال إنشاء الحساب.",
    });
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.post("/auth/sign-in", async (req, res): Promise<void> => {
  setNoStore(res);
  if (!consumeLimit(req, "signin", 10, 15 * 60_000)) {
    responseMessage(res, 429, "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.");
    return;
  }

  const identifier = readString(req.body, "identifier", 254);
  const password = readPassword(req.body, "password");
  if (!identifier || !password) {
    responseMessage(res, 400, "أدخل البريد الإلكتروني أو اسم المستخدم وكلمة المرور.");
    return;
  }

  try {
    const email = await resolveLoginEmail(identifier);
    if (!email) {
      responseMessage(res, 401, "بيانات الدخول غير صحيحة.");
      return;
    }

    const supabase = createSupabaseServerClient(req, res);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.user) {
      responseMessage(res, 401, "بيانات الدخول غير صحيحة.");
      return;
    }

    const profile = await pool.query<{ active: boolean; account_status: string | null }>(
      `select active, account_status
       from public.petro_profiles
       where user_id = $1
       limit 1`,
      [data.user.id],
    );
    const account = profile.rows[0];
    if (account && !account.active && account.account_status !== "pending") {
      await supabase.auth.signOut({ scope: "local" });
      responseMessage(res, 403, "هذا الحساب معطل. تواصل مع مسؤول المنصة.");
      return;
    }

    res.json({
      status: account?.active ? "active" : "pending",
      message: account?.active
        ? "تم تسجيل الدخول."
        : "تم تسجيل الدخول. الحساب بانتظار اعتماد الصلاحيات.",
    });
  } catch {
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
  if (!consumeLimit(req, "recovery", 4, 60 * 60_000)) {
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
    if (!email) {
      res.status(202).json({
        message: "إذا كانت البيانات مرتبطة بحساب، فستصل تعليمات الاستعادة إلى البريد المسجل.",
      });
      return;
    }

    const supabase = createSupabaseServerClient(req, res);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    if (error) {
      responseMessage(res, 503, "تعذر إرسال تعليمات الاستعادة حاليًا.");
      return;
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

    if (!profile.active && profile.account_status !== "pending") {
      await supabase.auth.signOut({ scope: "local" });
      responseMessage(res, 403, "هذا الحساب معطل. تواصل مع مسؤول المنصة.");
      return;
    }

    let accessContext: unknown = null;
    if (profile.active) {
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
      accessContext,
    });
  } catch {
    responseMessage(res, 503, safeErrorMessage());
  }
});

router.get("/auth/bootstrap-status", async (_req, res): Promise<void> => {
  setNoStore(res);
  const bootstrapToken = process.env["PERTOMAX_OWNER_BOOTSTRAP_TOKEN"];
  if (!bootstrapToken || bootstrapToken.length < 32) {
    res.json({ available: false });
    return;
  }

  try {
    const result = await pool.query<{ owner_exists: boolean }>(
      `select exists(
         select 1
         from public.petro_platform_roles r
         join public.petro_profiles p on p.user_id = r.user_id
         where r.role = 'owner' and r.active and p.active
       ) as owner_exists`,
    );
    res.json({ available: !result.rows[0]?.owner_exists });
  } catch {
    responseMessage(res, 503, "تعذر التحقق من حالة الإعداد.");
  }
});

router.post("/auth/bootstrap-owner", async (req, res): Promise<void> => {
  setNoStore(res);
  if (!consumeLimit(req, "owner-bootstrap", 5, 60 * 60_000)) {
    responseMessage(res, 429, "محاولات كثيرة. انتظر قبل المحاولة مجددًا.");
    return;
  }

  const configuredToken = process.env["PERTOMAX_OWNER_BOOTSTRAP_TOKEN"];
  const providedToken = readString(req.body, "token", 256);
  if (!configuredToken || configuredToken.length < 32 || !providedToken) {
    responseMessage(res, 403, "إعداد مالك المنصة غير متاح.");
    return;
  }

  const expected = Buffer.from(configuredToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    responseMessage(res, 403, "تعذر اعتماد هذا الطلب.");
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
      const ownerResult = await client.query<{ owner_exists: boolean }>(
        `select exists(
           select 1
           from public.petro_platform_roles r
           join public.petro_profiles p on p.user_id = r.user_id
           where r.role = 'owner' and r.active and p.active
         ) as owner_exists`,
      );
      if (ownerResult.rows[0]?.owner_exists) {
        await client.query("ROLLBACK");
        responseMessage(res, 409, "مالك المنصة موجود بالفعل.");
        return;
      }

      const emailVerification = await client.query<{ verified: boolean }>(
        `select email_confirmed_at is not null as verified
         from auth.users
         where id = $1`,
        [authData.user.id],
      );
      if (!emailVerification.rows[0]?.verified) {
        await client.query("ROLLBACK");
        responseMessage(res, 403, "أكمل تأكيد البريد قبل إعداد مالك المنصة.");
        return;
      }

      const profileResult = await client.query(
        `update public.petro_profiles
         set active = true, account_status = 'active'
         where user_id = $1`,
        [authData.user.id],
      );
      if (profileResult.rowCount !== 1) {
        await client.query("ROLLBACK");
        responseMessage(res, 409, "أكمل إنشاء الحساب وتأكيد البريد قبل الإعداد.");
        return;
      }

      await client.query(
        `insert into public.petro_platform_roles (user_id, role, active)
         values ($1, 'owner', true)
         on conflict (user_id, role) do update set active = true`,
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
