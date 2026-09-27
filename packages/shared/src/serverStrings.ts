import type { Lang } from "./types";

/**
 * Тексты, которые собирает сервер или общий пакет.
 *
 * Четвёртый словарь рядом с UI, ERRORS и PUSH — и заведён по той же причине,
 * что два последних: текст складывается не там, где его показывают. Проблемы
 * методики в конструкторе, сравнение версий, печатные документы, подписи
 * выгрузки SPSS, вывод командной консоли собирает сервер; предупреждения
 * подсчёта и объяснения правил — движок общего пакета. Клиент получает их
 * готовой строкой и переводить не может: он не знает, из чего она сложена.
 *
 * Внешний разбор (волна 13) насчитал в этих модулях двести с лишним
 * литералов — и все по-русски, на любом языке интерфейса. Украинский
 * специалист печатал заключение со словами «Результаты по субшкалам», а
 * английский — выгружал словарь переменных с «Пол» и «мужской».
 *
 * Два рода текстов, и живут они по-разному:
 *
 *  - собранные на лету (проблемы методики, сравнение версий, печать,
 *    выгрузка, консоль) — собираются сразу на языке запроса, langOf(c);
 *
 *  - хранимые (предупреждения подсчёта, объяснения правил) — хранятся
 *    КОДОМ и подстановками (CodedText ниже), а текстом становятся при
 *    показе, на языке смотрящего. Иначе объяснение правила навсегда
 *    осталось бы на языке того, кто сдал методику, а читает его другой
 *    человек и в другой день.
 *
 *  - пометки, которые сервер пишет в текстовую колонку рядом с текстом
 *    человека (заметки версий, примечания доступа и назначений, итоги
 *    прогонов расписаний; волна 14) — встроенным кодом ⟦ключ{…}⟧ (noteCode
 *    ниже), тоже фразой при показе. Колонка остаётся текстом: в ней же
 *    лежит то, что набрал человек, и то, что записано до кодов.
 *
 * Подстановки — «{имя}», как в ERRORS и PUSH: форматирования сложнее
 * подстановки здесь нет. Все три языка обязательны с первого дня: тексты
 * эти сервер отдаёт готовыми, и непереведённая строка приезжала бы на
 * английский экран украинской, без всякой возможности это заметить на
 * клиенте. Полноту, подстановки и буквы держит
 * packages/shared/test/serverStrings.test.ts, литералы в самих модулях —
 * сторож apps/api/test/noRawStrings.test.ts.
 *
 * Термины английского — те же, что в ERRORS (методика — assessment, шкала —
 * scale, полоса — band, заключение — conclusion, специалист — clinician),
 * чтобы экран, отказ и распечатка не называли одно и то же по-разному.
 * Русские тексты перенесены из модулей дословно: сценарии e2e (локаль ru)
 * ищут их по словам, и перевод не должен был сдвинуть ни одного.
 */
export interface ServerTextEntry {
  uk: string;
  ru: string;
  en: string;
}

