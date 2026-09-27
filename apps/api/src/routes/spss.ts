import { Hono, type Context } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ageAt, applyQuasi, contentLangFor, exportQuery, generalizeQuasi, serverText } from "@quizzy/shared";
import type { AgeBand, ContentLang, Generalization, Lang, ServerTextKey, TextParams } from "@quizzy/shared";
import { db } from "../db";
import { env } from "../env";
import { answers, options, questions, responseScores, responses, scales, surveyVersions, users } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { csvCell } from "../lib/csv";
import { forbidden, langOf, notFound, parseQuery } from "../lib/http";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { hasPermission } from "../lib/permissions";

export const spssRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». Набор закрыт правом на обезличенную
 * выгрузку — это нижняя граница: без него сюда нечего ходить вовсе. Выгрузка
 * с именами требует второго права и проверяется по профилю (см. ниже).
 */
spssRoutes.use("*", requireAuth, requireStaff, requirePermission("export.deidentified"));

/** Пропущенное значение: SPSS не понимает пустую ячейку в числовом поле */
const MISSING = -99;

interface Variable {
  name: string;
  /** Формат SPSS: F — число, A — строка */
  spec: string;
  label: string;
  /** Числовые коды со значениями, если переменная категориальная */
  values?: [number, string][];
  value: (ctx: RowContext) => string;
}

/**
 * Строка выгрузки — одно прохождение, приведённое к схеме действующей версии.
 *
 * Ключи — не идентификаторы, а то, что у версий общее (клиническое ревью,
 * P1). Вопросы, варианты и шкалы у каждой версии методики — свои строки со
 * своими id, а схема выгрузки строится по действующей. Сопоставление по id
 * превращало всю историю до последней правки методики в «пропущено»:
 * GAD-7 первой версии с 14 баллами выгружался строкой из -99. Теперь ответ
 * находится по позиции пункта в СВОЕЙ версии, вариант — по порядковому
 * номеру в своём пункте, балл — по коду шкалы; номер версии прохождения —
 * отдельной колонкой, чтобы расхождения версий было видно в самих данных.
 */
interface RowContext {
  response: typeof responses.$inferSelect;
  user: typeof users.$inferSelect | null;
  /** Ответы по позиции пункта в версии прохождения */
  answer: Map<number, typeof answers.$inferSelect>;
  /** Баллы по коду шкалы */
  score: Map<string, typeof responseScores.$inferSelect>;
  /** Номер версии методики, которой проходили */
  version: number | null;
  /** id варианта или строки матрицы любой версии → порядковый номер в своём пункте (с нуля) */
  optionIndex: Map<string, number>;
}

/**
 * Имя переменной в SPSS: латиница, цифры и подчёркивание, не длиннее 64 знаков
 * и не начинается с цифры. Коды шкал у нас латинские, но перестраховываемся.
 */
function varName(raw: string, fallback: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `${fallback}${cleaned ? `_${cleaned}` : ""}`;
}

/** Метка переменной в синтаксисе заключена в апострофы — удваиваем внутренние */
function sq(text: string): string {
  return `'${text.replace(/'/g, "''").replace(/[\r\n]+/g, " ").slice(0, 250)}'`;
}


/**
 * Схема выгрузки. Данные и синтаксис строятся из одного описания, иначе они
 * разъезжаются: в SPSS это выглядит как правдоподобные, но чужие метки.
 */
export type ExportProfile = "full" | "deidentified" | "anonymous";

/** Возрастная полоса вместо точного возраста: перекрёстно не опознаётся */
function ageBand(age: number | null): string {
  if (age === null) return String(MISSING);
  if (age < 25) return "1";
  if (age < 35) return "2";
  if (age < 45) return "3";
  return "4";
}

/**
 * Стабильный необратимый код субъекта: HMAC от id с секретом выгрузок.
 * Стабильность важна для лонгитюда — повторные выгрузки склеиваются по
 * коду, но вернуть из кода личность без секрета нельзя.
 *
 * Секрет свой (EXPORT_SECRET), а не JWT_SECRET: код обязан не меняться
 * годами, а секрет подписи сессий положено менять при любом подозрении на
 * утечку. Пока значение было одно, ротация подписи молча превращала все
 * прежние коды в новые — и лонгитюд по выгрузкам, сделанным до неё,
 * переставал склеиваться, ничем себя не обнаруживая.
 */
function subjectCode(userId: string): string {
  const h = new Bun.CryptoHasher("sha256", env.exportSecret).update(`subject:${userId}`).digest("hex");
  return `R${h.slice(0, 10).toUpperCase()}`;
}

