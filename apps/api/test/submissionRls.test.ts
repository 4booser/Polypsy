import { afterAll, describe, expect, test } from "bun:test";
import {
  adminA,
  api,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  groupAdmins,
  makeUser,
  root,
  sql,
  surveys,
} from "./fixtures";
import { alertCases, decisionRules, responses, riskAlerts, ruleHits } from "../src/db/schema";
import { baseDb } from "../src/db";
import { asSystem, withDbContext } from "../src/db/context";
import { underAppRole } from "./appRole";

/**
 * Отправка прохождения под боевой ролью базы.
 *
 * Вся остальная сюита ходит владельцем базы, а владелец политики строк
 * обходит. Поэтому в бою обнаружилось то, чего сюита показать не могла:
 * прохождение с критическим пунктом падало с «new row violates row-level
 * security policy for table "alert_cases"» — случай для дежурного писался
 * под ролью пациента, которому очередь разбора закрыта намеренно. Транзакция
 * откатывалась, ответы пропадали, человек с тревожным сигналом оставался
 * незамеченным. Здесь тот же путь прогоняется отдельным процессом под ролью
 * без прав владельца — как в бою.
 *
 * Мутация: убрать asSystem из attachToCase — первый тест падает с той самой
 * ошибкой политики на alert_cases; убрать asSystem вокруг applyRules —
 * срабатывания правила нет (rule_hits закрыта пациенту, а движок правил
 * ошибку глотает).
 */

/* методика с критическим пунктом и тяжёлой полосой — оба пути к случаю */
const surveyId = crypto.randomUUID();
const draft = createSurveySchema.parse({
  title: { uk: "Скринінг із критичним пунктом", ru: "Скрининг с критическим пунктом" },
  administration: "self",
  scoringEnabled: true,
  questions: [
    {
      type: "single",
      title: { uk: "Чи були думки, що краще не жити?", ru: "Были ли мысли, что лучше не жить?" },
      required: true,
      scaleCode: "S",
      options: [
        /* критический вариант стоит первым: сдача берёт options[0] */
        {
          text: { uk: "Часто", ru: "Часто" },
          score: 3,
          riskFlag: true,
          riskLabel: { uk: "Часті думки про небажання жити", ru: "Частые мысли о нежелании жить" },
          riskSeverity: "severe",
        },
        { text: { uk: "Ні", ru: "Нет" }, score: 0 },
      ],
    },
  ],
  scales: [
    {
      code: "S",
      title: { uk: "Тяжкість стану", ru: "Тяжесть состояния" },
      kind: "clinical",
      normalization: "raw",
      key: [{ item: 1 }],
      bands: [
        { minScore: 0, maxScore: 1, label: { uk: "Немає", ru: "Нет" }, severity: "none" },
        { minScore: 2, maxScore: 3, label: { uk: "Виражена", ru: "Выраженная" }, severity: "severe" },
      ],
    },
  ],
});
await db.insert(surveys).values({
  id: surveyId,
  groupId: groupA,
  title: draft.title,
  safetyPlan: { uk: "Якщо важко просто зараз — зателефонуйте 7333", ru: "Если тяжело прямо сейчас — позвоните 7333" },
  administration: "self",
  status: "published",
  publishedAt: new Date().toISOString(),
  visibility: "public",
  scoringEnabled: true,
  allowRetake: true,
  createdBy: adminA.id,
} as never);
await createVersion(surveyId, draft, adminA.id, "v1");

/* общее правило «тревога → дежурному»: срабатывание пишется в rule_hits, закрытую пациенту */
const rule = await api("/api/decisions/rules", root.token, {
  method: "POST",
  body: JSON.stringify({
    title: "Тревога — дежурному",
    conditions: [{ kind: "risk", severity: "moderate" }],
    actions: [{ kind: "notify_duty" }],
  }),
});
if (rule.status !== 201) throw new Error(`правило не заведено: ${rule.status} ${JSON.stringify(rule.body)}`);

/* правило общее и действовало бы на прохождения в других файлах */
afterAll(async () => {
  await db.update(decisionRules).set({ enabled: false }).where(eq(decisionRules.id, rule.body.id));
});

