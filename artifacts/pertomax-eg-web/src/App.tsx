import { useEffect, useRef, type ReactNode } from 'react';
import { ClerkProvider, Show, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { arSA } from '@clerk/localizations';
import { useHealthCheck, useSupabaseHealthCheck } from '@workspace/api-client-react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpLeft, BadgeCheck, Building2, ChevronLeft, CircleAlert, CircleCheck, CircleDashed, Compass, LockKeyhole, LogOut, ShieldCheck, Sparkles, Waves } from 'lucide-react';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const arabicLocalization = {
  ...arSA,
  signIn: {
    ...arSA.signIn,
    start: {
      ...(arSA.signIn?.start ?? {}),
      title: 'تسجيل الدخول',
      subtitle: 'تابع إلى مساحة العمل الخاصة بك',
    },
  },
  signUp: {
    ...arSA.signUp,
    start: {
      ...(arSA.signUp?.start ?? {}),
      title: 'إنشاء حساب',
      subtitle: 'ابدأ حسابك على Pertomax EG',
    },
  },
  formFieldInputPlaceholder__emailAddress: 'أدخل بريدك الإلكتروني',
  formFieldInputPlaceholder__password: 'أدخل كلمة المرور',
  formFieldInputPlaceholder__signUpPassword: 'أنشئ كلمة مرور',
  badge__developmentMode: 'وضع التطوير',
} as never;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={`brand-lockup ${compact ? 'brand-compact' : ''}`} aria-label="Pertomax EG — الرئيسية" data-testid="link-brand-home">
      <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
      <span className="brand-wordmark"><b>Pertomax</b><span>EG</span></span>
    </Link>
  );
}

function Topbar({ minimal = false }: { minimal?: boolean }) {
  return (
    <header className="topbar" dir="rtl">
      <Brand />
      {!minimal && <nav className="topnav" aria-label="التنقل الرئيسي">
        <a href="#platform" data-testid="link-platform">عن المنصة</a>
        <a href="#access" data-testid="link-access">إدارة الصلاحيات</a>
      </nav>}
      <div className="topbar-actions">
        {!minimal && <Link href="/sign-in" className="signin-link" data-testid="link-sign-in">تسجيل الدخول</Link>}
        {!minimal && <Link href="/sign-up" className="button button-small" data-testid="link-create-account">إنشاء حساب <ArrowLeft size={15} /></Link>}
        {minimal && <Link href="/" className="back-link" data-testid="link-back-home"><ArrowLeft size={16} /> الرئيسية</Link>}
      </div>
    </header>
  );
}

