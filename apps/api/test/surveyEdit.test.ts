import { beforeAll, describe, expect, test } from "bun:test";
import { api, batteries, createSurveySchema, createVersion, db, eq, groupAdmins, makeUser, root, surveys } from "./fixtures";
import { surveyGroups, surveyVersions } from "../src/db/schema";
import { underAppRole } from "./appRole";

/**
 * Правка методики и её версии (волна 12, участок engine).
 *
 * Дефекты из внешнего разбора и находки соседнего участка, каждый
 * воспроизведён тестом, падавшим до правки:
 *   — опубликованную методику правили без проверки пригодности к
 *     публикации: проверка стояла только на явном status: "published";
 *   — частичная правка стирала неуказанное: одни questions — версия без
 *     шкал и секций, одни scales — версия без единого вопроса;
 *   — номер версии max+1 без замка: две одновременные правки падали
 *     нарушением уникальности вместо управляемого конфликта;
 *   — createVersion не записывал каскад полосы (батарея, срок, повторы) —
 *     сохранение в конструкторе молча снимало назначения по полосе;
 *   — копия методики теряла коды вариантов (ключ «Так/Ні» переставал
 *     считаться) и держала условия показа на вариантах исходника.
 *
 * Методики — в своей группе, с uuid в названиях: файлы сюиты идут одним
 * процессом и на Linux в другом порядке, чем на macOS.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const L = (uk: string) => ({ uk, ru: uk });
const group = crypto.randomUUID();
const battery = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(surveyGroups).values({ id: group, title: `Правка ${tag()}`, createdBy: root.id });
  await db.insert(batteries).values({ id: battery, title: `Поглиблене ${tag()}`, groupId: group, createdBy: root.id });
});

/** Два пункта «Так/Ні» с кодами, шкала по ключу «Так», секция и полосы — всё, что можно потерять */
function content() {
  const yesNo = (title: string) => ({
    type: "yesno" as const,
    title: L(title),
    required: true,
    sectionKey: "main",
    options: [
      { text: L("Так"), score: 1, keyCode: "yes" },
      { text: L("Ні"), score: 0, keyCode: "no" },
    ],
  });
  return {
    sections: [{ key: "main", title: L("Основне") }],
    questions: [yesNo("Перший"), yesNo("Другий")],
    scales: [
      {
        code: "S",
        title: L("Сума"),
        kind: "clinical" as const,
        normalization: "raw" as const,
        key: [
          { item: 1, matchKey: "yes", weight: 1 },
          { item: 2, matchKey: "yes", weight: 1 },
        ],
        bands: [
          { minScore: 0, maxScore: 1, label: L("Норма"), severity: "none" as const },
          { minScore: 2, maxScore: 2, label: L("Виражено"), severity: "moderate" as const },
        ],
      },
    ],
  };
}

async function newSurvey(publish = true) {
  const created = await api("/api/surveys", root.token, {
    method: "POST",
    body: JSON.stringify({
      title: L(`Правка ${tag()}`),
      groupId: group,
      administration: "self",
      scoringEnabled: true,
      allowRetake: true,
      // копия переносит и этот флаг: баллы копии проверяются по ответу на сдачу
      showResultsToPatient: true,
      ...content(),
    }),
  });
  expect(created.status).toBe(201);
  if (!publish) return created.body;
  const published = await api(`/api/surveys/${created.body.id}`, root.token, {
    method: "PATCH",
    body: JSON.stringify({ status: "published" }),
  });
  expect(published.status).toBe(200);
  return published.body;
}

const patch = (id: string, body: unknown) =>
  api(`/api/surveys/${id}`, root.token, { method: "PATCH", body: JSON.stringify(body) });

const raw = (id: string) => api(`/api/surveys/${id}?raw=1`, root.token);