export const SERVER_TEXTS = {
  /* ── w13:srvi18n ── */

  /* ─── проблемы методики: packages/shared/src/validate.ts ─── */
  "val.where.scale": { uk: "Шкала {code}", ru: "Шкала {code}", en: "Scale {code}" },
  "val.where.scaleNoCode": { uk: "Шкала без коду", ru: "Шкала без кода", en: "Scale without a code" },
  "val.where.item": { uk: "Пункт {n}", ru: "Пункт {n}", en: "Item {n}" },
  /* ключ без ожидаемого варианта считает балл пункта — так он и назван в противоречии */
  "val.scoreMode": { uk: "бал", ru: "балл", en: "score" },
  "val.noCodes": { uk: "кодів немає", ru: "нет кодов", en: "no codes" },
  /*
   * «Повторяется {n} раза» в русском верно только для двух–четырёх; в
   * украинском фраза построена так, чтобы число не требовало согласования.
   * Русскую оставили как была — её ищут по словам.
   */
  "val.scaleCodeRepeated": {
    uk: "Той самий код мають кілька шкал ({n}) — коди мають бути унікальними",
    ru: "Код шкалы повторяется {n} раза — коды должны быть уникальны",
    en: "The scale code is used {n} times — codes must be unique",
  },
  "val.scaleCodeEmpty": {
    uk: "У шкали порожній код — на неї не можна послатися",
    ru: "У шкалы пустой код, на неё нельзя сослаться",
    en: "The scale has an empty code, so nothing can refer to it",
  },
  "val.tooFewOptions": {
    uk: "Тип «{type}» потребує щонайменше двох варіантів, а задано {n}",
    ru: "Тип «{type}» требует минимум двух вариантов, задано {n}",
    en: "Type “{type}” needs at least two options; {n} given",
  },
  "val.optionCodesRepeated": {
    uk: "Коди варіантів повторюються — ключ не зможе розрізнити відповіді",
    ru: "Коды вариантов повторяются — ключ не сможет отличить ответы",
    en: "Option codes repeat — the key can’t tell the answers apart",
  },
  "val.riskWithoutLabel": {
    uk: "Критичний варіант без тексту тривоги — персонал побачить лише текст пункту",
    ru: "Критический вариант без текста тревоги — персонал увидит текст пункта",
    en: "Critical option without alert text — staff will see the item wording instead",
  },
  "val.scaleUnlinked": {
    uk: "У шкали немає ні ключа, ні прив’язаних пунктів — вона завжди дасть нуль",
    ru: "У шкалы нет ни ключа, ни привязанных пунктов — она всегда даст ноль",
    en: "The scale has neither a key nor linked items — it will always score zero",
  },
  "val.keyItemOutOfRange": {
    uk: "У ключі пункт {item}, а в методиці їх {total}",
    ru: "В ключе пункт {item}, а в методике их {total}",
    en: "The key refers to item {item}, but the assessment has {total}",
  },
  "val.keyItemTwice": {
    uk: "Пункт {item} стоїть у ключі двічі",
    ru: "Пункт {item} указан в ключе дважды",
    en: "Item {item} appears in the key twice",
  },
  "val.keyContradiction": {
    uk: "Пункт {item} вимагає водночас «{a}» і «{b}» — суперечність у ключі",
    ru: "Пункт {item} требует одновременно «{a}» и «{b}» — противоречие в ключе",
    en: "Item {item} requires both “{a}” and “{b}” — the key contradicts itself",
  },
  "val.keyUnknownOption": {
    uk: "Пункт {item}: ключ чекає на варіант «{code}», а в пункту такі коди: {codes}",
    ru: "Пункт {item}: ключ ждёт вариант «{code}», а у пункта такие коды: {codes}",
    en: "Item {item}: the key expects option “{code}”, but the item’s codes are: {codes}",
  },
  "val.correctionUnknown": {
    uk: "Поправка посилається на шкалу «{from}», якої немає",
    ru: "Поправка ссылается на шкалу «{from}», которой нет",
    en: "A correction refers to scale “{from}”, which doesn’t exist",
  },
  "val.correctionSelf": {
    uk: "Шкала виправляє сама себе",
    ru: "Шкала поправляет саму себя",
    en: "The scale corrects itself",
  },
  "val.correctionMutual": {
    uk: "Взаємна поправка зі шкалою {other} — так рахувати не можна",
    ru: "Взаимная поправка со шкалой {other} — так считать нельзя",
    en: "Mutual correction with scale {other} — this can’t be scored",
  },
  "val.ratioNoDenominator": {
    uk: "Частка без знаменника — буде взято максимум за ключем, а в методиці він може бути іншим",
    ru: "Доля без знаменателя — будет взят максимум по ключу, а в методике он может быть другим",
    en: "Proportion without a denominator — the key’s maximum will be used, and the manual may give a different one",
  },
  "val.tscoreNoNorms": {
    uk: "T-бали без норм: сирий бал нема в що перевести",
    ru: "T-баллы без норм: перевести сырой балл не во что",
    en: "T-scores without norms: there is nothing to convert the raw score with",
  },
  "val.stenNoTable": {
    uk: "Стени без таблиці переведення",
    ru: "Стены без таблицы перевода",
    en: "Stens without a conversion table",
  },
  "val.stenTableUnused": {
    uk: "Задано таблицю стенів, але нормування інше — таблиця не застосується",
    ru: "Задана таблица стенов, но нормирование другое — таблица не применится",
    en: "A sten table is set, but the normalisation is different — the table won’t apply",
  },
  "val.normsUnused": {
    uk: "Задано норми, але нормування не T-бали — норми не застосуються",
    ru: "Заданы нормы, но нормирование не T-баллы — нормы не применятся",
    en: "Norms are set, but the normalisation isn’t T-scores — the norms won’t apply",
  },
  "val.normSdNotPositive": {
    uk: "Стандартне відхилення в нормі має бути більшим за нуль",
    ru: "Стандартное отклонение в норме должно быть больше нуля",
    en: "The standard deviation in a norm must be greater than zero",
  },
  "val.validityNoThreshold": {
    uk: "Шкала достовірності без порогу — перевірка не спрацює. Це законно, якщо шкала потрібна лише для поправок",
    ru: "Шкала достоверности без порога — гейт не сработает. Это законно, если шкала нужна только для поправок",
    en: "Validity scale without a threshold — the check won’t trigger. That’s fine if the scale is only used for corrections",
  },
  "val.validityNoDirection": {
    uk: "Для порогу достовірності не вказано, з якого боку він порушується",
    ru: "У порога достоверности не указано, с какой стороны он нарушается",
    en: "The validity threshold doesn’t say which side counts as a breach",
  },
  "val.bandInverted": {
    uk: "Норма «{label}»: верхня межа нижча за нижню",
    ru: "Норма «{label}»: верхняя граница ниже нижней",
    en: "Band “{label}”: the upper bound is below the lower one",
  },
  "val.bandsOverlap": {
    uk: "Норми «{a}» і «{b}» перетинаються: результат залежав би від порядку",
    ru: "Нормы «{a}» и «{b}» пересекаются: результат зависел бы от порядка",
    en: "Bands “{a}” and “{b}” overlap: the result would depend on their order",
  },
  "val.clinicalNoBands": {
    uk: "У змістовної шкали немає норм — бал буде без інтерпретації",
    ru: "У содержательной шкалы нет норм — балл будет без интерпретации",
    en: "The clinical scale has no bands — the score will have no interpretation",
  },
  "val.stenRowsOverlap": {
    uk: "Рядки стенів {a} і {b} перетинаються за сирим балом",
    ru: "Строки стенов {a} и {b} пересекаются по сырому баллу",
    en: "Sten rows {a} and {b} overlap in raw score",
  },
  "val.stenGapAtZero": {
    uk: "Таблиця стенів починається з {min}: нульовий бал нікуди не потрапить",
    ru: "Таблица стенов начинается с {min}: нулевой балл никуда не попадёт",
    en: "The sten table starts at {min}: a raw score of zero falls nowhere",
  },

  /* ─── сравнение версий: packages/shared/src/versionDiff.ts ─── */
  "diff.field.wording": { uk: "формулювання", ru: "формулировка", en: "wording" },
  "diff.field.help": { uk: "пояснення", ru: "пояснение", en: "help text" },
  "diff.field.type": { uk: "тип", ru: "тип", en: "type" },
  "diff.field.required": { uk: "обов’язковість", ru: "обязательность", en: "required" },
  "diff.field.reverse": { uk: "зворотний ключ", ru: "обратный ключ", en: "reverse scoring" },
  "diff.field.scale": { uk: "шкала", ru: "шкала", en: "scale" },
  "diff.field.options": { uk: "варіанти відповіді", ru: "варианты ответа", en: "answer options" },
  "diff.field.order": { uk: "порядок", ru: "порядок", en: "order" },
  "diff.field.title": { uk: "назва", ru: "название", en: "title" },
  "diff.field.description": { uk: "опис", ru: "описание", en: "description" },
  "diff.field.aggregation": { uk: "підрахунок", ru: "подсчёт", en: "aggregation" },
  "diff.field.normalization": { uk: "нормування", ru: "нормирование", en: "normalisation" },
  "diff.field.denominator": { uk: "знаменник частки", ru: "знаменатель доли", en: "proportion denominator" },
  "diff.field.key": { uk: "ключ", ru: "ключ", en: "key" },
  "diff.field.bands": { uk: "смуги інтерпретації", ru: "полосы интерпретации", en: "interpretation bands" },
  "diff.field.validity": { uk: "поріг достовірності", ru: "порог достоверности", en: "validity threshold" },
  "diff.field.corrections": { uk: "поправки", ru: "поправки", en: "corrections" },
  "diff.removedItems": { uk: "прибрано пунктів: {n}", ru: "убрано пунктов: {n}", en: "items removed: {n}" },
  "diff.addedItems": { uk: "додано пунктів: {n}", ru: "добавлено пунктов: {n}", en: "items added: {n}" },
  "diff.scoringItems": {
    uk: "пунктів із правкою, що впливає на бал: {n}",
    ru: "пунктов с правкой, влияющей на балл: {n}",
    en: "items with a change that affects the score: {n}",
  },
  "diff.scoringScales": {
    uk: "шкал зі зміненим підрахунком: {n}",
    ru: "шкал с изменённым подсчётом: {n}",
    en: "scales with changed scoring: {n}",
  },

  /* ─── предупреждения подсчёта (хранятся кодом): packages/shared/src/scoring.ts ─── */
  "score.tooFewAnswers": {
    uk: "Шкала «{scale}»: відповіді є на {answered} з {asked} пунктів, потрібно щонайменше {min} % — бал не обчислено",
    ru: "Шкала «{scale}»: ответы есть на {answered} из {asked} пунктов, нужно не меньше {min} % — балл не вычислен",
    en: "Scale “{scale}”: {answered} of {asked} items answered, at least {min}% needed — score not computed",
  },
  "score.sourceUncomputed": {
    uk: "Шкала «{scale}»: не обчислено шкалу «{source}», від якої йде поправка, — бал не обчислено",
    ru: "Шкала «{scale}»: не вычислена шкала «{source}», от которой идёт поправка, — балл не вычислен",
    en: "Scale “{scale}”: scale “{source}”, which supplies its correction, wasn’t computed — score not computed",
  },
  "score.validityUncomputed": {
    uk: "Шкалу достовірності «{scale}» перевірити не вдалося: бал не обчислено",
    ru: "Шкалу достоверности «{scale}» проверить не удалось: балл не вычислен",
    en: "Validity scale “{scale}” couldn’t be checked: score not computed",
  },
  "score.noDenominator": {
    uk: "Шкала «{scale}»: не задано знаменник частки, показано сирий бал",
    ru: "Шкала «{scale}»: не задан знаменатель доли, показан сырой балл",
    en: "Scale “{scale}”: no proportion denominator set, showing the raw score",
  },
  "score.zeroSd": {
    uk: "Шкала «{scale}»: у норми нульове стандартне відхилення, показано сирий бал",
    ru: "Шкала «{scale}»: у нормы нулевое стандартное отклонение, показан сырой балл",
    en: "Scale “{scale}”: the norm has zero standard deviation, showing the raw score",
  },
  "score.noNorm": {
    uk: "Шкала «{scale}»: немає норми для цієї статі й віку, показано сирий бал",
    ru: "Шкала «{scale}»: нет нормы для этого пола и возраста, показан сырой балл",
    en: "Scale “{scale}”: no norm for this sex and age, showing the raw score",
  },
  "score.outsideSten": {
    uk: "Шкала «{scale}»: сирий бал поза таблицею стенів",
    ru: "Шкала «{scale}»: сырой балл вне таблицы стенов",
    en: "Scale “{scale}”: the raw score is outside the sten table",
  },
  "score.validityNotNormalized": {
    uk: "Шкалу достовірності «{scale}» перевірити не вдалося: результат не нормовано",
    ru: "Шкалу достоверности «{scale}» проверить не удалось: результат не нормирован",
    en: "Validity scale “{scale}” couldn’t be checked: the result isn’t normalised",
  },
  "score.validityExceeded": {
    uk: "Шкала достовірності «{scale}» вийшла за поріг {threshold} — результат ненадійний",
    ru: "Шкала достоверности «{scale}» вышла за порог {threshold} — результат ненадёжен",
    en: "Validity scale “{scale}” crossed the threshold of {threshold} — the result is unreliable",
  },

  /* ─── объяснения правил (хранятся кодом): packages/shared/src/rules.ts ─── */
  "rule.otherSurvey": {
    uk: "методика не та, до якої належить умова",
    ru: "методика не та, к которой относится условие",
    en: "a different assessment from the one the condition refers to",
  },
  "rule.noScale": {
    uk: "шкали {scale} у цьому проходженні немає",
    ru: "шкалы {scale} в этом прохождении нет",
    en: "scale {scale} isn’t in this response",
  },
  "rule.noNorms": {
    uk: "{scale}: норми не застосувалися, порівнювати нема з чим",
    ru: "{scale}: нормы не применились, сравнивать не с чем",
    en: "{scale}: no norms applied, nothing to compare",
  },
  "rule.raw": {
    uk: "{scale}: сирий бал {actual} {op} {value}",
    ru: "{scale}: сырой балл {actual} {op} {value}",
    en: "{scale}: raw score {actual} {op} {value}",
  },
  "rule.normed": {
    uk: "{scale}: нормований бал {actual} {op} {value}",
    ru: "{scale}: нормированный балл {actual} {op} {value}",
    en: "{scale}: normed score {actual} {op} {value}",
  },
  "rule.riskRaised": {
    uk: "піднято прапорець ризику ({severity})",
    ru: "поднят флаг риска ({severity})",
    en: "risk flag raised ({severity})",
  },
  "rule.riskAbsent": {
    uk: "прапорця ризику рівня «{severity}» немає",
    ru: "флага риска уровня «{severity}» нет",
    en: "no risk flag at the “{severity}” level",
  },
  /*
   * Уровень риска прежде печатался кодом («moderate») посреди русской
   * фразы. Теперь он хранится ключом ниже и переводится вместе с фразой —
   * см. renderCoded, вложенные ключи.
   */
  "rule.sev.moderate": { uk: "помірний", ru: "умеренный", en: "moderate" },
  "rule.sev.severe": { uk: "виражений", ru: "выраженный", en: "severe" },
  "rule.history": {
    uk: "проходжень цієї методики: {count} (потрібно {need})",
    ru: "прохождений этой методики: {count} (нужно {need})",
    en: "completed responses to this assessment: {count} (need {need})",
  },

  /* ─── печатные документы: apps/api/src/routes/reports.ts ─── */
  "print.anonymous": { uk: "Анонімний респондент", ru: "Анонимный респондент", en: "Anonymous respondent" },
  "print.sexMale": { uk: "чол.", ru: "муж.", en: "male" },
  "print.sexFemale": { uk: "жін.", ru: "жен.", en: "female" },
  /*
   * Возраст — тремя формами, по правилу числа языка (Intl.PluralRules):
   * прежде стояло «лет» при любом числе, и в отчёте печаталось «21 лет».
   * Английскому формы не нужны — фраза построена так, что число с
   * существительным не согласуется.
   */
  "print.age.one": {
    uk: "{age} рік на момент обстеження",
    ru: "{age} год на момент обследования",
    en: "aged {age} at the assessment",
  },
  "print.age.few": {
    uk: "{age} роки на момент обстеження",
    ru: "{age} года на момент обследования",
    en: "aged {age} at the assessment",
  },
  "print.age.many": {
    uk: "{age} років на момент обстеження",
    ru: "{age} лет на момент обследования",
    en: "aged {age} at the assessment",
  },
  "print.reportTitle": { uk: "Висновок — {survey}", ru: "Заключение — {survey}", en: "Report — {survey}" },
  "print.surveyVersion": { uk: "версія методики {n}", ru: "версия методики {n}", en: "assessment version {n}" },
  "print.notFinished": { uk: "не завершено", ru: "не завершено", en: "not completed" },
  "print.timeTaken": { uk: "час проходження {duration}", ru: "время прохождения {duration}", en: "time taken {duration}" },
  "print.scoresTitle": { uk: "Результати за субшкалами", ru: "Результаты по субшкалам", en: "Results by subscale" },
  "print.colSubscale": { uk: "Субшкала", ru: "Субшкала", en: "Subscale" },
  "print.colScore": { uk: "Бал", ru: "Балл", en: "Score" },
  "print.colPercent": { uk: "% від максимуму", ru: "% от максимума", en: "% of maximum" },
  "print.colInterpretation": { uk: "Інтерпретація", ru: "Интерпретация", en: "Interpretation" },
  "print.colPercentile": { uk: "Перцентиль", ru: "Перцентиль", en: "Percentile" },
  "print.scoreOf": { uk: "{raw} з {max}", ru: "{raw} из {max}", en: "{raw} of {max}" },
  /* порядковое «72-й» в английском было бы «72nd»; число под заголовком «Percentile» читается и так */
  "print.percentileN": { uk: "{n}-й", ru: "{n}-й", en: "{n}" },
  "print.answersTitle": { uk: "Відповіді", ru: "Ответы", en: "Answers" },
  "print.colNo": { uk: "№", ru: "№", en: "No." },
  "print.colQuestion": { uk: "Питання", ru: "Вопрос", en: "Question" },
  "print.colAnswer": { uk: "Відповідь", ru: "Ответ", en: "Answer" },
  "print.colTime": { uk: "Час", ru: "Время", en: "Time" },
  "print.notAnswered": { uk: "— без відповіді", ru: "— не отвечено", en: "— not answered" },
  "print.conclusionTitle": { uk: "Висновок фахівця", ru: "Заключение специалиста", en: "Clinician’s conclusion" },
  "print.signedBy": { uk: "Підписано: {who}", ru: "Подписано: {who}", en: "Signed: {who}" },
  "print.version": { uk: "версія {n}", ru: "версия {n}", en: "version {n}" },
  "print.disclaimer": {
    uk: "Результат скринінгового обстеження не є діагнозом. Інтерпретацію виконує фахівець з урахуванням клінічної картини та анамнезу. Перцентиль розраховано відносно вибірки, накопиченої в цій системі, і він не замінює популяційних норм методики.",
    ru: "Результат скринингового обследования не является диагнозом. Интерпретацию выполняет специалист с учётом клинической картины и анамнеза. Перцентиль рассчитан относительно выборки, накопленной в этой системе, и не заменяет популяционные нормы методики.",
    en: "A screening result is not a diagnosis. It is interpreted by a clinician in the light of the clinical picture and history. The percentile is calculated against the sample accumulated in this system and does not replace the assessment’s population norms.",
  },
  "print.clinician": { uk: "Фахівець", ru: "Специалист", en: "Clinician" },
  "print.signature": { uk: "підпис", ru: "подпись", en: "signature" },
  "print.date": { uk: "Дата", ru: "Дата", en: "Date" },
  "print.printedBy": { uk: "Роздруковано: {who}, {at}", ru: "Распечатано: {who}, {at}", en: "Printed by {who}, {at}" },
  "print.certTitle": { uk: "Довідка про відвідування", ru: "Справка о посещении", en: "Certificate of attendance" },
  /* {unit} приходит с запятой впереди или пустым: подразделения у человека может не быть */
  "print.certBody": {
    uk: "Видана {name}{unit} у тому, що {date} з {from} до {to} він(вона) перебував(ла) на прийомі.",
    ru: "Выдана {name}{unit} в том, что {date} с {from} до {to} он(она) находился(-ась) на приёме.",
    en: "Issued to {name}{unit} to certify that on {date} from {from} to {to} they attended an appointment.",
  },
  "print.certPurpose": {
    uk: "Довідка видана для пред’явлення за місцем вимоги.",
    ru: "Справка выдана для предъявления по месту требования.",
    en: "This certificate is issued for presentation on request.",
  },
  "print.certIssued": { uk: "Дата видачі: {date}", ru: "Дата выдачи: {date}", en: "Date of issue: {date}" },
  "print.extractTitle": { uk: "Витяг за зверненням", ru: "Выписка по обращению", en: "Episode of care summary" },
  "print.ongoing": { uk: "триває", ru: "продолжается", en: "ongoing" },
  "print.leadBy": { uk: "веде {name}", ru: "ведёт {name}", en: "lead clinician {name}" },
  "print.reasonTitle": { uk: "Привід звернення", ru: "Повод обращения", en: "Presenting concern" },
  "print.visitsTitle": { uk: "Прийоми", ru: "Приёмы", en: "Appointments" },
  "print.colStatus": { uk: "Стан", ru: "Состояние", en: "Status" },
  "print.noVisits": { uk: "Прийомів не було.", ru: "Приёмов не было.", en: "No appointments." },
  "print.conclusionsTitle": { uk: "Висновки", ru: "Заключения", en: "Conclusions" },
  "print.noConclusions": { uk: "Підписаних висновків немає.", ru: "Подписанных заключений нет.", en: "No signed conclusions." },
  "print.referralsTitle": { uk: "Направлення", ru: "Направления", en: "Referrals" },
  "print.colDestination": { uk: "Куди", ru: "Куда", en: "To" },
  "print.outcomeTitle": { uk: "Результат", ru: "Результат", en: "Outcome" },
  "print.chartTitle": { uk: "Амбулаторна карта", ru: "Амбулаторная карта", en: "Outpatient record" },
  "print.bornOn": { uk: "{date} р. н.", ru: "{date} г. р.", en: "born {date}" },
  "print.episodesTitle": { uk: "Звернення", ru: "Обращения", en: "Episodes of care" },
  "print.colPeriod": { uk: "Період", ru: "Период", en: "Period" },
  "print.colReason": { uk: "Привід", ru: "Повод", en: "Reason" },
  "print.colLead": { uk: "Веде", ru: "Ведёт", en: "Lead" },
  "print.noEpisodes": { uk: "Звернень не було.", ru: "Обращений не было.", en: "No episodes of care." },
  "print.colKind": { uk: "Вид", ru: "Вид", en: "Type" },
  "print.assessmentsTitle": { uk: "Обстеження", ru: "Обследования", en: "Assessments" },
  "print.colAssessment": { uk: "Методика", ru: "Методика", en: "Assessment" },
  "print.colSource": { uk: "Звідки", ru: "Откуда", en: "Source" },
  "print.noAssessments": { uk: "Обстежень не було.", ru: "Обследований не было.", en: "No assessments." },
  "print.notesTitle": { uk: "Записи прийому", ru: "Записи приёма", en: "Visit notes" },
  "print.noNotes": { uk: "Підписаних записів немає.", ru: "Подписанных записей нет.", en: "No signed notes." },

  /* ─── подписи выгрузки SPSS: apps/api/src/routes/spss.ts (имена переменных не переводятся) ─── */
  "spss.caseIdFull": { uk: "Ідентифікатор проходження", ru: "Идентификатор прохождения", en: "Response ID" },
  "spss.caseIdCode": {
    uk: "Код спостереження (до картки не веде)",
    ru: "Код наблюдения (в карту не ведёт)",
    en: "Case code (does not lead back to the record)",
  },
  "spss.subjectFull": { uk: "Ідентифікатор обстежуваного", ru: "Идентификатор обследуемого", en: "Subject ID" },
  "spss.subjectCode": {
    uk: "Код суб’єкта (незворотний, сталий між вивантаженнями)",
    ru: "Код субъекта (необратимый, стабильный между выгрузками)",
    en: "Subject code (irreversible, stable across exports)",
  },
  "spss.sex": { uk: "Стать", ru: "Пол", en: "Sex" },
  "spss.male": { uk: "чоловіча", ru: "мужской", en: "male" },
  "spss.female": { uk: "жіноча", ru: "женский", en: "female" },
  "spss.age": {
    uk: "Вік на момент обстеження, повних років",
    ru: "Возраст на момент обследования, полных лет",
    en: "Age at assessment, completed years",
  },
  "spss.unit": { uk: "Підрозділ", ru: "Подразделение", en: "Unit" },
  "spss.rank": { uk: "Звання", ru: "Звание", en: "Rank" },
  "spss.submittedAt": { uk: "Дата й час завершення", ru: "Дата и время завершения", en: "Completion date and time" },
  "spss.ageBand": { uk: "Вікова група", ru: "Возрастная полоса", en: "Age band" },
  "spss.ageUnder25": { uk: "до 25", ru: "до 25", en: "under 25" },
  "spss.age45plus": { uk: "45 і старші", ru: "45 и старше", en: "45 and over" },
  "spss.submittedMonth": { uk: "Місяць завершення", ru: "Месяц завершения", en: "Completion month" },
  "spss.durationMin": { uk: "Тривалість проходження, хвилин", ru: "Длительность прохождения, минут", en: "Time taken, minutes" },
  "spss.version": { uk: "Версія методики, за якою проходили", ru: "Версия методики, которой проходили", en: "Assessment version used" },
  "spss.itemMs": { uk: "Час відповіді на пункт {n}, мс", ru: "Время ответа на пункт {n}, мс", en: "Response time for item {n}, ms" },
  "spss.itemChanges": {
    uk: "Кількість змін відповіді, пункт {n}",
    ru: "Число переключений ответа, пункт {n}",
    en: "Answer changes, item {n}",
  },
  "spss.scaleRaw": { uk: "{scale} — сирий бал", ru: "{scale} — сырой балл", en: "{scale} — raw score" },
  "spss.scaleT": { uk: "{scale} — T-бал", ru: "{scale} — T-балл", en: "{scale} — T-score" },
  "spss.scaleSten": { uk: "{scale} — стен", ru: "{scale} — стен", en: "{scale} — sten" },
  "spss.scaleRatio": { uk: "{scale} — частка від максимуму", ru: "{scale} — доля от максимума", en: "{scale} — proportion of maximum" },
  "spss.scaleFinal": { uk: "{scale} — підсумкове значення", ru: "{scale} — итоговое значение", en: "{scale} — final value" },
  "spss.scaleNormed": {
    uk: "{scale} — нормування застосовано",
    ru: "{scale} — нормировка применена",
    en: "{scale} — normalisation applied",
  },
  "spss.normedNo": {
    uk: "ні: норм для людини не знайшлося, є лише сирий бал",
    ru: "нет: норм для человека не нашлось, есть только сырой балл",
    en: "no: no norms found for this person, raw score only",
  },
  "spss.yes": { uk: "так", ru: "да", en: "yes" },
  "spss.notChosen": { uk: "не вибрано", ru: "не выбрано", en: "not selected" },
  "spss.chosen": { uk: "вибрано", ru: "выбрано", en: "selected" },
  "spss.rankPlace": { uk: "{title}: місце {k}", ru: "{title}: место {k}", en: "{title}: rank {k}" },
  "spss.syntaxFrom": {
    uk: "Синтаксис вивантажено з Quizzy: {title}.",
    ru: "Синтаксис выгружен из Quizzy: {title}.",
    en: "Syntax exported from Quizzy: {title}.",
  },
  "spss.syntaxDataFile": {
    uk: "Файл даних покладіть поруч із цим синтаксисом і підставте шлях у FILE.",
    ru: "Файл данных положите рядом с этим синтаксисом и подставьте путь в FILE.",
    en: "Put the data file next to this syntax and set its path in FILE.",
  },
  "spss.syntaxMissing": {
    uk: "Пропущені значення закодовано як {missing}.",
    ru: "Пропущенные значения закодированы как {missing}.",
    en: "Missing values are coded as {missing}.",
  },
  "spss.freeTextNote": {
    uk: "Вільні відповіді й дати в знеособлених профілях не вивантажуються: вилучення ідентифікатора не знеособлює того, що людина написала сама.",
    ru: "Свободные ответы и даты в обезличенных профилях не выгружаются: удаление идентификатора не обезличивает то, что человек написал сам.",
    en: "Free-text answers and dates are not exported in de-identified profiles: removing the identifier does not de-identify what the person wrote themselves.",
  },
  "spss.kanonNote": {
    uk: "Вікові групи злито до наповнення k; у решти рідкісних поєднань стать і вік стерто. Пропуски в цих полях не випадкові.",
    ru: "Возрастные полосы слиты до наполнения k; у оставшихся редких сочетаний пол и возраст стёрты. Пропуски в этих полях не случайны.",
    en: "Age bands were merged until each reached k; for the remaining rare combinations sex and age were blanked. Missing values in these fields are not random.",
  },
  "spss.loadTitle": {
    uk: "Як відкрити вивантаження Quizzy в {tool}.",
    ru: "Загрузка выгрузки Quizzy в {tool}.",
    en: "Loading a Quizzy export into {tool}.",
  },
  "spss.loadFormat": {
    uk: "Кодування UTF-8 з BOM, роздільник — кома, пропуски — порожній рядок.",
    ru: "Кодировка UTF-8 с BOM, разделитель — запятая, пропуски — пустая строка.",
    en: "Encoding UTF-8 with BOM, comma-separated, missing values are empty strings.",
  },
  "spss.loadFactorsR": {
    uk: "Категоріальні змінні оголошено факторами: інакше порядкові коди варіантів потраплять у модель як числа, і «варіант 3» виявиться втричі більшим за «варіант 1».",
    ru: "Категориальные переменные объявлены факторами: иначе порядковые коды вариантов попадут в модель как числа, и «вариант 3» окажется втрое больше «варианта 1».",
    en: "Categorical variables are declared as factors: otherwise the option codes would enter the model as numbers, and “option 3” would count as three times “option 1”.",
  },
  "spss.loadFactorsPy": {
    uk: "Категоріальні змінні оголошено категоріями: інакше порядкові коди варіантів потраплять у модель як числа.",
    ru: "Категориальные переменные объявлены категориями: иначе порядковые коды вариантов попадут в модель как числа.",
    en: "Categorical variables are declared as categories: otherwise the option codes would enter the model as numbers.",
  },

  /* ─── командная консоль: apps/api/src/lib/commands.ts, routes/console.ts ─── */
  "cmd.help.summary": { uk: "Список команд", ru: "Список команд", en: "List of commands" },
  "cmd.whoami.summary": { uk: "Хто ви і що вам можна", ru: "Кто вы и что вам можно", en: "Who you are and what you may do" },
  "cmd.stats.summary": { uk: "Стан системи в числах", ru: "Состояние системы в числах", en: "System state in numbers" },
  "cmd.queue.summary": {
    uk: "Черга розбору: скільки і як давно чекає",
    ru: "Очередь разбора: сколько и как давно висит",
    en: "Review queue: how many and how long they’ve waited",
  },
  "cmd.rls.summary": {
    uk: "Чи діють політики рядків на цьому підключенні",
    ru: "Действуют ли политики строк на этом подключении",
    en: "Whether row policies apply on this connection",
  },
  "cmd.audit.summary": { uk: "Звірити хеш-ланцюжок журналу", ru: "Сверить хеш-цепочку журнала", en: "Verify the audit log hash chain" },
  "cmd.catalog.summary": { uk: "Спільний каталог методик", ru: "Общий каталог методик", en: "Shared assessment catalogue" },
  "cmd.dept.summary": { uk: "Відділення", ru: "Отделения", en: "Departments" },
  "cmd.user.summary": {
    uk: "Облікові записи: знайти, змінити клас, заборонити запис",
    ru: "Учётные записи: найти, сменить класс, запретить запись",
    en: "Accounts: find, change class, block writing",
  },
  "cmd.help.legend": {
    uk: "× — команда є, але у вас немає права на неї",
    ru: "× — команда есть, но у вас нет права на неё",
    en: "× — the command exists, but you don’t have the permission for it",
  },
  "cmd.whoami.class": { uk: "клас облікового запису: {role}", ru: "класс учётной записи: {role}", en: "account class: {role}" },
  "cmd.whoami.perms": { uk: "права на команди: {list}", ru: "права на команды: {list}", en: "command permissions: {list}" },
  "cmd.none": { uk: "немає", ru: "нет", en: "none" },
  "cmd.stats.people": { uk: "обстежуваних", ru: "обследуемых", en: "respondents" },
  "cmd.stats.staff": { uk: "співробітників", ru: "сотрудников", en: "staff" },
  "cmd.stats.published": { uk: "методик (опубл.)", ru: "методик (опубл.)", en: "assessments (published)" },
  "cmd.stats.responses": { uk: "проходжень", ru: "прохождений", en: "responses" },
  "cmd.stats.openCases": { uk: "випадків у розборі", ru: "случаев в разборе", en: "cases under review" },
  "cmd.stats.appointments": { uk: "прийомів від сьогодні", ru: "приёмов с сегодня", en: "appointments from today" },
  "cmd.queue.empty": { uk: "черга порожня", ru: "очередь пуста", en: "the queue is empty" },
  "cmd.queue.total": { uk: "усього", ru: "всего", en: "total" },
  "cmd.queue.severe": { uk: "з них тяжких", ru: "из них тяжёлых", en: "of them severe" },
  "cmd.queue.oldest": { uk: "найдавніший", ru: "самый давний", en: "oldest" },
  "cmd.hours": { uk: "{n} год", ru: "{n} ч", en: "{n} h" },
  "cmd.onlyForm": { uk: "єдина форма: {form}", ru: "единственная форма: {form}", en: "the only form: {form}" },
  "cmd.forms": { uk: "форми: {forms}", ru: "формы: {forms}", en: "forms: {forms}" },
  "cmd.rls.bypass": {
    uk: "ПОЛІТИКИ НЕ ДІЮТЬ на цьому підключенні",
    ru: "ПОЛИТИКИ НЕ ДЕЙСТВУЮТ на этом подключении",
    en: "ROW POLICIES DO NOT APPLY on this connection",
  },
  "cmd.rls.role": { uk: "роль: {role}", ru: "роль: {role}", en: "role: {role}" },
  "cmd.rls.reason": { uk: "причина: {reason}", ru: "причина: {reason}", en: "reason: {reason}" },
  "cmd.rls.unknownReason": { uk: "невідома", ru: "неизвестна", en: "unknown" },
  "cmd.rls.owned": {
    uk: "таблиць з увімкненою RLS у власності: {n}",
    ru: "таблиц с включённой RLS во владении: {n}",
    en: "owned tables with RLS enabled: {n}",
  },
  "cmd.rls.ok": { uk: "політики рядків діють; роль: {role}", ru: "политики строк действуют; роль: {role}", en: "row policies apply; role: {role}" },
  "cmd.audit.ok": { uk: "ланцюжок цілий, записів: {n}", ru: "цепочка цела, записей: {n}", en: "chain intact, entries: {n}" },
  "cmd.audit.head": { uk: "головний хеш: {hash}", ru: "головной хэш: {hash}", en: "head hash: {hash}" },
  "cmd.audit.broken": { uk: "ЛАНЦЮЖОК ПОРУШЕНО на записі {seq}", ru: "ЦЕПОЧКА НАРУШЕНА на записи {seq}", en: "CHAIN BROKEN at entry {seq}" },
  "cmd.audit.checked": { uk: "перевірено: {n}", ru: "проверено: {n}", en: "checked: {n}" },
  "cmd.catalog.deptCreated": { uk: "відділення заведено", ru: "отделение заведено", en: "department created" },
  "cmd.catalog.deptExisted": { uk: "відділення вже було", ru: "отделение уже было", en: "department already existed" },
  "cmd.catalog.installed": { uk: "встановлено: {list}", ru: "поставлено: {list}", en: "installed: {list}" },
  "cmd.catalog.nothingNew": { uk: "нових методик немає", ru: "новых методик нет", en: "no new assessments" },
  "cmd.catalog.skipped": { uk: "уже стояли: {list}", ru: "уже стояли: {list}", en: "already installed: {list}" },
  "cmd.dept.none": { uk: "відділень немає", ru: "отделений нет", en: "no departments" },
  "cmd.user.nobody": { uk: "нікого", ru: "никого", en: "nobody" },
  "cmd.user.readOnly": { uk: "лише читання", ru: "только чтение", en: "read-only" },
  "cmd.user.writeBlocked": { uk: "{email}: запис заборонено", ru: "{email}: запись запрещена", en: "{email}: writing blocked" },
  "cmd.user.writeAllowed": { uk: "{email}: запис дозволено", ru: "{email}: запись разрешена", en: "{email}: writing allowed" },
  "cmd.user.roleValues": { uk: "клас: superadmin, admin або user", ru: "класс: superadmin, admin или user", en: "class: superadmin, admin or user" },
  "cmd.user.onOff": { uk: "значення: on або off", ru: "значение: on или off", en: "value: on or off" },
  "cmd.usage.userFind": { uk: "user find <частина пошти>", ru: "user find <часть почты>", en: "user find <part of email>" },
  "cmd.usage.userRole": {
    uk: "user role <пошта> <superadmin|admin|user>",
    ru: "user role <почта> <superadmin|admin|user>",
    en: "user role <email> <superadmin|admin|user>",
  },
  "cmd.usage.userReadonly": {
    uk: "user readonly <пошта> <on|off>",
    ru: "user readonly <почта> <on|off>",
    en: "user readonly <email> <on|off>",
  },
  "cmd.needArgs": { uk: "потрібно більше аргументів: {usage}", ru: "нужно больше аргументов: {usage}", en: "more arguments needed: {usage}" },
  "cmd.notFound": { uk: "не знайдено: {email}", ru: "не найден: {email}", en: "not found: {email}" },
  "cmd.unknown": { uk: "немає такої команди: {name}", ru: "нет такой команды: {name}", en: "no such command: {name}" },
  "cmd.typeHelp": { uk: "наберіть help", ru: "наберите help", en: "type help" },

  /* ── w14:srvstrings ── */

  /*
   * ─── пометки, которые сервер сам пишет в базу ───
   *
   * Хранятся встроенным кодом (noteCode ниже), фразой становятся при показе —
   * на языке того, кто смотрит. Заметки версий: routes/surveys.ts,
   * routes/norms.ts, lib/catalogInstall.ts.
   */
  "note.firstVersion": { uk: "Перша версія", ru: "Первая версия", en: "First version" },
  "note.importFile": { uk: "Імпорт з файлу", ru: "Импорт из файла", en: "Imported from a file" },
  "note.copyOf": { uk: "Копія «{title}»", ru: "Копия «{title}»", en: "Copy of “{title}”" },
  "note.localNorms": { uk: "Локальні норми: {scales}", ru: "Локальные нормы: {scales}", en: "Local norms: {scales}" },
  /* {edition} — отпечаток редакции каталога: по нему установщик узнаёт, что методику надо обновить */
  "note.catalog": { uk: "Каталог · {edition}", ru: "Каталог · {edition}", en: "Catalogue · {edition}" },
  /* примечания доступа и назначений: routes/batteries.ts, lib/cascade.ts, lib/scheduler.ts, lib/invites.ts, lib/followup.ts */
  "note.battery": { uk: "Набір «{title}»", ru: "Батарея «{title}»", en: "Battery “{title}”" },
  "note.cascade": {
    uk: "Каскад за результатом скринінгу",
    ru: "Каскад по результату скрининга",
    en: "Cascade after a screening result",
  },
  "note.schedule": { uk: "Розклад «{title}»", ru: "Расписание «{title}»", en: "Schedule “{title}”" },
  "note.invite": { uk: "За запрошенням", ru: "По приглашению", en: "By invitation" },
  "note.followup": {
    uk: "Протокол спостереження: повтор через {days} дн.",
    ru: "Протокол наблюдения: повтор через {days} дн.",
    en: "Follow-up protocol: repeat after {days} days",
  },
  /* отметка о пропуске дописывается к примечанию назначения через « · » (lib/batteries.ts, closeMissed) */
  "note.missed.reassigned": {
    uk: "пропущено: строк минув, призначено знову",
    ru: "пропущено: срок истёк, назначено заново",
    en: "missed: overdue, assigned again",
  },
  "note.missed.cascade": {
    uk: "пропущено: строк минув, призначено знову за результатом скринінгу",
    ru: "пропущено: срок истёк, назначено заново по результату скрининга",
    en: "missed: overdue, assigned again after a screening result",
  },
  "note.missed.schedule": {
    uk: "пропущено: строк минув, видано наступне за розкладом «{title}»",
    ru: "пропущено: срок истёк, выдано следующее по расписанию «{title}»",
    en: "missed: overdue, the next one issued by schedule “{title}”",
  },
  /* итоги прогонов расписаний: lib/scheduler.ts → schedule_runs.note, техпанель «Задачі» */
  "note.run.archived": {
    uk: "Набір в архіві — призначення не видаються",
    ru: "Набор в архиве — назначения не выдаются",
    en: "The battery is archived — no assignments are issued",
  },
  "note.run.missedClosed": { uk: "Пропущено й закрито: {n}", ru: "Пропущено и закрыто: {n}", en: "Missed and closed: {n}" },
  "note.run.nobody": { uk: "Нема кого охопити", ru: "Некого охватить", en: "Nobody to reach" },
  "note.run.unknownError": { uk: "Невідома помилка", ru: "Неизвестная ошибка", en: "Unknown error" },
  /* источник локальной нормы: routes/norms.ts → scale_norms.source; по коду её и не выгружают (lib/surveys.ts) */
  "note.localSample": {
    uk: "локальна вибірка, N={n}, {date}",
    ru: "локальная выборка, N={n}, {date}",
    en: "local sample, N={n}, {date}",
  },
  /* почему роль обходит политики строк: lib/rlsGuard.ts → консоль, техпанель, сохранённая проверка */
  "rls.why.superuser": { uk: "суперкористувач бази", ru: "суперпользователь базы", en: "database superuser" },
  "rls.why.bypass": { uk: "роль з BYPASSRLS", ru: "роль с BYPASSRLS", en: "role with BYPASSRLS" },
  "rls.why.owner": {
    uk: "володіє {n} табл. з увімкненою RLS",
    ru: "владеет {n} табл. с включённой RLS",
    en: "owns {n} tables with RLS enabled",
  },

  /* ─── собранные на лету — на языке запроса ─── */

  /* что мешает удалить: «{details}» в err.groupNotEmpty / err.surveyFolderNotEmpty */
  "inside.surveys": { uk: "методик: {n}", ru: "методик: {n}", en: "assessments: {n}" },
  "inside.folders": { uk: "папок: {n}", ru: "папок: {n}", en: "folders: {n}" },
  "inside.batteries": { uk: "наборів: {n}", ru: "батарей: {n}", en: "batteries: {n}" },
  "inside.rules": { uk: "правил підтримки рішень: {n}", ru: "правил поддержки решений: {n}", en: "decision support rules: {n}" },
  /* очередь работы: routes/worklist.ts */
  "wl.noShow": { uk: "Не прийшов на прийом", ru: "Не пришёл на приём", en: "Missed the appointment" },
  "wl.unread": { uk: "Непрочитане повідомлення", ru: "Непрочитанное сообщение", en: "Unread message" },
  /* лист ключей (routes/surveys.ts, /key): норма без пола — для любого; мужская и женская — print.sexMale/Female */
  "print.sexAny": { uk: "будь-яка", ru: "любой", en: "any" },
  /* дрейф шкалы по месяцам: routes/dataQuality.ts */
  "dq.drift.significant": { uk: "суттєвий", ru: "существенный", en: "significant" },
  "dq.drift.noticeable": { uk: "помітний", ru: "заметный", en: "noticeable" },
  "dq.drift.stable": { uk: "стабільно", ru: "стабильно", en: "stable" },
  /* признаки небрежного заполнения: lib/psychometrics.ts (qualityOf) */
  "quality.tooFast": {
    uk: "{share}% відповідей швидше за {ms} мс",
    ru: "{share}% ответов быстрее {ms} мс",
    en: "{share}% of answers faster than {ms} ms",
  },
  "quality.straightLine": {
    uk: "серія з {n} однакових відповідей",
    ru: "серия из {n} одинаковых ответов",
    en: "a run of {n} identical answers",
  },
  "quality.tooShort": {
    uk: "загальний час менший за мінімально правдоподібний",
    ru: "общее время меньше минимально правдоподобного",
    en: "total time below the minimum plausible",
  },
  "quality.personFit": {
    uk: "нетиповий патерн відповідей ({value})",
    ru: "нетипичный паттерн ответов ({value})",
    en: "atypical answer pattern ({value})",
  },
  /* стирание устройства: routes/devices.ts — ответ говорит, чего команда не делает */
  "device.wipeNote": {
    uk: "Дані буде стерто, коли пристрій наступного разу вийде на зв’язок. Пристрій, який більше не ввімкнуть, цією командою не очистити.",
    ru: "Данные будут стёрты, когда устройство в следующий раз выйдет на связь. Устройство, которое больше не включат, этой командой не очистить.",
    en: "The data will be erased the next time the device connects. A device that is never switched on again can’t be wiped by this command.",
  },
  /* строгий порядок набора: lib/batteries.ts — когда название прежней методики не нашлось */
  "battery.previousSurvey": { uk: "попередня методика", ru: "предыдущая методика", en: "the previous assessment" },

  /*
   * ─── содержимое, которое пишет сервер ───
   *
   * Поле многоязычное (LocalizedText), поэтому пишется сразу на всех языках
   * содержимого (CONTENT_LANGS), а язык выбирает t() при показе — как у
   * любого другого названия. Английский здесь для полноты словаря: у
   * содержимого его нет намеренно (types.ts).
   */
  "content.copySuffix": { uk: "(копія)", ru: "(копия)", en: "(copy)" },
  /* отделение по умолчанию (lib/catalogInstall.ts); ищется по украинскому названию — не переименовывать молча */
  "content.defaultDepartment": { uk: "Психологічне відділення", ru: "Психологическое отделение", en: "Psychology department" },

  /*
   * ─── без запроса: письма и события, которые уходят не тому, кто спросил ───
   *
   * Язык — отделения (MAIL_LANG в lib/notify.ts), как у оповещений техпанели
   * (lib/opsAlerts.ts): языка получателя сервер не знает.
   */
  /* событие в календаре специалиста (routes/clinic.ts → lib/meet.ts): без имени пациента намеренно */
  "meet.eventTitle": { uk: "Прийом", ru: "Приём", en: "Appointment" },
  /* уровень согласован с «відповідь» / «ответ»: в украинском женский род, в русском мужской */
  "mail.sev.severe": { uk: "критична", ru: "критический", en: "critical" },
  "mail.sev.moderate": { uk: "підвищена", ru: "повышенный", en: "elevated" },
  "mail.alert.subject": {
    uk: "Тривога: {level} відповідь — {title}",
    ru: "Тревога: {level} ответ — {title}",
    en: "Alert: {level} answer — {title}",
  },
  "mail.alert.body": {
    uk: "У методиці «{title}» надійшла {level} відповідь.",
    ru: "В методике «{title}» получен {level} ответ.",
    en: "An answer flagged {level} was received in “{title}”.",
  },
  "mail.alert.open": {
    uk: "Відкрийте консоль, щоб побачити, хто і на який пункт відповів:",
    ru: "Откройте консоль, чтобы увидеть, кто и на какой пункт ответил:",
    en: "Open the console to see who answered which item:",
  },
  "mail.alert.noPersonal": {
    uk: "Персональні дані в листі не передаються навмисно.",
    ru: "Персональные данные в письме не передаются намеренно.",
    en: "Personal data is deliberately left out of this email.",
  },
  "mail.escalation.subject": {
    uk: "ЕСКАЛАЦІЯ: тривогу не розібрано {minutes} хв — {title}",
    ru: "ЭСКАЛАЦИЯ: тревога не разобрана {minutes} мин — {title}",
    en: "ESCALATION: alert unreviewed for {minutes} min — {title}",
  },
  "mail.escalation.body": {
    uk: "Тривогу за методикою «{title}» не підтверджено за {limit} хв.",
    ru: "Тревога по методике «{title}» не подтверждена за {limit} мин.",
    en: "The alert for “{title}” wasn’t acknowledged within {limit} min.",
  },
  "mail.escalation.open": { uk: "Відкрита вже {minutes} хв.", ru: "Открыта уже {minutes} мин.", en: "Open for {minutes} min." },
} as const satisfies Record<string, ServerTextEntry>;