/**
 * Код наблюдения (case_id) — по профилю, а не одинаковый для всех.
 *
 * Раньше во всех трёх профилях сюда шёл `response.id` — первичный ключ
 * прохождения. В обезличенной и анонимной выгрузке это ключ обратной
 * идентификации в чистом виде: берём case_id из CSV, открываем
 * GET /api/reports/responses/<case_id> и читаем ФИО. Обобщение возраста,
 * стирание пола в редких ячейках и отсутствие субъекта при этом ничего не
 * защищали — достаточно было одной колонки, которая печаталась первой.
 *
 * Профили теперь разные, потому что разное обещают:
 *
 *  full — настоящий идентификатор: выгрузка с именами и существует ради
 *    возврата к карте, прятать в ней ключ бессмысленно;
 *
 *  deidentified — HMAC от идентификатора: стабилен между выгрузками (иначе
 *    ломается дозагрузка новой волны к уже собранному датасету) и
 *    необратим без EXPORT_SECRET;
 *
 *  anonymous — случайный код, живущий ровно одну выгрузку. Стабильный
 *    (хоть бы и HMAC) склеивал бы повторные выгрузки между собой — ровно
 *    то, что этот профиль обещает исключить: две выгрузки в разные месяцы
 *    сопоставляются построчно, и «анонимные» наблюдения снова становятся
 *    цепочкой одного человека. Порядковый номер не годится по той же
 *    причине: у старых наблюдений он в двух выгрузках совпадает.
 *    Плата — датасеты разных выгрузок (и wide с long) в этом профиле не
 *    соединяются по case_id. Это не потеря: оба файла содержат одни и те же
 *    наблюдения в разных представлениях, а соединять их между собой и
 *    значит восстанавливать связь, которой в профиле быть не должно.
 */
function caseCoder(profile: ExportProfile): (responseId: string) => string {
  if (profile === "full") return (id) => id;
  if (profile === "deidentified") {
    return (id) => {
      const h = new Bun.CryptoHasher("sha256", env.exportSecret).update(`case:${id}`).digest("hex");
      return `C${h.slice(0, 10).toUpperCase()}`;
    };
  }
  // соль живёт в замыкании одного запроса и нигде не сохраняется
  const salt = crypto.randomUUID();
  return (id) => {
    const h = new Bun.CryptoHasher("sha256").update(`${salt}:${id}`).digest("hex");
    return `A${h.slice(0, 10).toUpperCase()}`;
  };
}

/**
 * Обобщение квазиидентификаторов для обезличенного профиля.
 *
 * Считается по самим выгружаемым строкам, а не по всей базе: защищать надо то,
 * что уходит наружу. Расчёт по базе дал бы «в системе таких много», хотя в
 * этой выгрузке человек один.
 */
async function quasiPlan(
  surveyId: string,
  profile: ExportProfile,
): Promise<Generalization | null> {
  if (profile !== "deidentified") return null;
  const rows = await loadRows(surveyId);
  return generalizeQuasi(
    rows.map((c) => ({
      sex: (c.user?.sex as "male" | "female" | null) ?? null,
      band: bandName(ageAt(decryptField(c.user?.birthDate ?? null), c.response.submittedAt)),
    })),
  );
}

/** Название полосы для k-анонимности; null — возраст неизвестен */
function bandName(age: number | null): AgeBand | null {
  if (age === null) return null;
  if (age < 25) return "<25";
  if (age < 35) return "25-34";
  if (age < 45) return "35-44";
  return "45+";
}

/**
 * Подписи выгрузки — на языке запроса (волна 13).
 *
 * Имена переменных (sex, age_band, q3_ms) — машинные и не переводятся: по
 * ним склеиваются выгрузки разных лет и пишутся скрипты анализа. Подписи
 * к ним («Стать», «чоловіча», «Час відповіді на пункт 3, мс») — то, что
 * исследователь читает в SPSS и в словаре переменных; раньше они были
 * русскими при любом языке и любом ?lang.
 */
function sayer(lang: Lang) {
  return (key: ServerTextKey, params?: TextParams) => serverText(key, lang, params);
}

