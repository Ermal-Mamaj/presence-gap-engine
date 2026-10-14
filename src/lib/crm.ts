export const CRM_STAGES = [
  "NEW",
  "QUALIFIED",
  "CONTACTED",
  "REPLIED",
  "CONVERTED",
  "DELIVERED",
  "RETAINED",
  "DEAD",
] as const;

export type CrmStageName = (typeof CRM_STAGES)[number];

// The happy path, in order. DEAD sits outside it.
const PIPELINE: CrmStageName[] = ["NEW", "QUALIFIED", "CONTACTED", "REPLIED", "CONVERTED", "DELIVERED", "RETAINED"];

// A dead lead can only be reopened at the start of the pipeline, so reviving
// one never skips past the qualification a human should redo.
const REOPEN_TARGETS: CrmStageName[] = ["NEW", "QUALIFIED"];

export function isCrmStage(value: unknown): value is CrmStageName {
  return typeof value === "string" && (CRM_STAGES as readonly string[]).includes(value);
}

/**
 * Forward moves may skip stages (a lead can go straight to CONTACTED), any
 * lead can be marked DEAD, and a single step back is allowed to correct a
 * mis-click. Anything else is rejected so history stays meaningful.
 */
export function canTransition(from: CrmStageName, to: CrmStageName): boolean {
  if (from === to) return true;
  if (to === "DEAD") return true;
  if (from === "DEAD") return REOPEN_TARGETS.includes(to);
  const fromIndex = PIPELINE.indexOf(from);
  const toIndex = PIPELINE.indexOf(to);
  return toIndex > fromIndex || toIndex === fromIndex - 1;
}
