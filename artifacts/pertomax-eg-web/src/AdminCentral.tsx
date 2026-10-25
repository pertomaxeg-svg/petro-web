import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import "./AdminCentral.css";
import { ArrowLeft, ArrowRight, Banknote, Building2, Check, ChevronDown, ChevronLeft, CircleAlert, Clock3, CreditCard, FileSearch, Fuel, LockKeyhole, Menu, Package, PanelRightClose, RefreshCw, Search, ShieldCheck, UserRound, UserPlus, Users, X, Truck } from "lucide-react";
import {
  getGetAuthMeQueryKey, getGetPlatformUserQueryKey, getListAdminOrganizationRequestsQueryKey,
  getGetPlatformUserMembershipsQueryKey, getListOrganizationsQueryKey, getListPlatformUsersQueryKey,
  useGetAuthMe, useGetPlatformUser, useGetPlatformUserMemberships,
  useListAdminOrganizationRequests, useListOrganizations, useListPlatformUsers, useCreatePlatformUser, useSetPlatformUserRoles,
  useSetUserStatus, useSignOut,
} from "@workspace/api-client-react";
import type { PlatformRole, PlatformUser } from "@workspace/api-client-react";
const AdminFinancePage = lazy(() => import("./admin-finance/AdminFinancePage").then(module => ({ default: module.AdminFinancePage })));
const FleetAdminPage = lazy(() => import("./FleetAdmin").then(module => ({ default: module.FleetAdminPage })));
const CatalogAdminPage = lazy(() => import("./CatalogAdmin").then(module => ({ default: module.CatalogAdminPage })));
const ServiceOrdersPage = lazy(() => import("./ServiceOrders").then(module => ({ default: module.ServiceOrdersPage })));
const WorkforceAdmin = lazy(() => import("./WorkforceAdmin").then(module => ({ default: module.WorkforceAdmin })));
const AdminInventoryPage = lazy(() => import("./inventory/AdminInventoryPage").then(module => ({ default: module.AdminInventoryPage })));

const roles: PlatformRole[] = ["owner", "operations", "finance", "support", "auditor"];
const roleFallback: Record<PlatformRole, string> = { owner: "مالك المنصة", operations: "العمليات", finance: "المالية", support: "الدعم", auditor: "مراجع" };
const statusLabel: Record<string, string> = { active: "نشط", pending: "بانتظار التفعيل", suspended: "موقوف" };
const kindLabel: Record<string, string> = { company: "شركة", station: "محطة", provider: "مقدّم خدمة" };
const requestLabel: Record<string, string> = { join: "انضمام جهة", change: "تغيير بيانات", bank: "حساب بنكي", document: "مستند" };
const errorInfo = (err: unknown) => err as { status?: number; message?: string; data?: { message?: string } };
const apiMessage = (err: unknown) => errorInfo(err)?.data?.message || errorInfo(err)?.message || "تعذر إتمام الطلب. حاول مرة أخرى.";
const platformRoles = (ctx: unknown): PlatformRole[] => {
  if (!ctx || typeof ctx !== "object") return [];
  const c = ctx as Record<string, unknown>;
  const value = c.platform_roles ?? c.platformRoles;
  return Array.isArray(value)
    ? value.filter((role): role is PlatformRole => roles.includes(role as PlatformRole))
    : [];
};
const dateText = (value?: string) => value ? new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }) : "—";

function AdminGate({ children, allowedRoles = ["owner"] }: {
  children: (name: string, userId: string, roles: PlatformRole[]) => ReactNode;
  allowedRoles?: PlatformRole[];
}) {
  const me = useGetAuthMe({ query: { queryKey: getGetAuthMeQueryKey(), retry: false, staleTime: 20_000 } });
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (me.data?.passwordChangeRequired) setLocation("/reset-password?update=1&temporary=1");
  }, [me.data?.passwordChangeRequired, setLocation]);
  if (me.isLoading) return <main className="ac-page" dir="rtl"><div className="ac-loading"><i/><i/><i/></div></main>;
  if (me.isError || !me.data) return <main className="ac-guard" dir="rtl"><div className="ac-guard-mark"><LockKeyhole/></div><h1>يلزم تسجيل الدخول</h1><p>تتطلب الإدارة المركزية جلسة موثّقة بصلاحية منصة مخوّلة.</p><Link className="ac-button" href="/sign-in">تسجيل الدخول <ArrowLeft size={16}/></Link></main>;
  if (me.data.passwordChangeRequired) return <main className="ac-guard" dir="rtl"><div className="ac-guard-mark"><LockKeyhole/></div><h1>غيّر كلمة المرور المؤقتة</h1><p>لن تُفتح أقسام الإدارة قبل تعيين كلمة مرور جديدة.</p><Link className="ac-button" href="/reset-password?update=1&temporary=1">تغيير كلمة المرور <ArrowLeft size={16}/></Link></main>;
  const userRoles = platformRoles(me.data.accessContext);
  if (me.data.state !== "active" || !allowedRoles.some((role) => userRoles.includes(role))) return <main className="ac-guard" dir="rtl"><div className="ac-guard-mark"><ShieldCheck/></div><h1>هذه المساحة غير متاحة</h1><p>لا يملك الحساب الحالي تفويض المنصة المطلوب لهذا القسم.</p><Link className="ac-button ac-button-quiet" href="/workspace">العودة إلى مساحة العمل <ArrowLeft size={16}/></Link></main>;
  return <AdminShell name={me.data.displayName} userRoles={userRoles}>{children(me.data.displayName, me.data.id, userRoles)}</AdminShell>;
}

export function CentralAdminFrame({ children }: { children: ReactNode }) {
  return <AdminGate>{() => children}</AdminGate>;
}

export function FinanceAdminFrame() {
  return <AdminGate allowedRoles={["owner", "finance", "auditor", "operations"]}>
    {(_name, _userId, userRoles) => <Suspense fallback={<main className="af-page" dir="rtl" aria-busy="true"><section className="af-state"><span className="af-kicker">المالية والتحصيل</span><b>جارٍ تحميل مساحة المالية…</b></section></main>}><AdminFinancePage roles={userRoles}/></Suspense>}
  </AdminGate>;
}

