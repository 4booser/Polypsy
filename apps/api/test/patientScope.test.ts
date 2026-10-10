import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { eq, inArray } from "drizzle-orm";
import { PostgresJsPreparedQuery } from "drizzle-orm/postgres-js/session";
import type { User } from "@quizzy/shared";
import { appApi, appRequest, db, encryptPersonFields, hashPassword, makeUser, root, type Person } from "./fixtures";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { withDbContext } from "../src/db/context";
import {
  appointments,
  batteries,
  batteryAssignments,
  breakGlass,
  departmentPatients,
  departments,
  groupAdmins,
  referrals,
  responses,
  slots,
  specialistProfiles,
  surveyAccess,
  surveyGroups,
  surveys,
  users,
} from "../src/db/schema";
import { publish } from "../src/lib/events";
import { accessiblePatientIds, assertPatientAccess, patientsInScope } from "../src/lib/scope";
import { eventStreamTiming } from "../src/routes/events";

/**
 * Вопрос «можно ли к этому человеку» — без построения всей зоны (#181).
 *
 * assertPatientAccess строил зону целиком ради одного пациента, а поток
 * событий — при открытии вкладки и с каждым пульсом. На учреждении в пять
 * тысяч пациентов под ролью приложения это секунды на каждую карточку и на
 * каждую вкладку раз в двадцать пять секунд: пул из десяти соединений
 * кончался, и лёгкий запрос ждал минуту.
 *
 * Проверяется под ролью приложения, как в бою: политики строк — часть
 * цены вопроса, и владелец базы их обходит.
 *
 * 1. Эквивалентность: ответ о человеке тот же, что членство в полной зоне
 *    (accessiblePatientIds), на всех путях в зону и на её границах.
 * 2. Цена не зависит от зоны: число запросов и строк, прочитанных
 *    приложением, при зоне в 1 000 и в 10 000 человек одно и то же.
 * 3. Карточка и очередь работы не строят зону списком: очередь применяет
 *    правило условием к своим строкам.
 * 4. Поток событий не строит зону вовсе — ни при открытии, ни на пульсе, —
 *    и по-прежнему отдаёт события о своих и молчит о чужих.
 */

type Staff = Person & { role: "admin" | "superadmin" };

const asUser = (s: Staff) => ({ id: s.id, role: s.role }) as User;

/** Выполнить fn под ролью приложения с контекстом строк сотрудника — как маршрут */
function underApp<T>(s: Staff, fn: () => Promise<T>): Promise<T> {
  return asAppRole(() => withDbContext(baseDb, { userId: s.id, role: s.role }, fn));
}

/** Пускает ли assertPatientAccess: true — да, false — «не найдено» */
async function asserts(s: Staff, patientId: string): Promise<boolean> {
  try {
    await underApp(s, () => assertPatientAccess(asUser(s), patientId));
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return false;
    throw e;
  }
}

/* ─────────── счёт запросов и строк, прочитанных приложением ─────────── */

interface Tally {
  sql: number;
  rows: number;
}
const tally = new AsyncLocalStorage<Tally>();
type Run = (this: unknown, ...args: unknown[]) => Promise<unknown>;
const proto = PostgresJsPreparedQuery.prototype as unknown as Record<"execute" | "all", Run>;
const originals = { execute: proto.execute, all: proto.all };

async function counted<T>(fn: () => Promise<T>): Promise<{ out: T; sql: number; rows: number }> {
  const t: Tally = { sql: 0, rows: 0 };
  const out = await tally.run(t, fn);
  return { out, sql: t.sql, rows: t.rows };
}

const L = (uk: string) => ({ uk, ru: uk, en: uk });
const OLD = "2024-03-01T09:00:00.000Z";

async function group(title: string): Promise<{ groupId: string; surveyId: string }> {
  const groupId = crypto.randomUUID();
  await db.insert(surveyGroups).values({ id: groupId, title, createdBy: root.id });
  const surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    title: L(title),
    description: L("—"),
    groupId,
    createdBy: root.id,
    status: "published",
  } as never);
  return { groupId, surveyId };
}

async function staff(tag: string, groupIds: string[]): Promise<Staff> {
  const s = await makeUser("admin", `pscope-${tag}-${crypto.randomUUID()}@test`);
  if (groupIds.length) await db.insert(groupAdmins).values(groupIds.map((groupId) => ({ groupId, userId: s.id })));
  return { ...s, role: "admin" };
}

