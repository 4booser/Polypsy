import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ageAt, ageBandOf, answerScore, computeProfile, type Answer, type StatModelColumn } from "@quizzy/shared";
import { db } from "../db";
import { answers, filterPresets, responseScores, responses, statModels, surveys, users } from "../db/schema";
import { decryptField } from "../lib/crypto";
import { getSurvey } from "../lib/surveys";

/**
 * Посев раздела «Статистика»: населённые пункты пациентам, прохождения
 * демонстрационных методик пулом пациентов, два пресета и две модели.
 *
 * Отдельным модулем, а не внутри seed.ts: тот и так на тысячу строк, и
 * раздел с собственными сущностями должен быть виден одним файлом. Вызов
 * — одной строкой в конце seed.ts. Всё здесь дополняет посев, ничего не
 * удаляет и не переписывает: каждая часть пропускается, если уже есть.
 *
 * ═══ Почему свои прохождения, а не те, что насыпал seed.ts ═══
 *
 * Основной посев отдаёт прохождения демонстрационных методик двум людям
 * (user@ и user2@) — сорок шесть бланков от двоих. Для аналитики методики
 * это годится, для статистики по людям — нет: респондент считается по
 * последнему сданному прохождению, и любая колонка сводилась бы к двоим,
 * то есть всегда под порогом. Здесь по одному прохождению каждому из пула:
 * получается четырнадцать человек, и колонки можно развести по обе стороны
 * порога — ради этого раздел и показывают.
 *
 * Критические пункты обходятся стороной: вариант с riskFlag здесь не
 * выбирается, иначе посев заводил бы случаи риска без тревог, которые их
 * объясняют, — а этим занимается основной посев своим кодом.
 */

/** Детерминированный генератор: посев воспроизводим между запусками */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const random = makeRandom(7);
const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)]!;

const POOL_EMAILS = [
  ...Array.from({ length: 12 }, (_, i) => `patient${i + 1}@quizzy.dev`),
  "user@quizzy.dev",
  "user2@quizzy.dev",
];

/**
 * Города по индексу пациента: пятеро в Киеве, четверо в Харькове, трое во
 * Львове, user@ — Киев, user2@ — Одесса. Разложены так, чтобы «Київ» был
 * над порогом малых чисел, а «Львів» — под ним: модель ниже показывает
 * на них подавление.
 */
function localityFor(index: number): string {
  if (index === 12) return "Київ";
  if (index === 13) return "Одеса";
  if (index < 5) return "Київ";
  if (index < 9) return "Харків";
  return "Львів";
}

async function surveyByTitle(uk: string) {
  const [row] = await db
    .select()
    .from(surveys)
    .where(sql`${surveys.title}->>'uk' = ${uk}`)
    .limit(1);
  return row ?? null;
}

