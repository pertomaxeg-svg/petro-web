# DB-01 — جرد المخطط وخطة قابلية إعادة الإنشاء

**تاريخ الجرد الأولي:** 14 أكتوبر 2026؛
**تحديث التنفيذ:** 15 أكتوبر 2026
**النطاق:** Pertomax EG فقط؛ Supabase `msvgzsfzrqlrfpstthhe` ومستودع `pertomaxeg-svg/petro-web`.
**الحالة الحالية:** أضيفت نسخة مخطط كاملة قابلة لإعادة البناء محليًا واختُبرت في PostgreSQL مؤقت ومعزول. قاعدة Supabase الحية لم تتلق أي DDL أو كتابة؛ فحصها واستخراج المخطط كانا للقراءة فقط مع TLS كامل. لم تُقرأ صفوف مستخدمين أو قيم أسرار.

## الملخص التنفيذي

- جرد القاعدة الحية: **11 جدولًا** (10 في `public` وواحد في `petro_private`)، **57 قيدًا**، **22 فهرسًا**، **23 دالة**، **مشغّل واحد**، **12 سياسة RLS**، و32 تجميعة صلاحيات جداول و62 تجميعة صلاحيات تنفيذ دوال.
- RLS مفعّل على الجداول الـ11 كلها؛ `FORCE ROW LEVEL SECURITY` غير مفعّل على أي منها.
- ملفات الترحيل الثلاثة لا تعيد إنشاء القاعدة من الصفر. أضيف الآن `lib/db/rebuild/current-schema.sql` كنسخة نهائية منفصلة للاختبار المحلي فقط؛ لا يطابق ذلك سجل الترحيلات التاريخي ولا يجعل `0001`–`0003` سلسلة تأسيسية. سجل Supabase يحوي سجلين باسم `petro_foundation` و`petro_plan_versions`، لكن مصدري SQL المقابلين غير موجودين ضمن ملفات الترحيل الحالية؛ لا يمكن استنتاج التطابق من اسم السجل وحده.
- التطبيق يستخدم SQL migrations وعميل Supabase و`pg` مباشرة. لم يُعثر على استدعاءات `db` الخاصة بـDrizzle في API، وملف `lib/db/src/schema/index.ts` قالب فارغ؛ لا مبرر لإضافة تعريفات Drizzle شكلية.

## الملفات والأنظمة التي فُحصت

- ملفات SQL الموجودة فقط:
  - `lib/db/migrations/0001_petro_auth_and_management.sql`
  - `lib/db/migrations/0002_username_only_auth.sql`
  - `lib/db/migrations/0003_auth_signin_rate_limits.sql`
- سجل `supabase_migrations.schema_migrations` يعرض إصدارين فقط: `20261013111142` باسم `petro_foundation` و`20261013111150` باسم `petro_plan_versions`. لم أقرأ عمود `statements` أو بيانات مستخدمين.
- لا يوجد ملف تأسيسي ضمن `lib/db/migrations`؛ ملف إعادة الإنشاء الجديد منفصل تحت `lib/db/rebuild` ولا يُشغّل على قاعدة قائمة.
- `lib/db/src/schema/index.ts` لا يعرّف جداول Drizzle.
- مسارات الإدارة تستخدم عميل Supabase من الخادم: `.from(...)` للقراءة و`.rpc(...)` للكتابات الإدارية. مسارات المصادقة ومحدد محاولات الدخول تستخدم `pg.Pool` مباشرة. `drizzle(pool, { schema })` مُصدّر من مكتبة DB، لكن لم أجد استدعاءات `db.*` في API.
- مراجع التطبيق الأساسية: `artifacts/api-server/src/routes/auth.ts` و`management.ts` و`lib/db/src/connection.ts` و`artifacts/api-server/src/lib/supabaseServer.ts`.

## جرد الجداول والأعمدة الحية

كل جدول أدناه عليه RLS، ولا يوجد جدول عليه FORCE RLS:

