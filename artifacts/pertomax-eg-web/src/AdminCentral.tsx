import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, Check, ChevronLeft, CircleAlert, Clock3, CreditCard, FileSearch, LockKeyhole, RefreshCw, Search, ShieldCheck, UserRound, Users, X } from "lucide-react";
import {
  getGetAuthMeQueryKey, getGetPlatformUserQueryKey, getListAdminOrganizationRequestsQueryKey,
  getListOrganizationsQueryKey, getListPlatformUsersQueryKey, useGetAuthMe, useGetPlatformUser,
  useListAdminOrganizationRequests, useListOrganizations, useListPlatformUsers, useSetPlatformUserRoles,
  useSetUserStatus, useSignOut,
} from "@workspace/api-client-react";
import type { PlatformRole, PlatformUser } from "@workspace/api-client-react";

const roles: PlatformRole[] = ["owner", "operations", "finance", "support", "auditor"];
const roleFallback: Record<PlatformRole, string> = { owner: "مالك المنصة", operations: "العمليات", finance: "المالية", support: "الدعم", auditor: "مراجع" };
const statusLabel: Record<string, string> = { active: "نشط", pending: "بانتظار التفعيل", suspended: "موقوف" };
const kindLabel: Record<string, string> = { company: "شركة", station: "محطة", provider: "مقدّم خدمة" };
const requestLabel: Record<string, string> = { join: "انضمام جهة", change: "تغيير بيانات", bank: "حساب بنكي", document: "مستند" };
const errorInfo = (err: unknown) => err as { status?: number; message?: string; data?: { message?: string } };
const apiMessage = (err: unknown) => errorInfo(err)?.data?.message || errorInfo(err)?.message || "تعذر إتمام الطلب. حاول مرة أخرى.";
const isOwner = (ctx: unknown) => {
  if (!ctx || typeof ctx !== "object") return false;
  const c = ctx as Record<string, unknown>;
  const value = c.platform_roles ?? c.platformRoles;
  return Array.isArray(value) && value.includes("owner");
};
const dateText = (value?: string) => value ? new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }) : "—";

function AdminGate({ children }: { children: (name: string, userId: string) => ReactNode }) {
  const me = useGetAuthMe({ query: { queryKey: getGetAuthMeQueryKey(), retry: false, staleTime: 20_000 } });
  if (me.isLoading) return <main className="ac-page" dir="rtl"><div className="ac-loading"><i/><i/><i/></div></main>;
  if (me.isError || !me.data) return <main className="ac-guard" dir="rtl"><div className="ac-guard-mark"><LockKeyhole/></div><h1>يلزم تسجيل الدخول</h1><p>تتطلب الإدارة المركزية جلسة موثّقة بحساب مالك المنصة.</p><Link className="ac-button" href="/sign-in">تسجيل الدخول <ArrowLeft size={16}/></Link></main>;
  if (me.data.state !== "active" || !isOwner(me.data.accessContext)) return <main className="ac-guard" dir="rtl"><div className="ac-guard-mark"><ShieldCheck/></div><h1>هذه المساحة غير متاحة</h1><p>صلاحية مالك المنصة منفصلة عن عضوية أي جهة. لا يملك الحساب الحالي التفويض المطلوب.</p><Link className="ac-button ac-button-quiet" href="/workspace">العودة إلى مساحة العمل <ArrowLeft size={16}/></Link></main>;
  return <AdminShell name={me.data.displayName}>{children(me.data.displayName, me.data.id)}</AdminShell>;
}

export function CentralAdminFrame({ children }: { children: ReactNode }) {
  return <AdminGate>{() => children}</AdminGate>;
}