async function buildSchema(
  surveyId: string,
  /* язык содержимого — названия пунктов и вариантов: схема выгрузки (exportQuery) других не пропускает */
  lang: ContentLang,
  profile: ExportProfile = "full",
  kanon: Generalization | null = null,
  /* язык подписей системы: «Стать», «сирий бал»; английский — законный, в отличие от содержимого */
  labels: Lang = lang,
) {
  const say = sayer(labels);
  const survey = await getSurvey(surveyId, null, lang);
  if (!survey) notFound("err.surveyNotFound");

  const asked = survey.questions.filter((q) => q.type !== "info");
  const used = new Set<string>();
  const unique = (name: string) => {
    let candidate = name;
    let n = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${name.slice(0, 58)}_${n++}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };

  // код наблюдения общий на всю выгрузку: внутри одного файла он обязан
  // совпадать сам с собой, а между выгрузками — по правилам профиля
  const caseOf = caseCoder(profile);
  const vars: Variable[] = [
    {
      name: unique("case_id"),
      spec: "A36",
      label: say(profile === "full" ? "spss.caseIdFull" : "spss.caseIdCode"),
      value: (c) => caseOf(c.response.id),
    },
  ];

  if (profile === "full") {
    vars.push({
      name: unique("subject"),
      spec: "A36",
      label: say("spss.subjectFull"),
      value: (c) => c.response.userId ?? "",
    });
  } else if (profile === "deidentified") {
    vars.push({
      name: unique("subject"),
      spec: "A12",
      label: say("spss.subjectCode"),
      value: (c) => (c.response.userId ? subjectCode(c.response.userId) : ""),
    });
  }
  // anonymous: субъекта нет вовсе — лонгитюд невъзможен намеренно

  vars.push(
    {
      name: unique("sex"),
      spec: "F1.0",
      label: say("spss.sex"),
      values: [
        [1, say("spss.male")],
        [2, say("spss.female")],
      ],
      /*
       * В обезличенном профиле пол проходит через обобщение: у редкой ячейки
       * он стирается, иначе сочетание пола и возраста указывает на человека.
       */
      value: (c) => {
        const sex = kanon
          ? applyQuasi(
              {
                sex: (c.user?.sex as "male" | "female" | null) ?? null,
                band: bandName(ageAt(decryptField(c.user?.birthDate ?? null), c.response.submittedAt)),
              },
              kanon,
            ).sex
          : ((c.user?.sex as "male" | "female" | null) ?? null);
        return sex === "male" ? "1" : sex === "female" ? "2" : String(MISSING);
      },
    },
    ...(profile === "full"
      ? [
          {
            name: unique("age"),
            spec: "F3.0",
            label: say("spss.age"),
            value: (c: RowContext) => String(ageAt(decryptField(c.user?.birthDate ?? null), c.response.submittedAt) ?? MISSING),
          },
          { name: unique("unit"), spec: "A80", label: say("spss.unit"), value: (c: RowContext) => c.user?.unit ?? "" },
          { name: unique("mil_rank"), spec: "A80", label: say("spss.rank"), value: (c: RowContext) => c.user?.rank ?? "" },
          {
            name: unique("sub_date"),
            spec: "A32",
            label: say("spss.submittedAt"),
            value: (c: RowContext) => c.response.submittedAt ?? "",
          },
        ]
      : [
          {
            name: unique("age_band"),
            spec: "F1.0",
            label: say("spss.ageBand"),
            values: [
              [1, say("spss.ageUnder25")],
              [2, "25–34"],
              [3, "35–44"],
              [4, say("spss.age45plus")],
            ] as [number, string][],
            value: (c: RowContext) => {
              const age = ageAt(decryptField(c.user?.birthDate ?? null), c.response.submittedAt);
              if (!kanon) return ageBand(age);
              /*
               * Пол передаётся настоящий: ячейка определяется парой, и с
               * подставленным null ключ не совпал бы с тем, который считался
               * при обобщении, — возраст остался бы на месте у строки, у
               * которой стёрли пол.
               */
              const shown = applyQuasi(
                {
                  sex: (c.user?.sex as "male" | "female" | null) ?? null,
                  band: bandName(age),
                },
                kanon,
              );
              /*
               * Слитые полосы кодируются номером первой из слитых: числовой
               * код обязан остаться числом, а расшифровка слияния лежит в
               * манифесте — там, где её и ищут.
               */
              return shown.band === null ? String(MISSING) : ageBand(age);
            },
          },
          {
            name: unique("sub_month"),
            spec: "A7",
            label: say("spss.submittedMonth"),
            value: (c: RowContext) => c.response.submittedAt?.slice(0, 7) ?? "",
          },
        ]),
    {
      name: unique("dur_min"),
      spec: "F8.2",
      label: say("spss.durationMin"),
      value: (c) => (c.response.durationMs ? (c.response.durationMs / 60000).toFixed(2) : String(MISSING)),
    },
    {
      /*
       * Версия, которой проходили: пункты сопоставлены по позиции, и если
       * правка методики сдвинула смысл пункта, исследователь должен видеть,
       * какие строки из какой версии.
       */
      name: unique("version"),
      spec: "F3.0",
      label: say("spss.version"),
      value: (c) => String(c.version ?? MISSING),
    },
  );

  /*
   * Пункты: переменные по типу вопроса, время и число переключений.
   *
   * Раньше на любой вопрос с вариантами приходилась одна переменная с кодом
   * ПЕРВОГО выбранного варианта (optionIds[0]): у множественного выбора из
   * двух отмеченных в файл попадал один, матрица и ранжирование сводились к
   * «код 1» или пропуску (третье ревью заказчика, P2). Теперь форма — по
   * типу, и словарь переменных строится из той же схемы, поэтому совпадает
   * с данными сам собой:
   *
   *   single / yesno  — одна переменная, код варианта 1…N;
   *   multiple        — переменная на вариант: 1 выбран, 0 нет;
   *   matrix          — переменная на строку: код варианта-столбца;
   *   ranking         — переменная на место: код варианта на этом месте;
   *   scale / slider / number — число как есть;
   *   text / longtext / date — строка, и только в полном профиле (ниже).
   *
   * Пропуск (пункт не отвечен или пропущен) — -99 во всех числовых
   * переменных пункта: «не выбран ни один» у множественного выбора — это
   * нули, а не пропуск, и различать их исследователю нужно.
   */
  for (const q of asked) {
    const base = unique(varName(`q${q.position + 1}`, "q"));
    vars.push(...itemVariables(q, base, unique, profile, labels));
    vars.push({
      name: unique(`${base}_ms`),
      spec: "F8.0",
      label: say("spss.itemMs", { n: q.position + 1 }),
      value: (c) => String(c.answer.get(q.position)?.durationMs ?? MISSING),
    });
    vars.push({
      name: unique(`${base}_chg`),
      spec: "F3.0",
      label: say("spss.itemChanges", { n: q.position + 1 }),
      value: (c) => String(c.answer.get(q.position)?.changeCount ?? MISSING),
    });
  }

  /*
   * Шкалы: сырой балл, итоговое значение в единицах нормализации и признак,
   * что нормировка применилась.
   *
   * Балл ищется по коду шкалы, а не по id: у каждой версии шкалы свои строки.
   * Нормированное — только там, где нормировка действительно применилась
   * (клиническое ревью, P2): если норм для пола и возраста человека не
   * нашлось, в value лежит СЫРОЙ балл (response_scores.normalized = false), и
   * под подписью «T-балл» он читался бы как T-балл. Такая ячейка — пропуск,
   * а признак _nf говорит, почему.
   */
  for (const scale of survey.scales) {
    const base = unique(varName(scale.code, "sc"));
    vars.push({
      name: base,
      spec: "F8.2",
      label: say("spss.scaleRaw", { scale: scale.title }),
      value: (c) => String(c.score.get(scale.code)?.rawScore ?? MISSING),
    });
    vars.push({
      name: unique(`${base}_n`),
      spec: "F8.3",
      label: say(normalizationLabel(scale.normalization), { scale: scale.title }),
      value: (c) => {
        const score = c.score.get(scale.code);
        return score && score.normalized ? String(score.value) : String(MISSING);
      },
    });
    vars.push({
      name: unique(`${base}_nf`),
      spec: "F1.0",
      label: say("spss.scaleNormed", { scale: scale.title }),
      values: [
        [0, say("spss.normedNo")],
        [1, say("spss.yes")],
      ],
      value: (c) => {
        const score = c.score.get(scale.code);
        return score ? (score.normalized ? "1" : "0") : String(MISSING);
      },
    });
  }

  return { survey, vars };
}

