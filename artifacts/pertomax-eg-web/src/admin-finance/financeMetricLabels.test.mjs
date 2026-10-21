import assert from "node:assert/strict";
import test from "node:test";
import {
  financeMetricCountKeys,
  getFinanceMetricLabel,
} from "./financeMetricLabels.ts";

const reconciliationFields = [
  "status",
  "unbalancedEntries",
  "overallocatedReceipts",
  "overfundedTopups",
  "mismatchedSubscriptionCollections",
  "negativeOrOverreservedAccounts",
  "autoRepairPerformed",
  "checkedAt",
];

test("every reconciliation field returned by the finance RPC has an Arabic label", () => {
  for (const field of reconciliationFields) {
    assert.ok(getFinanceMetricLabel(field), `missing Arabic label for ${field}`);
  }
});

test("snake_case fields normalize and count metrics are not treated as currency", () => {
  assert.equal(getFinanceMetricLabel("unbalanced_entries"), "قيود غير متوازنة (عدد)");
  assert.ok(financeMetricCountKeys.has("unbalancedEntries"));
});

test("unknown finance fields are explicitly unknown, not presented as extra details", () => {
  assert.equal(getFinanceMetricLabel("unreviewedMysteryMetric"), null);
});