export type ServerTextKey = keyof typeof SERVER_TEXTS;

/** Подстановки: имена в фигурных скобках заменяются значениями */
export type TextParams = Record<string, string | number>;

const ENTRIES: Readonly<Record<string, ServerTextEntry | undefined>> = SERVER_TEXTS;

/** Есть ли такой ключ в словаре — для кодов, пришедших из базы */
export function isServerTextKey(key: unknown): key is ServerTextKey {
  // hasOwnProperty, а не `in`: «toString» ключом словаря не является
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(ENTRIES, key);
}

/**
 * Текст по ключу на нужном языке.
 *
 * Неизвестный ключ возвращается сам, а не пустой строкой: пустота читается
 * как «сказать нечего», и никто о ней не сообщит, а ключ человек называет в
 * заявке — и его находят поиском. Тот же выбор, что у makeUiT.
 */
export function serverText(key: ServerTextKey | string, lang: Lang, params?: TextParams): string {
  const entry = ENTRIES[key];
  if (!entry) return key;
  let text = entry[lang] ?? entry.uk;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/**
 * Хранимый текст: код и подстановки вместо готовой фразы.
 *
 * `text` — для двух случаев, и оба важнее кода. Первый — слова самой
 * методики: у шкалы достоверности бывает своё сообщение (validityMessage),
 * и это контент каталога, а не фраза движка. Второй — запись, сохранённая
 * до кодов: у старых срабатываний правил в базе лежит только русский
 * текст, и показать его надо как есть — переписывать историю задним
 * числом нельзя, а перевести готовую фразу не из чего.
 */
export interface CodedText {
  code?: ServerTextKey | string;
  params?: TextParams;
  text?: string;
}

/**
 * Хранимый текст — на языке смотрящего.
 *
 * Порядок решения: строка целиком (так хранили раньше) — как есть; свой
 * текст записи — как есть; иначе код по словарю. Подстановка, которая сама
 * является ключом словаря («rule.sev.severe»), переводится тем же языком:
 * так уровень риска внутри объяснения правила хранится кодом и не остаётся
 * английским словом посреди украинской фразы.
 */
export function renderCoded(item: CodedText | string, lang: Lang): string {
  if (typeof item === "string") return item;
  if (item.text) return item.text;
  if (!item.code) return "";
  let params: TextParams | undefined;
  if (item.params) {
    params = {};
    for (const [name, value] of Object.entries(item.params)) {
      params[name] = isServerTextKey(value) ? serverText(value, lang) : value;
    }
  }
  return serverText(item.code, lang, params);
}

/*
 * ─── встроенный код: пометка сервера в текстовой колонке (волна 14) ───
 *
 * Заметку версии, примечание доступа, итог прогона расписания сервер пишет
 * сам — и писал русской фразой. Эти колонки видят потом на любом языке:
 * «Первая версия» на английском экране истории версий, «Батарея «…»» в
 * украинском списке назначенных. Записать фразу на языке автора нельзя —
 * у большинства таких пометок автора нет: их пишут каскад по сданному
 * скринингу, планировщик, приглашение, установщик каталога. Поэтому — как
 * у объяснений правил (CodedText): храним код и подстановки, фразу
 * собирает показ.
 *
 * Отдельной колонки под код нет и заводить её ради этого — миграция на
 * шесть таблиц. Код встраивается в сам текст: ⟦ключ⟧ или ⟦ключ{"имя":…}⟧.
 * Так в одной колонке спокойно живут три вещи — код сервера, текст, который
 * набрал человек (примечание к назначению), и русская фраза, записанная до
 * кодов (её показ оставляет как есть: переписывать историю задним числом
 * нельзя). И склейка работает, как работала: отметка о пропуске
 * дописывается к примечанию назначения через « · » (lib/batteries.ts), а
 * очередь работы находит повторы протокола наблюдения по началу текста.
 *
 * Скобки ⟦⟧ выбраны за то, что их не набирают руками и не пишут в названиях;
 * «⟧» внутри подстановки (в названии набора) экранируется, и код не
 * закрывается раньше времени.
 */
const NOTE_RE = /⟦([A-Za-z][\w.-]*)(\{[^⟧]*\})?⟧/g;

/** Встроенный код пометки — для записи в текстовую колонку */
export function noteCode(code: ServerTextKey, params?: TextParams): string {
  if (!params || !Object.keys(params).length) return `⟦${code}⟧`;
  return `⟦${code}${JSON.stringify(params).replaceAll("⟧", "\\u27e7")}⟧`;
}

/**
 * Начало пометки с этим кодом — для поиска по началу текста (LIKE).
 * Ключ не должен быть началом другого ключа: «note.followup» ищется как
 * «⟦note.followup%», и «note.followupX» попал бы туда же.
 */
export function notePrefix(code: ServerTextKey): string {
  return `⟦${code}`;
}

/** Коды, встроенные в хранимый текст, по порядку; текст без кодов — пусто */
export function readNotes(text: string | null | undefined): CodedText[] {
  if (!text) return [];
  const out: CodedText[] = [];
  for (const m of text.matchAll(NOTE_RE)) {
    let params: TextParams | undefined;
    if (m[2]) {
      try {
        params = JSON.parse(m[2]) as TextParams;
      } catch {
        // испорченная подстановка: код остаётся кодом, без подстановок
      }
    }
    out.push({ code: m[1]!, params });
  }
  return out;
}

/**
 * Хранимый текст на языке смотрящего: каждый встроенный код — фразой,
 * остальное — как лежит (текст человека, запись до кодов).
 */
export function renderNote(text: string, lang: Lang): string;
export function renderNote(text: string | null | undefined, lang: Lang): string | null;
export function renderNote(text: string | null | undefined, lang: Lang): string | null {
  if (text === null || text === undefined) return null;
  if (!text.includes("⟦")) return text;
  return text.replace(NOTE_RE, (whole, code: string, raw?: string) => {
    if (!raw) return renderCoded({ code }, lang);
    try {
      return renderCoded({ code, params: JSON.parse(raw) as TextParams }, lang);
    } catch {
      return whole;
    }
  });
}
