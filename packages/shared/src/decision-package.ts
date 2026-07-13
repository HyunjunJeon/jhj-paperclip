/**
 * Stage 1 package-bearing predicate (C1 / remediation plan).
 * An interaction is package-bearing iff its payload has a non-null object
 * under the nested `decisionPackage` key.
 */
export function isPackageBearingPayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const dp = (payload as Record<string, unknown>).decisionPackage;
  return dp != null && typeof dp === "object" && !Array.isArray(dp);
}
