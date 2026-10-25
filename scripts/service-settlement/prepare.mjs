import { planServiceSettlement } from './plan.mjs';

/**
 * Preflight only. Never authorizes or posts funds.
 * The database MUST revalidate proof, balances, assignment and pricing
 * inside the same atomic transaction that captures/posts the service.
 */
export function prepareServiceSettlement({ operationId, proof, operation, accounts, now = new Date() }) {
  if (!proof || proof.valid !== true || proof.locked === true) throw new Error('PIN_PROOF_INVALID');
  if (typeof proof.verificationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(proof.verificationId))
    throw new Error('PIN_PROOF_ID_INVALID');
  const expiresAt = new Date(proof.expiresAt);
  const timestamp = new Date(now);
  if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(timestamp.getTime()) ||
      expiresAt <= timestamp) throw new Error('PIN_PROOF_EXPIRED');
  if (!operation || typeof operation !== 'object') throw new Error('OPERATION_REQUIRED');
  if (!['fuel', 'wash', 'service', 'parts'].includes(operation.serviceGroup))
    throw new Error('UNSUPPORTED_SERVICE_GROUP');
  if (typeof operation.branchId !== 'string' || !operation.branchId.trim() ||
      typeof operation.vehicleId !== 'string' || !operation.vehicleId.trim() ||
      typeof operation.companyOrganizationId !== 'string' || !operation.companyOrganizationId.trim())
    throw new Error('OPERATION_SCOPE_REQUIRED');
  if (proof.branchId && proof.branchId !== operation.branchId) throw new Error('BRANCH_MISMATCH');
  if (proof.serviceGroup && proof.serviceGroup !== operation.serviceGroup) throw new Error('SERVICE_GROUP_MISMATCH');
  if (proof.vehicleId && proof.vehicleId !== operation.vehicleId) throw new Error('VEHICLE_MISMATCH');
  if (!accounts || accounts.currency !== 'EGP' ||
      accounts.companyOrganizationId !== operation.companyOrganizationId ||
      accounts.merchantBranchId !== operation.branchId)
    throw new Error('ACCOUNT_SCOPE_MISMATCH');
  if (!['company_funding','branch_funding'].includes(accounts.companyAccountKind) ||
      accounts.merchantAccountKind !== 'merchant_payable')
    throw new Error('ACCOUNT_TYPE_MISMATCH');
  if (operation.stationShareMinor !== undefined && operation.stationShareMinor !== operation.amountMinor)
    throw new Error('SERVICE_COMMISSION_NOT_ALLOWED');
  const plan = planServiceSettlement({
    operationId,
    companyAccountId: accounts.companyAccountId,
    merchantAccountId: accounts.merchantAccountId,
    amountMinor: operation.amountMinor,
  });
  return {
    ...plan,
    proofId: proof.verificationId,
    branchId: operation.branchId,
    vehicleId: operation.vehicleId,
    serviceGroup: operation.serviceGroup,
    expiresAt: proof.expiresAt,
    status: 'preflight_only',
  };
}