function HomePage() {
  return (
    <main className="landing" dir="rtl">
      <Topbar />
      <section className="hero">
        <div className="hero-copy page-enter">
          <div className="eyebrow"><span className="eyebrow-line" /> منصة تشغيل مصرية <span className="eyebrow-dot" /> نسخة تأسيسية</div>
          <h1>مساحة عمل واحدة،<br /><em>وصول واضح.</em></h1>
          <p className="hero-lede">Pertomax EG تمهّد لإدارة الشركات والفروع ومقدّمي الخدمات ضمن منظومة تشغيل موحّدة، بصلاحيات تُسند بوضوح إلى أصحابها.</p>
          <div className="hero-actions">
            <Link href="/sign-up" className="button" data-testid="link-hero-sign-up">ابدأ بإنشاء حساب <ArrowLeft size={17} /></Link>
            <Link href="/sign-in" className="text-button" data-testid="link-hero-sign-in">لديك حساب بالفعل؟ <span>سجّل الدخول</span></Link>
          </div>
          <div className="hero-assurance"><ShieldCheck size={16} strokeWidth={1.8} /><span>إنشاء الحساب لا يمنح صلاحيات إدارية تلقائيًا</span></div>
        </div>

        <div className="hero-art page-enter-delay" aria-label="رسم توضيحي يرمز إلى تنظيم الوصول بين فرق العمل">
          <div className="art-index"><span>01</span><span>ACCESS, BY DESIGN</span></div>
          <div className="orbit orbit-outer" />
          <div className="orbit orbit-inner" />
          <div className="art-center">
            <span className="center-ring"><Waves size={30} strokeWidth={1.5} /></span>
            <span className="center-label">Pertomax<br />Operations</span>
          </div>
          <div className="orbit-node node-one"><Building2 size={19} /><span>شركة</span></div>
          <div className="orbit-node node-two"><Compass size={19} /><span>فرع</span></div>
          <div className="orbit-node node-three"><BadgeCheck size={19} /><span>مقدّم خدمة</span></div>
          <div className="art-caption"><span className="caption-rule" /> بنية واضحة للصلاحيات<br />من اليوم الأول</div>
          <span className="art-spark spark-a" />
          <span className="art-spark spark-b" />
          <span className="art-spark spark-c" />
          <div className="art-stamp">EGYPT<br /><b>01</b><br />FOUNDATION</div>
        </div>
        <div className="hero-footnote"><span>القاهرة · مصر</span><span>منظومة تشغيل بهوية محلية</span></div>
      </section>

      <section className="principles" id="platform">
        <div className="section-heading">
          <span className="section-kicker">01 / الفكرة</span>
          <h2>تشغيل منظم<br /><span>يبدأ بالثقة.</span></h2>
        </div>
        <div className="principle-intro">
          <p>نبني مساحة عمل تجمع أطراف التشغيل في صورة مفهومة: من يدير؟ أين يعمل؟ وما النطاق الذي يخصه؟</p>
          <span className="principle-note"><span className="note-dot" /> لا بيانات تجريبية ولا صلاحيات مفترضة</span>
        </div>
        <div className="principle-list">
          <article className="principle-row">
            <span className="row-num">١</span><span className="row-icon"><Building2 size={20} /></span>
            <div><h3>هيكل مفهوم</h3><p>شركات وفروع ومقدّمو خدمات ضمن نطاقات واضحة.</p></div><ChevronLeft size={18} className="row-arrow" />
          </article>
          <article className="principle-row">
            <span className="row-num">٢</span><span className="row-icon"><LockKeyhole size={20} /></span>
            <div><h3>وصول بمسؤولية</h3><p>الحساب الجديد لا يصبح مالكًا للمنصة أو لأي جهة.</p></div><ChevronLeft size={18} className="row-arrow" />
          </article>
          <article className="principle-row">
            <span className="row-num">٣</span><span className="row-icon"><CircleDashed size={20} /></span>
            <div><h3>تأسيس موثوق</h3><p>تفعيل مساحة العمل بعد اعتماد الإعدادات والصلاحيات.</p></div><ChevronLeft size={18} className="row-arrow" />
          </article>
        </div>
      </section>

      <section className="access-section" id="access">
        <div className="access-orbit" aria-hidden="true"><span /><span /><span /><i /></div>
        <div className="access-copy">
          <span className="section-kicker section-kicker-light">02 / الصلاحيات</span>
          <h2>الانتماء لا يُفترض.<br /><em>يُعتمد.</em></h2>
          <p>بعد إنشاء الحساب، تبقى صلاحيات الوصول معلّقة حتى يعيّنها مسؤول موثوق. لن تظهر لك سجلات جهة أو فرع قبل إتمام الإعداد والتحقق.</p>
          <div className="access-points">
            <span><CircleCheck size={17} /> لا ملكية تلقائية</span>
            <span><CircleCheck size={17} /> لا سجلات قبل التحقق</span>
          </div>
          <Link href="/sign-up" className="button button-light" data-testid="link-access-sign-up">إنشاء حساب جديد <ArrowLeft size={16} /></Link>
        </div>
        <span className="access-mark">P / EG</span>
      </section>

      <section className="start-section">
        <div className="start-panel">
          <span className="start-icon"><Sparkles size={19} /></span>
          <div><span className="section-kicker">03 / الخطوة الأولى</span><h2>أنشئ حسابك، ثم انتظر التعيين الموثوق.</h2><p>سجّل بيانات الدخول. سيظل الوصول للجهات والفروع غير متاح حتى اعتماد صلاحياتك.</p></div>
          <Link href="/sign-up" className="button" data-testid="link-start-sign-up">متابعة التسجيل <ArrowUpLeft size={17} /></Link>
        </div>
      </section>

      <footer className="footer" dir="rtl">
        <Brand compact />
        <span>منظومة تشغيل قيد التأسيس — مصر</span>
        <span className="footer-year">PERTOMAX EG <i /> {new Date().getFullYear()}</span>
      </footer>
    </main>
  );
}

function AuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const isSignUp = mode === 'sign-up';
  return (
    <main className="auth-page" dir="rtl">
      <Topbar minimal />
      <section className="auth-layout">
        <div className="auth-context">
          <span className="section-kicker">{isSignUp ? 'حساب جديد / 01' : 'مرحبًا بعودتك / 01'}</span>
          <h1>{isSignUp ? <>ابدأ من<br /><em>هنا.</em></> : <>مساحتك<br /><em>بانتظارك.</em></>}</h1>
          <p>{isSignUp ? 'أنشئ بيانات الدخول الخاصة بك. سيبقى حسابك دون صلاحيات تشغيل حتى يعيّنها مسؤول موثوق.' : 'سجّل الدخول للمتابعة إلى حالة مساحة العمل والصلاحيات المرتبطة بحسابك.'}</p>
          <div className="auth-trust"><ShieldCheck size={18} /><span>صلاحيات الوصول تُسند يدويًا وبشكل موثوق</span></div>
        </div>
        <div className="auth-form-wrap">
          <div className="auth-card-head"><span className="auth-step">{isSignUp ? 'إنشاء حساب' : 'تسجيل الدخول'}</span><span className="auth-step-index">PERTOMAX / 01</span></div>
          {clerkPubKey ? (
            <div className="clerk-host">
              {isSignUp
                ? <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
                : <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />}
            </div>
          ) : (
            <div className="auth-unavailable" role="status" data-testid="status-auth-setup">
              <span className="status-symbol status-warn"><CircleAlert size={20} /></span>
              <h2>تسجيل الدخول غير مهيأ بعد</h2>
              <p>تعذر تحميل خدمة الحسابات. لم يتم إدخال بياناتك، ويمكنك العودة لاحقًا بعد إتمام إعداد الدخول.</p>
              <Link href="/" className="button button-outline" data-testid="link-auth-return">العودة للرئيسية <ArrowLeft size={16} /></Link>
            </div>
          )}
          <p className="auth-note"><LockKeyhole size={14} /> بيانات الدخول محمية. لا تُمنح صلاحيات إدارية تلقائيًا.</p>
        </div>
      </section>
      <footer className="auth-footer"><span>PERTOMAX EG</span><span>مساحة تشغيل مصرية</span></footer>
    </main>
  );
}

