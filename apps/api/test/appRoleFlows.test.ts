import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  alertCases,
  auditLog,
  batteries,
  batteryAssignments,
  consentTexts,
  consents,
  departmentPatients,
  departments,
  devices,
  pushTokens,
  riskAlerts,
  slots,
  specialistProfiles,
  staffRoles,
  surveyAccess,
} from "../src/db/schema";
import { followupNote } from "../src/lib/followup";
import { api, app, appApi, appRequest, db, groupA, makeUser, responsesTable, root, submitSurvey, surveyInA } from "./fixtures";
import { dedupe } from "../src/lib/openapi";
import { asAppRole, RLS_ROLE } from "./appRole";
import { answersFor, buildWorld, closeWorld, futureSlot, type World } from "./appRoleWorld";

/**
 * Сквозные сценарии под ролью приложения.
 *
 * Вся остальная сюита ходит в базу владельцем, а владелец в PostgreSQL
 * политики строк обходит. Три боевые поломки волны 12 (пустые списки
 * записи у пациента, 500 на автосохранении с критическим ответом,
 * потерянный impersonation.view) сюита не видела именно поэтому — их нашли
 * случайно. Здесь то же самое делается системно: каждый запрос сценария
 * идёт через appApi, то есть приложение ходит в базу ролью без прав
 * владельца, с политиками строк, как в бою (механика — src/db/index.ts,
 * runOnPool; почему не SET ROLE — там же). Подготовка сцены и проверки
 * «что легло в базу» — владельцем, им политики только мешали бы.
 *
 * Сценарии идут по ролям в том порядке, в каком живёт отделение: пациент
 * соглашается, проходит, пишет, записывается; специалист разбирает то, что
 * пациент оставил; суперадмин смотрит техпанель и входит «от имени».
 * Поэтому describe-блоки зависят от предыдущих — это один день одного
 * отделения, а не набор независимых проверок.
 */

let w: World;
/** Вход настоящим паролем: токен сценария получен так же, как в бою */
let patientToken = "";

const json = (body: unknown) => ({ body: JSON.stringify(body) });
const post = (body: unknown = {}) => ({ method: "POST", ...json(body) });
const put = (body: unknown) => ({ method: "PUT", ...json(body) });
const patch = (body: unknown) => ({ method: "PATCH", ...json(body) });

beforeAll(async () => {
  w = await buildWorld("flows");
}, 30_000);

afterAll(async () => {
  await closeWorld(w);
  /* текст согласия общий на всю базу: после файла его не остаётся (как в access.test.ts) */
  await db.delete(consents);
  await db.delete(consentTexts);
}, 30_000);

/* ───────────────────────── пациент ───────────────────────── */

/* прохождения пациента — дальше их разбирает специалист */
let openResponseId = "";
let hiddenResponseId = "";
/* что сценарии завели по дороге — для обхода всех GET-маршрутов в конце */
const made = { threadId: "", caseId: "", mailingId: "", batteryId: "", appointmentId: "" };

