import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { ageAt } from "@quizzy/shared";
import { db } from "../db";
import { answers, responseScores, responses, users } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { notFound } from "../lib/http";
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
async function buildSchema(surveyId: string, lang: string) {
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
    {
      name: unique("subject"),
      spec: "A36",
      label: "Идентификатор обследуемого",
      value: (c) => c.response.userId ?? "",
    },
    {
      name: unique("sex"),
      spec: "F1.0",
      label: "Пол",
      values: [
        [1, "мужской"],
        [2, "женский"],
      ],
      value: (c) => (c.user?.sex === "male" ? "1" : c.user?.sex === "female" ? "2" : String(MISSING)),
    },
    {
      name: unique("age"),
      spec: "F3.0",
      label: "Возраст на момент обследования, полных лет",
      value: (c) => String(ageAt(decryptField(c.user?.birthDate ?? null), c.response.submittedAt) ?? MISSING),
    },
    { name: unique("unit"), spec: "A80", label: "Подразделение", value: (c) => c.user?.unit ?? "" },
    { name: unique("mil_rank"), spec: "A80", label: "Звание", value: (c) => c.user?.rank ?? "" },
    {
      name: unique("sub_date"),
      spec: "A32",
      label: "Дата и время завершения",
      value: (c) => c.response.submittedAt ?? "",
    },
    {
      name: unique("dur_min"),
      spec: "F8.2",
      label: "Длительность прохождения, минут",
      value: (c) => (c.response.durationMs ? (c.response.durationMs / 60000).toFixed(2) : String(MISSING)),
    },
  ];

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

/** Числовая матрица: варианты закодированы порядковыми номерами */
spssRoutes.get("/surveys/:id/data.csv", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const { vars } = await buildSchema(surveyId, c.req.query("lang") ?? "ru");
  const rows = await loadRows(surveyId);

  const body = [
    vars.map((v) => v.name).join(","),
    ...rows.map((ctx) => vars.map((v) => csvCell(v.value(ctx))).join(",")),
  ].join("\r\n");

  await audit(c, {
    action: "analytics.export",
    resourceType: "survey",
    resourceId: surveyId,
    details: {
      format: "spss-data",
      rows: rows.length,
      subjects: [...new Set(rows.map((r) => r.response.userId).filter(Boolean))].length,
      includesUserIds: true,
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
  const { survey, vars } = await buildSchema(surveyId, c.req.query("lang") ?? "ru");
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