type SurveyQuestion = NonNullable<Awaited<ReturnType<typeof getSurvey>>>["questions"][number];

/**
 * Свободный ввод: то, что человек написал сам, а не выбрал.
 *
 * В обезличенную и анонимную выгрузку он не идёт (третье ревью заказчика,
 * P1: имя и телефон из текстового ответа целиком попадали в CSV обоих
 * профилей). Убрать идентификатор пользователя — не значит обезличить
 * содержание: «я, Петренко, 3-я рота, телефон …» остаётся тем, чем было, и
 * никакое обобщение квазиидентификаторов его не касается. Дата — туда же:
 * «дата народження» или день ранения опознают не хуже фамилии.
 *
 * Отдельного профиля «обезличенный, но с текстом» нет намеренно: текст
 * нельзя обезличить механически, а выгрузка, в которой он есть, по сути
 * поимённая — значит, это профиль full, с правом export.full и отметкой
 * freeText в журнале. Безопасное умолчание — без текста; кому текст нужен
 * для исследования, берёт полную выгрузку и отвечает за неё как за полную.
 */
const FREE_INPUT = new Set(["text", "longtext", "date"]);

function isFreeInput(type: string): boolean {
  return FREE_INPUT.has(type);
}

/** Переменные одного пункта по его типу — см. пояснение у цикла пунктов в buildSchema */
function itemVariables(
  q: SurveyQuestion,
  base: string,
  unique: (name: string) => string,
  profile: ExportProfile,
  labels: Lang,
): Variable[] {
  const say = sayer(labels);
  const choices = q.options.filter((o) => o.kind !== "row");
  const rows = q.options.filter((o) => o.kind === "row");
  const codes: [number, string][] = choices.map((o, i) => [i + 1, o.text]);
  /*
   * Код варианта — по его порядковому номеру в своём пункте, а не по id:
   * у прохождения прежней версии id другие (см. RowContext).
   */
  const codeOf = (c: RowContext, optionId: string | undefined) => {
    const idx = optionId === undefined ? undefined : c.optionIndex.get(optionId);
    return idx !== undefined && idx < choices.length ? String(idx + 1) : String(MISSING);
  };
  const title = `${q.position + 1}. ${q.title}`;
  /** Ответ, если он есть и не пропущен; иначе null — пропуск для всех переменных пункта */
  const given = (c: RowContext) => {
    const a = c.answer.get(q.position);
    return a && !a.skipped ? a : null;
  };

  switch (q.type) {
    case "single":
    case "yesno":
      return [
        {
          name: base,
          spec: "F3.0",
          label: title,
          values: codes,
          value: (c) => {
            const a = given(c);
            return a ? codeOf(c, a.optionIds?.[0]) : String(MISSING);
          },
        },
      ];

    case "multiple":
      return choices.map((o, i) => ({
        name: unique(`${base}_${i + 1}`),
        spec: "F1.0",
        label: `${title}: ${o.text}`,
        values: [
          [0, say("spss.notChosen")],
          [1, say("spss.chosen")],
        ] as [number, string][],
        value: (c: RowContext) => {
          const a = given(c);
          if (!a) return String(MISSING);
          return (a.optionIds ?? []).some((id) => c.optionIndex.get(id) === i) ? "1" : "0";
        },
      }));

    case "matrix":
      return rows.map((row, j) => ({
        name: unique(`${base}_r${j + 1}`),
        spec: "F3.0",
        label: `${title}: ${row.text}`,
        values: codes,
        value: (c: RowContext) => {
          const a = given(c);
          if (!a) return String(MISSING);
          // строка — тоже по порядковому номеру среди строк своего пункта
          const key = Object.keys(a.matrix ?? {}).find((rowId) => c.optionIndex.get(rowId) === j);
          return key === undefined ? String(MISSING) : codeOf(c, a.matrix![key]);
        },
      }));

    case "ranking":
      return choices.map((_, k) => ({
        name: unique(`${base}_p${k + 1}`),
        spec: "F3.0",
        label: say("spss.rankPlace", { title, k: k + 1 }),
        values: codes,
        value: (c: RowContext) => {
          const a = given(c);
          return a ? codeOf(c, a.ranking?.[k]) : String(MISSING);
        },
      }));

    case "scale":
    case "slider":
    case "number":
      return [
        {
          name: base,
          spec: "F8.2",
          label: title,
          value: (c) => {
            const a = given(c);
            return a && a.number !== null && a.number !== undefined ? String(a.number) : String(MISSING);
          },
        },
      ];

    case "text":
    case "longtext":
    case "date":
      // свободный ввод — только в полном профиле: см. FREE_INPUT
      if (profile !== "full") return [];
      return [
        {
          name: base,
          spec: q.type === "date" ? "A10" : "A200",
          label: title,
          value: (c) => {
            const a = given(c);
            if (!a) return "";
            return q.type === "date" ? (a.date ?? "") : (decryptField(a.text) ?? "");
          },
        },
      ];

    default:
      return [];
  }
}

