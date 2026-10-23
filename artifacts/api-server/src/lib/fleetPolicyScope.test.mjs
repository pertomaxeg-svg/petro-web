import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBranchMerchantScope } from './fleetPolicyScope.ts';
const policy = { scope: 'branch', status: 'published', organizationId: 'company', branchId: 'branch', effectiveFrom: '2026-01-01T00:00:00Z', version: 1, allowedMerchantOrganizationIds: ['merchant'], allowedMerchantBranchIds: ['service-point'] };
const select = rows => selectBranchMerchantScope(rows, 'company', 'branch', Date.parse('2026-10-23T00:00:00Z'));
test('inherits only a published network of the selected company and branch', () => {
  assert.deepEqual(select([policy]), { organizationIds: ['merchant'], branchIds: ['service-point'] });
  for (const change of [{organizationId: 'other'}, {branchId: 'other'}, {scope: 'vehicle'}, {status: 'draft'}, {effectiveFrom: '2027-01-01T00:00:00Z'}]) assert.equal(select([{...policy, ...change}]), null);
});
test('newest effective policy replaces older scopes without merging access', () => {
  assert.deepEqual(select([policy, {...policy, version: 2, effectiveFrom: '2026-10-22T00:00:00Z', allowedMerchantBranchIds: ['new-point']}]).branchIds, ['new-point']);
});
test('missing or empty latest policy fails closed rather than reviving old access', () => {
  assert.equal(select([]), null);
  assert.equal(select([policy, {...policy, version: 2, effectiveFrom: '2026-10-22T00:00:00Z', allowedMerchantBranchIds: []}]), null);
});