describe("правка опубликованной методики проверяется как публикация", () => {
  test("содержимое с ошибкой структуры без поля status — отказ", async () => {
    /*
     * Проверка стояла только на `status === "published"` в самом запросе.
     * Конструктор сохраняет опубликованную методику без поля status — и
     * методика, которая не может быть посчитана (здесь T-баллы без норм),
     * уходила к пациентам новой действующей версией.
     */
    const survey = await newSurvey();
    const broken = content();
    broken.scales[0] = { ...broken.scales[0]!, normalization: "tscore" as never };
    const res = await patch(survey.id, { scales: broken.scales });
    expect(res.status).toBe(400);
    const after = await raw(survey.id);
    expect(after.body.versionId, "сломанная версия стала действующей").toBe(survey.versionId);
  });

  test("черновик с той же ошибкой сохраняется — это незаконченная работа", async () => {
    const survey = await newSurvey(false);
    const broken = content();
    broken.scales[0] = { ...broken.scales[0]!, normalization: "tscore" as never };
    expect((await patch(survey.id, { scales: broken.scales })).status).toBe(200);
  });

  test("исправная правка опубликованной проходит", async () => {
    const survey = await newSurvey();
    const next = content();
    next.questions[0]!.title = L("Перший, уточнений");
    expect((await patch(survey.id, { questions: next.questions })).status).toBe(200);
  });
});

describe("частичная правка переносит неуказанное из действующей версии", () => {
  test("одни questions — шкалы, ключ, полосы и секции на месте", async () => {
    const survey = await newSurvey();
    const current = await raw(survey.id);
    const sectionId = current.body.sections[0].id;
    const questions = content().questions.map((q, i) => ({
      ...q,
      title: L(`Пункт ${i + 1} ${tag()}`),
      // ключ перенесённой секции — её идентификатор, тот, что клиент видит в sectionId
      sectionKey: sectionId,
    }));
    const res = await patch(survey.id, { questions });
    expect(res.status).toBe(200);

    const after = await raw(survey.id);
    expect(after.body.versionId).not.toBe(survey.versionId);
    expect(after.body.scales.map((s: { code: string }) => s.code), "шкалы стёрты").toEqual(["S"]);
    expect(after.body.scales[0].items.length).toBe(2);
    expect(after.body.scales[0].bands.length).toBe(2);
    expect(after.body.sections.length, "секции стёрты").toBe(1);
    expect(after.body.questions[0].sectionId).toBe(after.body.sections[0].id);
  });

  test("одни scales — вопросы, варианты и коды на месте", async () => {
    const survey = await newSurvey();
    const scales = content().scales.map((s) => ({ ...s, title: L("Сума, перейменована") }));
    expect((await patch(survey.id, { scales })).status).toBe(200);

    const after = await raw(survey.id);
    expect(after.body.questions.length, "вопросы стёрты").toBe(2);
    expect(after.body.questions[0].options.map((o: { keyCode: string }) => o.keyCode)).toEqual(["yes", "no"]);
    expect(after.body.questions[0].sectionId).not.toBeNull();
  });
});

describe("каскад полосы", () => {
  const withCascade = () => {
    const c = content();
    c.scales[0]!.bands[1] = {
      ...c.scales[0]!.bands[1]!,
      cascadeBatteryId: battery,
      cascadeDueDays: 7,
      followUpDays: "7,30",
    } as never;
    return c.scales;
  };

  test("сохраняется правкой и переживает следующую частичную правку", async () => {
    const survey = await newSurvey();
    expect((await patch(survey.id, { scales: withCascade() })).status).toBe(200);

    const after = await raw(survey.id);
    const band = after.body.scales[0].bands[1];
    expect(band.cascadeBatteryId, "каскад не записан").toBe(battery);
    expect(band.cascadeDueDays).toBe(7);
    expect(band.followUpDays).toBe("7,30");

    // правка одних вопросов не снимает каскад с перенесённых шкал
    const questions = content().questions.map((q) => ({ ...q, sectionKey: after.body.sections[0].id }));
    expect((await patch(survey.id, { questions })).status).toBe(200);
    const later = await raw(survey.id);
    expect(later.body.scales[0].bands[1].cascadeBatteryId).toBe(battery);
  });

  test("несуществующая батарея — понятный отказ, а не 500", async () => {
    const survey = await newSurvey();
    const scales = withCascade();
    (scales[0]!.bands[1] as unknown as { cascadeBatteryId: string }).cascadeBatteryId = crypto.randomUUID();
    expect((await patch(survey.id, { scales })).status).toBe(400);
  });
});