| الجدول | الأعمدة والأنواع |
|---|---|
| `public.petro_profiles` | `user_id uuid`, `display_name text`, `active boolean`, `created_at timestamptz`, `username text`, `login_identifier_type text`, `account_status text` |
| `public.petro_platform_roles` | `user_id uuid`, `role text`, `active boolean` |
| `public.petro_organizations` | `id uuid`, `name text`, `kind text`, `country_code text`, `currency text`, `status text`, `created_at timestamptz`, `created_by uuid` |
| `public.petro_branches` | `id uuid`, `organization_id uuid`, `name text`, `address text`, `status text`, `created_at timestamptz` |
| `public.petro_memberships` | `id uuid`, `user_id uuid`, `organization_id uuid`, `role text`, `scope text`, `active boolean` |
| `public.petro_membership_branches` | `organization_id uuid`, `membership_id uuid`, `branch_id uuid` |
| `public.petro_membership_invites` | `id uuid`, `organization_id uuid`, `invited_email text`, `role text`, `scope text`, `branch_ids uuid[]`, `token_hash text`, `created_by uuid`, `created_at timestamptz`, `expires_at timestamptz`, `accepted_by uuid`, `accepted_at timestamptz`, `revoked_at timestamptz` |
| `public.petro_audit_events` | `id bigint`, `actor_id uuid`, `organization_id uuid`, `action text`, `target_id uuid`, `detail jsonb`, `occurred_at timestamptz` |
| `public.petro_plans` | `id uuid`, `code text`, `audience text`, `name text`, `active boolean` |
| `public.petro_plan_versions` | `id uuid`, `plan_id uuid`, `version integer`, `annual_price_minor bigint`, `nfc_issue_price_minor bigint`, `billing_unit text`, `features text[]`, `effective_at timestamptz`, `created_by uuid` |
| `petro_private.petro_auth_signin_limits` | `bucket_key text`, `attempt_count integer`, `window_started_at timestamptz`, `updated_at timestamptz` |

## العلاقات والقيود

العلاقات الخارجية المهمة: ملفات الحسابات وأدوار المنصة وعضويات الجهات وسجل التدقيق والمنشئون والمستخدمون المدعوون تشير إلى `auth.users`. الفروع تتبع الجهة. جسر الفروع يربط العضوية بفرع من الجهة نفسها بمفتاحين مركبين. إصدارات الأسعار تتبع باقة. قيد جهة/عضوية أو جهة/فرع المركب يمنع ربطًا عابرًا للجهات.

ملخص القيود الحية الـ57، مجمّعًا حسب الجدول:

- `petro_profiles` (5): مفتاح أساسي ومرجع `auth.users`؛ حالة الحساب `pending/active/suspended` أو null؛ نوع الدخول `username`؛ تنسيق اسم المستخدم lowercase وبالنمط المقيد.
- `petro_platform_roles` (3): مفتاح `(user_id, role)`، مرجع المستخدم، وقيم الدور `owner/operations/finance/support/auditor`.
- `petro_organizations` (7): مفتاح أساسي ومرجع `created_by`؛ الدولة `EG` والعملة `EGP`؛ النوع `company/station/provider`؛ الاسم بطول 2–160؛ الحالة `pending/active/suspended`.
- `petro_branches` (5): مفتاح أساسي، فريد `(organization_id,id)`، مرجع الجهة، الاسم 2–160، والحالة `pending/active/suspended`.
- `petro_memberships` (8): مفتاح أساسي، فريد `(organization_id,id)` و`(user_id,organization_id)`، مرجعا الجهة والمستخدم، أدوار الجهة المقيدة، نطاق `organization/branches`، والعامل مقيد بنطاق الفروع.
- `petro_membership_branches` (3): مفتاح `(membership_id,branch_id)` ومرجعان مركبان يثبتان تطابق الجهة مع العضوية والفرع.
- `petro_audit_events` (3): مفتاح أساسي ومرجعا الفاعل والجهة؛ كلاهما يمنع الحذف المتسلسل.
- `petro_plans` (3): مفتاح أساسي، `code` فريد، و`audience` ضمن `company/provider`.
- `petro_plan_versions` (8): مفتاح أساسي، فريد `(plan_id,version)`، مرجعا الباقة والمنشئ، الإصدار أكبر من صفر، الوحدة `vehicle/branch`، السعر السنوي من صفر إلى مليار وحدة صغرى، ورسوم NFC غير سالبة.
- `petro_membership_invites` (9): مفتاح أساسي، `token_hash` فريد وبصيغة 64 خانة hex، بريد مطبّع، دور ونطاق مقيدان، ومرجع الجهة مع `ON DELETE CASCADE` ومرجعا القبول والمنشئ إلى `auth.users`.
- `petro_auth_signin_limits` (3): المفتاح هو `bucket_key`، بصيغة 64 خانة hex، وعدّ المحاولات بين 1 و100.

