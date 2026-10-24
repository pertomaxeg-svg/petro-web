import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareServiceSettlement } from './prepare.mjs';

const proof = { valid: true, locked: false, verificationId: '550e8400-e29b-41d4-a716-446655440000', expiresAt: '2026-10-24T12:02:00Z', branchId: 'merchant-branch', vehicleId: 'vehicle-1', serviceGroup: 'fuel' };
const operation = { serviceGroup: 'fuel', branchId: 'merchant-branch', vehicleId: 'vehicle-1', companyOrganizationId: 'org-1', amountMinor: 10000, stationShareMinor: 9000 };
const accounts = { currency: 'EGP', companyOrganizationId: 'org-1', merchantBranchId: 'merchant-branch', companyAccountKind: 'company_funding', stationAccountKind: 'merchant_payable', platformAccountKind: 'platform_revenue', companyAccountId: 'company-1', stationAccountId: 'merchant-1', platformAccountId: 'platform-1' };
const base = { operationId: 'op-1', proof, operation, accounts, now: '2026-10-24T12:00:00Z' };

test('prepares balanced settlement but never posts it', () => {
  const plan = prepareServiceSettlement(base);
  assert.equal(plan.status, 'preflight_only');
  assert.equal(plan.lines.length, 3);
  assert.equal(plan.lines[0].amountMinor, 10000);
  assert.equal(plan.lines[1].amountMinor, 9000);
  assert.equal(plan.lines[2].amountMinor, 1000);
  assert.equal(plan.proofId, proof.verificationId);
});

for (const [label, patch] of [
  ['missing proof', { proof: null }],
  ['invalid PIN', { proof: { ...proof, valid: false } }],
  ['expired PIN', { now: '2026-10-24T12:02:00Z' }],
  ['invalid expiry', { proof: { ...proof, expiresAt: 'not-a-date' } }],
  ['wrong branch', { operation: { ...operation, branchId: 'wrong' } }],
  ['wrong vehicle', { operation: { ...operation, vehicleId: 'wrong' } }],
  ['wrong service group', { operation: { ...operation, serviceGroup: 'wash' } }],
  ['wrong organization', { accounts: { ...accounts, companyOrganizationId: 'other' } }],
  ['wrong merchant branch', { accounts: { ...accounts, merchantBranchId: 'other' } }],
  ['wrong currency', { accounts: { ...accounts, currency: 'USD' } }],
  ['wrong account kind', { accounts: { ...accounts, companyAccountKind: 'other' } }],
  ['bad amount', { operation: { ...operation, amountMinor: -1 } }],
  ['missing operation', { operation: null }],
]) {
  test('fails closed for ' + label, () => {
    assert.throws(() => prepareServiceSettlement({ ...base, ...patch }));
  });
}