describe("условия показа и коды вариантов в новой версии и в копии", () => {
  /** Второй пункт показывается, только если в первом выбран вариант «Так» — по его id */
  async function surveyWithOptionRule() {
    const survey = await newSurvey();
    const current = await raw(survey.id);
    const yesId = current.body.questions[0].options[0].id;
    const questions = content().questions.map((q, i) => ({
      ...q,
      sectionKey: current.body.sections[0].id,
      logic: i === 1 ? [{ sourceIndex: 0, operator: "eq", value: yesId, action: "show" }] : [],
    }));
    expect((await patch(survey.id, { questions })).status).toBe(200);
    return (await raw(survey.id)).body;
  }

  test("условия пункта приходят по номеру пункта-источника, а не в порядке строк базы", async () => {
    /*
     * Своей позиции у правила нет, и без порядка строки приходили как лягут:
     * на CI лист сверки ASSIST показал «п. 12 > 0 і п. 1 ≥ 1», локально —
     * наоборот, и выкатка v1.15.0 встала на тесте листов. Здесь правила
     * записаны задом наперёд — вставка идёт в этом же порядке, — а читаются
     * по номеру источника.
     */
    const survey = await newSurvey();
    const current = await raw(survey.id);
    const base = content().questions;
    const third = { ...base[1]!, title: L("Третій") };
    const questions = [...base, third].map((q, i) => ({
      ...q,
      sectionKey: current.body.sections[0].id,
      logic:
        i === 2
          ? [
              { sourceIndex: 1, operator: "answered", action: "show" },
              { sourceIndex: 0, operator: "answered", action: "show" },
            ]
          : [],
    }));
    expect((await patch(survey.id, { questions })).status).toBe(200);
    const after = (await raw(survey.id)).body;
    expect(after.questions[2].logic.map((r: { sourceQuestionId: string }) => r.sourceQuestionId)).toEqual([
      after.questions[0].id,
      after.questions[1].id,
    ]);
  });

  test("ключ шкалы приходит по номеру пункта, а не в порядке строк базы", async () => {
    /*
     * Та же причина, что у условий показа, — и v1.16.0 встала на ней же: лист
     * сверки МЛО брал в пример пропусков «первые» пункты шкалы, а на CI они
     * пришли в другом порядке. Ключ записан задом наперёд — вставка идёт в
     * этом же порядке, — а читается по номеру пункта.
     */
    const survey = await newSurvey();
    const scales = content().scales;
    scales[0]!.key = [...scales[0]!.key].reverse();
    expect((await patch(survey.id, { scales })).status).toBe(200);
    const after = (await raw(survey.id)).body;
    expect(after.scales[0].items.map((i: { questionId: string }) => i.questionId)).toEqual([
      after.questions[0].id,
      after.questions[1].id,
    ]);
  });

  test("ссылка условия на вариант переводится на вариант новой версии", async () => {
    /*
     * Каждая версия заводит варианты с новыми id. Условие «показать, если
     * выбран вариант X» хранит id варианта — и в новой версии указывало бы
     * на вариант прежней: пункт не показывался бы никогда.
     */
    const survey = await surveyWithOptionRule();
    expect(survey.questions[1].logic[0].value).toBe(survey.questions[0].options[0].id);

    // и переносится при правке одних шкал
    expect((await patch(survey.id, { scales: content().scales })).status).toBe(200);
    const after = (await raw(survey.id)).body;
    expect(after.versionId).not.toBe(survey.versionId);
    expect(after.questions[1].logic[0].value).toBe(after.questions[0].options[0].id);
  });

  test("копия: условия на своих вариантах, коды вариантов на месте — ключ считает", async () => {
    const source = await surveyWithOptionRule();
    const dup = await api(`/api/surveys/${source.id}/duplicate`, root.token, { method: "POST" });
    expect(dup.status).toBe(201);
    const copy = (await raw(dup.body.id)).body;

    expect(copy.questions[1].logic[0].value, "условие копии смотрит на вариант исходника").toBe(
      copy.questions[0].options[0].id,
    );
    expect(copy.questions[0].options.map((o: { keyCode: string }) => o.keyCode), "коды вариантов потеряны").toEqual([
      "yes",
      "no",
    ]);
    expect(copy.scales[0].bands.length).toBe(2);
    expect(copy.sections.length).toBe(1);

    // ключ копии считает: «Так» на оба пункта — 2, а не 0
    expect((await patch(copy.id, { status: "published" })).status).toBe(200);
    const person = await makeUser("user", `copy-${tag()}@test`);
    const shown = (await api(`/api/surveys/${copy.id}`, person.token)).body;
    const res = await api(`/api/surveys/${copy.id}/responses`, person.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: shown.questions.map((q: { id: string; options: { id: string }[] }) => ({
          questionId: q.id,
          optionIds: [q.options[0]!.id],
        })),
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.scores[0].rawScore, "ключ копии не нашёл кодов вариантов").toBe(2);
  });
});