## الفهارس

يوجد 22 فهرسًا:

- `petro_private.petro_auth_signin_limits`: `petro_auth_signin_limits_pkey`, `petro_auth_signin_limits_updated_at_idx`.
- `petro_audit_events`: `petro_audit_events_pkey`, `petro_audit_org_time_idx` على الجهة والوقت التنازلي.
- `petro_branches`: `petro_branches_pkey`, `petro_branches_organization_id_id_key`, `petro_branches_org_idx`.
- `petro_membership_branches`: `petro_membership_branches_pkey`.
- `petro_membership_invites`: `petro_membership_invites_pkey`, `petro_membership_invites_token_hash_key`.
- `petro_memberships`: `petro_memberships_pkey`, `petro_memberships_organization_id_id_key`, `petro_memberships_user_id_organization_id_key`, `petro_memberships_user_idx` (جزئي على العضويات النشطة).
- `petro_organizations`: `petro_organizations_pkey`.
- `petro_plan_versions`: `petro_plan_versions_pkey`, `petro_plan_versions_plan_id_version_key`.
- `petro_plans`: `petro_plans_pkey`, `petro_plans_code_key`.
- `petro_platform_roles`: `petro_platform_roles_pkey`.
- `petro_profiles`: `petro_profiles_pkey`, `petro_profiles_username_ci_unique` (جزئي على `lower(username)`).

## الدوال والمشغلات

الدوال الـ23 الحية كلها `SECURITY DEFINER` وتضبط `search_path` إلى قيمة فارغة؛ يلزم إبقاء هذا الضبط ومراجعة قوائم السماح لكل دالة في DB-01:

- `petro_private`: `can_manage_branch(uuid,uuid)`, `can_manage_org(uuid)`, `can_read_branch(uuid,uuid)`, `can_read_org(uuid)`, `can_view_membership(uuid)`, `can_view_profile(uuid)`, `handle_auth_user()`, `platform_has(text[])`, `user_active()`.
- `public`: `petro_accept_invitation(text)`, `petro_access_context()`, `petro_create_branch(uuid,text,text)`, `petro_create_invitation(uuid,text,text,text,uuid[],text)`, `petro_create_organization(text,text)`, `petro_list_invitations(uuid)`, `petro_publish_plan_price(uuid,bigint)`, `petro_revoke_invitation(uuid)`, `petro_set_account_status(uuid,text)`, `petro_set_branch_status(uuid,uuid,text)`, `petro_set_membership(uuid,uuid,text,text,uuid[],boolean)`, `petro_set_organization_status(uuid,text)`, `petro_update_branch(uuid,uuid,text,text)`, `petro_update_organization(uuid,text)`.
- المشغّل غير الداخلي الوحيد في النطاق المفحوص: `auth.users.petro_auth_user_created`، مفعّل، يعمل بعد الإدراج ويستدعي `petro_private.handle_auth_user()`.

## RLS والصلاحيات