const patient = (tag: string, role: "user" | "admin" = "user") =>
  makeUser(role, `pscope-p-${tag}-${crypto.randomUUID()}@test`);

beforeAll(() => {
  for (const name of ["execute", "all"] as const) {
    const original = originals[name];
    proto[name] = async function (this: unknown, ...args: unknown[]) {
      const out = await original.apply(this, args);
      const t = tally.getStore();
      if (t) {
        t.sql += 1;
        if (Array.isArray(out)) t.rows += out.length;
      }
      return out;
    };
  }
});

afterAll(() => {
  proto.execute = originals.execute;
  proto.all = originals.all;
});

describe("один пациент — тот же ответ, что членство в полной зоне", () => {
  test(
    "отделение, группа, выдача, прохождение, набор, приём, стекло, суперадмин, чужой",
    async () => {
      const own = await group("Зона: своя");
      const foreign = await group("Зона: чужа");
      const batteryId = crypto.randomUUID();
      await db.insert(batteries).values({ id: batteryId, title: "Набір зони", groupId: own.groupId, createdBy: root.id });

      const departmentId = crypto.randomUUID();
      await db.insert(departments).values({ id: departmentId, title: L("Відділення зони"), timezone: "Europe/Kyiv" });

      /* врач: своя группа, своё отделение, приёмы и разбитое стекло */
      const doctor = await staff("doc", [own.groupId]);
      await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId });
      /* без групп: зона только из приёма и стекла — пустой список групп не должен их отменять */
      const bare = await staff("bare", []);
      /* администратор чужой группы */
      const other = await staff("other", [foreign.groupId]);
      const superadmin: Staff = { ...root, role: "superadmin" };

      const p = {
        dept: await patient("dept"),
        detached: await patient("detached"),
        grant: await patient("grant"),
        responded: await patient("resp"),
        battery: await patient("battery"),
        appointment: await patient("appt"),
        cancelledAppointment: await patient("appt-x"),
        glass: await patient("glass"),
        glassExpired: await patient("glass-old"),
        glassRevoked: await patient("glass-rev"),
        foreign: await patient("foreign"),
        /* сотрудник, которому выдали методику группы, — не обследуемый: путь через группу его не берёт */
        staffSubject: await patient("staff", "admin"),
        nobody: await patient("nobody"),
      };

      await db.insert(departmentPatients).values([
        { departmentId, patientId: p.dept.id, attachedVia: "staff" },
        { departmentId, patientId: p.detached.id, attachedVia: "staff", detachedAt: new Date().toISOString() },
      ] as never);
      await db.insert(surveyAccess).values([
        { surveyId: own.surveyId, userId: p.grant.id, grantedBy: root.id },
        { surveyId: foreign.surveyId, userId: p.foreign.id, grantedBy: root.id },
        { surveyId: own.surveyId, userId: p.staffSubject.id, grantedBy: root.id },
      ]);
      await db.insert(responses).values({
        id: crypto.randomUUID(),
        surveyId: own.surveyId,
        userId: p.responded.id,
        status: "completed",
        startedAt: OLD,
        submittedAt: OLD,
      } as never);
      /* набор закрыт: строка не висит в общих очередях, а в зону всё равно ведёт */
      await db.insert(batteryAssignments).values({
        id: crypto.randomUUID(),
        batteryId,
        userId: p.battery.id,
        assignedBy: root.id,
        completedAt: OLD,
      } as never);

      /* приёмы в прошлом, у каждого врача свой слот: дневные очереди соседних файлов их не видят */
      for (const [who, patientId, status] of [
        [doctor, p.appointment.id, "done"],
        [doctor, p.cancelledAppointment.id, "cancelled"],
        [bare, p.appointment.id, "done"],
      ] as const) {
        const slotId = crypto.randomUUID();
        const start = Date.parse(OLD) + Math.floor(Math.random() * 1e6) * 60_000;
        await db.insert(slots).values({
          id: slotId,
          departmentId,
          specialistId: who.id,
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 3_000_000).toISOString(),
          kind: "primary",
        } as never);
        await db.insert(appointments).values({
          id: crypto.randomUUID(),
          slotId,
          patientId,
          specialistId: who.id,
          kind: "primary",
          status,
          bookedBy: who.id,
          ...(status === "cancelled" ? { cancelledAt: OLD } : {}),
        } as never);
      }

      const hour = 3_600_000;
      await db.insert(breakGlass).values([
        {
          id: crypto.randomUUID(),
          actorId: doctor.id,
          patientId: p.glass.id,
          reason: "тест зони",
          expiresAt: new Date(Date.now() + hour).toISOString(),
        },
        {
          id: crypto.randomUUID(),
          actorId: bare.id,
          patientId: p.glass.id,
          reason: "тест зони",
          expiresAt: new Date(Date.now() + hour).toISOString(),
        },
        {
          id: crypto.randomUUID(),
          actorId: doctor.id,
          patientId: p.glassExpired.id,
          reason: "тест зони",
          grantedAt: new Date(Date.now() - 2 * hour).toISOString(),
          expiresAt: new Date(Date.now() - hour).toISOString(),
        },
        {
          id: crypto.randomUUID(),
          actorId: doctor.id,
          patientId: p.glassRevoked.id,
          reason: "тест зони",
          expiresAt: new Date(Date.now() + hour).toISOString(),
          revokedAt: new Date().toISOString(),
        },
      ]);

      const everyone = Object.values(p).map((x) => x.id);
      const names = new Map(Object.entries(p).map(([k, v]) => [v.id, k]));

      /*
       * Ожидание записано явно, а не только «как у полной зоны»: совпадение
       * двух пустых ответов ничего не доказывало бы.
       */
      const expected: [Staff, string, (keyof typeof p)[]][] = [
        [
          doctor,
          "врач",
          ["dept", "grant", "responded", "battery", "appointment", "cancelledAppointment", "glass"],
        ],
        [bare, "без групп", ["appointment", "glass"]],
        [other, "чужая группа", ["foreign"]],
        [superadmin, "суперадмин", Object.keys(p) as (keyof typeof p)[]],
      ];

      for (const [s, label, sees] of expected) {
        const full = await underApp(s, () => accessiblePatientIds(asUser(s)));
        const batch = await underApp(s, () => patientsInScope(asUser(s), everyone));
        for (const id of everyone) {
          const inFull = full === null || full.has(id);
          const one = await asserts(s, id);
          const what = `${label} → ${names.get(id)}`;
          expect(one, `${what}: assertPatientAccess разошёлся с полной зоной`).toBe(inFull);
          expect(batch === null || batch.has(id), `${what}: patientsInScope разошёлся с полной зоной`).toBe(inFull);
          expect(one, `${what}: ожидание`).toBe(sees.includes(names.get(id) as keyof typeof p));
        }
      }
    },
    60_000,
  );
});

