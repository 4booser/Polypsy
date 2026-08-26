import type { CreateSurveyDraft } from "@quizzy/shared";

/**
 * SAD PERSONS Scale (Patterson et al., 1983).
 * Источник: Психологічна оцінка суїцидального ризику у військовослужбовців. —
 * К.: НДЦ ГП ЗСУ, 2019. — С. 45–46.
 *
 * Заполняется специалистом, а не респондентом: часть пунктов требует
 * клинической оценки (нарушения мышления, наличие плана).
 *
 * Показывает две вещи, которых раньше не было:
 *   • administration: "clinician" — методику заполняет клиницист;
 *   • полоса несёт клиническую рекомендацию вплоть до обязательной госпитализации.
 */

const FACTORS: { code: string; uk: string; ru: string; help?: { uk: string; ru: string } }[] = [
  {
    code: "S",
    uk: "Sex — чоловіча стать",
    ru: "Sex — мужской пол",
    help: { uk: "1 — чоловік, 0 — жінка", ru: "1 — мужчина, 0 — женщина" },
  },
  {
    code: "A",
    uk: "Age — вік до 20 або понад 45 років",
    ru: "Age — возраст до 20 или старше 45 лет",
  },
  { code: "D", uk: "Depression — депресія", ru: "Depression — депрессия" },
  {
    code: "P",
    uk: "Previous attempt — парасуїциди в анамнезі",
    ru: "Previous attempt — парасуициды в анамнезе",
  },
  { code: "E", uk: "Ethanol abuse — зловживання алкоголем", ru: "Ethanol abuse — злоупотребление алкоголем" },
  {
    code: "R",
    uk: "Rational thinking loss — порушення раціонального мислення",
    ru: "Rational thinking loss — нарушение рационального мышления",
    help: {
      uk: "Шизофренія, розлад настрою, когнітивні порушення",
      ru: "Шизофрения, расстройство настроения, когнитивные нарушения",
    },
  },
  {
    code: "So",
    uk: "Social support lacking — відсутність соціальної підтримки",
    ru: "Social support lacking — отсутствие социальной поддержки",
  },
  {
    code: "O",
    uk: "Organized plan — наявність продуманого плану",
    ru: "Organized plan — наличие продуманного плана",
  },
  { code: "N", uk: "No spouse — відсутність партнера", ru: "No spouse — отсутствие партнёра" },
  { code: "Si", uk: "Sickness — соматичне захворювання", ru: "Sickness — соматическое заболевание" },
];

/** Пункты, наличие которых само по себе требует немедленного внимания */
const CRITICAL = new Set(["P", "O"]);

export const sadPersons: CreateSurveyDraft = {
  title: { uk: "Шкала оцінки ризику суїциду (SAD PERSONS)", ru: "Шкала оценки риска суицида (SAD PERSONS)" },
  description: {
    uk: "Контрольний перелік із 10 факторів ризику, оцінюваних клініцистом",
    ru: "Контрольный перечень из 10 факторов риска, оцениваемых клиницистом",
  },
  instructions: {
    uk: "Заповнює фахівець за результатами обстеження. Кожен фактор оцінюється як наявний (1) або відсутній (0).",
    ru: "Заполняет специалист по результатам обследования. Каждый фактор оценивается как имеющийся (1) или отсутствующий (0).",
  },
  administration: "clinician",
  scoringEnabled: true,
  allowRetake: true,
  visibility: "restricted",
  sections: [],

  questions: FACTORS.map((f) => ({
    type: "yesno" as const,
    title: { uk: f.uk, ru: f.ru },
    ...(f.help ? { help: f.help } : {}),
    required: true,
    options: [
      {
        text: { uk: "Наявний", ru: "Имеется" },
        keyCode: "yes",
        ...(CRITICAL.has(f.code)
          ? {
              riskFlag: true,
              riskSeverity: "severe" as const,
              riskLabel: {
                uk: `SAD PERSONS: ${f.uk}`,
                ru: `SAD PERSONS: ${f.ru}`,
              },
            }
          : {}),
      },
      { text: { uk: "Відсутній", ru: "Отсутствует" }, keyCode: "no" },
    ],
  })),

  scales: [
    {
      code: "SP",
      title: { uk: "Сумарний ризик суїциду", ru: "Суммарный риск суицида" },
      kind: "clinical",
      normalization: "raw",
      key: FACTORS.map((_, i) => ({ item: i + 1, matchKey: "yes" })),
      bands: [
        {
          minScore: 0,
          maxScore: 2,
          label: { uk: "Низький ризик", ru: "Низкий риск" },
          severity: "none",
          grade: 1,
          recommendation: {
            uk: "Можливе амбулаторне спостереження",
            ru: "Возможно амбулаторное наблюдение",
          },
        },
        {
          minScore: 3,
          maxScore: 4,
          label: { uk: "Середній ризик", ru: "Средний риск" },
          severity: "moderate",
          grade: 2,
          recommendation: {
            uk: "Зустрічі 1–3 рази на тиждень або розгляд можливості госпіталізації",
            ru: "Встречи 1–3 раза в неделю либо рассмотрение возможности госпитализации",
          },
        },
        {
          minScore: 5,
          maxScore: 6,
          label: { uk: "Високий ризик", ru: "Высокий риск" },
          severity: "severe",
          grade: 3,
          recommendation: {
            uk: "Госпіталізація, якщо немає впевненості в якісному амбулаторному спостереженні",
            ru: "Госпитализация, если нет уверенности в качественном амбулаторном наблюдении",
          },
        },
        {
          minScore: 7,
          maxScore: 10,
          label: { uk: "Дуже високий ризик", ru: "Очень высокий риск" },
          severity: "severe",
          grade: 4,
          recommendation: {
            uk: "Обов’язкова госпіталізація, у тому числі примусова",
            ru: "Обязательная госпитализация, в том числе принудительная",
          },
        },
      ],
    },
  ],
};