- توجد 12 سياسة، وكلها `SELECT` للدور `authenticated`: `petro_audit_events_org_manager_read`, `petro_audit_read`, `petro_branch_read`, `petro_membership_branches_scoped_read`, `petro_membership_read`, `petro_memberships_manager_read`, `petro_org_read`, `petro_plan_version_read`, `petro_plan_read`, `petro_platform_role_read`, `petro_profile_read`, `petro_profiles_manager_read`.
- لا توجد سياسة على `petro_membership_invites` أو `petro_private.petro_auth_signin_limits`؛ الجدولان عليهما RLS، وتظل نتيجة التطبيق الفعلية بحاجة لاختبارات جلسات مصرح بها في DB-01.
- صلاحيات الجداول: `authenticated` يملك `SELECT` على الجداول العامة التسعة الأساسية؛ `service_role` و`postgres` يملكان الصلاحيات الكاملة على الجداول العامة. على `petro_membership_invites` توجد صلاحيات DML كاملة صريحة لـ`anon` و`authenticated` أيضًا، رغم عدم وجود سياسة RLS له؛ يجب توثيق هذا الفرق بين SQL grants وRLS واختباره وعدم تغيير الصلاحية في هذه المهمة. جدول محدد الدخول في `petro_private` لا تظهر له صلاحيات تطبيقية؛ صلاحياته المجمعة للـ`postgres` فقط.
- صلاحية `USAGE` على `public` موجودة للأدوار المفحوصة `anon/authenticated/service_role/postgres`. على `petro_private` توجد لـ`authenticated` و`postgres` فقط، ولا توجد لـ`anon` أو`service_role`.
- صلاحيات الدوال: يوجد 62 صفًا مجمعًا؛ دوال `public` الأربع عشرة قابلة للتنفيذ من `authenticated/service_role/postgres`. ثلاث مساعدات خاصة (`can_manage_branch`, `can_view_profile`, `can_view_membership`) لها كذلك `EXECUTE` لـ`PUBLIC`؛ خمس مساعدات خاصة أخرى (`can_manage_org`, `can_read_branch`, `can_read_org`, `platform_has`, `user_active`) متاحة لـ`authenticated/postgres`، ومشغّل `handle_auth_user` لـ`postgres`. يجب تقرير الحاجة إلى صلاحيات `PUBLIC` صراحةً في DB-01؛ لا تغيير هنا.

## الفروقات الدقيقة بين القاعدة والمستودع

1. لا يعرّف أي ملف SQL إنشاء الجداول الأساسية التسعة: `petro_profiles`, `petro_platform_roles`, `petro_organizations`, `petro_branches`, `petro_memberships`, `petro_membership_branches`, `petro_audit_events`, `petro_plans`, `petro_plan_versions`. من قيودها الحية الـ45، توجد تعريفات لقيود الملف الشخصي الثلاثة في `0001/0002`؛ تبقى **42 قيدًا** بلا مصدر ترحيل، كما تبقى **17 من 18 فهرسًا** على الجداول الأساسية بلا تعريف في الملفات (`0001` يعرّف فهرس اسم المستخدم). `0001` يعدّل `petro_profiles` ويفترض الجداول ودوال الصلاحيات الأساسية موجودة؛ `0002` يفترض وجود ملف الحساب. لا يمكن تشغيل السلسلة الحالية على قاعدة فارغة.
2. لا توجد في SQL المتتبع تعريفات لعشر دوال حية: `petro_private.can_manage_org`, `can_read_branch`, `can_read_org`, `platform_has`, `user_active`، و`public.petro_access_context`, `petro_create_organization`, `petro_create_branch`, `petro_set_organization_status`, `petro_publish_plan_price`.
3. ثماني سياسات قراءة أساسية حية لا تظهر كتعريفات في الملفات: `petro_audit_read`, `petro_branch_read`, `petro_membership_read`, `petro_org_read`, `petro_plan_version_read`, `petro_plan_read`, `petro_platform_role_read`, `petro_profile_read`. أما سياسات مدير الجهة/الفرع الأربع الأخرى فتظهر في `0001`.
4. `0001` ينشئ `petro_membership_invites` وبعض دوال الإدارة وسياساتها، ويعرّف `handle_auth_user` دون إنشاء المشغّل. `0002` يعيد تعريف الدالة وينشئ المشغّل بطريقة تتحقق من الموجود. يوجد مشغّل واحد حي فقط. `0003` ينشئ جدول `petro_private.petro_auth_signin_limits` وفهرس الوقت ويمنع صلاحيات تطبيقية مباشرة عليه.
5. لا يعرّف أي ملف إنشاء مخطط `petro_private`. قد يكون موجودًا بسبب مصدر SQL تاريخي غير موجود في المستودع؛ لا يُعاد إنشاؤه أو استبداله قبل المطابقة.
6. سجل Supabase يسمي إصدارين `petro_foundation` و`petro_plan_versions`، ولا توجد ملفات بهذا الاسمين في المستودع. كما أن أسماء `0001/0002/0003` لا تطابق سجلي التاريخ. المطابقة الدقيقة بين محتوى السجل وملفات SQL غير مثبتة؛ لا تُعاد هذه الملفات عميانيًا ولا تُعلّم كمنفذة بالاسم فقط.

