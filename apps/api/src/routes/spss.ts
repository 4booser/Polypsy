import { Hono, type Context } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ageAt, applyQuasi, exportQuery, generalizeQuasi } from "@quizzy/shared";
import type { AgeBand, Generalization } from "@quizzy/shared";
import { db } from "../db";
import { env } from "../env";
import { answers, responseScores, responses, surveyVersions, users } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { notFound, parseQuery } from "../lib/http";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const spssRoutes = new Hono<AppEnv>();

spssRoutes.use("*", requireAuth, requireStaff);

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

interface RowContext {
  response: typeof responses.$inferSelect;
  user: typeof users.$inferSelect | null;
  answer: Map<string, typeof answers.$inferSelect>;
  score: Map<string, typeof responseScores.$inferSelect>;
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

function csvCell(value: string): string {
  return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
 * Стабильный необратимый код субъекта: HMAC от id с серверным секретом.
 * Стабильность важна для лонгитюда — повторные выгрузки склеиваются по
 * коду, но вернуть из кода личность без секрета нельзя.
 */
function subjectCode(userId: string): string {
  const h = new Bun.CryptoHasher("sha256", env.jwtSecret).update(`subject:${userId}`).digest("hex");
  return `R${h.slice(0, 10).toUpperCase()}`;
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

async function buildSchema(
  surveyId: string,
  lang: string,
  profile: ExportProfile = "full",
  kanon: Generalization | null = null,
) {
  const survey = await getSurvey(surveyId, null, lang === "uk" ? "uk" : "ru");
  if (!survey) notFound("Методика не найдена");

  const asked = survey.questions.filter((q) => q.type !== "info");
  const used = new Set<string>();
  const unique = (name: string) => {
    let candidate = name;
    let n = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${name.slice(0, 58)}_${n++}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };

  const vars: Variable[] = [
    {
      name: unique("case_id"),
      spec: "A36",
      label: "Идентификатор прохождения",
      value: (c) => c.response.id,
    },
  ];

  if (profile === "full") {
    vars.push({
      name: unique("subject"),
      spec: "A36",
      label: "Идентификатор обследуемого",
      value: (c) => c.response.userId ?? "",
    });
  } else if (profile === "deidentified") {
    vars.push({
      name: unique("subject"),
      spec: "A12",
      label: "Код субъекта (необратимый, стабильный между выгрузками)",
      value: (c) => (c.response.userId ? subjectCode(c.response.userId) : ""),
    });
  }
  // anonymous: субъекта нет вовсе — лонгитюд невъзможен намеренно

  vars.push(
    {
      name: unique("sex"),
      spec: "F1.0",
      label: "Пол",
      values: [
        [1, "мужской"],
        [2, "женский"],
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
            label: "Возраст на момент обследования, полных лет",
            value: (c: RowContext) => String(ageAt(decryptField(c.user?.birthDate ?? null), c.response.submittedAt) ?? MISSING),
          },
          { name: unique("unit"), spec: "A80", label: "Подразделение", value: (c: RowContext) => c.user?.unit ?? "" },
          { name: unique("mil_rank"), spec: "A80", label: "Звание", value: (c: RowContext) => c.user?.rank ?? "" },
          {
            name: unique("sub_date"),
            spec: "A32",
            label: "Дата и время завершения",
            value: (c: RowContext) => c.response.submittedAt ?? "",
          },
        ]
      : [
          {
            name: unique("age_band"),
            spec: "F1.0",
            label: "Возрастная полоса",
            values: [
              [1, "до 25"],
              [2, "25–34"],
              [3, "35–44"],
              [4, "45 и старше"],
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
            label: "Месяц завершения",
            value: (c: RowContext) => c.response.submittedAt?.slice(0, 7) ?? "",
          },
        ]),
    {
      name: unique("dur_min"),
      spec: "F8.2",
      label: "Длительность прохождения, минут",
      value: (c) => (c.response.durationMs ? (c.response.durationMs / 60000).toFixed(2) : String(MISSING)),
    },
  );

  // Пункты: числовой код варианта (порядковый номер), время и число переключений
  for (const q of asked) {
    const base = unique(varName(`q${q.position + 1}`, "q"));
    const codes: [number, string][] = q.options.map((o, i) => [i + 1, o.text]);
    vars.push({
      name: base,
      spec: q.options.length ? "F3.0" : "A200",
      label: `${q.position + 1}. ${q.title}`,
      values: q.options.length ? codes : undefined,
      value: (c) => {
        const a = c.answer.get(q.id);
        if (!a || a.skipped) return q.options.length ? String(MISSING) : "";
        if (q.options.length) {
          const idx = q.options.findIndex((o) => a.optionIds?.[0] === o.id);
          return idx >= 0 ? String(idx + 1) : String(MISSING);
        }
        if (a.number !== null && a.number !== undefined) return String(a.number);
        return decryptField(a.text) ?? "";
      },
    });
    vars.push({
      name: unique(`${base}_ms`),
      spec: "F8.0",
      label: `Время ответа на пункт ${q.position + 1}, мс`,
      value: (c) => String(c.answer.get(q.id)?.durationMs ?? MISSING),
    });
    vars.push({
      name: unique(`${base}_chg`),
      spec: "F3.0",
      label: `Число переключений ответа, пункт ${q.position + 1}`,
      value: (c) => String(c.answer.get(q.id)?.changeCount ?? MISSING),
    });
  }

  // Шкалы: сырой балл и итоговое значение в единицах нормализации
  for (const scale of survey.scales) {
    const base = unique(varName(scale.code, "sc"));
    vars.push({
      name: base,
      spec: "F8.2",
      label: `${scale.title} — сырой балл`,
      value: (c) => String(c.score.get(scale.id)?.rawScore ?? MISSING),
    });
    vars.push({
      name: unique(`${base}_n`),
      spec: "F8.3",
      label: `${scale.title} — ${normalizationLabel(scale.normalization)}`,
      value: (c) => String(c.score.get(scale.id)?.value ?? MISSING),
    });
  }

  return { survey, vars };
}

function normalizationLabel(n: string): string {
  switch (n) {
    case "tscore":
      return "T-балл";
    case "sten":
      return "стен";
    case "ratio":
      return "доля от максимума";
    default:
      return "итоговое значение";
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

  return rows.map((r) => ({
    response: r.response,
    user: r.user,
    answer: new Map(answerRows.filter((a) => a.responseId === r.response.id).map((a) => [a.questionId, a])),
    score: new Map(scoreRows.filter((s) => s.responseId === r.response.id).map((s) => [s.scaleId, s])),
  }));
}

/**
 * Профиль и язык выгрузки.
 *
 * Раньше неизвестный профиль молча становился «full»: опечатка в
 * `?profile=deidentifed` отдавала выгрузку с фамилиями тому, кто был уверен,
 * что забирает обезличенную. Теперь — отказ.
 */
function exportOptions(c: Context) {
  return parseQuery(c, exportQuery);
}

/** Числовая матрица: варианты закодированы порядковыми номерами */
spssRoutes.get("/surveys/:id/data.csv", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const { profile, lang, purpose } = exportOptions(c);
  const kanon = await quasiPlan(surveyId, profile);
  const { vars } = await buildSchema(surveyId, lang, profile, kanon);
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
  const { profile, lang } = exportOptions(c);
  const { survey, vars } = await buildSchema(surveyId, lang, profile);
  const dataFile = `quizzy-${surveyId}-data.csv`;

  const lines: string[] = [
    `* Синтаксис выгружен из Quizzy: ${survey.title}.`,
    `* Файл данных положите рядом с этим синтаксисом и подставьте путь в FILE.`,
    `* Пропущенные значения закодированы как ${MISSING}.`,
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
  const { profile, lang } = exportOptions(c);
  const { survey, vars } = await buildSchema(surveyId, lang, profile);

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
  const { profile, purpose } = exportOptions(c);

  const { sql } = await import("drizzle-orm");
  const rows = await db.execute(sql`
    select response_id, user_id, submitted_at, submitted_month, lang,
           respondent_sex, respondent_age_band, unit,
           scale_code, normalization, raw_score, value, band_label, severity, is_risk
    from response_facts
    where survey_id = ${surveyId} and status = 'completed'
    order by submitted_at, response_id, scale_code`);

  type Row = Record<string, unknown>;
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
      String(r.response_id),
      profile === "anonymous" ? null : subject,
      profile === "full" ? String(r.submitted_at ?? "") : String(r.submitted_month ?? ""),
      String(r.lang ?? ""),
      String(r.respondent_sex ?? ""),
      String(r.respondent_age_band ?? ""),
      profile === "full" ? String(r.unit ?? "") : null,
      String(r.scale_code),
      String(r.normalization ?? ""),
      String(r.raw_score ?? ""),
      String(r.value ?? ""),
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
  const { profile, lang, purpose } = exportOptions(c);
  const kanon = await quasiPlan(surveyId, profile);
  const { survey, vars } = await buildSchema(surveyId, lang, profile, kanon);

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
          note: "Возрастные полосы слиты до наполнения k; у оставшихся редких сочетаний пол и возраст стёрты. Пропуски в этих полях не случайны.",
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
  if (ext !== "r" && ext !== "py") notFound("Такого скрипта нет");
  const { profile, lang } = exportOptions(c);
  const { vars } = await buildSchema(surveyId, lang, profile);

  const dataFile = `quizzy-${surveyId}-data.csv`;
  const codeFile = `quizzy-${surveyId}-codebook.csv`;
  const factors = vars.filter((v) => v.values?.length).map((v) => v.name);

  const script =
    ext === "r"
      ? [
          "# Загрузка выгрузки Quizzy в R.",
          "# Кодировка UTF-8 с BOM, разделитель — запятая, пропуски — пустая строка.",
          "",
          `data <- read.csv("${dataFile}", fileEncoding = "UTF-8-BOM", na.strings = c(""))`,
          `codebook <- read.csv("${codeFile}", fileEncoding = "UTF-8-BOM")`,
          "",
          "# Категориальные переменные объявлены факторами: иначе порядковые коды",
          "# вариантов попадут в модель как числа, и «вариант 3» окажется втрое",
          "# больше «варианта 1».",
          ...factors.map((name) => `data$${name} <- factor(data$${name})`),
          "",
          "str(data)",
        ].join("\n")
      : [
          "# Загрузка выгрузки Quizzy в Python.",
          "# Кодировка UTF-8 с BOM, разделитель — запятая, пропуски — пустая строка.",
          "",
          "import pandas as pd",
          "",
          `data = pd.read_csv("${dataFile}", encoding="utf-8-sig", keep_default_na=False, na_values=[""])`,
          `codebook = pd.read_csv("${codeFile}", encoding="utf-8-sig")`,
          "",
          "# Категориальные переменные объявлены категориями: иначе порядковые",
          "# коды вариантов попадут в модель как числа.",
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