function normalizationLabel(n: string): ServerTextKey {
  switch (n) {
    case "tscore":
      return "spss.scaleT";
    case "sten":
      return "spss.scaleSten";
    case "ratio":
      return "spss.scaleRatio";
    default:
      return "spss.scaleFinal";
  }
}

async function loadRows(surveyId: string): Promise<RowContext[]> {
  const rows = await db
    .select({ response: responses, user: users })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")));

  const ids = rows.map((r) => r.response.id);
  const answerRows = ids.length
    ? await db.select().from(answers).where(inArray(answers.responseId, ids))
    : [];
  const scoreRows = ids.length
    ? await db.select().from(responseScores).where(inArray(responseScores.responseId, ids))
    : [];

  /*
   * Словари всех версий методики сразу: позиция пункта, порядковый номер
   * варианта в пункте, код шкалы, номер версии. См. RowContext.
   */
  const [versionRows, questionRows, optionRows, scaleRows] = await Promise.all([
    db.select({ id: surveyVersions.id, version: surveyVersions.version }).from(surveyVersions).where(eq(surveyVersions.surveyId, surveyId)),
    db.select({ id: questions.id, position: questions.position }).from(questions).where(eq(questions.surveyId, surveyId)),
    db
      .select({ id: options.id, questionId: options.questionId, kind: options.kind })
      .from(options)
      .innerJoin(questions, eq(questions.id, options.questionId))
      .where(eq(questions.surveyId, surveyId))
      .orderBy(asc(options.questionId), asc(options.position), asc(options.id)),
    db.select({ id: scales.id, code: scales.code }).from(scales).where(eq(scales.surveyId, surveyId)),
  ]);
  const versionNo = new Map(versionRows.map((v) => [v.id, v.version]));
  const positionOf = new Map(questionRows.map((q) => [q.id, q.position]));
  const codeOf = new Map(scaleRows.map((s) => [s.id, s.code]));
  const optionIndex = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const o of optionRows) {
    // варианты и строки матрицы нумеруются раздельно — как в схеме пункта
    const key = `${o.questionId}:${o.kind === "row" ? "row" : "option"}`;
    const n = seen.get(key) ?? 0;
    optionIndex.set(o.id, n);
    seen.set(key, n + 1);
  }

  return rows.map((r) => {
    const answer = new Map<number, (typeof answerRows)[number]>();
    for (const a of answerRows) {
      if (a.responseId !== r.response.id) continue;
      const position = positionOf.get(a.questionId);
      if (position !== undefined) answer.set(position, a);
    }
    const score = new Map<string, (typeof scoreRows)[number]>();
    for (const s of scoreRows) {
      if (s.responseId !== r.response.id) continue;
      const code = codeOf.get(s.scaleId);
      if (code !== undefined) score.set(code, s);
    }
    return {
      response: r.response,
      user: r.user,
      answer,
      score,
      version: r.response.versionId ? (versionNo.get(r.response.versionId) ?? null) : null,
      optionIndex,
    };
  });
}

/**
 * Профиль и язык выгрузки.
 *
 * Раньше неизвестный профиль молча становился «full»: опечатка в
 * `?profile=deidentifed` отдавала выгрузку с фамилиями тому, кто был уверен,
 * что забирает обезличенную. Теперь — отказ. А без профиля вовсе (или с
 * опечаткой в имени параметра — её ловит `.strict()` схемы) — обезличенная:
 * фамилии уезжают только по слову «full», сказанному явно (волна 12).
 *
 * Здесь же проверяется право на выгрузку с именами. Проверка стоит в разборе
 * параметров, а не строкой middleware, потому что маршрут один, а выгрузок
 * две: обезличенная и с идентификаторами. Закрыть весь набор правом
 * export.full значило бы запретить обезличенную выгрузку тем, кому она
 * разрешена; оставить обе под одним правом значило бы, что различие профилей
 * ничего не значит для доступа — а оно и есть всё различие.
 *
 * Точка одна на все четыре маршрута выгрузки: разложить ту же проверку по
 * маршрутам означало бы завести четыре места, где её можно забыть.
 */
