import type { CreateSurveyDraft } from "@quizzy/shared";
import { L, PUBLIC_DEFAULTS, bands, item, sumKey, WORKING_TRANSLATION } from "./common";
import { SCI_EXTENT, SCI_NIGHTS, SCI_NIGHTS_ITEM, SCI_TROUBLED_ITEM } from "./sci";

/**
 * SCI-02 — двухпунктовая версия Sleep Condition Indicator
 * (Luik A.I., Machado P.F., Siriwardena N., Espie C.A., Br J Gen Pract
 * 2019;69(679):79-80; пункты выделены в Espie и соавт., BMJ Open 2014).
 * Досье: docs/instruments/dossiers/sleep.json, карточка `sci02`.
 *
 * Два пункта полной SCI — без изменений: «… troubled you in general» (пункт 7
 * SCI) и «… how many nights a week do you have a problem with your sleep?»
 * (пункт 3), в порядке Table 1 письма: сначала «troubled», потом «nights».
 * Тексты и варианты — общие константы sci.ts, а не копия. Лицензия та же,
 * что у SCI: права на пункты у Sleepio (Big Health), бесплатно для
 * некоммерческого использования по CC BY-NC 4.0.
 *
 * Больше — лучше (0–8), как у полной SCI. Порог — дословно из письма: «with a
 * SCI-02 score of 2 or less indicating insomnia»; «A cut-off of ≤2 for the
 * SCI-02 predicted those identified with probable insomnia according to the
 * full SCI, with a specificity of 81% and sensitivity of 80%». То есть это
 * фильтр к полной SCI, а не к диагнозу, — и рекомендация положительной полосы
 * отправляет к полной методике, как у PHQ-4. Выборка — 190 000 пользователей
 * Sleepio онлайн; авторы сами предупреждают о самоотборе.
 *
 * severity положительной полосы — "mild", как у SCI: случая не открывает.
 * Результат человеку показывается — по той же причине, что у SCI.
 */
export const sci02: CreateSurveyDraft = {
  ...PUBLIC_DEFAULTS,
  title: L("Безсоння: коротко (SCI-02)", "Бессонница: кратко (SCI-02)"),
  description: L(
    "Два запитання про сон за останній місяць.",
    "Два вопроса о сне за последний месяц.",
  ),
  instructions: L(
    "Два запитання про ваш сон за ОСТАННІЙ МІСЯЦЬ. Оберіть варіант, який найточніше описує ваш стан.",
    "Два вопроса о вашем сне за ПОСЛЕДНИЙ МЕСЯЦ. Выберите вариант, который точнее всего описывает ваше состояние.",
  ),
  showResultsToPatient: true,
  sections: [],

  questions: [item(SCI_TROUBLED_ITEM, "SCI02", SCI_EXTENT), item(SCI_NIGHTS_ITEM, "SCI02", SCI_NIGHTS)],

  scales: [
    {
      code: "SCI02",
      title: L("Стан сну, коротко", "Состояние сна, кратко"),
      description: L(
        "Сума 2 пунктів, 0–8: більший бал — кращий сон. Поріг ≤2 — ймовірне безсоння за повною SCI.",
        "Сумма 2 пунктов, 0–8: больший балл — лучший сон. Порог ≤2 — вероятная бессонница по полной SCI.",
      ),
      kind: "clinical",
      normalization: "raw",
      key: sumKey([1, 2]),
      bands: bands([
        {
          min: 0,
          max: 2,
          // как у SCI: меньший балл — хуже сон, поэтому «поріг досягнуто», а не «вище порога»
          label: L("Поріг досягнуто — ймовірне безсоння", "Порог достигнут — вероятная бессонница"),
          severity: "mild",
          grade: 1,
          recommendation: L(
            "Провести повну SCI (ще шість запитань) і клінічну оцінку сну",
            "Провести полную SCI (ещё шесть вопросов) и клиническую оценку сна",
          ),
        },
        {
          min: 3,
          max: 8,
          label: L("Поріг не досягнуто", "Порог не достигнут"),
          severity: "none",
          grade: 2,
        },
      ]),
    },
  ],
};

/**
 * Для персонала — «Джерело» в паспорте методики (surveys.source_note, ставит
 * установщик каталога): откуда текст и пороги, чего система не считает.
 * Описание выше читает обследуемый на первом экране — в нём этого нет.
 */
export const sci02Note = `Пункти 7 і 3 повної SCI без змін. Більший бал — кращий сон (0–8). Бал ≤2 — ймовірне безсоння за повною SCI (Luik та ін., 2019: онлайн-вибірка 190 000, чутливість 80 %, специфічність 81 %). Це фільтр: позитивний результат означає «пройти повну SCI», а не діагноз; українських норм немає. ${WORKING_TRANSLATION.uk}`;
