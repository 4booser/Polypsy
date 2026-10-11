import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AUDIT_OFFSET_MAX } from "@quizzy/shared";
import { appApi, db, root, sql } from "./fixtures";

/**
 * Отбор журнала по автору на миллионе строк (#202).
 *
 * «Кто» куском почты был ILIKE '%…%' по actor_email — полный перебор
 * журнала, и дважды: страница и счёт на первой странице (2 млн строк на
 * цели). Индекс по тексту под политикой строк не помогает (ILIKE не
 * LEAKPROOF, см. routes/audit.ts). Теперь кусок почты находит учётки, а
 * журнал отбирается по их идентификаторам — индексом audit_actor_idx, по
 * всему журналу, без окна. Автор в строке журнала всегда учётка: почта без
 * идентификатора в журнал не пишется (вход с незнакомым адресом — без
 * автора).
 *
 * Глубокое смещение — до 5 000 строк; дальше — курсор (он уже есть).
 *
 * Строки посева — вне цепочки (seq пуст): проверку целостности они не
 * трогают, и уходят в afterAll вместе с учётками.
 */

const TAG = `w22act${crypto.randomUUID().slice(0, 8)}`;
const ROWS = 1_000_000;
const BULK = 50;
const bulkId = (n: number) => `${TAG}-bulk-${n}`;
const bulkEmail = (n: number) => `${TAG}-bulk-${n}@audit-actor.test`;
const rare = { id: crypto.randomUUID(), email: `${TAG}-rare@audit-actor.test` };

beforeAll(async () => {
  /* пятьдесят частых авторов и один редкий — учётки, как у настоящих строк журнала */
  await db.execute(sql`
    insert into users (id, email, password_hash, first_name, last_name, role)
    select ${TAG} || '-bulk-' || g, ${TAG} || '-bulk-' || g || '@audit-actor.test', 'x', 'Т', 'Т', 'admin'
    from generate_series(0, ${BULK - 1}::int) g`);
  await db.execute(sql`
    insert into users (id, email, password_hash, first_name, last_name, role)
    values (${rare.id}, ${rare.email}, 'x', 'Т', 'Т', 'admin')`);
  /* миллион строк за два года (шаг 63 с) от частых авторов; у редкого — пять строк, разнесённых на полтора года */
  await db.execute(sql`
    insert into audit_log (id, at, actor_id, actor_email, actor_role, action, resource_type, resource_id, outcome, details)
    select ${TAG} || '-' || g, now() - g * interval '63 seconds',
           ${TAG} || '-bulk-' || (g % ${BULK}), ${TAG} || '-bulk-' || (g % ${BULK}) || '@audit-actor.test', 'admin',
           (array['auth.login', 'response.read', 'report.render', 'patient.card_read'])[1 + g % 4],
           'response', md5(g::text), 'success', jsonb_build_object('n', g)
    from generate_series(1, ${ROWS}::int) g`);
  await db.execute(sql`
    insert into audit_log (id, at, actor_id, actor_email, actor_role, action, outcome)
    select ${TAG} || '-rare-' || g, now() - g * interval '100 days', ${rare.id}, ${rare.email}, 'admin', 'auth.login', 'success'
    from generate_series(1, 5) g`);
  /* как у живого журнала: дописанное только в конец автоочистка отмечает видимым, и счёт идёт по индексу */
  await db.execute(sql`vacuum analyze audit_log`);
  await db.execute(sql`analyze users`);
}, 300_000);

afterAll(async () => {
  // журнал неизменяем и для владельца; посев снимается так же, как в auditSearch.test.ts
  await db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
  try {
    await db.execute(sql`delete from audit_log where id like ${`${TAG}-%`}`);
  } finally {
    await db.execute(sql`alter table audit_log enable trigger audit_log_immutable`);
  }
  await db.execute(sql`delete from users where id like ${`${TAG}-%`} or id = ${rare.id}`);
  // миллион мёртвых строк не должен доставаться соседям полным просмотром
  await db.execute(sql`vacuum analyze audit_log`);
}, 300_000);