async function exportOptions(c: Context<AppEnv>) {
  const options = parseQuery(c, exportQuery);
  if (options.profile === "full" && !(await hasPermission(c.get("user"), "export.full"))) {
    forbidden("err.permissionRequired", { permission: "export.full" });
  }
  /*
   * Два языка, и они разные (волна 13).
   *
   * Подписи системы — язык запроса: явный ?lang или заголовок, как у
   * любого другого ответа сервера. Содержимое — названия пунктов и
   * вариантов — язык методики: явный ?lang (только uk и ru, английского
   * текста у методик нет) или тот, что t() покажет этому интерфейсу первым
   * (contentLangFor: английскому — украинский).
   *
   * Прежде без ?lang выгрузка была русской целиком — и подписи, и пункты, —
   * какой бы язык ни стоял в консоли.
   */
  const labels = langOf(c);
  return { ...options, lang: options.lang ?? contentLangFor(labels), labels };
}

/** Числовая матрица: варианты закодированы порядковыми номерами */
spssRoutes.get("/surveys/:id/data.csv", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const { profile, lang, labels, purpose } = await exportOptions(c);
  const kanon = await quasiPlan(surveyId, profile);
  const { vars } = await buildSchema(surveyId, lang, profile, kanon, labels);
  const rows = await loadRows(surveyId);

  const body = [
    vars.map((v) => v.name).join(","),
    ...rows.map((ctx) => vars.map((v) => csvCell(v.value(ctx))).join(",")),
  ].join("\r\n");

  // хэш датасета — воспроизводимость: в статье цитируется конкретная выгрузка
  const datasetHash = new Bun.CryptoHasher("sha256").update(body).digest("hex");

  await audit(c, {
    action: "analytics.export",
    resourceType: "survey",
    resourceId: surveyId,
    details: {
      format: "spss-data",
      profile,
      rows: rows.length,
      subjects: [...new Set(rows.map((r) => r.response.userId).filter(Boolean))].length,
      includesUserIds: profile === "full",
      // свободный ввод (текст, даты) уходит только с полным профилем — см. FREE_INPUT
      freeText: profile === "full",
      datasetSha256: datasetHash,
      purpose: purpose ?? null,
      /*
       * Что сделала k-анонимность, попадает в журнал вместе с выгрузкой: без
       * этого «почему у трети строк нет пола» через год объяснить будет
       * нечем.
       */
      kanon: kanon ? { merges: kanon.merges, blankedRows: kanon.blankedRows } : null,
    },
  });

  return new Response(`﻿${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="quizzy-${surveyId}-data.csv"`,
    },
  });
});

/** Синтаксис SPSS: чтение матрицы, метки переменных, метки значений, пропуски */
spssRoutes.get("/surveys/:id/syntax.sps", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const { profile, lang, labels } = await exportOptions(c);
  const { survey, vars } = await buildSchema(surveyId, lang, profile, null, labels);
  const dataFile = `quizzy-${surveyId}-data.csv`;
  const say = sayer(labels);

  const lines: string[] = [
    `* ${say("spss.syntaxFrom", { title: survey.title })}`,
    `* ${say("spss.syntaxDataFile")}`,
    `* ${say("spss.syntaxMissing", { missing: MISSING })}`,
    "",
    "GET DATA",
    "  /TYPE=TXT",
    `  /FILE="${dataFile}"`,
    "  /ENCODING='UTF8'",
    "  /DELIMITERS=','",
    "  /QUALIFIER='\"'",
    "  /ARRANGEMENT=DELIMITED",
    "  /FIRSTCASE=2",
    "  /VARIABLES=",
    ...vars.map((v, i) => `    ${v.name} ${v.spec}${i === vars.length - 1 ? "." : ""}`),
    "",
    "VARIABLE LABELS",
    ...vars.map((v, i) => `  ${v.name} ${sq(v.label)}${i === vars.length - 1 ? "." : ""}`),
    "",
  ];

  const labelled = vars.filter((v) => v.values?.length);
  if (labelled.length) {
    lines.push("VALUE LABELS");
    labelled.forEach((v, i) => {
      lines.push(`  /${v.name}`);
      for (const [code, text] of v.values!) lines.push(`    ${code} ${sq(text)}`);
      if (i === labelled.length - 1) lines[lines.length - 1] += ".";
    });
    lines.push("");
  }

  const numeric = vars.filter((v) => v.spec.startsWith("F"));
  if (numeric.length) {
    lines.push(`MISSING VALUES ${numeric.map((v) => v.name).join(" ")} (${MISSING}).`, "");
  }

  lines.push("EXECUTE.", "");

  await audit(c, {
    action: "analytics.export",
    resourceType: "survey",
    resourceId: surveyId,
    details: { format: "spss-syntax", variables: vars.length, includesUserIds: false },
  });

  return new Response(`﻿${lines.join("\r\n")}`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="quizzy-${surveyId}-syntax.sps"`,
    },
  });
});

/**
 * Codebook: словарь переменных для публикации рядом с датасетом.
 * Включает происхождение норм — читатель обязан знать, относительно какой
 * популяции интерпретировались T-баллы.
 */
spssRoutes.get("/surveys/:id/codebook.csv", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const { profile, lang, labels } = await exportOptions(c);
  const { survey, vars } = await buildSchema(surveyId, lang, profile, null, labels);

  const lines = [["variable", "type", "label", "values"].join(";")];
  for (const v of vars) {
    lines.push(
      [
        v.name,
        v.spec,
        csvCell(v.label),
        csvCell((v.values ?? []).map(([code, text]) => `${code}=${text}`).join(" | ")),
      ].join(";"),
    );
  }
  lines.push("");
  lines.push(["scale", "normalization", "norm_source"].join(";"));
  for (const scale of survey.scales) {
    const sources = [...new Set(scale.norms.map((n) => n.source).filter(Boolean))].join(" | ");
    lines.push([scale.code, scale.normalization, csvCell(sources || "—")].join(";"));
  }

  await audit(c, {
    action: "analytics.export",
    resourceType: "survey",
    resourceId: surveyId,
    details: { format: "codebook", profile, variables: vars.length },
  });

  return new Response(`\ufeff${lines.join("\r\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="quizzy-${surveyId}-codebook.csv"`,
    },
  });
});