function AdminShell({ children, name }: { children: ReactNode; name: string }) {
  const [route] = useRoute("/admin/platform-users/:userId");
  const [orgRoute] = useRoute("/admin/organizations/:id");
  const [path, navigate] = useLocation();
  const signOut = useSignOut();
  const cache = useQueryClient();
  const [signOutError, setSignOutError] = useState("");
  async function exit() {
    setSignOutError("");
    try {
      await signOut.mutateAsync();
      cache.clear();
      navigate("/sign-in");
    } catch {
      setSignOutError("تعذر تسجيل الخروج. حاول مرة أخرى.");
    }
  }
  const active = path === "/admin" ? "overview" : path.includes("organization-requests") ? "requests" : path.includes("platform-users") ? "users" : path.includes("/admin/plans") ? "plans" : path.includes("/admin/subscriptions") ? "subscriptions" : "organizations";
  const pageTitle = active === "overview" ? "نظرة عامة" : active === "requests" ? "مراجعة الطلبات" : active === "users" ? (route ? "ملف مستخدم المنصة" : "مستخدمو المنصة") : active === "plans" ? "الخطط والأسعار" : active === "subscriptions" ? "طلبات واشتراكات" : orgRoute ? "تفاصيل الجهة" : "الجهات والفروع";
  return <div className="ac-app" dir="rtl">
    <header className="ac-topbar">
      <Link href="/admin" className="ac-brand" aria-label="Pertomax EG — لوحة الإدارة"><img src={`${import.meta.env.BASE_URL}petro-max-lockup.png`} alt="Pertomax EG"/></Link>
      <div className="ac-context"><span>الإدارة المركزية</span><b>{pageTitle}</b></div>
      <div className="ac-top-user"><span className="ac-owner-chip"><ShieldCheck size={15}/> مالك المنصة</span><span className="ac-avatar">{name.trim().slice(0, 1) || "م"}</span><span className="ac-top-name">{name}</span><button className="ac-signout" disabled={signOut.isPending} onClick={()=>void exit()}>{signOut.isPending?"جارٍ الخروج…":"تسجيل الخروج"}</button></div>
    </header>
    {signOutError && <p className="ac-signout-error" role="alert">{signOutError}</p>}
    <nav className="ac-nav" aria-label="التنقل المركزي">
      <Link href="/admin" className={active === "overview" ? "selected" : ""}><span className="ac-nav-icon"><FileSearch size={16}/></span>نظرة عامة</Link>
      <Link href="/admin/organizations" className={active === "organizations" ? "selected" : ""}><span className="ac-nav-icon"><Building2 size={16}/></span>الجهات والفروع</Link>
      <Link href="/admin/organization-requests" className={active === "requests" ? "selected" : ""}><span className="ac-nav-icon"><Clock3 size={16}/></span>مراجعة الطلبات</Link>
      <Link href="/admin/platform-users" className={active === "users" ? "selected" : ""}><span className="ac-nav-icon"><Users size={16}/></span>مستخدمو المنصة</Link>
      <Link href="/admin/plans" className={active === "plans" ? "selected" : ""}><span className="ac-nav-icon"><CreditCard size={16}/></span>الخطط والأسعار</Link>
      <Link href="/admin/subscriptions" className={active === "subscriptions" ? "selected" : ""}><span className="ac-nav-icon"><Clock3 size={16}/></span>الاشتراكات</Link>
      <span className="ac-nav-boundary">نطاق المنصة فقط</span>
    </nav>
    <div className="ac-breadcrumb"><Link href="/admin">الإدارة المركزية</Link><ChevronLeft size={13}/><span>{pageTitle}</span></div>
    <main className="ac-content">{children}</main>
    <footer className="ac-footer"><span>Pertomax EG <i/> الإدارة المركزية</span><span>قرارات الوصول تُسجّل مع سببها</span></footer>
  </div>;
}

