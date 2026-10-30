const instantFields = new Set([
  "approvedAt",
  "createdAt",
  "updatedAt",
  "activatedAt",
  "revokedAt",
  "scheduledAt",
  "startsAt",
  "endsAt",
  "effectiveFrom",
  "effectiveTo",
  "recordedAt",
  "performedAt",
  "reviewedAt",
  "uploadedAt",
  "reservedAt",
  "installedAt",
  "receivedAt",
  "deliveredAt",
  "created_at",
  "updated_at",
]);

const calendarDateFields = new Set([
  "expiresOn",
  "expires_on",
  "nextDueAt",
  "dueAt",
]);

const minorAmountFields = new Set([
  "priceMinor",
  "issuePriceMinor",
  "amountMinor",
  "maxOperationMinor",
  "dailyAmountLimitMinor",
  "weeklyAmountLimitMinor",
  "monthlyAmountLimitMinor",
  "availableMinor",
  "reservedMinor",
  "ledgerMinor",
]);

const fieldUnits: Record<string, string> = {
  readingKm: "كم",
  odometer: "كم",
  dueOdometer: "كم",
  nextDueKm: "كم",
  tankCapacityLiters: "لتر",
  expectedConsumption: "لتر لكل ١٠٠ كم",
  byteSize: "بايت",
};

const translations: Record<string, string> = {
  active: "نشط",
  inactive: "غير نشط",
  suspended: "موقوف",
  draft: "مسودة",
  published: "منشور",
  pending: "قيد المراجعة",
  approved: "معتمد",
  rejected: "مرفوض",
  covered: "مغطاة",
  uncovered: "غير مغطاة",
  eligible: "مؤهل",
  ineligible: "غير مؤهل",
  installed: "مثبت",
  assigned: "مخصص",
  stopped: "متوقف",
  valid: "ساري",
  expired: "منتهي",
  submitted: "مرسل",
  needs_review: "بحاجة إلى مراجعة",
  requested: "مطلوب",
  scheduled: "مجدول",
  pending_review: "بانتظار المراجعة",
  ended: "منتهٍ",
  cancelled: "ملغي",
  revoked: "ملغى",
  available: "متاح",
  reserved: "محجوز",
  damaged: "تالف",
  lost: "مفقود",
  completed: "مكتمل",
  not_required: "غير مطلوب",
  awaiting_collection: "بانتظار التحصيل",
  waived: "معفى باعتماد",
  nfc: "شريحة NFC",
  qr: "رمز QR",
  fuel: "الوقود",
  wash: "الغسيل",
  oils: "الزيوت",
  batteries: "البطاريات",
  filters: "الفلاتر",
  parts: "قطع الغيار",
  consumables: "المستهلكات",
  other_services: "خدمات أخرى",
  gasoline: "بنزين",
  petrol: "بنزين",
  diesel: "سولار",
  natural_gas: "غاز طبيعي",
  company: "شركة",
  branch: "فرع",
  vehicle: "مركبة",
  driver: "سائق",
};

function formatMinorAmount(value: unknown): string {
  const raw = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^-?\d+$/.test(raw)) return "قيمة مالية غير صالحة";
  const amount = BigInt(raw);
  const sign = amount < 0n ? "−" : "";
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / 100n;
  const minor = new Intl.NumberFormat("ar-EG", { minimumIntegerDigits: 2, useGrouping: false })
    .format(Number(absolute % 100n));
  const wholeText = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(whole);
  return `${sign}${wholeText}٫${minor} جنيه مصري`;
}

function formatDate(value: unknown, withTime: boolean): string {
  if (typeof value !== "string" || value.trim() === "") return "—";
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    return "تاريخ غير صالح";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "تاريخ غير صالح";
  return new Intl.DateTimeFormat("ar-EG", withTime
    ? { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }
    : { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(parsed);
}

export function formatFleetField(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (instantFields.has(field)) return formatDate(value, true);
  if (calendarDateFields.has(field)) return formatDate(value, false);
  if (minorAmountFields.has(field)) return formatMinorAmount(value);
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (typeof value === "number" || typeof value === "bigint") {
    const rendered = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 3 }).format(value);
    const unit = fieldUnits[field];
    return unit ? `${rendered} ${unit}` : rendered;
  }
  if (typeof value === "string") {
    const translated = translations[value];
    if (translated) return translated;
    const numericUnit = fieldUnits[field];
    if (numericUnit && /^-?\d+(?:\.\d+)?$/.test(value)) {
      const parsed = Number(value);
      return `${new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 3 }).format(parsed)} ${numericUnit}`;
    }
    return value;
  }
  return "—";
}

export function formatFleetDate(value: unknown): string {
  return formatDate(value, true);
}