/**
 * Long-format выгрузка (8.3): одна строка на пару «прохождение × шкала».
 *
 * Формат, в котором работают R и pandas: не надо разворачивать широкую
 * матрицу, сразу годится для смешанных моделей и графиков по группам.
 * Профили деидентификации те же, что у SPSS-выгрузки; страты берутся из
 * витрины фактов, поэтому в файле уже есть пол, возрастная полоса и язык.
 */
spssRoutes.get("/surveys/:id/long.csv", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const { profile, purpose } = await exportOptions(c);

  const { sql } = await import("drizzle-orm");
  /*
   * Признак нормировки берётся из response_scores: в витрине response_facts
   * его нет (клиническое ревью, P2), а без него сырой балл выгружался в
   * колонку value под именем «T-балл». Витрину саму не трогаем — её правит
   * участок stats; здесь достаточно соединения по паре «прохождение × шкала».
   */
  const rows = await db.execute(sql`
    select f.response_id, f.user_id, f.submitted_at, f.submitted_month, f.lang,
           f.respondent_sex, f.respondent_age_band, f.unit,
           f.scale_code, f.normalization, f.raw_score, f.value, f.band_label, f.severity, f.is_risk,
           s.normalized
    from response_facts f
    join response_scores s on s.response_id = f.response_id and s.scale_id = f.scale_id
    where f.survey_id = ${surveyId} and f.status = 'completed'
    order by f.submitted_at, f.response_id, f.scale_code`);

  type Row = Record<string, unknown>;
  // тот же код наблюдения, что и в широкой выгрузке: см. caseCoder
  const caseOf = caseCoder(profile);
  const header = [
    "case_id",
    profile === "anonymous" ? null : "subject",
    profile === "full" ? "submitted_at" : "submitted_month",
    "lang",
    "sex",
    profile === "full" ? "age_band" : "age_band",
    profile === "full" ? "unit" : null,
    "scale",
    "normalization",
    "raw_score",
    "value",
    "normalized",
    "band",
    "severity",
    "is_risk",
  ].filter((x): x is string => x !== null);

  const body = (rows as unknown as Row[]).map((r) => {
    const subject =
      profile === "full"
        ? String(r.user_id ?? "")
        : profile === "deidentified" && r.user_id
          ? subjectCode(String(r.user_id))
          : "";
    return [
      caseOf(String(r.response_id)),
      profile === "anonymous" ? null : subject,
      profile === "full" ? String(r.submitted_at ?? "") : String(r.submitted_month ?? ""),
      String(r.lang ?? ""),
      String(r.respondent_sex ?? ""),
      String(r.respondent_age_band ?? ""),
      profile === "full" ? String(r.unit ?? "") : null,
      String(r.scale_code),
      String(r.normalization ?? ""),
      String(r.raw_score ?? ""),
      // нормированное — только если нормировка применилась; иначе пусто, а не сырой балл
      r.normalized ? String(r.value ?? "") : "",
      r.normalized ? "1" : "0",
      String(r.band_label ?? ""),
      String(r.severity ?? ""),
      r.is_risk ? "1" : "0",
    ]
      .filter((x): x is string => x !== null)
      .map(csvCell)
      .join(",");
  });

  const csv = [header.join(","), ...body].join("\r\n");
  const datasetHash = new Bun.CryptoHasher("sha256").update(csv).digest("hex");

  await audit(c, {
    action: "analytics.export",
    resourceType: "survey",
    resourceId: surveyId,
    details: {
      format: "long",
      profile,
      rows: body.length,
      includesUserIds: profile === "full",
      datasetSha256: datasetHash,
      purpose: purpose ?? null,
    },
  });

  return new Response(`\ufeff${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="quizzy-${surveyId}-long.csv"`,
    },
  });
});


/**
 * Снимок параметров выгрузки: манифест.
 *
 * Хэш датасета уже есть, и он отвечает на вопрос «та ли это выгрузка». Но не
 * отвечает на «как её повторить»: какие версии методик применялись, какие
 * нормы, какой профиль обезличивания. Через год, когда статью попросят
 * пересчитать, восстановить это будет неоткуда.
 *
 * Манифест кладут рядом с данными, и в нём нет ни одной строки самих данных.
 */