## الخطة الأولية للمطابقة (مرجع تاريخي؛ النتائج الحالية أدناه)

### قاعدة اختبار فارغة

1. إعداد Supabase محلي/قاعدة اختبار مؤقتة مع إصدار PostgreSQL وامتدادات وأدوار ومخطط Auth متوافقة؛ لا تتصل بقاعدة مستخدم أخرى ولا تستخدم بيانات أو أسرار الإنتاج.
2. إعداد سلسلة ترحيلات تأسيسية كاملة ومرتبة تصف المخططات والجداول والقيود والفهارس والدوال والمشغّل وسياسات RLS والصلاحيات، مع الاعتماد على SQL لأن هذا هو مسار DDL المستعمل حاليًا.
3. تطبيق السلسلة من الصفر، ثم مقارنة جرد metadata الناتج مع الجرد المعتمد أعلاه. اختبار تسجيل Auth/RPC وRLS بصلاحيات `anon` و`authenticated` وبجلسات محلية معزولة، بما فيها رفض الوصول بين الجهات والفروع.
4. يجب أن تنجح كل الترحيلات من قاعدة فارغة وتُسجَّل بإصدارات قابلة للمطابقة مع ملفات المصدر؛ لا جداول اختبار عامة مفتوحة ولا قيم أو حسابات ثابتة.

### القاعدة الحالية ذات البيانات

1. قبل أي تنفيذ لاحق، حفظ نسخة استرداد مناسبة والتحقق من إمكانية استعادتها، ثم أخذ مخطط فقط دون صفوف المستخدمين والأسرار.
2. مطابقة كل كائن حي مع SQL المصدر وسجل الترحيلات، وتصنيفه: مطابق، مفقود من المستودع، اختلاف مقصود يحتاج قرارًا، أو اختلاف مانع. لا يُعاد تطبيق كائن موجود.
3. لا يُعتمد سجل الترحيل الحالي أو يُصلح إلا بعد تطابق مضمون لمحتوى SQL مع الحالة الحية. لا تُستخدم `DROP/CREATE` أو `TRUNCATE` أو تعطيل RLS أو ترقيع يدوي في الإنتاج.
4. بعد نجاح القاعدة الفارغة ومراجعة الفروقات، لا يُسمح إلا بترحيل أمامي إضافي يضيف ما ثبت غيابه، مع preconditions وpostconditions واختبارات metadata. أي اختلاف أو اعتماد غير محسوم يوقف التنفيذ قبل DDL.

## المواصفات والقرارات التي عُثر عليها

- `replit.md`: حدود المشروع وترتيب المراحل وقواعد RTL/EGP والقواعد التجارية التي قدّمها المستخدم؛ تعليمات مشروع، وليست PRD تفصيلية.
- `docs/PERTOMAX-EG-ENGINEERING-REFERENCE-v3.md`: المرجع الهندسي الذي قدمه المستخدم؛ يرشد طريقة التنفيذ، لكنه لا يُعد مواصفة منتج تفصيلية أو إثباتًا لوجود ميزة.
- `lib/api-spec/openapi.yaml`: عقد API الموجود، وليس مخطط قاعدة أو مواصفة منتج كاملة.
- `AUTH-01-DECISION.md` و`AUTH-02-DECISION.md`: قرارات الهوية والدخول.
- `PERTOMAX_STATUS.md`: سجل الحالة والاختبارات.
- `PERTOMAX-CENTRAL-ADMIN-GAPS.md`: مصفوفة فجوات أُنشئت في العمل السابق؛ ليست مواصفة أصلية صادرة عن المنتج.
- لم أجد PRD مستقلًا أو baseline SQL كاملًا أو مصفوفة صلاحيات منتج شاملة أو مواصفات تفصيلية للطلبات والمالية والتسويات. المتطلبات التي ذكرها المستخدم في المحادثة تبقى المرجع المعتمد عند وجودها؛ المرفق الشخصي مستبعد من فرع الرفع.
- لا تُستنتج من جداول الباقات وحدها أسعار إضافية أو شروط مالية، ولا تُخترع صلاحيات أو إجراءات موافقة غير محددة في المصادر.