function StatusLine({ label, children, tone = 'neutral' }: { label: string; children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  const Icon = tone === 'ok' ? CircleCheck : tone === 'bad' ? CircleAlert : tone === 'warn' ? CircleDashed : CircleDashed;
  return <div className={`status-line tone-${tone}`} data-testid={`status-${label}`}><span className="status-line-icon"><Icon size={17} /></span><span className="status-line-label">{label}</span><span className="status-line-value">{children}</span></div>;
}

function WorkspaceStatus() {
  const { isLoaded, isSignedIn } = useAuth();
  const api = useHealthCheck();
  const supabase = useSupabaseHealthCheck();
  const { signOut } = useClerk();

  if (!isLoaded) return <main className="workspace-loading" dir="rtl"><Topbar minimal /><div className="loading-panel"><span className="skeleton skeleton-title" /><span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" /></div></main>;
  if (!isSignedIn) return <main className="workspace-loading" dir="rtl"><Topbar minimal /><div className="signed-out-panel"><span className="status-symbol status-warn"><LockKeyhole size={21} /></span><h1>يلزم تسجيل الدخول</h1><p>سجّل الدخول أولًا لعرض حالة مساحة العمل.</p><Link href="/sign-in" className="button" data-testid="link-workspace-sign-in">تسجيل الدخول <ArrowLeft size={16} /></Link></div></main>;

  const dbError = supabase.error?.data;
  const dbStatus = supabase.data?.status ?? dbError?.status;
  const dbMessage = supabase.data?.message ?? dbError?.message;
  const databaseLabel = dbStatus === 'connected'
    ? 'الاتصال متاح، التحقق مطلوب'
    : dbStatus === 'not_configured'
      ? 'الإعداد غير مكتمل'
      : dbStatus === 'project_mismatch'
        ? 'مرجع المشروع غير متطابق'
        : dbStatus === 'unauthorized'
          ? 'تعذر التحقق من الوصول'
          : dbStatus === 'unavailable'
            ? 'الخدمة غير متاحة'
            : 'بانتظار التحقق';
  const setupTone = dbStatus === 'unauthorized' || dbStatus === 'project_mismatch' ? 'bad' : 'warn';
  const showSetupError =
    api.isError ||
    (supabase.isError &&
      (dbStatus === 'unauthorized' || dbStatus === 'unavailable'));
  const retry = () => { void supabase.refetch(); void api.refetch(); };

  return (
    <main className="workspace-page" dir="rtl">
      <Topbar minimal />
      <section className="workspace-shell">
        <div className="workspace-heading">
          <div><span className="section-kicker">مساحة العمل / حالة الوصول</span><h1>أهلًا بك في <em>Pertomax EG</em></h1><p>هذه شاشة حالة تأسيسية. لا توجد سجلات جهات أو فروع معروضة قبل التحقق من إعداد المشروع.</p></div>
          <button className="signout-button" onClick={() => void signOut({ redirectUrl: basePath || '/' })} data-testid="button-sign-out"><LogOut size={16} /> تسجيل الخروج</button>
        </div>

        <div className="workspace-grid">
          <article className="permission-card">
            <div className="permission-top"><span className="permission-icon"><LockKeyhole size={21} /></span><span className="permission-tag">الوصول مقيّد</span></div>
            <span className="section-kicker">حالة الحساب</span>
            <h2>صلاحيات الحساب<br /><em>غير متحققة بعد.</em></h2>
            <p>لا يمكن تأكيد نطاق وصولك قبل تهيئة قاعدة البيانات. الحساب الجديد يبقى دون صلاحيات حتى يعيّنها مسؤول موثوق، ولا تُمنح ملكية المنصة تلقائيًا.</p>
            <div className="permission-foot"><span className="permission-pulse" /> لا يتم عرض بيانات أو صلاحيات قبل التحقق</div>
          </article>

          <article className="setup-card">
            <div className="setup-card-head"><div><span className="section-kicker">فحص تأسيسي</span><h2>إعداد الاتصال</h2></div><span className={`setup-state ${showSetupError ? 'setup-state-error' : ''}`}>{showSetupError ? 'يتطلب الانتباه' : supabase.isLoading || api.isLoading ? 'جارٍ الفحص' : 'الحالة الحالية'}</span></div>
            <p className="setup-description">نتحقق من جاهزية خدمة المنصة والاتصال بقاعدة البيانات دون عرض مفاتيح أو بيانات.</p>
            <div className="status-list">
              <StatusLine label="خدمة المنصة" tone={api.data?.status === 'ok' || api.data?.status === 'healthy' ? 'ok' : api.isError ? 'bad' : api.isLoading ? 'neutral' : 'warn'}>
                {api.isLoading ? 'جارٍ الفحص' : api.isError ? 'تعذر الوصول' : api.data?.status === 'ok' || api.data?.status === 'healthy' ? 'متاحة' : api.data?.status ?? 'بانتظار التحقق'}
              </StatusLine>
              <StatusLine label="اتصال Supabase" tone={setupTone}>
                {supabase.isLoading ? 'جارٍ الفحص' : supabase.isError ? 'تعذر التحقق' : databaseLabel}
              </StatusLine>
            </div>
            {showSetupError && <div className="inline-error" role="alert" data-testid="status-setup-error"><CircleAlert size={16} /><span>لم يكتمل فحص الإعداد. حاول مرة أخرى أو تواصل مع مسؤول المنصة.</span></div>}
            <div className="setup-callout" role="status" data-testid="status-setup-blocked">
              <span className="callout-icon"><CircleAlert size={18} /></span>
              <div><b>مساحة العمل غير مفعّلة</b><p>{dbMessage ?? (dbStatus === 'connected' ? 'الاتصال يستجيب، لكن توافق المخطط لم يُراجع بعد. لن تظهر أي سجلات قبل إتمام التحقق.' : dbStatus === 'project_mismatch' ? 'مرجع مشروع Supabase لا يطابق المشروع المصرّح به. لم يتم تحميل أي سجلات.' : dbStatus === 'unauthorized' ? 'تعذر التحقق من صلاحية الاتصال. لم يتم تحميل أي سجلات.' : dbStatus === 'unavailable' ? 'الخدمة غير متاحة الآن. لم يتم تحميل أي سجلات.' : 'أكمل إعداد اتصال Supabase المعتمد حتى يمكن التحقق من المخطط والصلاحيات.')}</p></div>
            </div>
            {supabase.isLoading && <div className="status-skeleton"><span /><span /></div>}
            <div className="setup-card-bottom">
              <span>لا بيانات تشغيل معروضة قبل اعتماد الإعداد.</span>
              <button className="retry-button" onClick={retry} disabled={supabase.isFetching || api.isFetching} data-testid="button-retry-setup">{supabase.isFetching || api.isFetching ? 'جارٍ الفحص…' : 'إعادة الفحص'} <ArrowLeft size={15} /></button>
            </div>
          </article>
        </div>

        <div className="workspace-notice"><span className="notice-mark"><ShieldCheck size={18} /></span><p><b>حسابك لا يملك صلاحيات تلقائية.</b> تعيين الوصول إلى الشركات أو الفروع يتم لاحقًا بواسطة مسؤول موثوق بعد تهيئة المشروع والتحقق من النطاق الصحيح.</p></div>
        <footer className="workspace-footer"><span>Pertomax EG · حالة الوصول</span><span>لا تظهر بيانات تشغيلية قبل التحقق</span></footer>
      </section>
    </main>
  );
}

function ProtectedWorkspace() {
  return <><Show when="signed-in"><WorkspaceStatus /></Show><Show when="signed-out"><RedirectHome /></Show></>;
}

function RedirectHome() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation('/'); }, [setLocation]);
  return <main className="workspace-loading" dir="rtl"><Topbar minimal /><div className="loading-panel"><span className="skeleton skeleton-title" /><span className="skeleton skeleton-line" /></div></main>;
}