describe("номер версии под замком методики", () => {
  test("одновременные createVersion дают разные номера подряд, а не ошибку уникальности", async () => {
    const id = crypto.randomUUID();
    await db.insert(surveys).values({
      id,
      groupId: group,
      title: L(`Гонка ${tag()}`),
      administration: "self",
      status: "draft",
      createdBy: root.id,
    } as never);
    const input = createSurveySchema.parse({ title: L("Гонка"), ...content() });
    await createVersion(id, input, root.id, "перша");

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => createVersion(id, input, root.id, `паралельна ${i}`)),
    );
    expect(
      results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);
    const numbers = (await db.select().from(surveyVersions).where(eq(surveyVersions.surveyId, id)))
      .map((v) => v.version)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  }, 20_000);

  test("две правки от одной версии: одна проходит, вторая — 409, а не молча поверх", async () => {
    const survey = await newSurvey();
    const edit = (title: string) => {
      const c = content();
      c.questions[0]!.title = L(title);
      return patch(survey.id, { questions: c.questions, baseVersionId: survey.versionId });
    };
    const [a, b] = await Promise.all([edit("Правка А"), edit("Правка Б")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const versions = await db.select().from(surveyVersions).where(eq(surveyVersions.surveyId, survey.id));
    expect(versions.length, "проигравшая правка записала версию").toBe(2);
  }, 20_000);

  test("правки без базовой версии встают друг за другом", async () => {
    const survey = await newSurvey();
    const results = await Promise.all(
      [1, 2, 3].map((n) => {
        const c = content();
        c.questions[0]!.title = L(`Правка ${n}`);
        return patch(survey.id, { questions: c.questions });
      }),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const numbers = (await db.select().from(surveyVersions).where(eq(surveyVersions.surveyId, survey.id)))
      .map((v) => v.version)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4]);
  }, 20_000);

  test("устаревшая базовая версия — 409 и без параллельности", async () => {
    const survey = await newSurvey();
    expect((await patch(survey.id, { questions: content().questions })).status).toBe(200);
    const stale = await patch(survey.id, { questions: content().questions, baseVersionId: survey.versionId });
    expect(stale.status).toBe(409);
    // правка настроек без содержимого базовую версию не проверяет: версии она не создаёт
    expect((await patch(survey.id, { title: L("Нова назва"), baseVersionId: survey.versionId })).status).toBe(200);
  });
});

describe("правка под боевой ролью базы", () => {
  test("администратор группы правит методику: замок строки проходит политики, неуказанное перенесено", async () => {
    /*
     * PATCH теперь начинается с `select … for update` по строке методики, а
     * createVersion берёт тот же замок. FOR UPDATE под политиками строк
     * требует и права на UPDATE этой строки — сюита ходит владельцем базы и
     * этого не видит, поэтому путь прогоняется ролью приложения, как в бою.
     */
    const email = `edit-rls-${crypto.randomUUID()}@test.dev`;
    const editor = await makeUser("admin", email);
    await db.insert(groupAdmins).values({ groupId: group, userId: editor.id, addedBy: root.id });
    const survey = await newSurvey();
    const questions = content().questions.map((q) => ({ ...q, sectionKey: undefined }));

    const out = await underAppRole<{ login: number; status: number; body: { versionId?: string; scales?: unknown[] } }>(`
      const login = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: "secret12345" }),
      });
      out.login = login.status;
      const auth = { Authorization: "Bearer " + (await login.json()).token, "Content-Type": "application/json" };
      const res = await app.request(${JSON.stringify(`/api/surveys/${survey.id}`)}, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ questions: ${JSON.stringify(questions)}, baseVersionId: ${JSON.stringify(survey.versionId)} }),
      });
      out.status = res.status;
      out.body = await res.json();
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);
    expect(out.login).toBe(200);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body!.versionId).not.toBe(survey.versionId);
    expect(out.body!.scales!.length).toBe(1);
  }, 60_000);
});