## معايير قبول DB-01 قبل اعتباره منجزًا

- كل كائن حي ضمن النطاق موثق ومطابق لملف SQL مصدر أو موسوم بوضوح أنه يحتاج قرارًا/ترحيلًا.
- تطبيق الترحيلات كاملة من قاعدة اختبار فارغة ينتج الجداول والعلاقات والقيود والفهارس والدوال والمشغّل والسياسات والصلاحيات المتوقعة بلا تكرار.
- لا تغييرات مفقودة أو مدمرة عند مقارنة الحالة الحالية؛ لا يعاد إنشاء أي جدول أو مشغّل موجود، ولا تُمس بيانات الحسابات أو العضويات.
- اختبارات RLS والـgrants تفصل مستخدمًا غير مسجل ومستخدمًا مصرحًا ومستخدمًا خارج الجهة/الفرع؛ وتراجع صراحةً منح `PUBLIC` و`anon` وتحقق أن صلاحيات الإدارة تتم عبر RPC المقصود فقط.
- تُختبر مسارات التطبيق الفعلية باستخدام Supabase JS و`pg`; لا تُضاف نماذج Drizzle ما لم يبدأ التطبيق باستخدامها فعليًا.
- لا يُنفذ أي DDL على Supabase الحية قبل مراجعة DB-01 وقرار صريح منفصل.

## نتيجة تنفيذ DB-01 — 15 أكتوبر 2026

### مصدر المخطط وحدود النسخة

- تحقق اتصال PostgreSQL الفعلي بالمضيف المنتمي إلى المشروع `msvgzsfzrqlrfpstthhe` داخل معاملة قراءة فقط؛ إصدار الخادم **17.11**، وTLS **1.3** مع cipher حاضر والتحقق من شهادة الجذر واسم المضيف كاملًا.
- استُخرج `lib/db/rebuild/current-schema.sql` بواسطة `pg_dump` **17.5** مع `--schema-only --no-owner` للمخططين `public` و`petro_private`. حجم الملف 67,481 بايت، ولا يحتوي صفوفًا أو سلاسل بريد أو أنماط أسرار معروفة. الصلاحيات وRLS محفوظة؛ ملكية الكائنات جرى توحيدها للاختبار بسبب `--no-owner`.
- لا يشمل الملف مخطط Supabase المُدار `auth` أو مستخدميه. يوفّر `local-auth-bootstrap.sql` بديلًا محليًا محدودًا لـ`auth.users` و`auth.uid()` لاختبار مفاتيح العلاقات وسياسات RLS؛ ليس بديلًا لخدمة Supabase Auth ولا يرسل بريدًا.
- النسخة تمثل **الحالة النهائية الحالية**، وليست migration إنتاجية. لا تُطبّق على Supabase المعتمدة أو على قاعدة موجودة. لا تُشغّل `0001` فوقها لأن آثار الترحيل موجودة أصلًا وقد تتكرر سياساته. أُعيد تشغيل `0002` و`0003` في الاختبار المحلي فقط للتحقق من سلوكهما على هذه الحالة.

### إعادة الإنشاء والتحقق المعزول