function ClerkCacheInvalidator() {
  const { addListener } = useClerk();
  const cache = useQueryClient();
  const prevId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const stop = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevId.current !== undefined && prevId.current !== userId) cache.clear();
      prevId.current = userId;
    });
    return stop;
  }, [addListener, cache]);
  return null;
}

function NotFound() {
  return <main className="not-found" dir="rtl"><Brand /><span className="section-kicker">404 / الصفحة غير موجودة</span><h1>لم نعثر على هذه الصفحة.</h1><Link href="/" className="button" data-testid="link-not-found-home">العودة للرئيسية <ArrowLeft size={16} /></Link></main>;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (isLoaded && isSignedIn) setLocation('/workspace');
  }, [isLoaded, isSignedIn, setLocation]);
  return isLoaded && isSignedIn
    ? <main className="workspace-loading" dir="rtl"><Topbar minimal /><div className="loading-panel"><span className="skeleton skeleton-title" /><span className="skeleton skeleton-line" /></div></main>
    : <HomePage />;
}

function Router({ authEnabled = false }: { authEnabled?: boolean }) {
  return <Switch>
    <Route path="/" component={authEnabled ? HomeRedirect : HomePage} />
    <Route path="/sign-in/*?" component={() => <AuthPage mode="sign-in" />} />
    <Route path="/sign-up/*?" component={() => <AuthPage mode="sign-up" />} />
    <Route path="/workspace" component={authEnabled ? ProtectedWorkspace : SetupBlockedWorkspace} />
    <Route component={NotFound} />
  </Switch>;
}

function SetupBlockedWorkspace() {
  return <main className="workspace-loading" dir="rtl"><Topbar minimal /><div className="signed-out-panel"><span className="status-symbol status-warn"><CircleAlert size={21} /></span><span className="section-kicker">حالة الإعداد</span><h1>تعذر التحقق من الحساب</h1><p>خدمة تسجيل الدخول غير مهيأة بعد. لم يتم تحميل أي بيانات أو صلاحيات.</p><Link href="/" className="button button-outline" data-testid="link-workspace-return">العودة للرئيسية <ArrowLeft size={16} /></Link></div></main>;
}

function ClerkRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    appearance={{
      variables: {
        colorPrimary: '#2d6659',
        colorForeground: '#263842',
        colorMutedForeground: '#6f7b7b',
        colorBackground: '#fbfaf6',
        colorInput: '#fffefa',
        colorInputForeground: '#263842',
        colorDanger: '#a4473d',
        colorNeutral: '#d9d3c8',
        fontFamily: "'IBM Plex Sans Arabic', 'DM Sans', sans-serif",
        borderRadius: '0.75rem',
      },
      options: {
        logoPlacement: 'inside',
        logoLinkUrl: `${window.location.origin}${basePath}/`,
        logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
      },
      elements: {
        card: 'clerk-card',
        cardBox: 'clerk-card-box',
        headerTitle: 'clerk-title',
        headerSubtitle: 'clerk-subtitle',
        formFieldLabel: 'clerk-label',
        formFieldInput: 'clerk-input',
        formButtonPrimary: 'clerk-primary',
        footerActionLink: 'clerk-link',
        footerActionText: 'clerk-footer-text',
        socialButtonsBlockButtonText: 'clerk-social-text',
      },
    }}
    localization={arabicLocalization}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >
    <ClerkCacheInvalidator />
    <Router authEnabled />
  </ClerkProvider>;
}

function App() {
  useEffect(() => {
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  }, []);
  return <QueryClientProvider client={queryClient}><WouterRouter base={basePath}>{clerkPubKey ? <ClerkRoutes /> : <Router />}</WouterRouter></QueryClientProvider>;
}

export default App;