export function FleetAdminFrame() {
  return <AdminGate allowedRoles={["owner", "operations", "auditor"]}>
    {(_name, _userId, roles) => <Suspense fallback={<main className="ac-page" dir="rtl"><div className="ac-loading"><i/><i/><i/></div></main>}><FleetAdminPage canMutate={roles.some(role => role === "owner" || role === "operations")} isOwner={roles.includes("owner")}/></Suspense>}
  </AdminGate>;
}

export function ServiceOrdersAdminFrame(){
 return <AdminGate allowedRoles={["owner","operations","finance","auditor"]}>
 {(_name,_userId,roles)=><Suspense fallback={<main className="ac-page" dir="rtl" aria-busy="true">جارٍ تحميل طلبات الخدمة…</main>}><ServiceOrdersPage central canManage={roles.some(role=>["owner","operations","finance"].includes(role))}/></Suspense>}
 </AdminGate>;
}

export function WorkforceAdminFrame() {
 return <AdminGate allowedRoles={["owner","operations","auditor"]}>
 {(_name,_userId,roles)=><Suspense fallback={<main className="ac-page" dir="rtl" aria-busy="true">جارٍ تحميل تكليفات العمال…</main>}><WorkforceAdmin canManage={roles.some(role=>role==="owner"||role==="operations")}/></Suspense>}
 </AdminGate>;
}

export function InventoryAdminFrame() {
  return <AdminGate allowedRoles={["owner", "operations", "finance", "auditor"]}>
    {(_name, _userId, roles) => <Suspense fallback={<main className="ac-page" dir="rtl"><div className="ac-loading"><i/><i/><i/></div></main>}><AdminInventoryPage canManageInventory={roles.some(role => role === "owner" || role === "operations")}/></Suspense>}
  </AdminGate>;
}

