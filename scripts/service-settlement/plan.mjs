/** Pure settlement planner. No database writes. All amounts are integer piasters. */
export function planServiceSettlement({operationId,companyAccountId,stationAccountId,platformAccountId,amountMinor,stationShareMinor}) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId required');
  const accounts=[companyAccountId,stationAccountId,platformAccountId];
  if (accounts.some(id=>typeof id!=='string'||!id.trim()) || new Set(accounts).size!==3) throw new Error('Accounts must be distinct and present');
  if (![amountMinor,stationShareMinor].every(Number.isSafeInteger) || amountMinor<=0 || stationShareMinor<0 || stationShareMinor>amountMinor) throw new Error('Invalid amount in piasters');
  const platformShareMinor=amountMinor-stationShareMinor;
  const lines=[{accountId:companyAccountId,side:'debit',amountMinor}];
  if(stationShareMinor) lines.push({accountId:stationAccountId,side:'credit',amountMinor:stationShareMinor});
  if(platformShareMinor) lines.push({accountId:platformAccountId,side:'credit',amountMinor:platformShareMinor});
  const debit=lines.filter(x=>x.side==='debit').reduce((a,x)=>a+x.amountMinor,0);
  const credit=lines.filter(x=>x.side==='credit').reduce((a,x)=>a+x.amountMinor,0);
  if(debit!==credit) throw new Error('Unbalanced journal');
  return {idempotencyKey:`service:${operationId}`,currency:'EGP',lines};
}