/** Одно прохождение методики человеком — как generateResponses в seed.ts, без ленты событий */
async function respond(surveyId: string, person: typeof users.$inferSelect, daysAgo: number): Promise<void> {
  const survey = await getSurvey(surveyId);
  if (!survey) return;
  const startedAt = new Date(Date.now() - daysAgo * 86_400_000 - Math.floor(random() * 8) * 3_600_000);

  const generated: Answer[] = [];
  for (const question of survey.questions) {
    if (question.type === "info") continue;
    const answer: Answer = {
      questionId: question.id,
      durationMs: Math.round(2000 + random() * 12000),
      changeCount: random() < 0.2 ? 1 : 0,
      visitCount: 1,
    };
    const choices = question.options.filter((o) => o.kind === "option" && !o.riskFlag);
    const rows = question.options.filter((o) => o.kind === "row");
    switch (question.type) {
      case "single":
      case "yesno":
        answer.optionIds = [pick(choices).id];
        break;
      case "multiple":
        answer.optionIds = choices.filter(() => random() < 0.4).map((o) => o.id);
        if (!answer.optionIds.length) answer.optionIds = [pick(choices).id];
        break;
      case "matrix":
        answer.matrix = Object.fromEntries(rows.map((r) => [r.id, pick(choices).id]));
        break;
      case "ranking":
        answer.ranking = [...choices].sort(() => random() - 0.5).map((o) => o.id);
        break;
      case "scale":
      case "slider":
      case "number": {
        const min = question.minValue ?? 0;
        const max = question.maxValue ?? 10;
        answer.number = Math.round(min + random() * (max - min));
        break;
      }
      default:
        answer.skipped = true;
    }
    generated.push(answer);
  }

  const birthDate = decryptField(person.birthDate);
  const age = ageAt(birthDate, startedAt.toISOString());
  const profile = computeProfile(survey, generated, { sex: person.sex, age });
  const responseId = crypto.randomUUID();
  const durationMs = generated.reduce((sum, a) => sum + (a.durationMs ?? 0), 0);

  await db.transaction(async (tx) => {
    await tx.insert(responses).values({
      id: responseId,
      surveyId,
      userId: person.id,
      versionId: survey.versionId,
      status: "completed",
      startedAt: startedAt.toISOString(),
      submittedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
      durationMs,
      respondentSex: person.sex,
      respondentAgeBand: ageBandOf(age),
      lang: "uk",
      source: "self",
    });
    for (const a of generated) {
      const question = survey.questions.find((q) => q.id === a.questionId)!;
      await tx.insert(answers).values({
        id: crypto.randomUUID(),
        responseId,
        questionId: a.questionId,
        optionIds: a.optionIds ?? null,
        number: a.number ?? null,
        matrix: a.matrix ?? null,
        ranking: a.ranking ?? null,
        skipped: a.skipped ?? false,
        score: survey.scoringEnabled ? answerScore(question, a) : null,
        durationMs: a.durationMs ?? 0,
        changeCount: a.changeCount ?? 0,
        visitCount: 1,
      });
    }
    for (const score of profile.scores) {
      await tx.insert(responseScores).values({
        id: crypto.randomUUID(),
        responseId,
        scaleId: score.scaleId,
        rawScore: score.rawScore,
        value: score.value,
        normalization: score.normalization,
        maxScore: score.maxScore,
        percent: score.percent,
        normalized: score.normalized,
        bandLabel: score.band?.label ?? null,
        severity: score.band?.severity ?? null,
      });
    }
  });
}