export function AdminShell({ children, name, userRoles }: { children: ReactNode; name: string; userRoles: PlatformRole[] }) {
  const [route] = useRoute("/admin/platform-users/:userId");
  const [orgRoute] = useRoute("/admin/organizations/:id");
  const [orgBranchRoute] = useRoute("/admin/organizations/:organizationId/branches/:branchId");
  const [path, navigate] = useLocation();
  const signOut = useSignOut();
  const cache = useQueryClient();
  const [signOutError, setSignOutError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [fleetExpanded, setFleetExpanded] = useState(path.startsWith("/admin/fleet"));
  useEffect(() => {
    setFleetExpanded(path.startsWith("/admin/fleet"));
  }, [path]);
  useEffect(() => { setDrawerOpen(false); }, [path]);
  useEffect(() => {
    if (!drawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        document.querySelector<HTMLButtonElement>(".ac-mobile-menu")?.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [drawerOpen]);
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
  const isOwner = userRoles.includes("owner");
  const canSeeFinance = userRoles.some((role) => ["owner", "finance", "auditor", "operations"].includes(role));
  const isFleet = path.startsWith("/admin/fleet");
  const active = path === "/admin" ? "overview" : path.startsWith("/admin/service-orders") ? "serviceOrders" : path === "/admin/workforce" ? "workforce" : path === "/admin/cards" ? "cards" : isFleet ? "fleet" : path === "/admin/fuel-prices" ? "fuel" : path.startsWith("/admin/catalog") ? "catalog" : path.startsWith("/admin/inventory") ? "inventory" : path.includes("/admin/finance") ? "finance" : path.includes("organization-requests") ? "requests" : path.includes("platform-users") ? "users" : path.includes("/admin/plans") ? "plans" : path.includes("/admin/subscriptions") ? "subscriptions" : "organizations";
  const fleetLabels: Record<string, string> = { "/admin/fleet": "الشركات والأسطول", "/admin/fleet/vehicles": "المركبات", "/admin/fleet/drivers": "السائقون", "/admin/fleet/policies": "سياسات الأسطول", "/admin/fleet/coverage": "تغطية المركبات", "/admin/fleet/documents": "مستندات المركبات", "/admin/fleet/odometer": "قراءات العداد", "/admin/fleet/maintenance": "سجلات الصيانة", "/admin/fleet/imports": "استيراد بيانات الأسطول" };
  const fleetTitle = isFleet ? path.match(/\/branches\/[^/]+$/) ? "مركبات الفرع" : path.match(/\/companies\/[^/]+$/) ? "الشركة والفروع" : path.startsWith("/admin/fleet/companies/") ? "الشركة والأسطول" : fleetLabels[path] ?? "إدارة الأسطول" : "";
  const pageTitle = isFleet ? fleetTitle : active === "serviceOrders" ? "طلبات الخدمة" : active === "workforce" ? "تكليفات العمال" : active === "cards" ? "إدارة البطاقات" : active === "fuel" ? "أسعار الوقود" : active === "catalog" ? "الكتالوج والخدمات" : active === "inventory" ? "مخزون منتجات التجار" : active === "overview" ? "نظرة عامة" : active === "finance" ? "المالية والتحصيل" : active === "requests" ? "مراجعة الطلبات" : active === "users" ? (route ? "ملف مستخدم المنصة" : "مستخدمو المنصة") : active === "plans" ? "الخطط والأسعار" : active === "subscriptions" ? "طلبات واشتراكات" : orgBranchRoute ? "تفاصيل الفرع" : orgRoute ? "تفاصيل الجهة" : "الجهات والفروع";
  const roleTitle = userRoles.includes("owner") ? "مالك المنصة" : userRoles.includes("finance") ? "المالية" : userRoles.includes("operations") ? "العمليات" : "مراجع";
  const fleetLinks = [
    ["/admin/fleet", "الشركات والأسطول"],
    ["/admin/fleet/vehicles", "المركبات"],
    ["/admin/fleet/drivers", "السائقون"],
    ["/admin/fleet/policies", "سياسات الأسطول"],
    ["/admin/fleet/coverage", "تغطية المركبات"],
    ["/admin/fleet/documents", "مستندات المركبات"],
    ["/admin/fleet/odometer", "قراءات العداد"],
    ["/admin/fleet/maintenance", "سجلات الصيانة"],
    ["/admin/fleet/imports", "استيراد بيانات الأسطول"],
  ];
  const nav = <nav className="ac-nav" aria-label="التنقل المركزي">
    {isOwner && <>
      <span className="ac-nav-group">مركز الإدارة</span>
      <Link href="/admin" onClick={()=>setDrawerOpen(false)} className={active === "overview" ? "selected" : ""}><span className="ac-nav-icon"><FileSearch size={17}/></span><span className="ac-nav-label">نظرة عامة</span></Link>
    </>}
    {(isOwner || userRoles.includes("operations")) && <>
      {!isOwner && <span className="ac-nav-group">مركز الإدارة</span>}
      <Link href="/admin/organizations" onClick={()=>setDrawerOpen(false)} className={active === "organizations" ? "selected" : ""}><span className="ac-nav-icon"><Building2 size={17}/></span><span className="ac-nav-label">الجهات والفروع</span></Link>
    </>}
    {(isOwner || userRoles.some(role => role === "operations" || role === "finance")) && <>
      {!isOwner && <span className="ac-nav-group ac-nav-group-spaced">مراجعة السجلات</span>}
      <Link href="/admin/organization-requests" onClick={()=>setDrawerOpen(false)} className={active === "requests" ? "selected" : ""}><span className="ac-nav-icon"><Clock3 size={17}/></span><span className="ac-nav-label">طلبات الجهات</span></Link>
    </>}
    {isOwner && <>
      <Link href="/admin/platform-users" onClick={()=>setDrawerOpen(false)} className={active === "users" ? "selected" : ""}><span className="ac-nav-icon"><Users size={17}/></span><span className="ac-nav-label">مستخدمو المنصة</span></Link>
      <Link href="/admin/catalog" onClick={()=>setDrawerOpen(false)} className={active === "catalog" ? "selected" : ""}><span className="ac-nav-icon"><Package size={17}/></span><span className="ac-nav-label">الكتالوج والخدمات</span></Link>
      <span className="ac-nav-group ac-nav-group-spaced">التسعير والاشتراكات</span>
      <Link href="/admin/fuel-prices" onClick={()=>setDrawerOpen(false)} className={active === "fuel" ? "selected" : ""} aria-current={active === "fuel" ? "page" : undefined}><span className="ac-nav-icon"><Fuel size={17}/></span><span className="ac-nav-label">أسعار الوقود</span></Link>
      <Link href="/admin/plans" onClick={()=>setDrawerOpen(false)} className={active === "plans" ? "selected" : ""}><span className="ac-nav-icon"><CreditCard size={17}/></span><span className="ac-nav-label">الباقات والأسعار</span></Link>
      <Link href="/admin/subscriptions" onClick={()=>setDrawerOpen(false)} className={active === "subscriptions" ? "selected" : ""}><span className="ac-nav-icon"><Clock3 size={17}/></span><span className="ac-nav-label">الطلبات والاشتراكات</span></Link>
    </>}
    {canSeeFinance && <>
      <span className="ac-nav-group ac-nav-group-spaced">العمليات والمالية</span>
      <Link href="/admin/service-orders" onClick={()=>setDrawerOpen(false)} className={active === "serviceOrders" ? "selected" : ""}><span className="ac-nav-icon"><FileSearch size={17}/></span><span className="ac-nav-label">طلبات الخدمة</span></Link>
      <Link href="/admin/finance" onClick={()=>setDrawerOpen(false)} className={active === "finance" ? "selected" : ""}><span className="ac-nav-icon"><Banknote size={17}/></span><span className="ac-nav-label">الدفتر المالي</span></Link>
      <Link href="/admin/inventory" onClick={()=>setDrawerOpen(false)} className={active === "inventory" ? "selected" : ""}><span className="ac-nav-icon"><Package size={17}/></span><span className="ac-nav-label">مخزون المنتجات</span></Link>
    </>}
    {(isOwner || userRoles.includes("operations") || userRoles.includes("auditor")) && <>
      <span className="ac-nav-group ac-nav-group-spaced">إدارة الأسطول</span>
      <Link href="/admin/fleet" onClick={()=>setDrawerOpen(false)} className={active === "fleet" ? "selected" : ""}><span className="ac-nav-icon"><Truck size={17}/></span><span className="ac-nav-label">مركز الأسطول</span></Link>
      <button type="button" className="ac-fleet-toggle" aria-expanded={fleetExpanded} onClick={()=>setFleetExpanded(value=>!value)}>
        <span>أقسام الأسطول</span><ChevronDown size={15} aria-hidden="true"/>
      </button>
      {fleetExpanded&&<div className="ac-fleet-subnav" aria-label="أقسام الأسطول">{fleetLinks.slice(1).map(([href, label]) => <Link key={href} href={href} onClick={()=>setDrawerOpen(false)} className={path === href ? "selected" : ""} aria-current={path === href ? "page" : undefined}>{label}</Link>)}</div>}
    </>}
    {userRoles.some((role) => ["owner", "operations", "auditor"].includes(role)) && <Link href="/admin/cards" onClick={()=>setDrawerOpen(false)} className={active === "cards" ? "selected" : ""} aria-current={active === "cards" ? "page" : undefined}><span className="ac-nav-icon"><LockKeyhole size={17}/></span><span className="ac-nav-label">إدارة البطاقات</span></Link>}
    {userRoles.some(role=>["owner","operations","auditor"].includes(role))&&<Link href="/admin/workforce" onClick={()=>setDrawerOpen(false)} className={active==="workforce"?"selected":""}><span className="ac-nav-icon"><Users size={17}/></span><span className="ac-nav-label">تكليفات العمال</span></Link>}
    <div className="ac-nav-bottom"><ShieldCheck size={15}/><span>قرارات موثقة<br/><small>نطاق المنصة فقط</small></span></div>
  </nav>;
  return <div className={`ac-app ${collapsed ? "ac-collapsed" : ""}`} dir="rtl">
    <header className="ac-topbar">
      <button className="ac-mobile-menu" aria-label="فتح قائمة الأقسام" aria-expanded={drawerOpen} aria-controls="central-navigation" onClick={()=>setDrawerOpen(true)}><Menu size={19}/></button>
      <Link href="/admin" className="ac-brand" aria-label="Pertomax EG — لوحة الإدارة"><img src={`${import.meta.env.BASE_URL}petro-max-lockup.png`} alt="Pertomax EG"/></Link>
      <div className="ac-context"><span>الإدارة المركزية</span><b>{pageTitle}</b></div>
      <div className="ac-top-user"><span className="ac-owner-chip"><ShieldCheck size={15}/> {roleTitle}</span><span className="ac-avatar">{name.trim().slice(0, 1) || "م"}</span><span className="ac-top-name">{name}</span><button className="ac-signout" disabled={signOut.isPending} onClick={()=>void exit()}>{signOut.isPending?"جارٍ الخروج…":"تسجيل الخروج"}</button></div>
    </header>
    {signOutError && <p className="ac-signout-error" role="alert">{signOutError}</p>}
    {drawerOpen && <button className="ac-drawer-scrim" aria-label="إغلاق القائمة" onClick={()=>setDrawerOpen(false)}/>}
    <div className="ac-shell">
      <aside id="central-navigation" className={`ac-sidebar ${drawerOpen ? "drawer-open" : ""}`}>
        <div className="ac-sidebar-head"><span>مساحة العمل</span><button aria-label={collapsed?"توسيع القائمة":"طي القائمة"} onClick={()=>setCollapsed(!collapsed)}><PanelRightClose size={16}/></button><button className="ac-sidebar-close" aria-label="إغلاق القائمة" onClick={()=>setDrawerOpen(false)}><X size={18}/></button></div>
        {nav}
      </aside>
      <section className="ac-main">
        {!isFleet && <div className="ac-breadcrumb"><Link href="/admin">الإدارة المركزية</Link><ChevronLeft size={13}/><span>{pageTitle}</span></div>}
        <main className="ac-content">{children}</main>
        <footer className="ac-footer"><span>Pertomax EG <i/> الإدارة المركزية</span><span>قرارات الوصول تُسجّل مع سببها</span></footer>
      </section>
    </div>
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
    <div className="ac-heading-row ac-overview-heading"><div><span className="ac-eyebrow">الإدارة المركزية <i/></span><h1>لوحة التشغيل</h1><p>راجع ما يحتاج إجراءً، ثم انتقل مباشرة إلى القسم المناسب.</p></div><div className="ac-overview-tools"><time dateTime={new Date().toISOString()}>{new Intl.DateTimeFormat("ar-EG",{dateStyle:"long",timeZone:"Africa/Cairo"}).format(new Date())}</time><button type="button" className="ac-button ac-button-quiet" disabled={orgs.isFetching||requests.isFetching||users.isFetching} onClick={()=>{void orgs.refetch();void requests.refetch();void users.refetch();}}><RefreshCw size={15}/> تحديث البيانات</button></div></div>
    <section className="ac-metrics" aria-label="ملخص السجلات">
        <Metric title="الجهات المسجلة" value={orgs.data?.total} note="الشركات والمحطات ومقدمو الخدمات" icon={<Building2 size={18}/>} loading={orgs.isLoading} error={orgs.isError} retry={()=>void orgs.refetch()}/>
        <Metric title="طلبات تنتظر المراجعة" value={requests.isError?undefined:pendingRequests.length} note="طلبات مرسلة للمراجعة" icon={<Clock3 size={18}/>} loading={requests.isLoading} error={requests.isError} retry={()=>void requests.refetch()}/>
        <Metric title="حسابات المنصة" value={users.data?.total} note="حسابات المستخدمين المسجلة" icon={<Users size={18}/>} loading={users.isLoading} error={users.isError} retry={()=>void users.refetch()}/>
      </section>
    <div className="ac-overview-grid">
      <section className="ac-panel ac-recent-panel"><div className="ac-panel-head"><div><span className="ac-eyebrow">الوارد الفعلي</span><h2>طلبات تحتاج مراجعة</h2></div><Link className="ac-inline-link" href="/admin/organization-requests">فتح صندوق المراجعة <ArrowLeft size={15}/></Link></div>
        {requests.isLoading ? <SkeletonRows/> : requests.isError ? <p className="ac-inline-message">تعذر قراءة سجل الطلبات.</p> : pendingRequests.length === 0 ? <div className="ac-empty"><span><Check size={18}/></span><b>لا توجد طلبات معلّقة</b><p>لا توجد طلبات مرسلة تنتظر إجراءً الآن.</p></div> :
          <div className="ac-inbox-list">{pendingRequests.slice(0, 6).map(item=><Link key={`${item.requestType}-${item.id}`} href="/admin/organization-requests" className="ac-inbox-row"><span className="ac-record-mark"><FileSearch size={17}/></span><span className="ac-inbox-copy"><b>{item.title}</b><small>{requestLabel[item.requestType] || item.requestType} · {dateText(item.createdAt)}</small></span><span className="ac-status ac-status-pending">{item.status === "submitted" ? "مرسل" : item.status}</span><ChevronLeft size={16}/></Link>)}</div>}
      </section>
      <section className="ac-panel ac-quick-panel" aria-label="اختصارات التشغيل"><div className="ac-panel-head"><div><span className="ac-eyebrow">ابدأ من هنا</span><h2>أقسامك الأساسية</h2></div></div><div className="ac-quick-grid">{[
 {href:"/admin/fleet/vehicles",label:"المركبات والسائقون",note:"بيانات الأسطول وضوابطه",icon:<Truck size={20}/>},
 {href:"/admin/plans",label:"الباقات والاشتراكات",note:"الأسعار والمميزات والنشر",icon:<Package size={20}/>},
 {href:"/admin/cards",label:"إدارة البطاقات",note:"الطلبات والإصدار والتسليم",icon:<CreditCard size={20}/>},
 {href:"/admin/service-orders",label:"طلبات الخدمة",note:"التنفيذ والتوثيق والدفع",icon:<FileSearch size={20}/>},
 {href:"/admin/fuel-prices",label:"أسعار الوقود",note:"الأنواع والتعريفة المعتمدة",icon:<Fuel size={20}/>},
 {href:"/admin/inventory",label:"المخزون",note:"الأرصدة والحركات والجرد",icon:<Building2 size={20}/>}
 ].map(item=><Link key={item.href} href={item.href} className="ac-quick-link"><span>{item.icon}</span><div><b>{item.label}</b><small>{item.note}</small></div><ChevronLeft size={15}/></Link>)}</div></section>
    </div>
    <section className="ac-org-preview"><div className="ac-panel-head"><div><span className="ac-eyebrow">البنية المسجلة</span><h2>أحدث الجهات</h2></div><Link className="ac-inline-link" href="/admin/organizations">سجل الجهات والفروع <ArrowLeft size={15}/></Link></div>
      {orgs.isLoading ? <SkeletonRows/> : orgs.isError ? <p className="ac-inline-message">تعذر قراءة سجل الجهات.</p> : !orgs.data?.items.length ? <div className="ac-empty"><span><Building2 size={18}/></span><b>لا توجد جهات مسجلة</b><p>ستظهر هنا الجهات المسجلة فعليًا.</p></div> :
        <div className="ac-org-grid">{orgs.data.items.slice(0, 4).map(org=><Link key={org.id} href={`/admin/organizations/${org.id}`} className="ac-org-tile"><span className="ac-org-logo"><Building2 size={17}/></span><span><b>{org.name}</b><small>{kindLabel[org.kind] || org.kind} · {org.code || "بلا كود"}</small></span><span className={`ac-status ac-status-${org.status}`}>{org.status === "active" ? "نشطة" : org.status === "suspended" ? "موقوفة" : "قيد الإجراء"}</span></Link>)}</div>}
    </section>
  </div>;
}
function Metric({ title, value, note, icon, loading, error=false, retry }: { title: string; value?: number; note: string; icon: ReactNode; loading: boolean;error?:boolean;retry?:()=>void }) {
  return <article className="ac-metric" data-testid="overview-metric"><div className="ac-metric-top"><span>{title}</span><i>{icon}</i></div>{loading ? <span className="ac-skeleton ac-metric-skeleton"/> : <strong>{value?.toLocaleString("ar-EG") ?? "—"}</strong>}{error?<small role="alert">تعذر تحديث هذا المؤشر. <button type="button" className="ac-inline-link" onClick={retry}>إعادة المحاولة</button></small>:<small>{note}</small>}</article>;
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
  const [createOpen, setCreateOpen] = useState(false);
  const [createNotice, setCreateNotice] = useState<{ kind: "success" | "warning"; text: string } | null>(null);
  const cache = useQueryClient();
  const params = useMemo(() => ({ page, pageSize: 12, ...(search.trim().length >= 2 ? { search: search.trim() } : {}), ...(status ? { accountStatus: status as "pending"|"active"|"suspended" } : {}), ...(role ? { role: role as PlatformRole } : {}) }), [page, search, status, role]);
  const query = useListPlatformUsers(params, { query: { queryKey: getListPlatformUsersQueryKey(params), retry: false, refetchOnMount: "always" } });
  return <div className="ac-page-enter">
    <div className="ac-heading-row"><div><span className="ac-eyebrow">تفويض المنصة <i/></span><h1>مستخدمو المنصة</h1><p>إنشاء الحسابات وتحديد الأدوار المركزية المصرّح بها.</p></div><div className="ac-heading-actions"><button className="ac-button ac-button-primary" onClick={()=>{setCreateOpen(!createOpen);setCreateNotice(null)}} aria-expanded={createOpen}><UserPlus size={16}/>{createOpen?"إغلاق النموذج":"إضافة مستخدم للمنصة"}</button><span className="ac-total-stamp"><b>{query.data?.total?.toLocaleString("ar-EG") ?? "—"}</b><small>حساب</small></span></div></div>
    {createNotice&&<div className={`ac-inline-notice ac-inline-notice-${createNotice.kind}`} role={createNotice.kind==="warning"?"alert":"status"}>{createNotice.kind==="warning"?<CircleAlert size={17}/>:<Check size={17}/>}<span>{createNotice.text}</span></div>}
    {createOpen&&<PlatformUserCreateForm
      roleCatalog={query.data?.roleCatalog ?? []}
      loadingRoles={query.isLoading}
      onCancel={()=>setCreateOpen(false)}
      onCreated={async result=>{
        setCreateOpen(false);
        setCreateNotice({kind:result.status==="confirmation_required"?"success":"warning",text:result.message});
        await cache.invalidateQueries({queryKey:getListPlatformUsersQueryKey()});
      }}
    />}
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

type PlatformRoleOption = {
  role: PlatformRole;
  label: string;
  scope: string;
  permissions: Array<{ code: string; label: string }>;
};
type PlatformUserCreateResult = {
  status: "confirmation_required" | "created_without_roles";
  message: string;
};
function PlatformUserCreateForm({
  roleCatalog,
  loadingRoles,
  onCancel,
  onCreated,
}: {
  roleCatalog: PlatformRoleOption[];
  loadingRoles: boolean;
  onCancel: () => void;
  onCreated: (result: PlatformUserCreateResult) => Promise<void>;
}) {
  const create = useCreatePlatformUser();
  const [selectedRoles, setSelectedRoles] = useState<PlatformRole[]>([]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const selectedPermissions = [...new Map(
    roleCatalog
      .filter(option => selectedRoles.includes(option.role))
      .flatMap(option => option.permissions)
      .map(permission => [permission.code, permission]),
  ).values()];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const roles = selectedRoles;
    if (!roles.length) {
      setError("اختر دورًا واحدًا على الأقل.");
      return;
    }
    try {
      const result = await create.mutateAsync({
        data: {
          username: String(data.get("username")).trim().toLowerCase(),
          displayName: String(data.get("displayName")).trim(),
          email: String(data.get("email")).trim().toLowerCase(),
          password,
          roles,
          reason: String(data.get("reason")).trim(),
        },
      });
      setPassword("");
      await onCreated(result);
    } catch (cause) {
      setPassword("");
      setError(apiMessage(cause));
    }
  }

  return <section className="ac-panel ac-create-platform-user" aria-labelledby="ac-create-user-title">
    <div className="ac-panel-head"><div><span className="ac-eyebrow">حساب وصلاحيات</span><h2 id="ac-create-user-title">إنشاء مستخدم منصة</h2><p>لا يُمنح الحساب دخولًا قبل تأكيد بريده وتغيير كلمة المرور المؤقتة.</p></div></div>
    <form className="ac-create-user-form" onSubmit={submit}>
      <div className="ac-create-user-fields">
        <label>الاسم الظاهر <b aria-hidden="true">*</b><input name="displayName" required minLength={2} maxLength={120} autoComplete="name" autoFocus placeholder="اسم المستخدم كما سيظهر في السجل"/></label>
        <label>اسم المستخدم <b aria-hidden="true">*</b><input name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" autoComplete="username" placeholder="مثال: ahmed.ops"/><small>3–32 خانة؛ أحرف لاتينية وأرقام ونقطة أو شرطة سفلية.</small></label>
        <label>البريد الإلكتروني <b aria-hidden="true">*</b><input name="email" type="email" required maxLength={254} autoComplete="email" placeholder="name@example.com"/><small>سيُرسل إليه رابط تأكيد الحساب فقط.</small></label>
        <label>كلمة مرور مؤقتة <b aria-hidden="true">*</b><input name="temporaryPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} placeholder="12 خانة على الأقل"/><small>لا تُرسل مع رابط التأكيد؛ سلّمها عبر قناة آمنة منفصلة، وسيُطلب تغييرها عند الدخول الأول.</small></label>
      </div>
      <fieldset className="ac-role-picker">
        <legend>الأدوار والأقسام المتاحة <b aria-hidden="true">*</b></legend>
        <p>اختر دورًا أو أكثر. الأقسام أدناه مأخوذة من صلاحيات الأدوار الفعلية؛ لا توجد صلاحيات حرة لكل إجراء في النظام الحالي.</p>
        {loadingRoles?<div className="ac-role-loading" role="status">جارٍ تحميل الأدوار المتاحة…</div>:roleCatalog.length===0?<div className="ac-role-loading" role="alert">تعذر تحميل الأدوار. أغلق النموذج وأعد تحميل دليل المستخدمين.</div>:
          <div className="ac-role-options">{roleCatalog.map(option=><label className={`ac-role-option ${selectedRoles.includes(option.role)?"is-selected":""}`} key={option.role}>
            <input type="checkbox" checked={selectedRoles.includes(option.role)} onChange={event=>setSelectedRoles(current=>event.target.checked?[...current,option.role]:current.filter(item=>item!==option.role))}/>
            <span className="ac-role-option-body"><b>{option.label}</b>{option.permissions.length?<span className="ac-permission-list">{option.permissions.map(permission=><small key={permission.code}>{permission.label}</small>)}</span>:<small className="ac-role-no-sections">لا يمنح أقسامًا تشغيلية حاليًا.</small>}</span>
          </label>)}</div>}
        {selectedPermissions.length>0&&<div className="ac-selected-permissions"><b>الأقسام التي ستُسند لهذا الحساب</b><ul>{selectedPermissions.map(permission=><li key={permission.code}>{permission.label}</li>)}</ul></div>}
      </fieldset>
      <input type="hidden" name="reason" value="تسجيل آلي: إجراء إداري من لوحة التحكم"/>
      {error&&<div className="ac-inline-notice ac-inline-notice-warning" role="alert"><CircleAlert size={17}/><span>{error}</span></div>}
      <div className="ac-create-user-actions"><button className="ac-button ac-button-primary" type="submit" disabled={create.isPending||loadingRoles||!roleCatalog.length}>{create.isPending?"جارٍ إنشاء الحساب…":"إنشاء الحساب وإسناد الأدوار"}</button><button className="ac-button ac-button-quiet" type="button" onClick={onCancel} disabled={create.isPending}>إلغاء</button></div>
    </form>
  </section>;
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
  const membershipsQuery = useGetPlatformUserMemberships(userId, { query: { queryKey: getGetPlatformUserMembershipsQueryKey(userId), enabled: !!userId, retry: false, refetchOnMount: "always" } });
  const cache = useQueryClient();
  const [editRoles, setEditRoles] = useState(false);
  const [draftRoles, setDraftRoles] = useState<PlatformRole[]>([]);
  const [reason, setReason] = useState("تسجيل آلي: إجراء إداري من لوحة التحكم");
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  const [statusIntent, setStatusIntent] = useState<"active"|"suspended"|null>(null);
  const roleMutation = useSetPlatformUserRoles();
  const statusMutation = useSetUserStatus();
  const detail = query.data;
  const isSelf = userId === actorUserId;
  const membershipRoleLabel: Record<string, string> = { organization_owner: "مالك الجهة", manager: "مدير", finance: "المالية", worker: "موظف", viewer: "مشاهد" };
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
    setReason("تسجيل آلي: إجراء إداري من لوحة التحكم"); setActionError(""); setSuccess(""); setEditRoles(true); setStatusIntent(null);
  }
  async function saveRoles(event: FormEvent) {
    event.preventDefault(); setActionError(""); setSuccess("");
    if (reason.trim().length < 5 || reason.trim().length > 500) { setActionError("سبب التغيير مطلوب، من 5 إلى 500 حرف."); return; }
    try {
      await roleMutation.mutateAsync({ userId, data: { roles: draftRoles, reason: reason.trim() } });
      setEditRoles(false); setSuccess("تم تحديث أدوار المنصة وتسجيل السبب في سجل التدقيق."); setReason("تسجيل آلي: إجراء إداري من لوحة التحكم"); await refresh();
    } catch (err) { setActionError(errorInfo(err)?.status === 409 ? "تعارض حماية: تعذر تطبيق التغيير لأنه قد يترك المنصة بلا مالك نشط. حدّث السجل وراجع الأدوار الحالية." : apiMessage(err)); await query.refetch(); }
  }
  async function saveStatus(event: FormEvent) {
    event.preventDefault(); if (!statusIntent) return; setActionError(""); setSuccess("");
    if (reason.trim().length < 5 || reason.trim().length > 500) { setActionError("سبب الإجراء مطلوب، من 5 إلى 500 حرف."); return; }
    try {
      await statusMutation.mutateAsync({ userId, data: { status: statusIntent, reason: reason.trim() } });
      setSuccess(statusIntent === "suspended" ? "تم إيقاف الحساب وتسجيل السبب." : "تم تفعيل الحساب وتسجيل السبب."); setStatusIntent(null); setReason("تسجيل آلي: إجراء إداري من لوحة التحكم"); await refresh();
    } catch (err) { setActionError(errorInfo(err)?.status === 409 ? "تعارض حماية: تعذر الإجراء للحفاظ على آخر مالك نشط. حدّث السجل قبل المتابعة." : apiMessage(err)); await query.refetch(); }
  }
  return <div className="ac-page-enter">
    <Link className="ac-back-link" href="/admin/platform-users"><ArrowRight size={15}/> العودة إلى دليل المستخدمين</Link>
    {query.isLoading ? <section className="ac-profile-loading"><SkeletonRows/></section> : query.isError || !detail ? <LoadError title="تعذر تحميل ملف المستخدم" error={query.error} retry={()=>void query.refetch()}/> :
    <>
      <div className="ac-heading-row ac-profile-heading"><div><span className="ac-eyebrow">ملف حساب / صلاحيات المنصة</span><h1>حساب المنصة</h1><p>قرارات الدور والحالة تُسجّل في سجل تدقيق خاص بهذا الحساب.</p></div><span className="ac-audit-seal"><ShieldCheck size={17}/> مساحة حساسة</span></div>
      <section className="ac-profile-card">
        <div className="ac-profile-identity"><span className="ac-profile-avatar">{detail.user.displayName.trim().slice(0,1) || "م"}</span><div><h2>{detail.user.displayName}</h2><span className="ac-username" dir="ltr">@{detail.user.username}</span></div><span className={`ac-status ac-status-${detail.user.accountStatus}`}><i/>{statusLabel[detail.user.accountStatus]}</span></div>
        <div className="ac-account-facts"><div><small>اسم المستخدم</small><b dir="ltr">{detail.user.username ? `@${detail.user.username}` : "غير محدد"}</b></div><div><small>تاريخ الإنشاء</small><b>{dateText(detail.user.createdAt)}</b></div><div><small>الدخول إلى الحساب</small><b>{detail.user.active ? "مفعّل" : "غير مفعّل"}</b></div></div>
      </section>
      <section className="ac-profile-grid">
        <article className="ac-panel ac-roles-panel"><div className="ac-panel-head"><div><span className="ac-eyebrow">نطاق: المنصة</span><h2>الأدوار النشطة</h2></div>{!editRoles&&!statusIntent&&<button className="ac-button ac-button-quiet" disabled={isSelf} title={isSelf?"لا يمكن تعديل أدوار حسابك من الجلسة نفسها":undefined} onClick={openRoleEditor}>تعديل الأدوار</button>}</div>
          {detail.user.platformRoles.length ? <div className="ac-active-roles">{detail.user.platformRoles.map(role=>{const catalog=detail.roleCatalog.find(item=>item.role===role);return <article className="ac-active-role" key={role}><div className="ac-active-role-title"><span className={`ac-role-glyph role-${role}`}><ShieldCheck size={16}/></span><div><b>{catalog?.label ?? roleFallback[role]}</b><small>دور على مستوى المنصة</small></div></div><ul>{catalog?.permissions.map(permission=><li key={permission.code}><Check size={13}/>{permission.label}</li>) ?? <li>لا توجد أوصاف قدرات متاحة.</li>}</ul></article>})}</div> : <div className="ac-no-active-roles"><span><ShieldCheck size={18}/></span><b>لا توجد أدوار منصة نشطة</b><small>لا يعني ذلك وجود عضوية جهة.</small></div>}
          {editRoles && <form className="ac-action-form" onSubmit={saveRoles}><div className="ac-action-title"><div><b>تحديث أدوار المنصة</b><small>راجع الصلاحيات المسجلة لكل دور قبل حفظ التغيير.</small></div><button type="button" className="ac-icon-button" onClick={()=>setEditRoles(false)} aria-label="إلغاء"><X size={17}/></button></div><div className="ac-role-picker">{detail.roleCatalog.map(item=><label key={item.role} className={draftRoles.includes(item.role)?"checked":""}><input type="checkbox" checked={draftRoles.includes(item.role)} onChange={e=>setDraftRoles(current=>e.target.checked?[...current,item.role]:current.filter(r=>r!==item.role))}/><span><b>{item.label}</b><small>{item.permissions.map(p=>p.label).join(" · ") || "لا توجد قدرات مسجلة"}</small></span><i>{draftRoles.includes(item.role)&&<Check size={14}/>}</i></label>)}</div><ReasonField reason={reason} setReason={setReason}/>{actionError&&<InlineAlert error>{actionError}</InlineAlert>}<div className="ac-form-actions"><button className="ac-button" disabled={roleMutation.isPending||reason.trim().length<5}>{roleMutation.isPending?"جارٍ تسجيل الأدوار…":"حفظ الأدوار"}</button><button type="button" className="ac-button ac-button-quiet" onClick={()=>setEditRoles(false)}>إلغاء</button></div></form>}
          {statusIntent&&<form className="ac-action-form" onSubmit={saveStatus}><div className="ac-action-title"><div><b>{statusIntent==="suspended"?"إيقاف الحساب":"تفعيل الحساب"}</b><small>سيُحفظ هذا الإجراء مع سبب واضح في سجل التدقيق.</small></div><button type="button" className="ac-icon-button" onClick={()=>setStatusIntent(null)} aria-label="إلغاء"><X size={17}/></button></div><ReasonField reason={reason} setReason={setReason}/>{actionError&&<InlineAlert error>{actionError}</InlineAlert>}<div className="ac-form-actions"><button className={statusIntent==="suspended"?"ac-button ac-button-danger":"ac-button"} disabled={statusMutation.isPending||reason.trim().length<5}>{statusMutation.isPending?"جارٍ تسجيل الحالة…":statusIntent==="suspended"?"تأكيد إيقاف الحساب":"تأكيد تفعيل الحساب"}</button><button type="button" className="ac-button ac-button-quiet" onClick={()=>setStatusIntent(null)}>إلغاء</button></div></form>}
        </article>
        <aside className="ac-panel ac-account-actions"><span className="ac-eyebrow">حالة الوصول</span><h2>إجراءات الحساب</h2><p>تغيير الحالة يؤثر في تسجيل الدخول، ولا يغيّر عضويات الجهات.</p>{isSelf ? <InlineAlert error>لا يمكن تغيير أدوار حسابك أو حالته من الجلسة نفسها.</InlineAlert> : detail.user.accountStatus==="suspended" ? <button className="ac-button" onClick={()=>{setStatusIntent("active");setReason("تسجيل آلي: إجراء إداري من لوحة التحكم");setActionError("");setEditRoles(false)}}>تفعيل الحساب</button> : <button className="ac-button ac-button-danger-outline" onClick={()=>{setStatusIntent("suspended");setReason("تسجيل آلي: إجراء إداري من لوحة التحكم");setActionError("");setEditRoles(false)}}>إيقاف الحساب</button>}{success&&<InlineAlert>{success}</InlineAlert>}<div className="ac-separation-note"><LockKeyhole size={15}/><span>أدوار المنصة منفصلة عن عضويات الجهات ونطاقات الفروع.</span></div></aside>
      </section>
      <section className="ac-panel ac-membership-panel" aria-labelledby="ac-memberships-title">
        <div className="ac-panel-head">
          <div><span className="ac-eyebrow">نطاق منفصل عن أدوار المنصة</span><h2 id="ac-memberships-title">عضويات الجهات والفروع</h2></div>
          <span className="ac-audit-count">{membershipsQuery.data?.items.length.toLocaleString("ar-EG") ?? "—"} عضوية</span>
        </div>
        {membershipsQuery.isLoading ? <SkeletonRows/> : membershipsQuery.isError
          ? <LoadError title="تعذر تحميل عضويات الجهات" error={membershipsQuery.error} retry={() => void membershipsQuery.refetch()}/>
          : !membershipsQuery.data?.items.length
            ? <div className="ac-empty"><span><Building2 size={18}/></span><b>لا توجد عضويات جهات لهذا الحساب</b><p>هذا لا يغيّر أدوار المنصة المعروضة أعلاه.</p></div>
            : <div className="ac-membership-list">{membershipsQuery.data.items.map(membership => (
              <article className="ac-membership-card" key={membership.membershipId}>
                <div className="ac-membership-main">
                  <Link className="ac-membership-org" href={`/admin/organizations/${encodeURIComponent(membership.organizationId)}`}>{membership.organizationName}</Link>
                  <span>{kindLabel[membership.organizationKind] ?? membership.organizationKind} · <bdi dir="ltr">{membership.organizationCode}</bdi></span>
                  <span className={`ac-status ${membership.active ? "ac-status-active" : "ac-status-suspended"}`}><i/>{membership.active ? "عضوية نشطة" : "عضوية موقوفة"}</span>
                </div>
                <div className="ac-membership-scope">
                  <b>{membershipRoleLabel[membership.role] ?? "دور جهة"}</b>
                  {membership.scope === "organization"
                    ? <span>نطاق الجهة بالكامل</span>
                    : <span>الفروع المحددة: {membership.branches.length
                      ? membership.branches.map(branch => `${branch.branchName}${branch.branchCode ? ` (${branch.branchCode})` : ""}`).join("، ")
                      : "لا توجد أسماء فروع متاحة"}</span>}
                </div>
                <div className="ac-membership-links">
                  <Link href={`/admin/organizations/${encodeURIComponent(membership.organizationId)}`}>ملف الجهة</Link>
                  {(membership.organizationKind === "company" || membership.organizationKind === "provider") &&
                    <Link href={`/admin/subscriptions?organizationId=${encodeURIComponent(membership.organizationId)}`}>الاشتراك</Link>}
                  {membership.organizationKind === "company" && <>
                    <Link href={`/admin/fleet/companies/${encodeURIComponent(membership.organizationId)}`}>أسطول الشركة</Link>
                    <Link href={`/admin/finance?section=accounts&search=${encodeURIComponent(membership.organizationCode)}`}>حسابات الشركة</Link>
                  </>}
                </div>
              </article>
            ))}</div>}
      </section>
      <section className="ac-panel ac-audit-panel"><div className="ac-panel-head"><div><span className="ac-eyebrow">أثر القرارات</span><h2>سجل التدقيق الأخير</h2></div><span className="ac-audit-count">{detail.activity.length.toLocaleString("ar-EG")} حدث</span></div>
        {!detail.activity.length ? <div className="ac-empty"><span><FileSearch size={18}/></span><b>لا توجد أحداث تدقيق بعد</b><p>ستظهر هنا التغييرات الفعلية على أدوار هذا الحساب وحالته.</p></div> : <div className="ac-audit-list">{detail.activity.map(event=><article className="ac-audit-event" key={event.activityId}><span className={`ac-event-mark ${event.action.includes("roles")?"event-role":"event-status"}`}>{event.action.includes("roles")?<ShieldCheck size={16}/>:<UserRound size={16}/>}</span><div className="ac-event-main"><div className="ac-event-head"><b>{event.action.includes("roles")?"تغيير أدوار المنصة":"تغيير حالة الحساب"}</b><time>{dateText(event.occurredAt)}</time></div><span>بواسطة {event.actorDisplayName || event.actorUsername || "النظام"}</span>{event.action.includes("roles")&&<div className="ac-role-diff"><small>قبل</small>{event.previousRoles.length?event.previousRoles.map(r=><i key={`old-${r}`}>{detail.roleCatalog.find(x=>x.role===r)?.label??roleFallback[r]}</i>):<i>بلا دور</i>}<ArrowLeft size={13}/><small>بعد</small>{event.newRoles.length?event.newRoles.map(r=><i key={`new-${r}`}>{detail.roleCatalog.find(x=>x.role===r)?.label??roleFallback[r]}</i>):<i>بلا دور</i>}</div>}{event.status&&<span className={`ac-status ac-status-${event.status}`}>{statusLabel[event.status]}</span>}{event.reason&&<p className="ac-event-reason"><b>السبب:</b> {event.reason}</p>}</div></article>)}</div>}
      </section>
    </>}
  </div>;
}
function ReasonField({ reason, setReason }: { reason: string; setReason: (value: string)=>void }) { return null; }
function InlineAlert({ children, error=false }: { children: string; error?: boolean }) {
  return <div className={error?"ac-inline-alert ac-inline-error":"ac-inline-alert"} role={error?"alert":"status"}>{error?<CircleAlert size={15}/>:<Check size={15}/>}<span>{children}</span></div>;
}