describe("пациент под ролью приложения", () => {

  test("вход паролем и /me", async () => {
    const login = await appRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: w.patient.email, password: "secret12345" }),
    });
    expect(login.status).toBe(200);
    patientToken = ((await login.json()) as { token: string }).token;
    const me = await appApi("/api/auth/me", patientToken);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(w.patient.id);
    expect(me.body.leadSpecialistId).toBe(w.specialist.id);
  });

  test("согласие: статус, отказ, принятие текущей редакции; без согласия черновик не пишется", async () => {
    const text = await appApi("/api/consents/text", root.token, put({
      body: { uk: `Згода на обстеження, редакція ${w.tag}`, ru: `Согласие на обследование, редакция ${w.tag}` },
    }));
    expect(text.status).toBe(200);

    const before = await appApi("/api/consents/me", patientToken);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ required: true, accepted: false });
    expect(before.body.text).toContain(w.tag);

    const blocked = await appApi(`/api/surveys/${w.surveyOpen}/draft`, patientToken, put({
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      answers: [],
    }));
    expect(blocked.status).toBe(403);

    const declined = await appApi("/api/consents/me/decline", patientToken, post());
    expect(declined.status).toBe(200);
    expect((await appApi("/api/consents/me", patientToken)).body.accepted).toBe(false);

    const accepted = await appApi("/api/consents/me/accept", patientToken, post({ textId: before.body.textId }));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await appApi("/api/consents/me", patientToken)).body.accepted).toBe(true);

    /* второй пациент мира принимает тоже — ему дальше проходить методику чужой группы */
    const stranger = await appApi("/api/consents/me", w.stranger.token);
    expect(
      (await appApi("/api/consents/me/accept", w.stranger.token, post({ textId: stranger.body.textId }))).status,
    ).toBe(200);
  });

  test("список доступных методик и открытие назначенной", async () => {
    const list = await appApi("/api/surveys?limit=200", patientToken);
    expect(list.status).toBe(200);
    const ids = (list.body.items as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(w.surveyOpen);
    expect(ids).toContain(w.surveyHidden);
    expect(ids, "методика чужой группы без назначения попала в список").not.toContain(w.surveyOther);

    /*
     * Счёт прохождений в списке обследуемого — только свои. Было (волна 13):
     * владельцем базы — сколько человек прошли общедоступную методику по
     * всему учреждению, ролью приложения — свои; одна строка, два ответа.
     */
    const other = await submitSurvey(surveyInA, w.stranger.token);
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    // список — по группе методики: владелец базы видит все методики набора
    // тестов, и в общем списке она уходила за двухсотую строку
    const counted = await both(`/api/surveys?limit=200&groupId=${groupA}`, patientToken);
    const ofA = (b: { items: { id: string; responseCount: number }[] }) => b.items.find((s) => s.id === surveyInA);
    expect(ofA(counted.owner.body)?.responseCount, "обследуемому показан счёт чужих прохождений").toBe(0);
    expect(ofA(counted.role.body)?.responseCount).toBe(0);

    const open = await appApi(`/api/surveys/${w.surveyOpen}`, patientToken);
    expect(open.status).toBe(200);
    expect(open.body.questions.length).toBe(2);
    expect((await appApi(`/api/surveys/${w.surveyOther}`, patientToken)).status).toBe(404);
  });

  test("черновик с критическим ответом сохраняется и открывает случай для дежурного", async () => {
    const survey = (await appApi(`/api/surveys/${w.surveyOpen}`, patientToken)).body;
    const saved = await appApi(`/api/surveys/${w.surveyOpen}/draft`, patientToken, put({
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      durationMs: 30_000,
      answers: answersFor(survey, "first").slice(0, 1),
    }));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const draft = await appApi(`/api/surveys/${w.surveyOpen}/draft`, patientToken);
    expect(draft.status).toBe(200);
    expect(draft.body.answers.length).toBe(1);

    const signals = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, saved.body.id));
    expect(signals.length, "критический ответ черновика не дал сигнала").toBeGreaterThan(0);
    const cases = await db.select().from(alertCases).where(eq(alertCases.userId, w.patient.id));
    expect(cases.length, "случай для дежурного не заведён").toBe(1);
  });

  test("сдача: кризисная карточка и свои баллы, когда методика их показывает", async () => {
    const survey = (await appApi(`/api/surveys/${w.surveyOpen}`, patientToken)).body;
    const sent = await appApi(`/api/surveys/${w.surveyOpen}/responses`, patientToken, post({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers: answersFor(survey, "first"),
    }));
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    openResponseId = sent.body.id;
    expect(sent.body.safetyPlan, "кризисная карточка не показана после критического ответа").toContain("7333");
    expect(sent.body.scores.length).toBeGreaterThan(0);

    /* черновик ушёл в сдачу: случай тот же, сигналы переехали на прохождение */
    const cases = await db.select().from(alertCases).where(eq(alertCases.userId, w.patient.id));
    expect(cases.length).toBe(1);
    const moved = await db
      .select()
      .from(riskAlerts)
      .where(and(eq(riskAlerts.userId, w.patient.id), eq(riskAlerts.responseId, openResponseId)));
    expect(moved.length).toBeGreaterThan(0);
  });

  test("методика с результатами у специалиста: баллов пациенту нет, отчёт закрыт", async () => {
    const survey = (await appApi(`/api/surveys/${w.surveyHidden}`, patientToken)).body;
    const sent = await appApi(`/api/surveys/${w.surveyHidden}/responses`, patientToken, post({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers: answersFor(survey, "last"),
    }));
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    hiddenResponseId = sent.body.id;
    expect(sent.body.scores).toEqual([]);
    expect(sent.body.safetyPlan).toBeNull();

    const report = await asText(`/api/reports/responses/${hiddenResponseId}`, patientToken);
    expect(report.status).toBe(403);
    const shown = await asText(`/api/reports/responses/${openResponseId}`, patientToken);
    expect(shown.status).toBe(200);
  });

  test("свои результаты: список, прохождение, динамика", async () => {
    const mine = await appApi("/api/me/responses", patientToken);
    expect(mine.status).toBe(200);
    const byId = new Map((mine.body.items as { id: string; scores: unknown[] }[]).map((r) => [r.id, r]));
    expect(byId.get(openResponseId)?.scores.length).toBeGreaterThan(0);
    expect(byId.get(hiddenResponseId)?.scores).toEqual([]);

    const one = await appApi(`/api/responses/${openResponseId}`, patientToken);
    expect(one.status).toBe(200);
    expect(one.body.answers.length).toBe(2);
    /*
     * Чужое прохождение — «не найдено». Владельцем тут 403 (строка видна,
     * отказывает проверка «своё или сотрудник»), под ролью строку прячет
     * политика, и ответ — 404. Расхождение безвредное и даже честнее: код
     * отказа не выдаёт, что такое прохождение есть.
     */
    expect((await appApi(`/api/responses/${openResponseId}`, w.stranger.token)).status).toBe(404);

    const dynamics = await appApi("/api/me/dynamics", patientToken);
    expect(dynamics.status).toBe(200);
    expect((dynamics.body.surveys as { surveyId: string }[]).map((s) => s.surveyId)).toEqual([w.surveyOpen]);
  });

  test("план безопасности: специалист пишет, пациент видит свой", async () => {
    const plan = {
      warningSigns: ["Безсоння"],
      copingStrategies: ["Прогулянка"],
      distractions: ["Музика"],
      people: [{ name: "Брат", contact: "+380500000000" }],
      professionals: [{ name: "Черговий", contact: "7333" }],
      meansRestriction: "Ліки — у брата",
      reasonsToLive: ["Донька"],
    };
    const written = await appApi(`/api/safety/patients/${w.patient.id}`, w.admin.token, put(plan));
    expect(written.status, JSON.stringify(written.body)).toBe(201);

    const own = await appApi("/api/safety/me", patientToken);
    expect(own.status).toBe(200);
    expect(own.body.plan?.content?.reasonsToLive).toEqual(["Донька"]);
    /* было (волна 13): строку автора пациенту прячет политика users — под ролью «—» вместо имени */
    expect(own.body.plan.authorName).toContain("role-adm-");
    expect((await appApi("/api/safety/me", w.stranger.token)).body.plan).toBeNull();
  });

  test("переписка с ведущим специалистом: письмо, прочтение, ответ", async () => {
    const empty = await appApi("/api/messages", patientToken);
    expect(empty.status).toBe(200);
    expect(empty.body.lead).toBe(w.specialist.id);

    const sent = await appApi("/api/messages", patientToken, post({ text: `Добрий день, ${w.tag}` }));
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const threadId = sent.body.threadId as string;
    made.threadId = threadId;

    const inbox = await appApi("/api/messages", w.specialist.token);
    expect(inbox.status).toBe(200);
    const thread = (inbox.body.items as { id: string; unread: number }[]).find((t) => t.id === threadId);
    expect(thread?.unread).toBe(1);

    const read = await appApi(`/api/messages/${threadId}`, w.specialist.token);
    expect(read.status).toBe(200);
    expect(read.body.items.map((m: { text: string }) => m.text)).toContain(`Добрий день, ${w.tag}`);
    const marked = await appApi(`/api/messages/${threadId}/read`, w.specialist.token, post({
      ids: read.body.items.map((m: { id: string }) => m.id),
    }));
    expect(marked.status).toBe(200);
    expect(marked.body.marked).toBe(1);

    const seen = await appApi(`/api/messages/${threadId}`, patientToken);
    expect(seen.body.items[0].readAt).not.toBeNull();

    const reply = await appApi("/api/messages", w.specialist.token, post({ patientId: w.patient.id, text: "Вітаю" }));
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.threadId).toBe(threadId);
    const after = await appApi("/api/messages", patientToken);
    const mineNow = (after.body.items as { id: string; unread: number; withName: string }[]).find((t) => t.id === threadId);
    expect(mineNow?.unread).toBe(1);
    /* было (волна 13): имя ведущего под ролью — «—», строку специалиста пациенту прячет политика */
    expect(mineNow?.withName).toContain("role-spec-");

    /* чужой переписки не видно ни пациенту, ни чужому администратору */
    expect((await appApi(`/api/messages/${threadId}`, w.stranger.token)).status).toBe(404);
    expect((await appApi(`/api/messages/${threadId}`, w.otherAdmin.token)).status).toBe(404);
  });

  test("запись на приём: отделения, специалисты, слоты, запись, мои приёмы, отмена", async () => {
    const deps = await appApi("/api/clinic/departments", patientToken);
    expect(deps.status).toBe(200);
    expect((deps.body.items as { id: string }[]).map((d) => d.id)).toContain(w.departmentId);

    const specialists = await appApi(`/api/clinic/specialists?departmentId=${w.departmentId}`, patientToken);
    expect(specialists.status).toBe(200);
    expect((specialists.body.items as { userId: string }[]).map((s) => s.userId)).toContain(w.specialist.id);

    const free = await appApi(`/api/clinic/slots?specialistId=${w.specialist.id}`, patientToken);
    expect(free.status).toBe(200);
    const offered = (free.body.items as { id: string }[]).map((s) => s.id);
    expect(offered, "свободное время под ролью приложения пустое").toEqual(expect.arrayContaining(w.slotIds));

    const booked = await appApi("/api/clinic/appointments", patientToken, post({ slotId: w.slotIds[0] }));
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    w.cleanup.appointments.push(booked.body.id);

    const mine = await appApi("/api/clinic/appointments/mine", patientToken);
    expect(mine.status).toBe(200);
    const row = (mine.body.items as { id: string; specialistName: string }[]).find((a) => a.id === booked.body.id);
    expect(row?.specialistName).toBeTruthy();

    const cancelled = await appApi(`/api/clinic/appointments/${booked.body.id}/cancel`, patientToken, post({}));
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const left = await appApi("/api/clinic/appointments/mine", patientToken);
    expect((left.body.items as { id: string }[]).map((a) => a.id)).not.toContain(booked.body.id);
  });

  test("рассылка: входящие, прочтение, ответ", async () => {
    const created = await appApi("/api/mailings", w.admin.token, post({
      title: `Опитування ${w.tag}`,
      body: "Чи зручно вам у четвер?",
      options: ["Так", "Ні"],
      patientIds: [w.patient.id],
    }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    made.mailingId = created.body.id;
    const sent = await appApi(`/api/mailings/${created.body.id}/send`, w.admin.token, post({}));
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const inbox = await appApi("/api/mailings/inbox", patientToken);
    expect(inbox.status).toBe(200);
    expect((inbox.body.items as { id: string }[]).map((m) => m.id)).toContain(created.body.id);
    expect((await appApi(`/api/mailings/${created.body.id}/read`, patientToken, post({}))).status).toBe(200);
    const answered = await appApi(`/api/mailings/${created.body.id}/answer`, patientToken, post({ answer: 0 }));
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(
      ((await appApi("/api/mailings/inbox", w.stranger.token)).body.items as { id: string }[]).map((m) => m.id),
    ).not.toContain(created.body.id);
  });
});

/** Дата со сдвигом в днях, YYYY-MM-DD */
const day = (shift: number) => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);

/** Ответ не JSON (HTML-отчёт): только статус */
async function asText(path: string, token: string): Promise<{ status: number }> {
  const res = await appApi(path, token);
  return { status: res.status };
}

/** Один и тот же GET владельцем и ролью приложения — для сторожей «обязаны совпасть» */
async function both<T = any>(path: string, token: string, init: RequestInit = {}) {
  const owner = await api<T>(path, token, init);
  const role = await appApi<T>(path, token, init);
  return { owner, role };
}

const idsOf = (items: { id: string }[] | undefined) => new Set((items ?? []).map((i) => i.id));

