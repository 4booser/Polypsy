import type { ResponseDetail, ResponseDetailAnswer, ScaleNormalization, Severity, SurveyFull } from "@quizzy/shared";

/*
 * Модель экрана «пройденный тест»: что показать в строке варианта и в лестнице
 * диапазонов, собранное из двух ответов сервера.
 *
 * Почему из двух. GET /api/responses/:id отдаёт ответы и баллы по шкалам, но
 * намеренно срезает вес варианта (options.score) и не отдаёт соседние
 * полосы — только ту, в которую попал балл (apps/api/src/routes/responses.ts,
 * «Варианты пункта — вместе с ответом»). Срезает не по забывчивости: тот же
 * маршрут открыт самому обследуемому, а баллы за варианты пациент видеть не
 * должен. Кадр f34 рисует и вес каждого варианта, и все три ступени «від —
 * до», и подсвеченную ступень. Недостающее берётся из GET /api/surveys/:id:
 * там и веса, и полосы целиком.
 *
 * Где на самом деле граница с пациентом. GET /api/surveys/:id НЕ закрыт от
 * пациента — маршрут объявлен с access: "user" (apps/api/src/lib/openapi.ts),
 * getSurvey в routes/surveys.ts роли не проверяет, и options.score в ответе
 * получает любой вошедший. Веса не попадают пациенту на экран не потому, что
 * сервер их прячет, а потому, что консольные маршруты — и этот экран среди
 * них — для role === "user" не рендерятся вовсе (App.tsx, ветка кабинета).
 * Это важно назвать прямо: вывод «раз маршрут отдаёт веса, значит, их можно
 * показывать и в кабинете» неверен — в кабинете вес варианта подсказывает
 * ответ, и закрывать его надо на сервере (в ответе прохождения он уже срезан),
 * а не полагаться на то, что кабинет пока его не запрашивает.
 *
 * Чего это стоит и где проходит граница. Методика по этому адресу — ДЕЙСТВУЮЩЕЙ
 * версии, а человек мог проходить прежнюю: каждая правка методики создаёт
 * новую версию с новыми идентификаторами пунктов, вариантов и шкал. Совпасть
 * могут только идентификаторы одной версии, поэтому сопоставление идёт по
 * ним, и когда версия сменилась, вес варианта и лестница не подставляются
 * вовсе — вместо правдоподобных, но чужих чисел на экране прочерк и строка
 * «методику изменено». Это записано в риске сверки макета: «экран покажет
 * правдоподобные, но чужие баллы» — и здесь ровно тот случай, когда лучше
 * не показать, чем показать не то.
 *
 * Функции чистые и вынесены из разметки ради проверки: сценарий «версия
 * сменилась» в браузере воспроизводится только правкой методики на живой
 * базе, а здесь — двумя объектами.
 */

export interface OptionRow {
  id: string;
  text: string;
  chosen: boolean;
  /** Вес варианта из действующей версии; null — версия разошлась или вариант не найден */
  score: number | null;
  riskFlag: boolean;
}

export interface QuestionView {
  questionId: string;
  /** Сквозной номер с единицы, как «Питання №1» на кадре */
  number: number;
  title: string;
  answered: boolean;
  options: OptionRow[];
  /**
   * Ответ не из вариантов: текст, число, дата, порядок. На кадре таких
   * пунктов нет, и рисуются они одной залитой строкой без веса.
   */
  free: string | null;
  /** Балл за пункт, который посчитал сервер, — для пунктов без вариантов */
  score: number | null;
}

export interface LadderRow {
  id: string;
  min: number;
  max: number;
  label: string;
  description: string | null;
  severity: Severity;
  /** Ступень, в которую попал балл этого прохождения */
  hit: boolean;
}

export interface ScaleLadder {
  scaleId: string;
  title: string;
  /** Значение в единицах нормировки — в тех же, в каких заданы ступени */
  value: number;
  normalization: ScaleNormalization;
  /** Подпись попавшей полосы от сервера — остаётся, даже когда лестницы нет */
  bandLabel: string | null;
  bandSeverity: Severity | null;
  rows: LadderRow[];
}

export interface ResponseViewModel {
  questions: QuestionView[];
  ladders: ScaleLadder[];
  /** Методика изменена после прохождения: веса и лестницы недоступны */
  stale: boolean;
}

/** Строка ответа, которого нет среди вариантов: текст, число, дата, порядок */
function freeAnswer(a: ResponseDetailAnswer, textById: Map<string, string>): string | null {
  if (a.text) return a.text;
  if (a.number !== null) return String(a.number);
  if (a.date) return a.date;
  if (a.ranking?.length) return a.ranking.map((id) => textById.get(id) ?? id).join(" → ");
  return null;
}

