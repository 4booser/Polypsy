import type { Survey, UiKey } from "@quizzy/shared";

/** Права на текст методики словом; «не з’ясовано» — отдельно, янтарём */
export const RIGHTS_KEY: Record<Exclude<NonNullable<Survey["rightsStatus"]>, "unclear">, UiKey> = {
  own: "mc.rightsOwn",
  licensed: "mc.rightsLicensed",
  public_domain: "mc.rightsPublic",
};

/** Слово прав или null, если права не выяснены */
export function rightsKey(status: Survey["rightsStatus"]): UiKey | null {
  return status && status !== "unclear" ? RIGHTS_KEY[status] : null;
}