/** Тело без полей, меняющихся от запроса к запросу (время расчёта, окна «с момента») */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      /* время расчёта и величины, растущие с часами: между двумя запросами они вправе сдвинуться */
      if (/^(since|generatedAt|computedAt|checkedAt|countedAt|exportedAt|ranAt|now|asOf|until|uptime|minutesOpen|requestId)$/.test(k)) {
        continue;
      }
      out[k] = stable(x);
    }
    return out;
  }
  return v;
}

/* ───────────────────────── специалист и администратор группы ───────────────────────── */

describe("сотрудник под ролью приложения", () => {
  let caseId = "";

  test("список пациентов своей зоны — свои есть, чужих нет, владелец и роль видят одно", async () => {
    const { owner, role } = await both("/api/patients?limit=200", w.admin.token);
    expect(role.status).toBe(200);
    const seen = idsOf(role.body.items);
    expect(seen.has(w.patient.id)).toBe(true);
    expect(seen.has(w.stranger.id), "чужой пациент в списке своей зоны").toBe(false);
    expect([...seen].sort()).toEqual([...idsOf(owner.body.items)].sort());

    const theirs = await appApi("/api/patients?limit=200", w.otherAdmin.token);
    expect(idsOf(theirs.body.items).has(w.patient.id), "пациент виден администратору чужой группы").toBe(false);
  });

  test("карточка, прохождения, лента, динамика", async () => {
    const card = await appApi(`/api/patients/${w.patient.id}/card`, w.admin.token);
    expect(card.status).toBe(200);
    const inCard = (card.body.responses as { responseId: string }[]).map((r) => r.responseId);
    expect(inCard).toEqual(expect.arrayContaining([openResponseId, hiddenResponseId]));
    expect((await appApi(`/api/patients/${w.stranger.id}/card`, w.admin.token)).status).toBe(404);

    const rows = await appApi(`/api/surveys/${w.surveyOpen}/responses?userId=${w.patient.id}`, w.admin.token);
    expect(rows.status).toBe(200);
    expect((rows.body.rows as { id: string }[]).map((r) => r.id)).toContain(openResponseId);

    const one = await appApi(`/api/responses/${openResponseId}`, w.admin.token);
    expect(one.status).toBe(200);
    expect(one.body.scores.length).toBeGreaterThan(0);

    const timeline = await appApi(`/api/timeline/${w.patient.id}`, w.admin.token);
    expect(timeline.status).toBe(200);
    expect(timeline.body.items.length).toBeGreaterThan(0);

    const dyn = await appApi(`/api/dynamics/respondents/${w.patient.id}`, w.admin.token);
    expect(dyn.status).toBe(200);
    expect((dyn.body.surveys as { surveyId: string }[]).map((s) => s.surveyId)).toContain(w.surveyOpen);
  });

  test("заключение: предложенный черновик, правка с ревизией, подпись", async () => {
    const base = `/api/conclusions/responses/${openResponseId}/conclusion`;
    const suggested = await appApi(`${base}/draft`, w.admin.token);
    expect(suggested.status).toBe(200);
    expect(suggested.body.scales.length).toBeGreaterThan(0);

    const first = await appApi(base, w.admin.token, put({ text: "Виражена тяжкість стану, потрібна консультація." }));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.current).toMatchObject({ version: 1, revision: 1, status: "draft" });

    const second = await appApi(base, w.admin.token, put({
      text: "Виражена тяжкість стану. Скеровано до психіатра.",
      baseVersion: 1,
      baseRevision: 1,
    }));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.current.revision).toBe(2);

    const stale = await appApi(base, w.admin.token, put({ text: "Застаріла правка", baseVersion: 1, baseRevision: 1 }));
    expect(stale.status).toBe(409);

    /* узкая роль подписывать не может — отказ по праву, а не пятисотка */
    expect((await appApi(`${base}/sign`, w.specialist.token, post({ version: 1, revision: 2 }))).status).toBe(403);

    const signed = await appApi(`${base}/sign`, w.admin.token, post({ version: 1, revision: 2 }));
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.current.status).toBe("signed");

    const read = await appApi(base, w.specialist.token);
    expect(read.status).toBe(200);
    expect(read.body.current.status).toBe("signed");
    expect((await appApi(base, w.otherAdmin.token)).status).toBe(404);
  });

  test("заметки: запись, подпись, поиск только в своей зоне", async () => {
    const word = `незвичайнеслово${w.tag}`;
    const note = await appApi(`/api/notes/patients/${w.patient.id}`, w.specialist.token, put({
      text: `Прийом: скарги на безсоння, ${word}.`,
      kind: "session",
    }));
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    const { version, revision } = note.body.current;
    const signed = await appApi(`/api/notes/patients/${w.patient.id}/sign`, w.specialist.token, post({ version, revision }));
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);

    const read = await appApi(`/api/notes/patients/${w.patient.id}`, w.admin.token);
    expect(read.status).toBe(200);
    expect(read.body.current.status).toBe("signed");
    expect((await appApi(`/api/notes/patients/${w.patient.id}`, w.otherAdmin.token)).status).toBe(404);

    const found = await appApi(`/api/search/notes?q=${encodeURIComponent(word)}`, w.admin.token);
    expect(found.status).toBe(200);
    expect((found.body.items as { userId: string }[]).map((i) => i.userId)).toContain(w.patient.id);
    const hidden = await appApi(`/api/search/notes?q=${encodeURIComponent(word)}`, w.otherAdmin.token);
    expect(hidden.status).toBe(200);
    expect(hidden.body.items).toEqual([]);
  });

  test("очередь тревог и разбор случая; чужая группа случая не видит", async () => {
    const queue = await both("/api/alert-cases?status=open&group=case&limit=100", w.admin.token);
    expect(queue.role.status).toBe(200);
    const mine = (queue.role.body.items as { id: string; userId: string }[]).filter((c) => c.userId === w.patient.id);
    expect(mine.length, "случай пациента не дошёл до очереди под ролью").toBe(1);
    caseId = mine[0]!.id;
    made.caseId = caseId;
    expect(
      (queue.owner.body.items as { id: string; userId: string }[])
        .filter((c) => c.userId === w.patient.id)
        .map((c) => c.id),
    ).toEqual([caseId]);

    const alerts = await appApi("/api/alerts", w.admin.token);
    expect(alerts.status).toBe(200);
    expect((alerts.body.items as { userId: string }[]).some((a) => a.userId === w.patient.id)).toBe(true);

    const signals = await appApi(`/api/alert-cases/${caseId}/signals`, w.specialist.token);
    expect(signals.status).toBe(200);
    expect(signals.body.items.length).toBeGreaterThan(0);

    const other = await appApi("/api/alert-cases?status=open&group=case&limit=100", w.otherAdmin.token);
    expect((other.body.items as { userId: string }[]).some((c) => c.userId === w.patient.id)).toBe(false);
    expect((await appApi(`/api/alert-cases/${caseId}`, w.otherAdmin.token, patch({ outcome: "confirmed" }))).status).toBe(404);

    const taken = await appApi(`/api/alert-cases/${caseId}/assign`, w.specialist.token, post());
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    const resolved = await appApi(`/api/alert-cases/${caseId}`, w.specialist.token, patch({
      outcome: "confirmed",
      note: "Розмова проведена, план безпеки складено",
    }));
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);

    const history = await appApi(`/api/alert-cases/${caseId}/history`, w.admin.token);
    expect(history.status).toBe(200);
    expect(history.body.items.length).toBeGreaterThan(0);
  });

  test("направления: своему пациенту — да, чужому — «не найдено», а не пятисотка", async () => {
    const made = await appApi("/api/referrals", w.specialist.token, post({
      userId: w.patient.id,
      destination: "psychiatrist",
      urgency: "urgent",
      reason: "Критичний пункт у скринінгу",
      responseId: openResponseId,
    }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const moved = await appApi(`/api/referrals/${made.body.id}`, w.specialist.token, patch({ status: "accepted" }));
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const list = await both("/api/referrals?limit=200", w.admin.token);
    expect(list.role.status).toBe(200);
    expect(idsOf(list.role.body.items).has(made.body.id)).toBe(true);
    const summary = await appApi(`/api/referrals/summary/${w.patient.id}`, w.admin.token);
    expect(summary.status).toBe(200);

    const foreign = await appApi("/api/referrals", w.specialist.token, post({
      userId: w.stranger.id,
      destination: "psychiatrist",
    }));
    /*
     * Было (волна 13): зону не спрашивал ни реестр, ни запись. Владельцем
     * направление на чужого заводилось (201), под ролью — 500 от политики;
     * реестр и правка владельцем показывали чужой группе всё отделение.
     */
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect((await api("/api/referrals", w.specialist.token, post({ userId: w.stranger.id, destination: "other" }))).status).toBe(404);
    const theirs = await both("/api/referrals?limit=200", w.otherAdmin.token);
    expect(idsOf(theirs.role.body.items).has(made.body.id)).toBe(false);
    expect(idsOf(theirs.owner.body.items).has(made.body.id), "реестр направлений не спрашивает зону").toBe(false);
    expect(theirs.owner.body.total).toBe(theirs.role.body.total);
    const touch = patch({ status: "completed" });
    expect((await api(`/api/referrals/${made.body.id}`, w.otherAdmin.token, touch)).status).toBe(404);
    expect((await appApi(`/api/referrals/${made.body.id}`, w.otherAdmin.token, touch)).status).toBe(404);
  });

  test("назначение методики и батареи; пациент видит назначенное", async () => {
    const newcomer = await makeUser("user", `role-new-${crypto.randomUUID()}@test.dev`);
    w.cleanup.people.push(newcomer.id);
    const granted = await appApi(`/api/access/surveys/${w.surveyHidden}/grants`, w.specialist.token, post({
      userId: newcomer.id,
      note: "Первинний скринінг",
    }));
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const grants = await appApi(`/api/access/surveys/${w.surveyHidden}/grants`, w.admin.token);
    expect(grants.status).toBe(200);
    expect(JSON.stringify(grants.body)).toContain(newcomer.id);
    const seen = await appApi("/api/surveys?limit=200", newcomer.token);
    expect((seen.body.items as { id: string }[]).map((s) => s.id)).toContain(w.surveyHidden);

    const battery = await appApi("/api/batteries", w.admin.token, post({
      title: `Батарея ${w.tag}`,
      groupId: w.groupId,
      items: [{ surveyId: w.surveyHidden, required: true }],
    }));
    expect(battery.status, JSON.stringify(battery.body)).toBe(201);
    made.batteryId = battery.body.id;
    const assigned = await appApi(`/api/batteries/${battery.body.id}/assign`, w.specialist.token, post({
      userId: w.patient.id,
      note: "До наступного прийому",
    }));
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    const list = await appApi(`/api/batteries/${battery.body.id}/assignments`, w.admin.token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(w.patient.id);
    const mine = await appApi("/api/batteries/mine", patientToken);
    expect(mine.status).toBe(200);
    expect((mine.body.items as { batteryId: string }[]).map((b) => b.batteryId)).toContain(battery.body.id);
  });

  test("батарея новому человеку и приглашение по ссылке: назначение вводит в зону, ссылка открывается до входа", async () => {
    /*
     * Было (волна 13): назначение батареи человеку, которого сотрудник ещё
     * не видит, — 500 от политики battery_assignments (новой строки при
     * проверке ещё нет, зона по ней не считается). Лечится миграцией 0108.
     */
    const newcomer = await makeUser("user", `role-bat-${crypto.randomUUID()}@test.dev`);
    w.cleanup.people.push(newcomer.id);
    expect((await appApi(`/api/patients/${newcomer.id}/card`, w.specialist.token)).status).toBe(404);
    const assigned = await appApi(`/api/batteries/${made.batteryId}/assign`, w.specialist.token, post({
      userId: newcomer.id,
    }));
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    expect((await appApi(`/api/patients/${newcomer.id}/card`, w.specialist.token)).status).toBe(200);
    const mine = await appApi("/api/batteries/mine", newcomer.token);
    expect((mine.body.items as { batteryId: string }[]).map((b) => b.batteryId)).toContain(made.batteryId);
    /* чужой батареей — нет: зона батареи, а не зона человека */
    expect(
      (await appApi(`/api/batteries/${made.batteryId}/assign`, w.otherAdmin.token, post({ userId: w.stranger.id }))).status,
    ).toBe(403);

    /*
     * Было (волна 13): предпросмотр приглашения — публичный маршрут без
     * контекста — под ролью приложения отвечал «ссылка недействительна» на
     * любую живую ссылку.
     */
    const invite = await appApi("/api/invites", w.admin.token, post({
      surveyId: w.surveyOpen,
      specialistId: w.specialist.id,
      maxUses: 1,
      ttlDays: 7,
    }));
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const preview = await appRequest(`/api/invites/preview/${invite.body.token}`);
    const shown = (await preview.json()) as { valid: boolean; surveyTitle: string | null };
    expect(shown.valid, JSON.stringify(shown)).toBe(true);
    expect(shown.surveyTitle).toContain("Скринінг");

    /* было (волна 13): ссылку с методикой видела и могла погасить любая группа */
    const theirs = await both("/api/invites?limit=100", w.otherAdmin.token);
    expect(idsOf(theirs.owner.body.items).has(invite.body.id), "чужая ссылка в списке приглашений").toBe(false);
    expect(idsOf(theirs.role.body.items).has(invite.body.id)).toBe(false);
    expect((await appApi(`/api/invites/${invite.body.id}/revoke`, w.otherAdmin.token, post({}))).status).toBe(403);
    expect(idsOf((await appApi("/api/invites?limit=100", w.admin.token)).body.items).has(invite.body.id)).toBe(true);

    await appApi(`/api/invites/${invite.body.id}/revoke`, w.admin.token, post({}));
    const revoked = (await (await appRequest(`/api/invites/preview/${invite.body.token}`)).json()) as { reason: string };
    expect(revoked.reason).toBe("revoked");
  });

  test("запись за другого: новый человек — да, пациент чужого отделения — 403, в том числе в свой слот", async () => {
    /*
     * Было (волна 13): под ролью приложения запись нового человека к другому
     * специалисту падала пятисоткой (политика appointments), а проверка
     * «прикреплён к чужому отделению» ослепала — прикрепление чужого пациента
     * сотруднику не видно — и запись в СВОЙ слот проходила: обход зоны,
     * закрытый проверкой, в бою был открыт.
     */
    const fresh = await makeUser("user", `role-reg-${crypto.randomUUID()}@test.dev`);
    w.cleanup.people.push(fresh.id);
    const byDesk = await appApi("/api/clinic/appointments", w.admin.token, post({
      slotId: await futureSlot(w),
      patientId: fresh.id,
    }));
    expect(byDesk.status, JSON.stringify(byDesk.body)).toBe(201);
    w.cleanup.appointments.push(byDesk.body.id);
    const [attached] = await db.select().from(departmentPatients).where(eq(departmentPatients.patientId, fresh.id));
    expect(attached?.attachedVia).toBe("staff");

    const foreign = await makeUser("user", `role-foreign-${crypto.randomUUID()}@test.dev`);
    w.cleanup.people.push(foreign.id);
    const otherDept = crypto.randomUUID();
    await db.insert(departments).values({ id: otherDept, title: { uk: "Чуже відділення", ru: "Чужое отделение" } } as never);
    await db.insert(departmentPatients).values({ departmentId: otherDept, patientId: foreign.id, attachedVia: "staff" } as never);

    const intoOther = await appApi("/api/clinic/appointments", w.admin.token, post({
      slotId: await futureSlot(w),
      patientId: foreign.id,
    }));
    expect(intoOther.status, JSON.stringify(intoOther.body)).toBe(403);
    /* свой слот: специалист сам принимает — политика бы пустила, держит проверка */
    const intoOwn = await appApi("/api/clinic/appointments", w.specialist.token, post({
      slotId: await futureSlot(w),
      patientId: foreign.id,
    }));
    expect(intoOwn.status, JSON.stringify(intoOwn.body)).toBe(403);
    if (intoOwn.status === 201) w.cleanup.appointments.push(intoOwn.body.id);
    expect((await appApi(`/api/timeline/${foreign.id}`, w.specialist.token)).status).toBe(404);
  });

  test("заполнение за пациента: своего — да, чужого — отказ", async () => {
    const survey = (await appApi(`/api/surveys/${w.surveyHidden}`, w.specialist.token)).body;
    const body = {
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers: answersFor(survey, "last"),
    };
    const filled = await appApi(`/api/surveys/${w.surveyHidden}/responses`, w.specialist.token, post({
      ...body,
      onBehalfOf: w.patient.id,
    }));
    expect(filled.status, JSON.stringify(filled.body)).toBe(201);
    const [row] = await db.select().from(responsesTable).where(eq(responsesTable.id, filled.body.id));
    expect(row?.userId).toBe(w.patient.id);

    const foreign = await appApi(`/api/surveys/${w.surveyHidden}/responses`, w.specialist.token, post({
      ...body,
      onBehalfOf: w.stranger.id,
    }));
    expect(foreign.status).toBe(403);
  });

  test("аналитика, когорты, очередь работы по своей зоне: роль видит то же, что владелец", async () => {
    for (const path of [
      "/api/analytics/overview",
      `/api/analytics/surveys/${w.surveyOpen}`,
      `/api/analytics/groups/${w.groupId}`,
      "/api/dashboard/conditions",
      "/api/worklist",
      `/api/missed?since=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`,
    ]) {
      const { owner, role } = await both(path, w.admin.token);
      expect(role.status, `${path}: ${JSON.stringify(role.body)}`).toBe(200);
      expect(stable(role.body), path).toEqual(stable(owner.body));
    }
    const cohort = await both("/api/cohorts/preview", w.admin.token, post({}));
    expect(cohort.role.status).toBe(200);
    expect(stable(cohort.role.body)).toEqual(stable(cohort.owner.body));

    /* узкая роль до аналитики не допущена — отказ по праву под ролью тоже */
    expect((await appApi("/api/analytics/overview", w.specialist.token)).status).toBe(403);
  });

  test("расписание и приёмы: неделя, запись за пациента, день, контекст, перенос, ход приёма", async () => {
    const own = await makeUser("admin", `role-sched-${crypto.randomUUID()}@test.dev`);
    await db.delete(staffRoles).where(eq(staffRoles.userId, own.id));
    await db.insert(staffRoles).values({ userId: own.id, roleId: "role-specialist", grantedBy: root.id });
    await db.insert(specialistProfiles).values({ userId: own.id, departmentId: w.departmentId, acceptsBookings: false });
    const week = await appApi("/api/clinic/schedule", own.token, put({
      templates: [{ weekday: 3, startsAt: "09:00", endsAt: "10:00", slotMinutes: 30 }],
    }));
    expect(week.status, JSON.stringify(week.body)).toBe(200);
    const read = await appApi("/api/clinic/schedule", own.token);
    expect(read.status).toBe(200);
    expect(read.body.templates.length).toBe(1);
    /* пустая неделя — без хвоста открытых слотов в общей базе */
    expect((await appApi("/api/clinic/schedule", own.token, put({ templates: [] }))).status).toBe(200);

    const booked = await appApi("/api/clinic/appointments", w.specialist.token, post({
      slotId: w.slotIds[1],
      patientId: w.patient.id,
      reason: "Після скринінгу",
    }));
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    w.cleanup.appointments.push(booked.body.id);
    made.appointmentId = booked.body.id;

    const moved = await appApi(`/api/clinic/appointments/${booked.body.id}/reschedule`, w.specialist.token, post({
      slotId: w.slotIds[2],
    }));
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const [slot] = await db.select().from(slots).where(eq(slots.id, w.slotIds[2]!));
    const day = new Date(slot!.startsAt).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    /*
     * Назначение чужой группы не сдано — пометка «пришёл без назначенного»
     * обязана его считать и под ролью. Было (волна 13): под ролью
     * специалист видел назначения только своих групп, и счёт терял чужое.
     */
    await db.insert(surveyAccess).values({ surveyId: w.surveyOther, userId: w.patient.id, grantedBy: w.otherAdmin.id });
    const today = await both(`/api/clinic/today?date=${day}`, w.specialist.token);
    expect(today.role.status).toBe(200);
    const visit = (today.role.body.items as { id: string; pendingAssignments: number }[]).find((a) => a.id === booked.body.id);
    expect(visit?.pendingAssignments).toBeGreaterThan(0);
    expect(stable(today.role.body)).toEqual(stable(today.owner.body));
    /* назначение чужой группы вводит пациента в её зону — дальше сценарии проверяют границу, снимаем */
    await db
      .delete(surveyAccess)
      .where(and(eq(surveyAccess.userId, w.patient.id), eq(surveyAccess.surveyId, w.surveyOther)));

    const context = await appApi(`/api/clinic/appointments/${booked.body.id}/context`, w.specialist.token);
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body.patient.id).toBe(w.patient.id);

    for (const status of ["arrived", "in_progress", "done"]) {
      const step = await appApi(`/api/clinic/appointments/${booked.body.id}/status`, w.specialist.token, post({ status }));
      expect(step.status, `${status}: ${JSON.stringify(step.body)}`).toBe(200);
    }
    const mine = await appApi("/api/clinic/appointments/mine?past=1", patientToken);
    const row = (mine.body.items as { id: string; status: string }[]).find((a) => a.id === booked.body.id);
    expect(row?.status).toBe("done");

    /* справка о посещении: было (волна 13) — пациенту 500, строку специалиста прячет политика users */
    const certificate = await appRequest(`/api/reports/visits/${booked.body.id}`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    expect(certificate.status).toBe(200);
    expect(await certificate.text()).toContain("role-spec-");
  });

  test("обращение и диспансерный учёт: открыть, привязать приём, взять на учёт, отметить осмотр, закрыть", async () => {
    const opened = await appApi("/api/episodes", w.specialist.token, post({
      patientId: w.patient.id,
      reason: "Безсоння після ротації",
    }));
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const attached = await appApi(
      `/api/episodes/${opened.body.id}/appointments/${made.appointmentId}`,
      w.specialist.token,
      { method: "POST" },
    );
    expect(attached.status, JSON.stringify(attached.body)).toBe(200);
    const list = await both(`/api/episodes/patients/${w.patient.id}`, w.admin.token);
    expect(list.role.status).toBe(200);
    expect(idsOf(list.role.body.items).has(opened.body.id)).toBe(true);
    expect(stable(list.role.body)).toEqual(stable(list.owner.body));

    const onBook = await appApi("/api/episodes/dispensary", w.specialist.token, put({
      patientId: w.patient.id,
      groupLabel: "Д-II",
      intervalMonths: 3,
    }));
    expect(onBook.status, JSON.stringify(onBook.body)).toBe(200);
    const state = await appApi(`/api/episodes/dispensary/${w.patient.id}`, w.admin.token);
    expect(state.body.on).toBe(true);
    const seen = await appApi(`/api/episodes/dispensary/${w.patient.id}/seen`, w.specialist.token, { method: "POST" });
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    /* чужой группе — ни обращения, ни учёта */
    expect((await appApi(`/api/episodes/patients/${w.patient.id}`, w.otherAdmin.token)).status).toBe(404);
    expect(
      (await appApi("/api/episodes/dispensary", w.otherAdmin.token, put({
        patientId: w.patient.id,
        groupLabel: "Д-I",
        intervalMonths: 1,
      }))).status,
    ).toBe(404);

    /* направление пациента ещё открыто — закрытие требует пояснения, и под ролью счёт направлений тот же */
    const blocked = await appApi(`/api/episodes/${opened.body.id}/close`, w.specialist.token, post({
      outcomeKind: "improved",
      outcome: "Сон відновився",
    }));
    expect(blocked.status).toBe(409);
    expect(blocked.body.open).toMatchObject({ riskCases: 0, referrals: 1 });
    const closed = await appApi(`/api/episodes/${opened.body.id}/close`, w.specialist.token, post({
      outcomeKind: "improved",
      outcome: "Сон відновився",
      openReferralsNote: "Направлення до психіатра веде психіатр",
    }));
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  test("статистика: сохранённая выборка и модель по своей методике — роль считает то же, что владелец", async () => {
    const survey = (await appApi(`/api/surveys/${w.surveyOpen}`, w.admin.token)).body;
    const q = survey.questions[0] as { id: string; options: { id: string }[] };
    const columns = [
      {
        title: null,
        presetId: null,
        filters: {},
        surveyId: w.surveyOpen,
        bands: [],
        questions: [
          {
            questionId: q.id,
            options: q.options.map((o, i) => ({ optionId: o.id, highRisk: i === 0 })),
          },
        ],
      },
    ];
    const run = await both("/api/stat-models/run", w.admin.token, post({ columns }));
    expect(run.role.status, JSON.stringify(run.role.body)).toBe(200);
    expect(stable(run.role.body)).toEqual(stable(run.owner.body));

    const model = await appApi("/api/stat-models", w.admin.token, post({ title: `Модель ${w.tag}`, columns }));
    expect(model.status, JSON.stringify(model.body)).toBe(201);
    expect((await appApi(`/api/stat-models/${model.body.id}`, w.admin.token)).status).toBe(200);
    expect((await appApi(`/api/stat-models/${model.body.id}`, w.otherAdmin.token)).status).toBe(404);

    const cohort = await appApi("/api/cohorts", w.admin.token, post({ title: `Вибірка ${w.tag}`, spec: {} }));
    expect(cohort.status, JSON.stringify(cohort.body)).toBe(201);
    const cohorts = await appApi("/api/cohorts", w.admin.token);
    expect(idsOf(cohorts.body.items).has(cohort.body.id)).toBe(true);
    expect(idsOf((await appApi("/api/cohorts", w.otherAdmin.token)).body.items).has(cohort.body.id)).toBe(false);
  });
});

/* ───────────────────────── конструктор, папки, устройства ───────────────────────── */

describe("администратор группы: конструктор, папки, общий планшет, телефон", () => {
  test("методика заводится, копируется и кладётся в свою папку; в чужую — «не ваша», а не «нет такой»", async () => {
    /*
     * Было (волна 13): INSERT … RETURNING в surveys проверялся политикой
     * чтения через rls_admin_sees_survey(id), которая новую строку ещё не
     * видит, — администратор группы получал 500 и на заведении, и на копии.
     * Лечится миграцией 0108. Чужая папка под ролью давала 404 вместо 403.
     */
    const folder = await appApi("/api/survey-folders", w.admin.token, post({ groupId: w.groupId, title: `Полиця ${w.tag}` }));
    expect(folder.status, JSON.stringify(folder.body)).toBe(201);
    const created = await appApi("/api/surveys", w.admin.token, post({
      title: { uk: `Нова методика ${w.tag}`, ru: `Новая методика ${w.tag}` },
      groupId: w.groupId,
      folderId: folder.body.id,
      administration: "self",
      questions: [
        {
          type: "single",
          title: { uk: "Як почуваєтесь?", ru: "Как самочувствие?" },
          options: [
            { text: { uk: "Добре", ru: "Хорошо" }, score: 0 },
            { text: { uk: "Погано", ru: "Плохо" }, score: 1 },
          ],
        },
      ],
    }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const copy = await appApi(`/api/surveys/${created.body.id}/duplicate`, w.admin.token, { method: "POST" });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);

    const theirs = await api("/api/survey-folders", w.otherAdmin.token, post({ groupId: w.otherGroupId, title: `Чужа полиця ${w.tag}` }));
    expect(theirs.status).toBe(201);
    const intoForeign = await appApi(`/api/surveys/${created.body.id}/folder`, w.admin.token, put({ folderId: theirs.body.id }));
    expect(intoForeign.status, JSON.stringify(intoForeign.body)).toBe(403);
    expect((await appApi(`/api/survey-folders/${theirs.body.id}`, w.admin.token, patch({ title: "Моя" }))).status).toBe(403);
  });

  test("общий планшет: второй сотрудник отмечается без пятисотки, чужое стирание ему не приходит", async () => {
    /*
     * Было (волна 13): отметка устройства — upsert по идентификатору, и у
     * второго вошедшего ON CONFLICT DO UPDATE упирался в политику devices
     * (строка первого) — 500 на каждой отметке.
     */
    const deviceId = `tablet-${crypto.randomUUID()}`;
    const first = await appApi("/api/devices/checkin", w.admin.token, post({ deviceId, label: "Планшет", platform: "android" }));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await db.update(devices).set({ wipeRequestedAt: new Date().toISOString() }).where(eq(devices.id, deviceId));
    const second = await appApi("/api/devices/checkin", w.specialist.token, post({ deviceId }));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.wipe).toBe(false);
    const own = await appApi("/api/devices/checkin", w.admin.token, post({ deviceId }));
    expect(own.body.wipe).toBe(true);
  });

  test("телефон сменил хозяина: пуш-токен переезжает к вошедшему", async () => {
    /*
     * Было (волна 13): ON CONFLICT DO UPDATE к строке прежнего владельца —
     * 500 под ролью; новый человек уведомлений не получал, прежний получал
     * свои на чужой теперь телефон.
     */
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;
    expect((await appApi("/api/push/register", w.stranger.token, post({ token, platform: "android" }))).status).toBe(200);
    const moved = await appApi("/api/push/register", patientToken, post({ token, platform: "android" }));
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(row?.userId).toBe(w.patient.id);
    await db.delete(pushTokens).where(eq(pushTokens.token, token));
  });
});

/* ───────────────────────── суперадмин и техпанель ───────────────────────── */

describe("суперадмин и техпанель под ролью приложения", () => {
  test("ключевые экраны /api/ops/* открываются и видят базу глазами роли приложения", async () => {
    const screens = [
      "/api/ops/overview",
      "/api/ops/traffic",
      "/api/ops/routes",
      "/api/ops/errors",
      "/api/ops/errors?window=24h",
      "/api/ops/logs?limit=20",
      "/api/ops/db",
      "/api/ops/jobs",
      "/api/ops/releases",
      "/api/ops/statements",
      "/api/ops/alerts",
      "/api/ops/alerts/history",
      "/api/ops/client-errors",
      "/api/ops/vitals",
      "/api/ops/recordings",
      "/api/ops/users",
      "/api/ops/users/summary",
      "/api/ops/sessions",
      "/api/ops/sessions/summary",
      "/api/ops/people/mfa",
      "/api/ops/people/suspicious",
      "/api/ops/people/grants",
      `/api/ops/people/who-viewed?patientId=${w.patient.id}&from=${day(-1)}&to=${day(1)}`,
      "/api/ops/sec/keys",
      "/api/ops/sec/integrity",
      "/api/ops/maint/status",
      "/api/ops/maint/flags",
      "/api/ops/maint/releases",
      "/api/ops/data/quality",
      "/api/ops/data/usage",
      "/api/ops/data/mobile",
      "/api/ops/data/push",
    ];
    for (const path of screens) {
      const res = await appApi(path, root.token);
      expect(res.status, `${path}: ${JSON.stringify(res.body)?.slice(0, 300)}`).toBe(200);
    }

    /* кто смотрел карточку — просмотр специалиста под ролью записан и виден техпанели */
    const viewed = await appApi(`/api/ops/people/who-viewed?patientId=${w.patient.id}&from=${day(-1)}&to=${day(1)}`, root.token);
    expect(JSON.stringify(viewed.body)).toContain(w.admin.id);

    /* проверка политик из техпанели под ролью — политики действуют */
    const rls = await appApi("/api/ops/sec/integrity/rls", root.token, post({}));
    expect(rls.status, JSON.stringify(rls.body)).toBe(200);
    expect(rls.body.bypasses).toBe(false);
  });

  test("пользователи: список, заведение сотрудника, выключение и включение", async () => {
    const list = await appApi("/api/users?staff=1&limit=200", root.token);
    expect(list.status).toBe(200);
    const email = `role-new-staff-${crypto.randomUUID()}@test.dev`;
    const made = await appApi("/api/users", root.token, post({
      email,
      password: "secret12345",
      firstName: "Нова",
      lastName: "Співробітниця",
      role: "admin",
    }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const found = await appApi(`/api/ops/users?q=${encodeURIComponent(email)}`, root.token);
    expect((found.body.items as { id: string }[]).map((u) => u.id)).toEqual([made.body.id]);

    const off = await appApi(`/api/ops/users/${made.body.id}/disable`, root.token, post({ reason: "Звільнена" }));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const on = await appApi(`/api/ops/users/${made.body.id}/enable`, root.token, post({}));
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  });

  test("журнал: записи, сводка, по дням, цепочка цела, выгрузка", async () => {
    const entries = await appApi(`/api/audit?limit=50&subjectUserId=${w.patient.id}`, root.token);
    expect(entries.status).toBe(200);
    expect(entries.body.entries.length, "журнал по пациенту под ролью пуст").toBeGreaterThan(0);
    expect((await appApi("/api/audit/summary", root.token)).status).toBe(200);
    expect((await appApi("/api/audit/daily", root.token)).status).toBe(200);
    const verify = await appApi("/api/audit/verify", root.token);
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    expect(verify.body.ok).toBe(true);
    const csv = await appApi(`/api/audit/export.csv?subjectUserId=${w.patient.id}`, root.token);
    expect(csv.status).toBe(200);
  });

  test("вход «от имени»: глазами человека, только чтение, каждый просмотр в журнале", async () => {
    const reason = "Перевірка скарги пацієнта на список записів";
    const start = await appApi(`/api/ops/people/impersonate/${w.patient.id}`, root.token, post({ reason }));
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const token = start.body.token as string;

    const me = await appApi("/api/auth/me", token);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(w.patient.id);
    expect(me.body.impersonation.actorId).toBe(root.id);

    /* видит то, что видит пациент, — и ровно то же, что пациент видит сам */
    const own = await appApi("/api/me/responses", patientToken);
    const seen = await appApi("/api/me/responses", token);
    expect(seen.status).toBe(200);
    expect(idsOf(seen.body.items)).toEqual(idsOf(own.body.items));
    for (const path of ["/api/messages", "/api/clinic/appointments/mine", "/api/safety/me", "/api/consents/me"]) {
      const res = await appApi(path, token);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    }

    /* запись — отказ с объяснением, а не пятисотка из транзакции «только чтение» */
    const write = await appApi("/api/messages", token, post({ text: "Не має піти" }));
    expect(write.status).toBe(403);
    expect((await appApi("/api/ops/overview", token)).status).toBe(403);

    const views = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "impersonation.view"), sql`${auditLog.details}->>'impersonation' = ${start.body.sessionId}`));
    expect(views.length, "просмотр «от имени» не записан в журнал под ролью").toBeGreaterThan(0);
    expect(views.every((v) => v.actorId === root.id && v.subjectUserId === w.patient.id)).toBe(true);

    const end = await appApi(`/api/ops/people/impersonate/${start.body.sessionId}/end`, root.token, post({}));
    expect(end.status).toBe(200);
    expect((await appApi("/api/auth/me", token)).status).toBe(401);
  });

  test("вход «от имени» специалиста: его зона та же, что у него самого", async () => {
    const start = await appApi(`/api/ops/people/impersonate/${w.specialist.id}`, root.token, post({
      reason: "Розбір звернення щодо списку пацієнтів",
    }));
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const own = await appApi("/api/patients?limit=200", w.specialist.token);
    const seen = await appApi("/api/patients?limit=200", start.body.token);
    expect(seen.status).toBe(200);
    expect([...idsOf(seen.body.items)].sort()).toEqual([...idsOf(own.body.items)].sort());
    const card = await appApi(`/api/patients/${w.patient.id}/card`, start.body.token);
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    await appApi(`/api/ops/people/impersonate/${start.body.sessionId}/end`, root.token, post({}));
  });

  test("консоль SQL: соединение роли приложения, политики действуют, запрос в журнале", async () => {
    const about = await appApi("/api/ops/sec/sql", root.token);
    expect(about.status).toBe(200);
    expect(about.body).toMatchObject({ role: RLS_ROLE, bypassesRls: false });

    const res = await appApi("/api/ops/sec/sql", root.token, post({
      query: `select count(*)::int as n from users where id = '${w.patient.id}'`,
      reason: "Перевірка облікового запису",
    }));
    expect(res.status).toBe(200);
    expect(res.body.status, JSON.stringify(res.body)).toBe("ok");
    expect(res.body.rows).toEqual([["1"]]);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "sec.sql_query"), eq(auditLog.actorId, root.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(JSON.stringify(row?.details)).toContain(w.patient.id);
  });
});

/* ───────────────────────── сторож: владелец и роль ───────────────────────── */

describe("сторож: владелец и роль приложения", () => {
  test("зона и очереди совпадают у владельца и роли для каждого сотрудника мира", async () => {
    /*
     * В очереди работы должно быть по строке каждого вида, который
     * фильтруется зоной: направление (есть), просроченное назначение и
     * просроченный повтор по протоколу — их делаем просроченными задним
     * числом. Без них сравнение «владелец = роль» прошло бы на пустоте.
     */
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    /* батарея сценария уже пройдена (заполнение за пациента) — просроченное назначение заводим отдельно */
    const [battery] = await db.select().from(batteries).where(eq(batteries.groupId, w.groupId)).limit(1);
    await db.insert(batteryAssignments).values({
      id: crypto.randomUUID(),
      batteryId: battery!.id,
      userId: w.patient.id,
      assignedBy: w.admin.id,
      dueAt: past,
      note: "Прострочене",
    });
    await db
      .update(surveyAccess)
      .set({ note: `${followupNote(7)} · ${w.tag}`, expiresAt: past, grantedAt: new Date().toISOString() })
      .where(and(eq(surveyAccess.userId, w.patient.id), eq(surveyAccess.surveyId, w.surveyHidden)));
    const work = await appApi("/api/worklist", w.admin.token);
    const kinds = (work.body.items as { kind: string; userId: string }[])
      .filter((i) => i.userId === w.patient.id)
      .map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["referral", "assignment", "followup"]));

    for (const who of [w.admin, w.specialist, w.otherAdmin]) {
      for (const path of [
        "/api/patients?limit=200",
        "/api/alert-cases?status=all&group=case&limit=100",
        "/api/referrals?all=1&limit=200",
        "/api/worklist",
      ]) {
        const { owner, role } = await both(path, who.token);
        expect(role.status, `${path}: ${JSON.stringify(role.body)?.slice(0, 200)}`).toBe(owner.status);
        if (role.status !== 200) continue;
        expect(
          [...idsOf(role.body.items)].sort(),
          `${path} (${who === w.admin ? "admin" : who === w.specialist ? "specialist" : "otherAdmin"}): ${JSON.stringify(owner.body.items)?.slice(0, 600)}`,
        ).toEqual([...idsOf(owner.body.items)].sort());
      }
    }
  });

  test("о чужих методиках — ни даты сдачи в списке пациентов, ни чужих баллов в нормах; отчёт пациента тот же, что у владельца", async () => {
    /*
     * Было (волна 13): «последняя сдача» в списке пациентов бралась по любой
     * методике учреждения — у администратора чужой группы стояла дата сдачи
     * методики группы А; ролью приложения — пусто.
     */
    const list = await both("/api/patients?limit=200", w.otherAdmin.token);
    const strangerRow = (b: { items: { id: string; lastResponseAt: string | null }[] }) =>
      b.items.find((p) => p.id === w.stranger.id);
    expect(strangerRow(list.owner.body)?.lastResponseAt, "дата сдачи методики чужой группы").toBeNull();
    expect(strangerRow(list.role.body)?.lastResponseAt).toBeNull();

    /*
     * Было (волна 13): печатный отчёт пациента под ролью — «—» вместо
     * подписавшего заключение и без перцентилей (нормативная выборка
     * пациенту видна только из своих прохождений). Десять сдавших — порог
     * нормативной выборки (MIN_NORM_SAMPLE).
     */
    const survey = (await api(`/api/surveys/${w.surveyOpen}`, w.admin.token)).body;
    for (let i = 0; i < 10; i++) {
      const extra = await makeUser("user", `role-norm-${i}-${crypto.randomUUID()}@test.dev`);
      w.cleanup.people.push(extra.id);
      await db.insert(surveyAccess).values({ surveyId: w.surveyOpen, userId: extra.id, grantedBy: w.admin.id });
      /* сцена — владельцем; безопасные ответы, чтобы не плодить случаев в общей очереди */
      const filled = await api(`/api/surveys/${w.surveyOpen}/responses`, w.admin.token, post({
        onBehalfOf: extra.id,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: answersFor(survey, "last"),
      }));
      expect(filled.status, JSON.stringify(filled.body)).toBe(201);
    }
    const report = await fetchBody(`/api/reports/responses/${openResponseId}`, patientToken, true);
    expect(report.status).toBe(200);
    const html = String(report.body);
    expect(html, "подписавший заключение не назван в отчёте пациента").toContain("role-adm-");
    expect(html, "перцентиль не посчитан в отчёте пациента").toMatch(/\d+(\.\d)?-й/);
    const byOwner = await fetchBody(`/api/reports/responses/${openResponseId}`, patientToken, false);
    expect(report.body).toEqual(byOwner.body);
  });

  test("отказы там, где роль не должна видеть: ответ — отказ, а не пустота и не пятисотка", async () => {
    const refusals: [string, string, number][] = [
      [`/api/patients/${w.patient.id}/card`, w.otherAdmin.token, 404],
      [`/api/notes/patients/${w.patient.id}`, w.otherAdmin.token, 404],
      [`/api/safety/patients/${w.patient.id}`, w.otherAdmin.token, 404],
      [`/api/timeline/${w.patient.id}`, w.otherAdmin.token, 404],
      [`/api/referrals/summary/${w.patient.id}`, w.otherAdmin.token, 404],
      [`/api/conclusions/responses/${openResponseId}/conclusion`, w.otherAdmin.token, 404],
      /*
       * Чужая методика — «не найдено» и владельцем, и ролью: с волны 15 зону
       * проверяет lib/clinicalRead.ts, как у заключения и печати (прежде
       * владельцем здесь был 403 «вне зоны»)
       */
      [`/api/responses/${openResponseId}`, w.otherAdmin.token, 404],
      ["/api/patients", patientToken, 403],
      ["/api/alert-cases", patientToken, 403],
      ["/api/referrals", patientToken, 403],
      ["/api/audit", w.admin.token, 403],
      ["/api/ops/overview", w.admin.token, 403],
      ["/api/ops/sec/sql", w.admin.token, 403],
    ];
    for (const [path, token, expected] of refusals) {
      const res = await appApi(path, token);
      expect(res.status, `${path}: ${JSON.stringify(res.body)?.slice(0, 200)}`).toBe(expected);
    }
  });
});