function LoadError({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  const status = errorInfo(error)?.status;
  return <section className="ac-state ac-state-error"><span className="ac-state-symbol"><CircleAlert size={21}/></span><h2>{status === 403 ? "غير مخوّل بالوصول" : title}</h2><p>{status === 403 ? "رفض الخادم هذا الطلب. تحقق من تفويض مالك المنصة." : apiMessage(error)}</p><button className="ac-button ac-button-quiet" onClick={retry}><RefreshCw size={15}/> إعادة المحاولة</button></section>;
}

export function AdminOverview() {
  return <AdminGate>{() => <OverviewData/>}</AdminGate>;
}
function OverviewData() {
  const orgs = useListOrganizations({ page: 1, pageSize: 100 }, { query: { queryKey: getListOrganizationsQueryKey({ page: 1, pageSize: 100 }), retry: false } });
  const requests = useListAdminOrganizationRequests(undefined, { query: { queryKey: getListAdminOrganizationRequestsQueryKey(), retry: false } });
  const users = useListPlatformUsers({ page: 1, pageSize: 1 }, { query: { queryKey: getListPlatformUsersQueryKey({ page: 1, pageSize: 1 }), retry: false } });
  const pendingRequests = (requests.data?.items ?? []).filter(item => ["submitted", "pending", "pending_review"].includes(item.status));
  return <div className="ac-page-enter">
    <div className="ac-heading-row"><div><span className="ac-eyebrow">مركز القرار <i/></span><h1>صورة المنصة</h1><p>ملخص مباشر من سجلات الجهات والطلبات وحسابات المنصة.</p></div><span className="ac-date-stamp">PERTOMAX / CENTRAL</span></div>
    {(orgs.isError || requests.isError || users.isError) ? <LoadError title="تعذر تحميل ملخص الإدارة" error={orgs.error || requests.error || users.error} retry={()=>{void orgs.refetch();void requests.refetch();void users.refetch();}}/> :
      <section className="ac-metrics" aria-label="ملخص السجلات">
        <Metric title="الجهات المسجلة" value={orgs.data?.total} note="وفق سجل الجهات" icon={<Building2 size={18}/>} loading={orgs.isLoading}/>
        <Metric title="طلبات تنتظر المراجعة" value={pendingRequests.length} note="طلبات مرسلة للمراجعة" icon={<Clock3 size={18}/>} loading={requests.isLoading}/>
        <Metric title="حسابات المنصة" value={users.data?.total} note="دليل حسابات موحد" icon={<Users size={18}/>} loading={users.isLoading}/>
      </section>}
    <div className="ac-overview-grid">
      <section className="ac-panel ac-recent-panel"><div className="ac-panel-head"><div><span className="ac-eyebrow">الوارد الفعلي</span><h2>طلبات تحتاج مراجعة</h2></div><Link className="ac-inline-link" href="/admin/organization-requests">فتح صندوق المراجعة <ArrowLeft size={15}/></Link></div>
        {requests.isLoading ? <SkeletonRows/> : requests.isError ? <p className="ac-inline-message">تعذر قراءة سجل الطلبات.</p> : pendingRequests.length === 0 ? <div className="ac-empty"><span><Check size={18}/></span><b>لا توجد طلبات معلّقة</b><p>لا توجد طلبات مرسلة تنتظر إجراءً الآن.</p></div> :
          <div className="ac-inbox-list">{pendingRequests.slice(0, 6).map(item=><Link key={`${item.requestType}-${item.id}`} href="/admin/organization-requests" className="ac-inbox-row"><span className="ac-record-mark"><FileSearch size={17}/></span><span className="ac-inbox-copy"><b>{item.title}</b><small>{requestLabel[item.requestType] || item.requestType} · {dateText(item.createdAt)}</small></span><span className="ac-status ac-status-pending">{item.status === "submitted" ? "مرسل" : item.status}</span><ChevronLeft size={16}/></Link>)}</div>}
      </section>
      <section className="ac-panel ac-principle-panel"><span className="ac-eyebrow">فصل النطاقات</span><div className="ac-principle-mark"><ShieldCheck size={22}/></div><h2>صلاحية المنصة<br/>ليست عضوية جهة.</h2><p>أدوار المنصة تُدار على مستوى Pertomax EG. تبقى عضويات الجهات ونطاقات الفروع ضمن سجلاتها المنفصلة.</p><Link href="/admin/platform-users" className="ac-button ac-button-quiet">إدارة مستخدمي المنصة <ArrowLeft size={15}/></Link></section>
    </div>
    <section className="ac-org-preview"><div className="ac-panel-head"><div><span className="ac-eyebrow">البنية المسجلة</span><h2>أحدث الجهات</h2></div><Link className="ac-inline-link" href="/admin/organizations">سجل الجهات والفروع <ArrowLeft size={15}/></Link></div>
      {orgs.isLoading ? <SkeletonRows/> : orgs.isError ? <p className="ac-inline-message">تعذر قراءة سجل الجهات.</p> : !orgs.data?.items.length ? <div className="ac-empty"><span><Building2 size={18}/></span><b>لا توجد جهات مسجلة</b><p>ستظهر هنا الجهات المسجلة فعليًا.</p></div> :
        <div className="ac-org-grid">{orgs.data.items.slice(0, 4).map(org=><Link key={org.id} href={`/admin/organizations/${org.id}`} className="ac-org-tile"><span className="ac-org-logo"><Building2 size={17}/></span><span><b>{org.name}</b><small>{kindLabel[org.kind] || org.kind} · {org.code || "بلا كود"}</small></span><span className={`ac-status ac-status-${org.status}`}>{org.status === "active" ? "نشطة" : org.status === "suspended" ? "موقوفة" : "قيد الإجراء"}</span></Link>)}</div>}
    </section>
  </div>;
}
function Metric({ title, value, note, icon, loading }: { title: string; value?: number; note: string; icon: ReactNode; loading: boolean }) {
  return <article className="ac-metric"><div className="ac-metric-top"><span>{title}</span><i>{icon}</i></div>{loading ? <span className="ac-skeleton ac-metric-skeleton"/> : <strong>{value?.toLocaleString("ar-EG") ?? "—"}</strong>}<small>{note}</small></article>;
}
function SkeletonRows() { return <div className="ac-skeleton-list"><i/><i/><i/></div>; }

export function PlatformUserDirectory() {
  return <AdminGate>{() => <DirectoryData/>}</AdminGate>;
}
function DirectoryData() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const params = useMemo(() => ({ page, pageSize: 12, ...(search.trim().length >= 2 ? { search: search.trim() } : {}), ...(status ? { accountStatus: status as "pending"|"active"|"suspended" } : {}), ...(role ? { role: role as PlatformRole } : {}) }), [page, search, status, role]);
  const query = useListPlatformUsers(params, { query: { queryKey: getListPlatformUsersQueryKey(params), retry: false, refetchOnMount: "always" } });
  return <div className="ac-page-enter">
    <div className="ac-heading-row"><div><span className="ac-eyebrow">تفويض المنصة <i/></span><h1>مستخدمو المنصة</h1><p>دليل الحسابات وأدوارها النشطة على مستوى المنصة فقط.</p></div><span className="ac-total-stamp"><b>{query.data?.total?.toLocaleString("ar-EG") ?? "—"}</b><small>حساب</small></span></div>
    <section className="ac-directory-tools">
      <label className="ac-search"><Search size={18}/><input value={search} onChange={e=>{setSearch(e.target.value);setPage(1)}} placeholder="ابحث بالاسم أو اسم المستخدم" aria-label="البحث عن مستخدم"/></label>
      <label className="ac-filter">حالة الحساب<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1)}}><option value="">كل الحالات</option><option value="pending">بانتظار التفعيل</option><option value="active">نشط</option><option value="suspended">موقوف</option></select></label>
      <label className="ac-filter">دور المنصة<select value={role} onChange={e=>{setRole(e.target.value);setPage(1)}}><option value="">كل الأدوار</option>{roles.map(r=><option key={r} value={r}>{roleFallback[r]}</option>)}</select></label>
    </section>
    {search.trim().length === 1 && <p className="ac-search-hint">اكتب حرفين على الأقل لبدء البحث.</p>}
    <section className="ac-table-wrap">
      {query.isLoading ? <SkeletonRows/> : query.isError ? <LoadError title="تعذر تحميل دليل المستخدمين" error={query.error} retry={()=>void query.refetch()}/> : !query.data?.items.length ? <div className="ac-empty ac-empty-large"><span><UserRound size={21}/></span><b>لا توجد حسابات مطابقة</b><p>جرّب تعديل البحث أو إزالة أحد عوامل التصفية.</p><button className="ac-button ac-button-quiet" onClick={()=>{setSearch("");setRole("");setStatus("");setPage(1)}}>مسح عوامل التصفية</button></div> :
      <>
        <div className="ac-table-scroll"><table className="ac-table"><thead><tr><th>الحساب</th><th>أدوار المنصة النشطة</th><th>حالة الحساب</th><th>تاريخ الإنشاء</th><th/></tr></thead><tbody>{query.data.items.map(user=><PlatformUserRow user={user} key={user.userId}/>)}</tbody></table></div>
        <div className="ac-pagination"><span>عرض {query.data.items.length.toLocaleString("ar-EG")} من {query.data.total.toLocaleString("ar-EG")} حساب</span><div><button onClick={()=>setPage(page-1)} disabled={page<=1}>السابق</button><b>{query.data.page} / {Math.max(1, query.data.totalPages)}</b><button onClick={()=>setPage(page+1)} disabled={page>=query.data.totalPages}>التالي</button></div></div>
      </>}
    </section>
    <p className="ac-scope-note"><LockKeyhole size={14}/> هذا الدليل يعرض أدوار المنصة فقط؛ العضويات ونطاقات الفروع لا تُعدّل من هنا.</p>
  </div>;
}
function PlatformUserRow({ user }: { user: PlatformUser }) {
  return <tr><td><Link href={`/admin/platform-users/${encodeURIComponent(user.userId)}`} className="ac-user-cell"><span className="ac-user-avatar">{user.displayName.trim().slice(0,1) || "م"}</span><span><b>{user.displayName}</b><small dir="ltr">@{user.username}</small></span></Link></td><td><div className="ac-role-tags">{user.platformRoles.length ? user.platformRoles.map(r=><span className={`ac-role-tag role-${r}`} key={r}>{roleFallback[r]}</span>) : <span className="ac-no-role">بلا دور منصة</span>}</div></td><td><span className={`ac-status ac-status-${user.accountStatus}`}><i/>{statusLabel[user.accountStatus]}</span></td><td>{dateText(user.createdAt).split("،")[0]}</td><td><Link className="ac-row-link" href={`/admin/platform-users/${encodeURIComponent(user.userId)}`}>عرض السجل <ArrowLeft size={14}/></Link></td></tr>;
}