/** Вход и сдача методики первыми вариантами — из дочернего процесса под боевой ролью */
function submitScript(email: string, extra = "") {
  return `
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ${JSON.stringify(email)}, password: "secret12345" }),
    });
    out.login = login.status;
    const auth = { Authorization: "Bearer " + (await login.json()).token, "Content-Type": "application/json" };
    const loaded = await app.request(${JSON.stringify(`/api/surveys/${surveyId}`)}, { headers: auth });
    out.loaded = loaded.status;
    const survey = await loaded.json();
    const answers = (survey.questions ?? []).map((q) => ({
      questionId: q.id,
      optionIds: [q.options[0].id],
      durationMs: 1500,
      changeCount: 0,
      visitCount: 1,
    }));
    const res = await app.request(${JSON.stringify(`/api/surveys/${surveyId}/responses`)}, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers,
        ${extra}
      }),
    });
    out.status = res.status;
    out.body = await res.json();
  `;
}

interface Submitted {
  login: number;
  loaded: number;
  status: number;
  body: { id?: string; safetyPlan?: unknown; scores?: unknown[]; message?: string };
}

describe("отправка прохождения под боевой ролью", () => {
  test("критический пункт пациента: прохождение сохранено, случай открыт, правило сработало", async () => {
    const email = `rls-run-${crypto.randomUUID()}@test.dev`;
    const me = await makeUser("user", email, { sex: "male", birthDate: "1990-01-01" });

    const out = await underAppRole<Submitted>(submitScript(email));
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);
    expect(out.login).toBe(200);
    expect(out.loaded).toBe(200);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const responseId = out.body!.id!;

    /* дальше — владельцем: проверяем, что легло в базу */
    const saved = await db.query.responses.findFirst({ where: eq(responses.id, responseId) });
    expect(saved?.status).toBe("completed");

    const alerts = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, responseId));
    // пункт и тяжёлая полоса — два сигнала, оба привязаны к случаю
    expect(alerts.length).toBe(2);
    expect(alerts.every((a) => a.caseId !== null), "сигнал без случая").toBe(true);

    const cases = await db.select().from(alertCases).where(eq(alertCases.userId, me.id));
    // случай — это человек: два сигнала, один случай
    expect(cases.length).toBe(1);
    expect(cases[0]!.severity).toBe("severe");

    const hits = await db.select().from(ruleHits).where(eq(ruleHits.responseId, responseId));
    expect(hits.length, "срабатывание правила потеряно").toBe(1);

    // план безопасности показывается ровно в этот момент — и он дошёл
    expect(out.body!.safetyPlan).toBeTruthy();
  }, 60_000);

  test("специалист заполняет за пациента: случай открывается под его ролью", async () => {
    const tail = crypto.randomUUID();
    const staffEmail = `rls-staff-${tail}@test.dev`;
    const staff = await makeUser("admin", staffEmail);
    await db.insert(groupAdmins).values({ groupId: groupA, userId: staff.id, addedBy: root.id });
    const subject = await makeUser("user", `rls-subject-${tail}@test.dev`, { sex: "female", birthDate: "1985-05-05" });

    const out = await underAppRole<Submitted>(
      submitScript(staffEmail, `onBehalfOf: ${JSON.stringify(subject.id)}, status: "completed",`),
    );
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive).toBe(true);
    expect(out.status, JSON.stringify(out.body)).toBe(201);

    const cases = await db.select().from(alertCases).where(eq(alertCases.userId, subject.id));
    expect(cases.length).toBe(1);
    // план безопасности — тому, кто держит устройство; специалисту он не отдаётся
    expect(out.body!.safetyPlan ?? null).toBeNull();
  }, 60_000);

  test("asSystem поднимает роль только на время вызова и возвращает прежнюю", async () => {
    const roleNow = async () => {
      const [row] = (await db.execute(sql`select current_setting('app.role', true) as role`)) as unknown as {
        role: string;
      }[];
      return row!.role;
    };
    await withDbContext(baseDb, { userId: adminA.id, role: "user" }, async () => {
      expect(await roleNow()).toBe("user");
      const inside = await asSystem(roleNow);
      expect(inside).toBe("system");
      // роль вернулась — остаток запроса не идёт под системной
      expect(await roleNow()).toBe("user");
      // и возвращается даже если автоматика упала
      await expect(asSystem(async () => { throw new Error("сбой автоматики"); })).rejects.toThrow("сбой автоматики");
      expect(await roleNow()).toBe("user");
    });
  });
});
