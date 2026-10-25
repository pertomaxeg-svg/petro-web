import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareServiceSettlement } from './prepare.mjs';

const proof = { valid: true, locked: false, verificationId: '550e8400-e29b-41d4-a716-446655440000', expiresAt: '2026-10-24T12:02:00Z', branchId: 'merchant-branch', vehicleId: 'vehicle-1', serviceGroup: 'fuel' };
const operation = { serviceGroup: 'fuel', branchId: 'merchant-branch', vehicleId: 'vehicle-1', companyOrganizationId: 'org-1', amountMinor: 10000 };
const accounts = { currency: 'EGP', companyOrganizationId: 'org-1', merchantBranchId: 'merchant-branch', companyAccountKind: 'company_funding', merchantAccountKind: 'merchant_payable', companyAccountId: 'company-1', merchantAccountId: 'merchant-1' };
const base = { operationId: 'op-1', proof, operation, accounts, now: '2026-10-24T12:00:00Z' };

test('prepares the full merchant payable but never posts it', () => {
  const plan = prepareServiceSettlement(base);
  assert.equal(plan.status, 'preflight_only');
  assert.equal(plan.lines.length, 2);
  assert.deepEqual(plan.lines.map(({ side, amountMinor }) => ({ side, amountMinor })), [
    { side: 'debit', amountMinor: 10000 },
    { side: 'credit', amountMinor: 10000 },
  ]);
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
  ['wrong company account kind', { accounts: { ...accounts, companyAccountKind: 'other' } }],
  ['wrong merchant account kind', { accounts: { ...accounts, merchantAccountKind: 'platform_revenue' } }],
  ['partial merchant share', { operation: { ...operation, stationShareMinor: 9000 } }],
  ['missing company organization', { operation: { ...operation, companyOrganizationId: '' } }],
  ['bad amount', { operation: { ...operation, amountMinor: -1 } }],
  ['missing operation', { operation: null }],
]) {
  test('fails closed for ' + label, () => {
    assert.throws(() => prepareServiceSettlement({ ...base, ...patch }));
  });
}
