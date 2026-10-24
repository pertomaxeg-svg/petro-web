import test from 'node:test';
import assert from 'node:assert/strict';
import { planServiceSettlement } from './plan.mjs';

const valid = {
  operationId: 'op-0001',
  companyAccountId: 'company-account',
  stationAccountId: 'station-account',
  platformAccountId: 'platform-account',
  amountMinor: 10000,
  stationShareMinor: 8500,
};

test('posts an exact balanced EGP settlement', () => {
  const result = planServiceSettlement(valid);
  assert.equal(result.currency, 'EGP');
  assert.equal(result.idempotencyKey, 'service:op-0001');
  assert.deepEqual(result.lines, [
    { accountId: 'company-account', side: 'debit', amountMinor: 10000 },
    { accountId: 'station-account', side: 'credit', amountMinor: 8500 },
    { accountId: 'platform-account', side: 'credit', amountMinor: 1500 },
  ]);
});

test('supports a 100% station share without zero-value lines', () => {
  assert.deepEqual(planServiceSettlement({ ...valid, stationShareMinor: 10000 }).lines.map(x => x.amountMinor), [10000, 10000]);
});

test('supports a zero station share without zero-value lines', () => {
  assert.deepEqual(planServiceSettlement({ ...valid, stationShareMinor: 0 }).lines.map(x => x.amountMinor), [10000, 10000]);
});

for (const amount of [0, -1, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test('rejects invalid service amount ' + String(amount), () => {
    assert.throws(() => planServiceSettlement({ ...valid, amountMinor: amount }));
  });
}

for (const share of [-1, 10001, 12.5, NaN, Infinity]) {
  test('rejects invalid station share ' + String(share), () => {
    assert.throws(() => planServiceSettlement({ ...valid, stationShareMinor: share }));
  });
}

test('rejects duplicate account identities', () => {
  assert.throws(() => planServiceSettlement({ ...valid, stationAccountId: valid.companyAccountId }));
});

test('rejects missing operation ID', () => {
  assert.throws(() => planServiceSettlement({ ...valid, operationId: ' ' }));
});

test('is deterministic for the same operation', () => {
  assert.deepEqual(planServiceSettlement(valid), planServiceSettlement(valid));
});