/* ───────────────────────── обход: каждый GET владельцем и ролью ───────────────────────── */

/**
 * Параметры пути — из мира сценариев. Маршрут, параметр которого миру
 * нечем заполнить (чужой токен приглашения, номер запроса в трассе, пара
 * версий для сравнения), пропускается: 404 на выдуманном идентификаторе
 * ничего не проверял бы.
 */
function fillPath(path: string): string | null {
  const byPrefix: [RegExp, () => string][] = [
    [/^\/api\/(groups|analytics\/groups)\//, () => w.groupId],
    [
      /^\/api\/(surveys|analytics\/surveys|access\/surveys|spss\/surveys|norms\/surveys|data-quality\/surveys|facets\/surveys)\//,
      () => w.surveyOpen,
    ],
    [/^\/api\/(reports\/responses|conclusions\/responses|responses)\//, () => openResponseId],
    [/^\/api\/(patients|permissions\/users)\//, () => w.patient.id],
    [/^\/api\/(clinic\/appointments|reports\/visits)\//, () => made.appointmentId],
    [/^\/api\/alert-cases\//, () => made.caseId],
    [/^\/api\/messages\//, () => made.threadId],
    [/^\/api\/mailings\//, () => made.mailingId],
    [/^\/api\/batteries\//, () => made.batteryId],
  ];
  let out = path;
  if (out.includes(":id")) {
    const hit = byPrefix.find(([re]) => re.test(out));
    if (!hit) return null;
    out = out.replace(":id", hit[1]());
  }
  out = out.replace(":userId", w.patient.id).replace(":appointmentId", made.appointmentId);
  return /:[a-zA-Z]/.test(out) ? null : out;
}

/*
 * Маршруты, которые обход не трогает, — с причиной. Поток событий не
 * заканчивается; вход через Google уводит наружу; SPSS-выгрузка «под
 * загрузку» требует расширения в пути.
 */
const SWEEP_SKIP = new Set(["/api/events", "/api/auth/google/start", "/api/auth/google/callback"]);

/* тело различается по замыслу: /health/ready сообщает, действуют ли политики, — это и есть разница */
const BODY_MAY_DIFFER = new Set(["/health/ready"]);

/**
 * Расхождения, которые разобраны и признаны верными. Ключ — «кто путь».
 * Каждое — с причиной; новое расхождение без причины роняет обход.
 */
const KNOWN_DIVERGENCE: Record<string, string> = {
  /*
   * Чужие персональные строки: владельцем строка видна и отказывает проверка
   * маршрута (403), под ролью её прячет политика, и маршрут отвечает «не
   * найдено» (404). В бою — 404, и это правильнее: код отказа не выдаёт, что
   * у другого человека такое прохождение или приём есть. Выравнивать бой по
   * сюите (читать чужую строку системной ролью ради 403) — расширять чтение
   * персональных данных ради кода ответа; наоборот — ломать проверенный
   * контракт маршрутов. Расхождение признано и закреплено здесь.
   */
  "stranger /api/responses/:id": "403→404",
  "stranger /api/reports/responses/:id": "403→404",
  "stranger /api/reports/visits/:id": "403→404",
};

/**
 * Ответ целиком: JSON — разобранным, остальное (HTML-отчёты, CSV, SPSS) —
 * текстом с вымаранными отметками времени. Тело читается внутри того же
 * участка, что и запрос: выгрузка потоком дочитывается уже при чтении тела,
 * и прочитанное снаружи шло бы пулом владельца.
 */
async function fetchBody(path: string, token: string, viaRole: boolean): Promise<{ status: number; body: unknown }> {
  const go = async () => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    let body: unknown = text.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, "<время>");
    if (type.includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        /* не JSON, хоть и назван им — сравним текстом */
      }
    }
    return { status: res.status, body };
  };
  return viaRole ? asAppRole(go) : go();
}

/**
 * Списки — без порядка. Обход сравнивает, ЧТО отдано: лишние и пропавшие
 * строки, «—» вместо имени, другой счёт. Порядок строк с равным ключом
 * сортировки план запроса вправе менять, а под ролью приложения план
 * другой; сравнение с порядком превратило бы обход в лотерею на общей базе
 * CI. Там, где порядок — часть смысла, его проверяют сценарии выше.
 */
function unordered(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(unordered).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unordered(x)]));
  }
  return v;
}

/** Первое место, где тела расходятся, — для отчёта обхода (QUIZZY_SWEEP_REPORT=1) */
function firstDiff(a: unknown, b: unknown, at = ""): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: длина ${a.length} / ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: ${JSON.stringify(a)?.slice(0, 120)} / ${JSON.stringify(b)?.slice(0, 120)}`;
}

describe("обход: каждый GET владельцем и ролью приложения", () => {
  test(
    "под ролью приложения ни один GET не падает пятисоткой и отвечает тем же статусом, что владельцем",
    async () => {
      const routes = dedupe(app.routes).filter((r) => r.method === "GET" && !SWEEP_SKIP.has(r.path));
      const people: [string, string][] = [
        ["patient", patientToken],
        ["stranger", w.stranger.token],
        ["admin", w.admin.token],
        ["specialist", w.specialist.token],
        ["otherAdmin", w.otherAdmin.token],
        ["root", root.token],
      ];
      const problems: string[] = [];
      const report = process.env.QUIZZY_SWEEP_REPORT === "1";
      let checked = 0;
      for (const [who, token] of people) {
        for (const r of routes) {
          const path = fillPath(r.path);
          if (!path) continue;
          checked += 1;
          const owner = await fetchBody(path, token, false);
          const role = await fetchBody(path, token, true);
          const key = `${who} ${r.path}`;
          if (role.status >= 500) {
            problems.push(`${key}: под ролью ${role.status} ${JSON.stringify(role.body)?.slice(0, 160)}`);
          } else if (owner.status !== role.status) {
            const known = KNOWN_DIVERGENCE[key];
            if (known !== `${owner.status}→${role.status}`) {
              problems.push(`${key}: владелец ${owner.status}, роль ${role.status} ${JSON.stringify(role.body)?.slice(0, 160)}`);
            }
          } else if (role.status === 200) {
            /*
             * Тела обязаны совпасть у всех, кроме суперадмина: у того в
             * ответах живые счётчики техпанели и журнала, которые растут
             * между двумя запросами. Так ловится «—» вместо имени и пустой
             * список там, где политика прячет строку, а маршрут молчит.
             */
            const diff = firstDiff(unordered(stable(owner.body)), unordered(stable(role.body)));
            if (diff && report) console.log(`ТЕЛО ${key} ${diff}`);
            if (diff && who !== "root" && !BODY_MAY_DIFFER.has(r.path)) problems.push(`${key}: тело ${diff}`);
          }
        }
      }
      expect(checked, "обход ничего не проверил").toBeGreaterThan(400);
      expect(problems).toEqual([]);
    },
    180_000,
  );
});
