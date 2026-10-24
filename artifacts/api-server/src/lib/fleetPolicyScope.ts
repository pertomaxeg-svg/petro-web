type PolicyRow = Record<string, unknown>;

/** Select the published branch network in force at the requested vehicle start.
 * Missing or empty scope is never interpreted as unrestricted access. */
export function selectBranchMerchantScope(
  policies: PolicyRow[], organizationId: string, branchId: string, effectiveAt: number,
): { organizationIds: string[]; branchIds: string[] } | null {
  const policy = policies.filter(row => row.scope === "branch" && row.status === "published"
    && row.organizationId === organizationId && row.branchId === branchId
    && Date.parse(String(row.effectiveFrom)) <= effectiveAt)
    .sort((a, b) => Date.parse(String(b.effectiveFrom)) - Date.parse(String(a.effectiveFrom))
      || Number(b.version ?? 0) - Number(a.version ?? 0))[0];
  const organizations = policy?.allowedMerchantOrganizationIds;
  const branches = policy?.allowedMerchantBranchIds;
  if (!Array.isArray(organizations) || !organizations.length || !Array.isArray(branches) || !branches.length
      || ![...organizations, ...branches].every(value => typeof value === "string" && value.length > 0)) return null;
  return { organizationIds: [...organizations], branchIds: [...branches] };
}
