import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { createSupabaseServerClient, isRecord, readString, readStringArray, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMBERSHIP_ROLES = new Set([
  "organization_owner",
  "manager",
  "finance",
  "worker",
  "viewer",
]);
const ORGANIZATION_KINDS = new Set(["company", "station", "provider"]);
const MEMBERSHIP_SCOPES = new Set(["organization", "branches"]);

type SessionContext = {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  userId: string;
};

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

function validId(value: string | undefined): value is string {
  return Boolean(value && UUID_RE.test(value));
}

async function requireSession(
  req: Request,
  res: Response,
  requireActive = true,
): Promise<SessionContext | null> {
  try {
    const supabase = createSupabaseServerClient(req, res);
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      fail(res, 401, "يلزم تسجيل الدخول.");
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from("petro_profiles")
      .select("active,account_status")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (profileError || !profile) {
      fail(res, 503, "تعذر قراءة صلاحية الحساب.");
      return null;
    }
    if (profile.account_status === "suspended" || (!profile.active && profile.account_status !== "pending")) {
      await supabase.auth.signOut({ scope: "local" });
      fail(res, 403, "هذا الحساب معطل.");
      return null;
    }
    if (requireActive && !profile.active) {
      fail(res, 403, "الحساب بانتظار اعتماد الصلاحيات.");
      return null;
    }

    return { supabase, userId: authData.user.id };
  } catch {
    fail(res, 503, "تعذر التحقق من جلسة الدخول.");
    return null;
  }
}

function apiError(res: Response, error: { code?: string } | null): void {
  if (error?.code === "42501" || error?.code === "PGRST301") {
    fail(res, 403, "ليست لديك صلاحية لهذا الإجراء.");
  } else if (error?.code === "23505") {
    fail(res, 409, "يوجد سجل مماثل بالفعل.");
  } else if (error?.code === "P0002") {
    fail(res, 404, "لم يتم العثور على السجل المطلوب.");
  } else {
    fail(res, 400, "تعذر تنفيذ الطلب. تحقق من البيانات والصلاحيات.");
  }
}

function organizationIdFrom(req: Request): string | null {
  const candidate = req.params["organizationId"];
  return typeof candidate === "string" && validId(candidate) ? candidate : null;
}

router.get("/organizations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const { data, error } = await session.supabase
    .from("petro_organizations")
    .select("id,name,kind,country_code,currency,status,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ items: data ?? [] });
});

router.post("/organizations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const name = readString(req.body, "name", 160);
  const kind = readString(req.body, "kind", 40);
  if (!name || name.length < 2 || !kind || !ORGANIZATION_KINDS.has(kind)) {
    fail(res, 400, "أدخل اسم الجهة ونوعًا صالحًا.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_create_organization", {
    p_name: name,
    p_kind: kind,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.status(201).json({ id: data, message: "تم إنشاء الجهة بحالة انتظار الاعتماد." });
});

router.patch("/organizations/:organizationId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  const name = readString(req.body, "name", 160);
  if (!organizationId || !name || name.length < 2) {
    fail(res, 400, "تحقق من معرّف الجهة واسمها.");
    return;
  }

  const { error } = await session.supabase.rpc("petro_update_organization", {
    p_organization_id: organizationId,
    p_name: name,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم تحديث بيانات الجهة." });
});

router.patch("/organizations/:organizationId/status", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  const status = readString(req.body, "status", 20);
  if (!organizationId || !status || !["pending", "active", "suspended"].includes(status)) {
    fail(res, 400, "تحقق من معرّف الجهة وحالتها.");
    return;
  }

  const { error } = await session.supabase.rpc("petro_set_organization_status", {
    p_organization_id: organizationId,
    p_status: status,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ status, message: "تم تحديث حالة الجهة وتسجيل التغيير." });
});

router.get("/organizations/:organizationId/branches", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  if (!organizationId) {
    fail(res, 400, "معرّف الجهة غير صالح.");
    return;
  }

  const { data, error } = await session.supabase
    .from("petro_branches")
    .select("id,organization_id,name,address,status,created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ items: data ?? [] });
});

router.post("/organizations/:organizationId/branches", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  const name = readString(req.body, "name", 160);
  const address = readString(req.body, "address", 500) ?? "";
  if (!organizationId || !name || name.length < 2) {
    fail(res, 400, "أدخل اسمًا صالحًا للفرع.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_create_branch", {
    p_organization_id: organizationId,
    p_name: name,
    p_address: address,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.status(201).json({ id: data, message: "تم إنشاء الفرع." });
});

router.patch("/branches/:branchId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const branchId = req.params["branchId"];
  const organizationId = readString(req.body, "organizationId", 64);
  const name = readString(req.body, "name", 160);
  const address = readString(req.body, "address", 500) ?? "";
  if (!validId(branchId) || !validId(organizationId ?? undefined) || !name || name.length < 2) {
    fail(res, 400, "تحقق من بيانات الفرع.");
    return;
  }

  const { error } = await session.supabase.rpc("petro_update_branch", {
    p_organization_id: organizationId,
    p_branch_id: branchId,
    p_name: name,
    p_address: address,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم تحديث بيانات الفرع." });
});

router.patch("/branches/:branchId/status", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const branchId = req.params["branchId"];
  const organizationId = readString(req.body, "organizationId", 64);
  const status = readString(req.body, "status", 16);
  if (
    !validId(branchId) ||
    !validId(organizationId ?? undefined) ||
    !status ||
    !["pending", "active", "suspended"].includes(status)
  ) {
    fail(res, 400, "تحقق من حالة الفرع.");
    return;
  }

  const { error } = await session.supabase.rpc("petro_set_branch_status", {
    p_organization_id: organizationId,
    p_branch_id: branchId,
    p_status: status,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ message: "تم تحديث حالة الفرع وتسجيل التغيير." });
});

router.get("/organizations/:organizationId/memberships", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  if (!organizationId) {
    fail(res, 400, "معرّف الجهة غير صالح.");
    return;
  }

  const { data: memberships, error: membershipError } = await session.supabase
    .from("petro_memberships")
    .select("id,user_id,organization_id,role,scope,active")
    .eq("organization_id", organizationId)
    .order("role");
  if (membershipError) {
    apiError(res, membershipError);
    return;
  }

  const membershipIds = (memberships ?? []).map((item) => item.id);
  const userIds = [...new Set((memberships ?? []).map((item) => item.user_id))];
  if (membershipIds.length === 0) {
    res.json({ items: [] });
    return;
  }

  const [branchResult, profileResult] = await Promise.all([
    session.supabase
      .from("petro_membership_branches")
      .select("membership_id,branch_id")
      .in("membership_id", membershipIds),
    session.supabase
      .from("petro_profiles")
      .select("user_id,display_name,username,active,account_status")
      .in("user_id", userIds),
  ]);
  if (branchResult.error) {
    apiError(res, branchResult.error);
    return;
  }
  if (profileResult.error) {
    apiError(res, profileResult.error);
    return;
  }

  const profiles = new Map((profileResult.data ?? []).map((profile) => [profile.user_id, profile]));
  const branchesByMembership = new Map<string, string[]>();
  for (const item of branchResult.data ?? []) {
    const items = branchesByMembership.get(item.membership_id) ?? [];
    items.push(item.branch_id);
    branchesByMembership.set(item.membership_id, items);
  }

  res.json({
    items: (memberships ?? []).map((membership) => ({
      ...membership,
      profile: profiles.get(membership.user_id) ?? null,
      branchIds: branchesByMembership.get(membership.id) ?? [],
    })),
  });
});

router.post("/organizations/:organizationId/memberships", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  const userId = readString(req.body, "userId", 64);
  const role = readString(req.body, "role", 40);
  const scope = readString(req.body, "scope", 20);
  const branchIds = readStringArray(req.body, "branchIds", 100);
  const active = isRecord(req.body) ? req.body["active"] !== false : true;
  if (
    !organizationId ||
    !validId(userId ?? undefined) ||
    !role ||
    !MEMBERSHIP_ROLES.has(role) ||
    !scope ||
    !MEMBERSHIP_SCOPES.has(scope) ||
    !branchIds ||
    branchIds.some((id) => !validId(id))
  ) {
    fail(res, 400, "تحقق من حساب الموظف والدور ونطاق الفروع.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_set_membership", {
    p_organization_id: organizationId,
    p_user_id: userId,
    p_role: role,
    p_scope: scope,
    p_branch_ids: branchIds,
    p_active: active,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ id: data, message: "تم تحديث صلاحيات الموظف وتسجيل التغيير." });
});

router.get("/organizations/:organizationId/invitations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  if (!organizationId) {
    fail(res, 400, "معرّف الجهة غير صالح.");
    return;
  }

  const { data, error } = await session.supabase.rpc("petro_list_invitations", {
    p_organization_id: organizationId,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ items: data ?? [] });
});

router.post("/organizations/:organizationId/invitations", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const organizationId = organizationIdFrom(req);
  const email = readString(req.body, "email", 254)?.toLowerCase();
  const role = readString(req.body, "role", 40);
  const scope = readString(req.body, "scope", 20);
  const branchIds = readStringArray(req.body, "branchIds", 100);
  if (
    !organizationId ||
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !role ||
    !MEMBERSHIP_ROLES.has(role) ||
    !scope ||
    !MEMBERSHIP_SCOPES.has(scope) ||
    !branchIds ||
    branchIds.some((id) => !validId(id))
  ) {
    fail(res, 400, "تحقق من البريد والدور ونطاق الفروع.");
    return;
  }

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const { data, error } = await session.supabase.rpc("petro_create_invitation", {
    p_organization_id: organizationId,
    p_email: email,
    p_role: role,
    p_scope: scope,
    p_branch_ids: branchIds,
    p_token_hash: tokenHash,
  });
  if (error) {
    apiError(res, error);
    return;
  }

  const origin = req.get("origin");
  const referer = req.get("referer");
  let appPrefix = "";
  try {
    if (origin && referer) {
      const refererUrl = new URL(referer);
      if (refererUrl.origin === new URL(origin).origin) {
        const routeMatch = refererUrl.pathname.match(
          /^(.*?)(?:\/(?:workspace|sign-in|sign-up|reset-password)(?:\/|$))/,
        );
        appPrefix = routeMatch?.[1] ?? "";
      }
    }
  } catch {
    appPrefix = "";
  }

  res.status(201).json({
    id: data,
    inviteUrl: `${origin ?? ""}${appPrefix}/sign-up?invite=${encodeURIComponent(rawToken)}`,
    expiresInDays: 7,
    message: "أُنشئت الدعوة. انسخ الرابط الآن؛ لن يُعرض رمزها مرة أخرى.",
  });
});

router.post("/invitations/accept", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res, false);
  if (!session) return;

  const token = readString(req.body, "token", 128);
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    fail(res, 400, "رابط الدعوة غير صالح.");
    return;
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await session.supabase.rpc("petro_accept_invitation", {
    p_token_hash: tokenHash,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ id: data, message: "تم قبول الدعوة وتفعيل صلاحيات الجهة." });
});

router.delete("/invitations/:invitationId", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const invitationId = req.params["invitationId"];
  if (!validId(invitationId)) {
    fail(res, 400, "معرّف الدعوة غير صالح.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_revoke_invitation", {
    p_invitation_id: invitationId,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.status(204).end();
});

router.patch("/users/:userId/status", async (req, res): Promise<void> => {
  setNoStore(res);
  const session = await requireSession(req, res);
  if (!session) return;

  const userId = req.params["userId"];
  const status = readString(req.body, "status", 20);
  if (!validId(userId) || (status !== "active" && status !== "suspended")) {
    fail(res, 400, "معرّف الحساب أو حالته غير صالح.");
    return;
  }
  const { error } = await session.supabase.rpc("petro_set_account_status", {
    p_user_id: userId,
    p_status: status,
  });
  if (error) {
    apiError(res, error);
    return;
  }
  res.json({ status, message: "تم تحديث حالة الحساب وتسجيل التغيير." });
});

export default router;