- شُغّل PostgreSQL **17.5** مؤقتًا داخل `/tmp`، مع Unix socket محلي و`listen_addresses` معطّل؛ لا اتصال شبكة أو خدمة مدفوعة. أُزيل مجلد الاختبار والكتلة المحلية عند انتهاء التشغيل.
- أُعيد تحميل النسخة على قاعدة فارغة، ثم طُبق `0002` و`0003` في الاختبار المحلي، وشُغّل اختبار RLS المضمّن في `lib/db/rebuild/`. أعاد التفريغ المحلي بعد التطبيع تطابقًا مطابقًا لتفريغ Supabase في تعريفات `public` و`petro_private`.
- تطابقت الأعداد بعد الاستعادة: **11 جدولًا، 57 قيدًا، 22 فهرسًا، 23 دالة، 12 سياسة، و11 جدولًا مفعّلًا عليه RLS**؛ كما تحقق المشغّل المحلي الواحد على `auth.users` بعد `0002`.
- اختبارات قاعدة البيانات المحلية: فصل مستخدمين على شركتين؛ حصر كل مستخدم في الجهة والفرع المعيّنين ومنع الفرع غير المعيّن والجهة الأخرى؛ رفض الربط المركب لفرع من جهة أخرى؛ منع قراءة `anon`؛ منع تعديل العضويات/الأدوار مباشرة؛ رفض إدخال الدعوات بواسطة RLS رغم صلاحية DML الممنوحة؛ منع الحساب المعطّل من القراءة؛ وإنشاء الملف الجديد بحالة `pending` دون منحه دور مالك تلقائيًا. كل البيانات التجريبية تراجعت بـ`ROLLBACK` ثم حُذفت الكتلة المحلية.
- ثبت اختبار الإعادة **المخططي وRLS المحلي**، وليس تسجيل دخول حقيقيًا أو بريدًا أو جلسة Supabase حية. لم يُختبر المستخدمون الفعليون أو تدفقات Auth/SMTP في هذه المهمة.

### الفجوات المتبقية والقرارات

- ملفات `0001`–`0003` ما زالت غير قابلة للتطبيق كسلسلة كاملة تبدأ من قاعدة فارغة؛ النسخة النهائية المنفصلة تعيد إنشاء الحالة الحالية للاختبار لكنها لا تصلح سجل `supabase_migrations.schema_migrations` ولا تعيد بناء تاريخ ما قبل `0001`.
- مصدرَا سجلي `petro_foundation` و`petro_plan_versions` في سجل Supabase لم يظهرا بين الملفات. يلزم قرار لاحق بشأن مصدر migrations الدائم وكيفية مطابقة السجل دون إعادة تطبيق أو تغيير على القاعدة الحالية.
- بقيت صلاحيات DML الصريحة لـ`anon` و`authenticated` على `petro_membership_invites` دون سياسة RLS؛ اختُبر الرفض الافتراضي محليًا ولم تتغير الصلاحيات. لا تُفتح سياسة قبل مراجعة منفصلة.
- بقيت صلاحيات `EXECUTE` الممنوحة إلى `PUBLIC` على ثلاث دوال مساعدة كما هي؛ لم تُغيّر أو تُختبر بقاعدة حية ضمن هذه المهمة.
- لم تُضف نماذج Drizzle؛ لا توجد استدعاءات Drizzle في مسارات API التي فُحصت.
- لم تُغيّر حساب المالك أو تهيئته أو Secrets أو RLS في Supabase الحية. يظل التحقق الكامل من TLS مطلوبًا لكل اتصال لاحق، وتظل التهيئة المغلقة كما هي.

### تحقق التنفيذ

- شغّل `bash lib/db/rebuild/run-local-test.sh` لإعادة الاختبار المحلي، بعد توفير أدوات PostgreSQL 17. لا يقرأ السكربت أسرارًا ولا يتصل بالشبكة أو بقاعدة Supabase.
- قبول DB-01 لهذه المهمة: **نجاح إعادة إنشاء النسخة النهائية محليًا، تطابق metadata والتفريغ، واجتياز اختبار العزل والصلاحيات المحلي**. لا يعني ذلك اعتماد سلسلة migrations إنتاجية أو السماح بأي DDL على القاعدة الحالية.
