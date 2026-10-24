import type { Survey, SurveyDomain, UiKey } from "@quizzy/shared";

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

/**
 * Направление методики словом (packages/shared/src/domains.ts): чипы каталога,
 * строка, паспорт методики, конструктор. Запись на каждое направление — тип
 * не даст завести направление без подписи.
 */
export const DOMAIN_KEY: Record<SurveyDomain, UiKey> = {
  distress: "dom.distress",
  trauma: "dom.trauma",
  suicide: "dom.suicide",
  sleep: "dom.sleep",
  addiction: "dom.addiction",
  wellbeing: "dom.wellbeing",
  cognitive: "dom.cognitive",
  personality: "dom.personality",
  staff: "dom.staff",
  other: "dom.other",
};

/** Ключ подписи направления или null — направление не выбрано */
export function domainKey(domain: Survey["domain"]): UiKey | null {
  return domain ? DOMAIN_KEY[domain] : null;
}
