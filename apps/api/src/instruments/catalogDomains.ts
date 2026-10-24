import type { SurveyDomain } from "@quizzy/shared";

/**
 * Направление каждой методики — по устойчивому ключу (ключ записи CATALOG в
 * ./catalog.ts; у четырёх встроенных — их имя в листах сверки).
 *
 * Картой, а не полем черновика методики. Черновик — содержимое: от него
 * считается отпечаток редакции (lib/catalogInstall.ts, fingerprint), и
 * направление внутри черновика выпустило бы новую версию у каждой
 * методики, которой его проставили, — с теми же пунктами и тем же ключом.
 * Направление же — настройка строки: установщик пишет его без версии, а
 * правку учреждения сохраняет (localFields / mergeFields). Черновики каталога
 * поля `domain` поэтому не несут — это проверяет
 * instruments/__tests__/catalogDomains.test.ts вместе с тем, что у каждой
 * записи CATALOG направление есть.
 *
 * ── Куда добавлять ключ ──
 * Новая методика каталога — строкой в блок своего направления ниже. Без
 * строки установщик поставит её без направления, а тест каталога упадёт с её
 * ключом. Один ключ — одно направление: методика, которая меряет и то и
 * другое (DASS-42, PHQ-4), стоит там, где её назначают чаще.
 *
 * Отнесение спорных — решение, которое должен подтвердить клинический
 * психолог: PQ-16 (риск психоза) — в «Інше», а не в дистресс; ASRS-v1.1
 * (СДУГ) — в когнитивные функции как внимание; WHO-5, Розенберг, UCLA-3 и
 * Brief COPE — в ресурсы, а не в настроение. Из каталога 2.1: AAQ-II и PSS-4 —
 * в дистресс, MIOS (моральная травма) — в травму, FAS (утомление) — в сон,
 * самосострадание (SCS-SF) и осознанность (MAAS) — в ресурсы, AQ-10 — в «Інше».
 */
export const CATALOG_DOMAINS: Readonly<Record<string, SurveyDomain>> = {
  /* ── distress: настроение, тревога, дистресс ── */
  phq9: "distress",
  gad7: "distress",
  pss10: "distress",
  phq4: "distress",
  phq8: "distress",
  cesdr: "distress",
  srq20: "distress",
  gds15: "distress",
  dass42: "distress",
  dass21: "distress",
  k10: "distress",
  k6: "distress",
  phq15: "distress",
  phq2: "distress",
  gad2: "distress",
  core10: "distress",
  pss4: "distress",
  aaq2: "distress",

  /* ── trauma ── */
  pcl5: "trauma",
  pcptsd5: "trauma",
  ces: "trauma",
  mios: "trauma",
  itq: "trauma",
  tgi_sr_plus: "trauma",
  ctsr_ua: "trauma",
  lec5: "trauma",

  /* ── suicide ── */
  sbqr: "suicide",
  sr45: "suicide",
  "sad-persons": "suicide",
  asq: "suicide",
  cssrs: "suicide",
  sidas: "suicide",

  /* ── sleep ── */
  sci: "sleep",
  sci02: "sleep",
  ris: "sleep",
  fas: "sleep",

  /* ── addiction ── */
  audit: "addiction",
  auditc: "addiction",
  cage: "addiction",
  assist: "addiction",
  cuditr: "addiction",
  ciwaar: "addiction",
  cows: "addiction",

  /* ── wellbeing: ресурсы и качество жизни ── */
  who5: "wellbeing",
  mspss: "wellbeing",
  osss3: "wellbeing",
  rses: "wellbeing",
  ucla3: "wellbeing",
  brief_cope: "wellbeing",
  swls: "wellbeing",
  flourishing: "wellbeing",
  spane: "wellbeing",
  mlq: "wellbeing",
  scs_sf: "wellbeing",
  maas: "wellbeing",

  /* ── cognitive ── */
  asrs6: "cognitive",
  "4at": "cognitive",
  adexi: "cognitive",

  /* ── personality ── */
  "big-five": "personality",
  minimult: "personality",
  mlo: "personality",
  tipi: "personality",

  /* ── staff: персонал ── */
  cbi: "staff",
  bat: "staff",
  bat12: "staff",
  proqol5: "staff",

  /* ── other ── */
  pq16: "other",
  aq10: "other",
};

/**
 * Встроенные методики: их ставит только демонстрационный посев (seed.ts), а
 * не установщик каталога, — направление им проставляет посев по той же
 * карте. Перечнем здесь, чтобы проверка карты знала, какие ключи вне CATALOG
 * законны.
 */
export const BUILTIN_KEYS = ["sr45", "sad-persons", "minimult", "mlo"] as const;

/** Направление методики по ключу; null — ключа в карте нет (своё свойство, а не унаследованное от Object) */
export function catalogDomain(key: string): SurveyDomain | null {
  return Object.hasOwn(CATALOG_DOMAINS, key) ? (CATALOG_DOMAINS[key] ?? null) : null;
}
