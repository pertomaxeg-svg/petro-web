/** Pure settlement planner. No database writes. All amounts are integer piasters. */
export function planServiceSettlement({operationId,companyAccountId,merchantAccountId,amountMinor}) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId required');
  const accounts=[companyAccountId,merchantAccountId];
  if (accounts.some(id=>typeof id!=='string'||!id.trim()) || new Set(accounts).size!==2) throw new Error('Accounts must be distinct and present');
  if (!Number.isSafeInteger(amountMinor) || amountMinor<=0) throw new Error('Invalid amount in piasters');
  return {
    idempotencyKey:`service:${operationId}`,
    currency:'EGP',
    lines:[
      {accountId:companyAccountId,side:'debit',amountMinor},
      {accountId:merchantAccountId,side:'credit',amountMinor},
    ],
  };
}