type Page = {
  entries: { id: string; actorId: string | null }[];
  total?: number;
  nextCursor: string | null;
  searchPeriod?: { from: string; to: string };
};

async function timed(path: string) {
  const t0 = performance.now();
  const res = await appApi<Page>(path, root.token);
  return { ...res, ms: performance.now() - t0 };
}

/*
 * Порог редкого автора — 300 мс. Индекс по автору отвечает за единицы
 * миллисекунд, а перебор миллиона строк дважды (страница и счёт) — от
 * полусекунды на машине разработчика и дольше на раннере CI: секундный
 * порог из условия задачи прежний код здесь проходил бы впритык, а
 * регрессию надо ловить. У частого автора (двадцать тысяч строк в счёте) —
 * секунда из условия задачи.
 */
const FAST_MS = 300;

describe("журнал: отбор по автору на миллионе строк (#202)", () => {
  test("кусок почты редкого автора — его строки за весь журнал, со счётом, быстро и без окна", async () => {
    const res = await timed(`/api/audit?actor=${encodeURIComponent(`${TAG}-rare@`)}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(FAST_MS);
    expect(res.body.entries.map((e) => e.id).sort()).toEqual([1, 2, 3, 4, 5].map((g) => `${TAG}-rare-${g}`).sort());
    expect(res.body.total).toBe(5);
    // поиск по автору окна не навязывает: строка полуторагодовой давности на месте
    expect(res.body.searchPeriod).toBeUndefined();
  }, 30_000);

  test("положительный контроль: идентификатор автора — те же строки", async () => {
    const res = await timed(`/api/audit?actor=${rare.id}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(FAST_MS);
    expect(res.body.total).toBe(5);
    expect(res.body.entries.every((e) => e.actorId === rare.id)).toBe(true);
  }, 30_000);

  test("частый автор: первая страница со счётом и следующая курсором — быстро", async () => {
    const first = await timed(`/api/audit?actor=${encodeURIComponent(bulkEmail(7))}&limit=50`);
    expect(first.status).toBe(200);
    expect(first.ms).toBeLessThan(1000);
    expect(first.body.entries).toHaveLength(50);
    expect(first.body.entries.every((e) => e.actorId === bulkId(7))).toBe(true);
    expect(first.body.total).toBe(ROWS / BULK);

    const second = await timed(
      `/api/audit?actor=${encodeURIComponent(bulkEmail(7))}&limit=50&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    expect(second.ms).toBeLessThan(1000);
    expect(second.body.entries).toHaveLength(50);
    expect(second.body.entries.every((e) => e.actorId === bulkId(7))).toBe(true);
    expect(second.body.entries[0]!.id).not.toBe(first.body.entries[0]!.id);
  }, 30_000);

  test("кусок почты, который не нашёл ни одной учётки, — пустой отбор, а не «фильтр не применён»", async () => {
    const res = await timed(`/api/audit?actor=${encodeURIComponent(`${TAG}-nobody`)}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  }, 30_000);
});

describe("журнал: глубокое смещение ограничено (#202)", () => {
  test("смещение дальше 5 000 — отказ: глубже листают курсором", async () => {
    const res = await timed(`/api/audit?offset=${AUDIT_OFFSET_MAX + 1}&limit=50`);
    expect(res.status).toBe(400);
    // прежде принималось до миллиона — и такая страница сортировала журнал целиком
    expect((await timed("/api/audit?offset=900000&limit=50")).status).toBe(400);
  }, 30_000);

  test("положительный контроль: смещение 5 000 с самой длинной страницей — страница, быстро", async () => {
    const res = await timed(`/api/audit?offset=${AUDIT_OFFSET_MAX}&limit=500`);
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(1000);
    expect(res.body.entries).toHaveLength(500);
  }, 30_000);
});