export function buildResponseView(detail: ResponseDetail, survey: SurveyFull): ResponseViewModel {
  const optionById = new Map(survey.questions.flatMap((q) => q.options.map((o) => [o.id, o] as const)));
  const scaleById = new Map(survey.scales.map((s) => [s.id, s] as const));

  /*
   * Признак разошедшейся версии — хоть один вариант или шкала прохождения,
   * которых в действующей методике нет. Идентификаторы версии либо совпадают все,
   * либо не совпадает ни один, поэтому «хоть один» здесь равно «все», а
   * проверка по одному не доверяет этому свойству базы сверх нужного.
   */
  let stale = false;

  const questions: QuestionView[] = [...detail.answers]
    .sort((a, b) => a.position - b.position)
    .map((a, i) => {
      /*
       * Выбранным считается и вариант из optionIds, и значение ячейки
       * матрицы: у матричного пункта ответ — «строка → вариант», и вариант
       * лежит в значениях. Строки самой матрицы (kind === "row") среди
       * вариантов не показываются: это подписи, а не ответы.
       */
      const picked = new Set([...(a.optionIds ?? []), ...Object.values(a.matrix ?? {})]);
      const rowIds = new Set(Object.keys(a.matrix ?? {}));
      const textById = new Map(a.options.map((o) => [o.id, o.text] as const));

      /*
       * Пункт «порядок» — не выбор из вариантов, а их перестановка: ответ —
       * цепочка, и список тех же вариантов под ней показывал бы нуль
       * напротив каждого (вес у порядка позиционный, у варианта его нет).
       * Заключение рисует цепочку; просмотр — тоже, иначе один ответ
       * выглядит на двух экранах двумя разными. Варианты всё же
       * перебираются: по ним ловится чужая версия.
       */
      const chain = a.type === "ranking";
      const rows: OptionRow[] = a.options
        .filter((o) => !rowIds.has(o.id) && optionById.get(o.id)?.kind !== "row")
        .map((o) => {
          const current = optionById.get(o.id);
          if (!current) stale = true;
          return {
            id: o.id,
            text: o.text,
            chosen: picked.has(o.id),
            score: current ? current.score : null,
            riskFlag: o.riskFlag,
          };
        });
      const options = chain ? [] : rows;

      return {
        questionId: a.questionId,
        number: i + 1,
        title: a.title,
        answered: a.answered,
        options,
        free: options.length ? null : freeAnswer(a, textById),
        score: a.score,
      };
    });

  const ladders: ScaleLadder[] = detail.scores.map((sc) => {
    const scale = scaleById.get(sc.scaleId);
    if (!scale) stale = true;
    const bands = scale ? [...scale.bands].sort((x, y) => x.minScore - y.minScore) : [];
    /*
     * Попавшая ступень ищется тем же сравнением, что в движке подсчёта
     * (packages/shared/src/scoring.ts: value >= min && value <= max), и только
     * когда сервер сам нашёл полосу. Без полосы от сервера значение не
     * нормировано — оно не в тех единицах, в которых заданы ступени, и
     * подсветить по нему было бы подсветкой наугад.
     *
     * Запасной путь по подписи — на случай, когда сравнение по значению не
     * сошлось (хранимое значение округлено иначе, чем считалось): сервер
     * помнит подпись полосы на момент подсчёта, и совпадение по ней надёжнее,
     * чем оставить лестницу без подсветки при живой полосе.
     */
    const byValue = sc.band ? bands.find((b) => sc.value >= b.minScore && sc.value <= b.maxScore) : undefined;
    const hitId = byValue?.id ?? (sc.band ? bands.find((b) => b.label === sc.band?.label)?.id : undefined);
    return {
      scaleId: sc.scaleId,
      title: sc.scaleTitle,
      value: sc.value,
      normalization: sc.normalization,
      bandLabel: sc.band?.label ?? null,
      bandSeverity: sc.band?.severity ?? null,
      rows: bands.map((b) => ({
        id: b.id,
        min: b.minScore,
        max: b.maxScore,
        label: b.label,
        description: b.description,
        severity: b.severity,
        hit: b.id === hitId,
      })),
    };
  });

  /*
   * При разошедшейся версии найденные веса и ступени всё равно снимаются:
   * половина совпавших идентификаторов — не «половина правды», а признак,
   * что сопоставление идёт не с той версией, и доверять нельзя ничему.
   */
  if (!stale) return { questions, ladders, stale };
  return {
    stale,
    questions: questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o, score: null })) })),
    ladders: ladders.map((l) => ({ ...l, rows: [] })),
  };
}
