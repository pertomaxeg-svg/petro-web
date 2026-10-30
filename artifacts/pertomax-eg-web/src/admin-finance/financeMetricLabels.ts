export const financeMetricLabels: Readonly<Record<string, string>> = {
  accountName: "الحساب",
  accountKind: "نوع الحساب",
  actorName: "المسؤول",
  availableMinor: "الرصيد المتاح (ج.م)",
  bankReference: "مرجع التحويل البنكي",
  branchName: "الفرع",
  checkedAt: "وقت الفحص",
  collectedAt: "وقت التحصيل",
  collectionStatus: "حالة التحصيل",
  createdAt: "وقت الإنشاء",
  creditMinor: "دائن (ج.م)",
  debitMinor: "مدين (ج.م)",
  differenceMinor: "الفرق (ج.م)",
  entryType: "نوع القيد",
  effectiveAt: "وقت السريان",
  isBalanced: "القيد متوازن",
  journalEntryId: "مرجع القيد",
  ledgerBalanceMinor: "الرصيد الدفتري (ج.م)",
  organizationName: "الجهة",
  reason: "السبب",
  reference: "المرجع",
  reservedMinor: "الرصيد المحجوز (ج.م)",
  reversedBy: "القيد العكسي",
  sourceType: "مصدر القيد",
  status: "حالة المطابقة",
  updatedAt: "وقت آخر تحديث",
  unbalancedEntries: "قيود غير متوازنة (عدد)",
  overallocatedReceipts: "إيصالات تجاوز تخصيصها قيمتها (عدد)",
  overfundedTopups: "طلبات شحن تجاوز تخصيصها المبلغ المطلوب (عدد)",
  mismatchedSubscriptionCollections: "فروق تحصيل الاشتراكات (عدد)",
  negativeOrOverreservedAccounts: "حسابات سالبة أو محجوزة بأكثر من الرصيد (عدد)",
  autoRepairPerformed: "تم إصلاح آلي",
};

export const financeMetricCountKeys = new Set([
  "unbalancedEntries",
  "overallocatedReceipts",
  "overfundedTopups",
  "mismatchedSubscriptionCollections",
  "negativeOrOverreservedAccounts",
]);

export function financeMetricKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export function getFinanceMetricLabel(key: string): string | null {
  return financeMetricLabels[financeMetricKey(key)] ?? null;
}
