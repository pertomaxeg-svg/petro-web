import test from 'node:test';
import assert from 'node:assert/strict';
import { planServiceSettlement } from './plan.mjs';

const valid = {
  operationId: 'op-0001',
  companyAccountId: 'company-account',
  merchantAccountId: 'merchant-account',
  amountMinor: 10000,
};

test('moves the full EGP service amount from company funding to merchant payable', () => {
  const result = planServiceSettlement(valid);
  assert.equal(result.currency, 'EGP');
  assert.equal(result.idempotencyKey, 'service:op-0001');
  assert.deepEqual(result.lines, [
    { accountId: 'company-account', side: 'debit', amountMinor: 10000 },
    { accountId: 'merchant-account', side: 'credit', amountMinor: 10000 },
  ]);
});

for (const amount of [0, -1, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test('rejects invalid service amount ' + String(amount), () => {
    assert.throws(() => planServiceSettlement({ ...valid, amountMinor: amount }));
  });
}

test('rejects duplicate company and merchant account identities', () => {
  assert.throws(() => planServiceSettlement({ ...valid, merchantAccountId: valid.companyAccountId }));
});

test('rejects missing company or merchant account identity', () => {
  assert.throws(() => planServiceSettlement({ ...valid, merchantAccountId: '' }));
});

test('rejects missing operation ID', () => {
  assert.throws(() => planServiceSettlement({ ...valid, operationId: ' ' }));
});

test('is deterministic for the same operation', () => {
  assert.deepEqual(planServiceSettlement(valid), planServiceSettlement(valid));
});