describe("цена вопроса о пациенте не зависит от размера зоны", () => {
  const SMALL = 1_000;
  const BIG = 10_000;
  const made: string[] = [];
  let small: Staff;
  let big: Staff;
  let mine: string;
  let neighbour: string;
  let nobody: string;
  /* сотня людей из «дальней» части зоны — для пачки событий */
  let crowd: string[];

  /*
   * Пациенты — пачкой и с одним хешем пароля, как в scopeLoad.test.ts:
   * десять тысяч bcrypt мерили бы подготовку, а не вопрос.
   */
  async function patientsOf(surveyId: string, n: number): Promise<string[]> {
    const hash = await hashPassword("secret12345");
    const rows = Array.from({ length: n }, () => {
      const id = crypto.randomUUID();
      return {
        id,
        email: `pscope-load-${id}@test`,
        ...encryptPersonFields({ firstName: "Тест", lastName: "Зона", birthDate: null }),
        passwordHash: hash,
        role: "user" as const,
      };
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await db.insert(users).values(rows.slice(i, i + 1000) as never);
      await db
        .insert(surveyAccess)
        .values(rows.slice(i, i + 1000).map((r) => ({ surveyId, userId: r.id, grantedBy: root.id })));
    }
    made.push(...rows.map((r) => r.id));
    return rows.map((r) => r.id);
  }

  beforeAll(async () => {
    const a = await group("Зона: тисяча");
    const b = await group("Зона: ще дев'ять тисяч");
    const inA = await patientsOf(a.surveyId, SMALL);
    const inB = await patientsOf(b.surveyId, BIG - SMALL);
    small = await staff("small", [a.groupId]);
    big = await staff("big", [a.groupId, b.groupId]);
    mine = inA[17]!;
    neighbour = inB[42]!;
    crowd = inB.slice(100, 200);
    nobody = (await patient("outside")).id;
    made.push(nobody);
  }, 120_000);

  /*
   * Десять тысяч человек не остаются в общей базе: соседние файлы листают
   * пациентов суперадмином, и чужие тысячи превратили бы порядок обхода
   * файлов в условие их скорости.
   */
  afterAll(async () => {
    for (let i = 0; i < made.length; i += 1000) {
      const chunk = made.slice(i, i + 1000);
      await db.delete(surveyAccess).where(inArray(surveyAccess.userId, chunk));
      await db.delete(users).where(inArray(users.id, chunk));
    }
  }, 120_000);

  test(
    "assertPatientAccess: зона 1 000 и 10 000 — те же запросы и строки",
    async () => {
      const check = (s: Staff, id: string) => counted(() => asserts(s, id));

      /* сначала — что зоны действительно такие, иначе сравнение ничего не значит */
      const sizes = await Promise.all(
        [small, big].map(async (s) => (await underApp(s, () => accessiblePatientIds(asUser(s))))!.size),
      );
      expect(sizes).toEqual([SMALL, BIG]);

      const cases = [
        { s: small, id: mine, allowed: true },
        { s: big, id: mine, allowed: true },
        { s: small, id: neighbour, allowed: false },
        { s: big, id: neighbour, allowed: true },
        { s: small, id: nobody, allowed: false },
        { s: big, id: nobody, allowed: false },
      ];
      const seen: { sql: number; rows: number }[] = [];
      for (const { s, id, allowed } of cases) {
        const { out, sql, rows } = await check(s, id);
        expect(out).toBe(allowed);
        seen.push({ sql, rows });
        /*
         * Строк — единицы: группы сотрудника, ответ о человеке и служебные
         * строки транзакции. Прежде здесь приходила вся зона — тысяча или
         * десять тысяч идентификаторов.
         */
        expect(rows, `${s === big ? "10 000" : "1 000"}: строк прочитано`).toBeLessThan(20);
      }
      const sqlCounts = new Set(seen.map((x) => x.sql));
      expect(sqlCounts.size, `число запросов разное: ${JSON.stringify(seen)}`).toBe(1);
    },
    60_000,
  );

  test(
    "карточка пациента под ролью приложения — без построения зоны",
    async () => {
      for (const s of [small, big]) {
        const { out, rows } = await counted(() => appApi(`/api/patients/${mine}/card`, s.token));
        expect(out.status).toBe(200);
        expect(out.body.id).toBe(mine);
        expect(rows, `${s === big ? "10 000" : "1 000"}: строк прочитано карточкой`).toBeLessThan(200);
      }
      const denied = await appApi(`/api/patients/${neighbour}/card`, small.token);
      expect(denied.status).toBe(404);
    },
    60_000,
  );

  test(
    "маршруты об одном пациенте — без построения зоны",
    async () => {
      /*
       * Те же проверки «человек в зоне», что у assertPatientAccess, только
       * записанные на месте: сводка, записи, план безопасности, направления,
       * динамика.
       */
      const paths = (id: string) => [
        `/api/timeline/${id}`,
        `/api/notes/patients/${id}`,
        `/api/safety/patients/${id}`,
        `/api/referrals/summary/${id}`,
        `/api/dynamics/respondents/${id}`,
      ];
      for (const [s, allowed] of [
        [small, false],
        [big, true],
      ] as const) {
        for (const path of paths(neighbour)) {
          const { out, rows } = await counted(() => appApi(path, s.token));
          const what = `${s === big ? "10 000" : "1 000"}: ${path.replace(neighbour, ":id")}`;
          if (allowed) expect(out.status, `${what}: ${JSON.stringify(out.body)}`).toBeLessThan(400);
          else expect(out.status, what).toBe(404);
          expect(rows, `${what}: строк прочитано`).toBeLessThan(500);
        }
      }
    },
    60_000,
  );

  test(
    "очередь работы — зона условием над своими строками, а не списком",
    async () => {
      /* открытое направление пациента из «дальней» части зоны: большой его видит, малый — нет */
      const referralId = crypto.randomUUID();
      await db.insert(referrals).values({
        id: referralId,
        userId: neighbour,
        destination: "psychiatrist",
        status: "created",
        createdBy: root.id,
      });
      try {
        for (const [s, sees] of [
          [small, false],
          [big, true],
        ] as const) {
          const { out, rows } = await counted(() => appApi("/api/worklist", s.token));
          expect(out.status).toBe(200);
          const ids = (out.body.items as { id: string }[]).map((i) => i.id);
          expect(ids.includes(referralId), `${s === big ? "10 000" : "1 000"}: направление в очереди`).toBe(sees);
          expect(rows, `${s === big ? "10 000" : "1 000"}: строк прочитано очередью`).toBeLessThan(500);
        }
      } finally {
        await db.update(referrals).set({ status: "declined" }).where(eq(referrals.id, referralId));
      }
    },
    60_000,
  );

  test(
    "поток событий не строит зону: ни при открытии, ни на пульсе",
    async () => {
      const saved = eventStreamTiming.pulseMs;
      eventStreamTiming.pulseMs = 120;
      const mark = crypto.randomUUID();
      const t: Tally = { sql: 0, rows: 0 };
      try {
        const res = await tally.run(t, () =>
          appRequest("/api/events", { headers: { Authorization: `Bearer ${big.token}` } }),
        );
        expect(res.status).toBe(200);
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let seen = "";
        const pump = (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              seen += value;
            }
          } catch {
            /* поток закрыт отменой */
          }
        })();
        const until = async (check: () => boolean, ms = 5000) => {
          const end = Date.now() + ms;
          while (Date.now() < end && !check()) await Bun.sleep(20);
          return check();
        };
        const pings = () => seen.split("event: ping").length - 1;
        try {
          expect(await until(() => seen.includes("ready"))).toBe(true);
          /* три пульса — три перечитывания зоны */
          expect(await until(() => pings() >= 3), "поток перестал пульсировать").toBe(true);

          const about = (userId: string, tag: string) =>
            publish(db, {
              kind: "action",
              action: "safety.save",
              surveyIds: null,
              userId,
              resourceId: `${tag}-${mark}`,
              at: new Date().toISOString(),
            });
          /* свой из «дальней» части зоны, чужой — и порядок: событие, ждущее проверки, не обгоняется */
          await about(neighbour, "near");
          await about(nobody, "far");
          await publish(db, {
            kind: "action",
            action: "system.tick",
            surveyIds: null,
            userId: null,
            resourceId: `sys-${mark}`,
            at: new Date().toISOString(),
          });
          expect(await until(() => seen.includes(`sys-${mark}`)), "системное событие не дошло").toBe(true);
          expect(seen.includes(`near-${mark}`), "событие о своём пациенте не дошло").toBe(true);
          expect(seen.indexOf(`near-${mark}`)).toBeLessThan(seen.indexOf(`sys-${mark}`));
          expect(seen.includes(`far-${mark}`), "событие о чужом пациенте ушло в поток").toBe(false);

          /*
           * Пачка: сто событий о разных людях одной транзакцией — так их
           * выпускает проход расписания по когорте. Поток спрашивает базу о
           * людях пачкой, а не запросом на событие: иначе сотня событий на
           * шестьдесят вкладок — шесть тысяч транзакций в пуле из десяти.
           * Вопрос стоит три запроса; пульс каждые 120 мс — ещё три.
           */
          const sqlBefore = t.sql;
          await db.transaction(async (tx) => {
            for (const userId of crowd) {
              await publish(tx, {
                kind: "action",
                action: "schedule.assign",
                surveyIds: null,
                userId,
                resourceId: `crowd-${mark}`,
                at: new Date().toISOString(),
              });
            }
          });
          const crowdSeen = () => seen.split(`crowd-${mark}`).length - 1;
          expect(await until(() => crowdSeen() >= crowd.length), `дошло из пачки: ${crowdSeen()}`).toBe(true);
          expect(t.sql - sqlBefore, "запросов потока на пачку из ста событий").toBeLessThan(60);
        } finally {
          await reader.cancel().catch(() => {});
          await pump;
        }
        /*
         * Открытие, три пульса и две проверки людей — десятки строк. Прежде
         * открытие и каждый пульс читали зону целиком: 10 000 строк × 4.
         */
        expect(t.rows, `строк прочитано потоком: ${t.rows}, запросов: ${t.sql}`).toBeLessThan(500);
      } finally {
        eventStreamTiming.pulseMs = saved;
      }
    },
    30_000,
  );
});