export function PlatformUserProfile() {
  const [, params] = useRoute("/admin/platform-users/:userId");
  return <AdminGate>{(_name, actorUserId) => <ProfileData userId={params?.userId ?? ""} actorUserId={actorUserId}/>}</AdminGate>;
}
function ProfileData({ userId, actorUserId }: { userId: string; actorUserId: string }) {
  const query = useGetPlatformUser(userId, { query: { queryKey: getGetPlatformUserQueryKey(userId), enabled: !!userId, retry: false, refetchOnMount: "always" } });
  const cache = useQueryClient();
  const [editRoles, setEditRoles] = useState(false);
  const [draftRoles, setDraftRoles] = useState<PlatformRole[]>([]);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  const [statusIntent, setStatusIntent] = useState<"active"|"suspended"|null>(null);
  const roleMutation = useSetPlatformUserRoles();
  const statusMutation = useSetUserStatus();
  const detail = query.data;
  const isSelf = userId === actorUserId;
  async function refresh() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: getGetPlatformUserQueryKey(userId) }),
      cache.invalidateQueries({ queryKey: getListPlatformUsersQueryKey() }),
      cache.invalidateQueries({ queryKey: getGetAuthMeQueryKey() }),
    ]);
  }
  function openRoleEditor() {
    if (isSelf) return;
    setDraftRoles([...(detail?.user.platformRoles ?? [])]);
    setReason(""); setActionError(""); setSuccess(""); setEditRoles(true); setStatusIntent(null);
  }
  async function saveRoles(event: FormEvent) {
    event.preventDefault(); setActionError(""); setSuccess("");
    if (reason.trim().length < 5 || reason.trim().length > 500) { setActionError("سبب التغيير مطلوب، من 5 إلى 500 حرف."); return; }
    try {
      await roleMutation.mutateAsync({ userId, data: { roles: draftRoles, reason: reason.trim() } });
      setEditRoles(false); setSuccess("تم تحديث أدوار المنصة وتسجيل السبب في سجل التدقيق."); setReason(""); await refresh();
    } catch (err) { setActionError(errorInfo(err)?.status === 409 ? "تعارض حماية: تعذر تطبيق التغيير لأنه قد يترك المنصة بلا مالك نشط. حدّث السجل وراجع الأدوار الحالية." : apiMessage(err)); await query.refetch(); }
  }
  async function saveStatus(event: FormEvent) {
    event.preventDefault(); if (!statusIntent) return; setActionError(""); setSuccess("");
    if (reason.trim().length < 5 || reason.trim().length > 500) { setActionError("سبب الإجراء مطلوب، من 5 إلى 500 حرف."); return; }
    try {
      await statusMutation.mutateAsync({ userId, data: { status: statusIntent, reason: reason.trim() } });
      setSuccess(statusIntent === "suspended" ? "تم إيقاف الحساب وتسجيل السبب." : "تم تفعيل الحساب وتسجيل السبب."); setStatusIntent(null); setReason(""); await refresh();
    } catch (err) { setActionError(errorInfo(err)?.status === 409 ? "تعارض حماية: تعذر الإجراء للحفاظ على آخر مالك نشط. حدّث السجل قبل المتابعة." : apiMessage(err)); await query.refetch(); }
  }
  return <div className="ac-page-enter">
    <Link className="ac-back-link" href="/admin/platform-users"><ArrowRight size={15}/> العودة إلى دليل المستخدمين</Link>
    {query.isLoading ? <section className="ac-profile-loading"><SkeletonRows/></section> : query.isError || !detail ? <LoadError title="تعذر تحميل ملف المستخدم" error={query.error} retry={()=>void query.refetch()}/> :
    <>
      <div className="ac-heading-row ac-profile-heading"><div><span className="ac-eyebrow">ملف حساب / صلاحيات المنصة</span><h1>حساب المنصة</h1><p>قرارات الدور والحالة تُسجّل في سجل تدقيق خاص بهذا الحساب.</p></div><span className="ac-audit-seal"><ShieldCheck size={17}/> مساحة حساسة</span></div>
      <section className="ac-profile-card">
        <div className="ac-profile-identity"><span className="ac-profile-avatar">{detail.user.displayName.trim().slice(0,1) || "م"}</span><div><h2>{detail.user.displayName}</h2><span className="ac-username" dir="ltr">@{detail.user.username}</span></div><span className={`ac-status ac-status-${detail.user.accountStatus}`}><i/>{statusLabel[detail.user.accountStatus]}</span></div>
        <div className="ac-account-facts"><div><small>معرّف الحساب</small><b dir="ltr">{detail.user.userId}</b></div><div><small>تاريخ الإنشاء</small><b>{dateText(detail.user.createdAt)}</b></div><div><small>الحساب مُفعّل</small><b>{detail.user.active ? "نعم" : "لا"}</b></div></div>
      </section>
      <section className="ac-profile-grid">
        <article className="ac-panel ac-roles-panel"><div className="ac-panel-head"><div><span className="ac-eyebrow">نطاق: المنصة</span><h2>الأدوار النشطة</h2></div>{!editRoles&&!statusIntent&&<button className="ac-button ac-button-quiet" disabled={isSelf} title={isSelf?"لا يمكن تعديل أدوار حسابك من الجلسة نفسها":undefined} onClick={openRoleEditor}>تعديل الأدوار</button>}</div>
          {detail.user.platformRoles.length ? <div className="ac-active-roles">{detail.user.platformRoles.map(role=>{const catalog=detail.roleCatalog.find(item=>item.role===role);return <article className="ac-active-role" key={role}><div className="ac-active-role-title"><span className={`ac-role-glyph role-${role}`}><ShieldCheck size={16}/></span><div><b>{catalog?.label ?? roleFallback[role]}</b><small>دور على مستوى المنصة</small></div></div><ul>{catalog?.permissions.map(permission=><li key={permission.code}><Check size={13}/>{permission.label}</li>) ?? <li>لا توجد أوصاف قدرات متاحة.</li>}</ul></article>})}</div> : <div className="ac-no-active-roles"><span><ShieldCheck size={18}/></span><b>لا توجد أدوار منصة نشطة</b><small>لا يعني ذلك وجود عضوية جهة.</small></div>}
          {editRoles && <form className="ac-action-form" onSubmit={saveRoles}><div className="ac-action-title"><div><b>تحديث أدوار المنصة</b><small>الأوصاف المعروضة مصدرها دليل الأدوار الفعلي في API.</small></div><button type="button" className="ac-icon-button" onClick={()=>setEditRoles(false)} aria-label="إلغاء"><X size={17}/></button></div><div className="ac-role-picker">{detail.roleCatalog.map(item=><label key={item.role} className={draftRoles.includes(item.role)?"checked":""}><input type="checkbox" checked={draftRoles.includes(item.role)} onChange={e=>setDraftRoles(current=>e.target.checked?[...current,item.role]:current.filter(r=>r!==item.role))}/><span><b>{item.label}</b><small>{item.permissions.map(p=>p.label).join(" · ") || "لا توجد قدرات مسجلة"}</small></span><i>{draftRoles.includes(item.role)&&<Check size={14}/>}</i></label>)}</div><ReasonField reason={reason} setReason={setReason}/>{actionError&&<InlineAlert error>{actionError}</InlineAlert>}<div className="ac-form-actions"><button className="ac-button" disabled={roleMutation.isPending||reason.trim().length<5}>{roleMutation.isPending?"جارٍ تسجيل الأدوار…":"حفظ الأدوار"}</button><button type="button" className="ac-button ac-button-quiet" onClick={()=>setEditRoles(false)}>إلغاء</button></div></form>}
          {statusIntent&&<form className="ac-action-form" onSubmit={saveStatus}><div className="ac-action-title"><div><b>{statusIntent==="suspended"?"إيقاف الحساب":"تفعيل الحساب"}</b><small>سيُحفظ هذا الإجراء مع سبب واضح في سجل التدقيق.</small></div><button type="button" className="ac-icon-button" onClick={()=>setStatusIntent(null)} aria-label="إلغاء"><X size={17}/></button></div><ReasonField reason={reason} setReason={setReason}/>{actionError&&<InlineAlert error>{actionError}</InlineAlert>}<div className="ac-form-actions"><button className={statusIntent==="suspended"?"ac-button ac-button-danger":"ac-button"} disabled={statusMutation.isPending||reason.trim().length<5}>{statusMutation.isPending?"جارٍ تسجيل الحالة…":statusIntent==="suspended"?"تأكيد إيقاف الحساب":"تأكيد تفعيل الحساب"}</button><button type="button" className="ac-button ac-button-quiet" onClick={()=>setStatusIntent(null)}>إلغاء</button></div></form>}
        </article>
        <aside className="ac-panel ac-account-actions"><span className="ac-eyebrow">حالة الوصول</span><h2>إجراءات الحساب</h2><p>تغيير الحالة يؤثر في تسجيل الدخول، ولا يغيّر عضويات الجهات.</p>{isSelf ? <InlineAlert error>لا يمكن تغيير أدوار حسابك أو حالته من الجلسة نفسها.</InlineAlert> : detail.user.accountStatus==="suspended" ? <button className="ac-button" onClick={()=>{setStatusIntent("active");setReason("");setActionError("");setEditRoles(false)}}>تفعيل الحساب</button> : <button className="ac-button ac-button-danger-outline" onClick={()=>{setStatusIntent("suspended");setReason("");setActionError("");setEditRoles(false)}}>إيقاف الحساب</button>}{success&&<InlineAlert>{success}</InlineAlert>}<div className="ac-separation-note"><LockKeyhole size={15}/><span>أدوار المنصة منفصلة عن عضويات الجهات ونطاقات الفروع.</span></div></aside>
      </section>
      <section className="ac-panel ac-audit-panel"><div className="ac-panel-head"><div><span className="ac-eyebrow">أثر القرارات</span><h2>سجل التدقيق الأخير</h2></div><span className="ac-audit-count">{detail.activity.length.toLocaleString("ar-EG")} حدث</span></div>
        {!detail.activity.length ? <div className="ac-empty"><span><FileSearch size={18}/></span><b>لا توجد أحداث تدقيق بعد</b><p>ستظهر هنا التغييرات الفعلية على أدوار هذا الحساب وحالته.</p></div> : <div className="ac-audit-list">{detail.activity.map(event=><article className="ac-audit-event" key={event.activityId}><span className={`ac-event-mark ${event.action.includes("roles")?"event-role":"event-status"}`}>{event.action.includes("roles")?<ShieldCheck size={16}/>:<UserRound size={16}/>}</span><div className="ac-event-main"><div className="ac-event-head"><b>{event.action.includes("roles")?"تغيير أدوار المنصة":"تغيير حالة الحساب"}</b><time>{dateText(event.occurredAt)}</time></div><span>بواسطة {event.actorDisplayName || event.actorUsername || "النظام"}</span>{event.action.includes("roles")&&<div className="ac-role-diff"><small>قبل</small>{event.previousRoles.length?event.previousRoles.map(r=><i key={`old-${r}`}>{detail.roleCatalog.find(x=>x.role===r)?.label??roleFallback[r]}</i>):<i>بلا دور</i>}<ArrowLeft size={13}/><small>بعد</small>{event.newRoles.length?event.newRoles.map(r=><i key={`new-${r}`}>{detail.roleCatalog.find(x=>x.role===r)?.label??roleFallback[r]}</i>):<i>بلا دور</i>}</div>}{event.status&&<span className={`ac-status ac-status-${event.status}`}>{statusLabel[event.status]}</span>}{event.reason&&<p className="ac-event-reason"><b>السبب:</b> {event.reason}</p>}</div></article>)}</div>}
      </section>
    </>}
  </div>;
}
function ReasonField({ reason, setReason }: { reason: string; setReason: (value: string)=>void }) {
  return <label className="ac-reason-field">سبب موثق <span>5–500 حرف</span><textarea value={reason} onChange={e=>setReason(e.target.value)} minLength={5} maxLength={500} required placeholder="اذكر سبب القرار بوضوح، وسيظهر في سجل التدقيق."/><small>{reason.trim().length} / 500</small></label>;
}
function InlineAlert({ children, error=false }: { children: string; error?: boolean }) {
  return <div className={error?"ac-inline-alert ac-inline-error":"ac-inline-alert"} role={error?"alert":"status"}>{error?<CircleAlert size={15}/>:<Check size={15}/>}<span>{children}</span></div>;
}