async function upsertPreset(ownerId: string, title: string, criteria: Record<string, unknown>) {
  const existing = await db.query.filterPresets.findFirst({
    where: and(eq(filterPresets.ownerId, ownerId), eq(filterPresets.title, title)),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(filterPresets)
    .values({ id: crypto.randomUUID(), ownerId, title, criteria })
    .returning();
  console.log(`  пресет фильтров: ${title}`);
  return row!;
}

async function upsertModel(ownerId: string, title: string, description: string, columns: StatModelColumn[]) {
  const existing = await db.query.statModels.findFirst({
    where: and(eq(statModels.ownerId, ownerId), eq(statModels.title, title)),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(statModels)
    .values({ id: crypto.randomUUID(), ownerId, title, description, columns })
    .returning();
  console.log(`  статистическая модель: ${title}`);
  return row!;
}

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export async function seedStatModels(): Promise<void> {
  const psy = await db.query.users.findFirst({ where: eq(users.email, "psy@quizzy.dev") });
  const emotional = await surveyByTitle("Скринінг емоційного стану (демо)");
  const sleep = await surveyByTitle("Якість сну (демо)");
  if (!psy || !emotional?.currentVersionId || !sleep?.currentVersionId) {
    console.log("  статистика: нет демонстрационных методик или психолога — пропуск");
    return;
  }

  /* населённые пункты — только тем, у кого поле пусто: заполненное руками не трогаем */
  const people = await db.select().from(users).where(inArray(users.email, POOL_EMAILS));
  const byEmail = new Map(people.map((p) => [p.email, p]));
  let localized = 0;
  for (const [index, email] of POOL_EMAILS.entries()) {
    const person = byEmail.get(email);
    if (!person || person.locality) continue;
    await db.update(users).set({ locality: localityFor(index) }).where(and(eq(users.id, person.id), isNull(users.locality)));
    localized += 1;
  }
  if (localized) console.log(`  населённый пункт выдан пациентам: ${localized}`);

  /* по одному прохождению каждой демо-методики от каждого из пула — если ещё нет */
  let made = 0;
  for (const survey of [emotional, sleep]) {
    const done = await db
      .select({ userId: responses.userId })
      .from(responses)
      .where(and(eq(responses.surveyId, survey.id), inArray(responses.userId, people.map((p) => p.id))));
    const already = new Set(done.map((r) => r.userId));
    for (const [index, email] of POOL_EMAILS.entries()) {
      const person = byEmail.get(email);
      if (!person || already.has(person.id)) continue;
      await respond(survey.id, person, 3 + ((index * 7) % 40));
      made += 1;
    }
  }
  if (made) console.log(`  прохождений демо-методик пулом пациентов: ${made}`);

  /* пресеты — как чипы на кадре f26: «вік + стать» и «населений пункт + дата» */
  const men = await upsertPreset(psy.id, "Чоловіки 25–45 років", { sex: "male", ageMin: 25, ageMax: 45 });
  const kyiv = await upsertPreset(psy.id, "Київ за останні пів року", { locality: "Київ", from: isoDaysAgo(180) });

  /* модель 1: тревога у мужчин 25–45 против женщин — обе колонки над порогом */
  const emo = await getSurvey(emotional.id, emotional.currentVersionId, "uk");
  const anxiety = emo?.scales.find((s) => s.code === "anxiety");
  const riskQuestion = emo?.questions.find((q) => q.type === "single" && q.options.some((o) => o.riskFlag));
  if (emo && anxiety && riskQuestion) {
    const indicators = {
      bands: anxiety.bands.map((b) => ({ scaleId: anxiety.id, bandId: b.id, highRisk: b.severity === "severe" })),
      questions: [
        {
          questionId: riskQuestion.id,
          options: riskQuestion.options
            .filter((o) => o.kind === "option")
            .map((o) => ({ optionId: o.id, highRisk: o.riskFlag })),
        },
      ],
    };
    await upsertModel(
      psy.id,
      "Тривога: чоловіки 25–45 проти жінок",
      "Скринінг емоційного стану (демо): полоси шкали «Тривога» та відповіді на пункт про думки про небажання жити. «ВШР» — виражена тривога і відповіді «Зрідка» / «Часто».",
      [
        { title: "Чоловіки 25–45", presetId: men.id, filters: null, surveyId: emo.id, versionId: emo.versionId!, ...indicators },
        { title: "Жінки", presetId: null, filters: { sex: "female" }, surveyId: emo.id, versionId: emo.versionId!, ...indicators },
      ],
    );
  }

  /* модель 2: сон в Киеве против Львова — вторая колонка под порогом, видно подавление */
  const slp = await getSurvey(sleep.id, sleep.currentVersionId, "uk");
  const sleepScale = slp?.scales.find((s) => s.code === "sleep");
  const obstacles = slp?.questions.find((q) => q.type === "multiple");
  if (slp && sleepScale && obstacles) {
    const options = obstacles.options.filter((o) => o.kind === "option");
    const indicators = {
      bands: sleepScale.bands.map((b) => ({ scaleId: sleepScale.id, bandId: b.id, highRisk: b.severity === "severe" })),
      questions: [
        {
          questionId: obstacles.id,
          // «Нав'язливі думки» — первый вариант — помечен «ВШР»: сон, который не даёт тревога, а не шум
          options: options.map((o, i) => ({ optionId: o.id, highRisk: i === 0 })),
        },
      ],
    };
    await upsertModel(
      psy.id,
      "Сон: Київ проти Львова",
      "Якість сну (демо): полоси шкали «Порушення сну» і відповіді «Що заважає вам засинати?». У Львові менше п'яти респондентів — колонка показує поріг малих чисел.",
      [
        { title: "Київ", presetId: kyiv.id, filters: null, surveyId: slp.id, versionId: slp.versionId!, ...indicators },
        { title: "Львів", presetId: null, filters: { locality: "Львів" }, surveyId: slp.id, versionId: slp.versionId!, ...indicators },
      ],
    );
  }
}