spssRoutes.get("/surveys/:id/manifest.json", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const { profile, lang, labels, purpose } = await exportOptions(c);
  const kanon = await quasiPlan(surveyId, profile);
  const { survey, vars } = await buildSchema(surveyId, lang, profile, kanon, labels);
  const say = sayer(labels);

  const versionRows = await db
    .select({ id: surveyVersions.id, version: surveyVersions.version, createdAt: surveyVersions.createdAt, note: surveyVersions.note })
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, surveyId))
    .orderBy(surveyVersions.version);

  const used = await db
    .select({ versionId: responses.versionId, n: sql<number>`count(*)::int` })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")))
    .groupBy(responses.versionId);
  const countByVersion = new Map(used.map((u) => [u.versionId, Number(u.n)]));

  const manifest = {
    survey: { id: surveyId, title: survey.title },
    exportedAt: new Date().toISOString(),
    profile,
    lang,
    /* язык подписей и пояснений — отдельно от языка содержимого (см. exportOptions) */
    labels,
    purpose: purpose ?? null,
    /*
     * Версии перечислены все, а не только использованные: отсутствие
     * прохождений у версии — тоже факт, и «этой версией никто не проходил»
     * приходится восстанавливать иначе.
     */
    versions: versionRows.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      note: v.note,
      responses: countByVersion.get(v.id) ?? 0,
    })),
    variables: vars.map((v) => v.name),
    /*
     * Свободный ввод в обезличенных профилях не выгружается (FREE_INPUT).
     * Сказано прямо, с номерами пунктов: иначе исследователь решит, что на
     * текстовые вопросы никто не ответил.
     */
    freeText:
      profile === "full"
        ? { included: true, excludedItems: [] }
        : {
            included: false,
            excludedItems: survey.questions.filter((q) => isFreeInput(q.type)).map((q) => q.position + 1),
            note: say("spss.freeTextNote"),
          },
    /*
     * Что сделано ради k-анонимности. Без этого раздела исследователь увидит
     * пропуски в поле «пол» и посчитает их случайными — а они не случайные:
     * пропущено ровно то, что было редким.
     */
    kanon: kanon
      ? {
          k: 5,
          merges: kanon.merges,
          bandMap: kanon.bandMap,
          blankedRows: kanon.blankedRows,
          note: say("spss.kanonNote"),
        }
      : null,
    /*
     * Нормы — часть параметров: T-балл, посчитанный по другим нормам, это
     * другое число под тем же именем.
     */
    norms: survey.scales.map((sc) => ({
      code: sc.code,
      normalization: sc.normalization,
      norms: sc.norms.map((n) => ({ sex: n.sex, mean: n.mean, sd: n.sd })),
      stenRows: sc.stenTable.length,
    })),
  };

  await audit(c, {
    action: "analytics.export",
    resourceType: "survey",
    resourceId: surveyId,
    details: { format: "manifest", profile, purpose: purpose ?? null },
  });

  return c.json(manifest);
});

/**
 * Готовые скрипты загрузки для R и Python.
 *
 * Не украшение: выгрузка, которую каждый читает своим способом, читается
 * по-разному. Типы колонок, кодировка, разделитель, пропуски — четыре места,
 * где два исследователя получат два датасета из одного файла.
 */
/*
 * Расширение отдельным сегментом, а не после точки: точка перед параметром
 * маршрутизатором не разбирается, и адрес молча превращался в 404.
 */
spssRoutes.get("/surveys/:id/load/:ext", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const ext = c.req.param("ext");
  if (ext !== "r" && ext !== "py") notFound("err.scriptNotFound");
  const { profile, lang, labels } = await exportOptions(c);
  const { vars } = await buildSchema(surveyId, lang, profile, null, labels);
  const say = sayer(labels);

  const dataFile = `quizzy-${surveyId}-data.csv`;
  const codeFile = `quizzy-${surveyId}-codebook.csv`;
  const factors = vars.filter((v) => v.values?.length).map((v) => v.name);

  const script =
    ext === "r"
      ? [
          ...comment(say("spss.loadTitle", { tool: "R" })),
          ...comment(say("spss.loadFormat")),
          "",
          `data <- read.csv("${dataFile}", fileEncoding = "UTF-8-BOM", na.strings = c(""))`,
          `codebook <- read.csv("${codeFile}", fileEncoding = "UTF-8-BOM")`,
          "",
          ...comment(say("spss.loadFactorsR")),
          ...factors.map((name) => `data$${name} <- factor(data$${name})`),
          "",
          "str(data)",
        ].join("\n")
      : [
          ...comment(say("spss.loadTitle", { tool: "Python" })),
          ...comment(say("spss.loadFormat")),
          "",
          "import pandas as pd",
          "",
          `data = pd.read_csv("${dataFile}", encoding="utf-8-sig", keep_default_na=False, na_values=[""])`,
          `codebook = pd.read_csv("${codeFile}", encoding="utf-8-sig")`,
          "",
          ...comment(say("spss.loadFactorsPy")),
          ...factors.map((name) => `data["${name}"] = data["${name}"].astype("category")`),
          "",
          "print(data.dtypes)",
        ].join("\n");

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="quizzy-${surveyId}-load.${ext}"`,
    },
  });
});

/**
 * Комментарий скрипта: «# » и перенос по словам на 72 знаках.
 *
 * Прежде фразы были разрезаны на строки руками — по-русски. Перевод длиннее
 * или короче, и ручной разрез в нём лёг бы посреди слова или оставил бы
 * строку в двести знаков; режем по словам после перевода.
 */
function comment(text: string, width = 72): string[] {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(/\s+/)) {
    if (line.length > 1 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  if (line.length > 1) lines.push(line);
  return lines;
}
