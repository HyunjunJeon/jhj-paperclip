export function isPackageBearingPayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object") {
    return false;
  }
  const p = payload as Record<string, unknown>;
  const reason = typeof p.reason === "string" ? p.reason.trim() : "";
  if (reason.length === 0) {
    return false;
  }
  return (
    p.optionLabels !== undefined ||
    p.resolverPolicy !== undefined ||
    p.requiredArtifacts !== undefined ||
    typeof p.estimatedHumanMinutes === "number" ||
    p.humanOnly === true
  );
}
