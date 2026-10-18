import { describe, expect, test } from "bun:test";
import type { AlertCase, AppointmentView, PatientListItem, WorkItem } from "@quizzy/shared";
import { buildList, flatIds, mineGroups, viewCounts, viewGroups, type ThreadLike } from "../src/pages/patientCard/listModel";

/**
 * Колонка «Мої пацієнти»: кто в ней, в какой группе и почему. Причина
 * собирается только из того, что приложение знает о дне специалиста, —
 * случаи, приёмный день, разговоры, очередь работы, последняя сдача.
 */

const NOW = Date.parse("2026-10-08T14:00:00.000Z");
const ME = "me";
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const patient = (id: string, over: Partial<PatientListItem> = {}): PatientListItem => ({
  id,
  name: `Пацієнт ${id}`,
  email: `${id}@example.org`,
  unit: "Рота 1",
  sex: "male",
  birthYear: 1990,
  phone: null,
  leadSpecialistId: ME,
  lastResponseAt: null,
  ...over,
});

const alertCase = (userId: string, over: Partial<AlertCase> = {}): AlertCase => ({
  id: `case-${userId}`,
  userId,
  userName: `Пацієнт ${userId}`,
  unit: null,
  surveyId: "s1",
  surveyTitle: "PHQ-9",
  severity: "severe",
  openedAt: iso(168),
  lastAlertAt: iso(168),
  signalCount: 1,
  signals: [],
  minutesOpen: 168,
  escalateMinutes: 240,
  overdue: false,
  assignedTo: null,
  assignedToName: null,
  acknowledgedBy: null,
  acknowledgedByName: null,
  acknowledgedAt: null,
  note: null,
  outcome: null,
  mergedFromLegacy: false,
  ...over,
});

const appt = (patientId: string, startsAt: string, status: AppointmentView["status"] = "booked"): AppointmentView =>
  ({ id: `a-${patientId}`, patientId, patientName: `Пацієнт ${patientId}`, startsAt, status, mode: "onsite", room: "214", kind: "repeat", reason: null }) as unknown as AppointmentView;

const thread = (patientId: string, unread: number): ThreadLike => ({
  id: `t-${patientId}`,
  patientId,
  withName: `Пацієнт ${patientId}`,
  lastMessageAt: iso(30),
  unread,
});

const work = (userId: string, kind: WorkItem["kind"], over: Partial<WorkItem> = {}): WorkItem => ({
  kind,
  id: `w-${userId}-${kind}`,
  userId,
  userName: `Пацієнт ${userId}`,
  unit: null,
  title: kind === "referral" ? "created" : "Безсоння",
  overdue: false,
  assignedTo: ME,
  since: iso(600),
  href: `/patients/${userId}`,
  ...over,
});

const built = buildList({
  me: ME,
  patients: [
    patient("p1"),
    patient("p2", { lastResponseAt: iso(60) }),
    patient("p3"),
    patient("p4"),
    patient("p5"),
    patient("p6"),
    patient("p7", { leadSpecialistId: "colleague" }),
    patient("p8", { leadSpecialistId: "colleague" }),
  ],
  cases: [alertCase("p1"), alertCase("p8", { severity: "moderate" })],
  today: [appt("p3", iso(-90)), appt("p4", iso(240), "no_show"), appt("p2", iso(-30))],
  threads: [thread("p5", 2), thread("p6", 0)],
  work: [work("p4", "noshow"), work("p6", "referral")],
  now: NOW,
});

describe("колонка «Мої пацієнти»", () => {
  test("у человека одна строка — в группе самой срочной причины, остальные едут с ним", () => {
    // p2: приём сегодня и свежий результат — главное приём
    const p2 = built.people.get("p2")!;
    expect(p2.reason.kind).toBe("today");
    expect(p2.also.map((r) => r.kind)).toEqual(["res"]);
    // p4: неявка из очереди работы и из дня — одна причина, не две
    const p4 = built.people.get("p4")!;
    expect(p4.reason.kind).toBe("miss");
    expect(p4.also.filter((r) => r.kind === "miss")).toHaveLength(0);
  });

  test("группы «Мої» — в порядке макета, «без відкритих дій» последней", () => {
    expect(mineGroups(built).map((g) => [g.key, g.items.map((p) => p.id)])).toEqual([
      ["now", ["p1"]],
      ["today", ["p2", "p3"]],
      ["msg", ["p5"]],
      ["miss", ["p4"]],
      ["work", ["p6"]],
    ]);
  });

  test("«мой» — ведущий я или моё дело дня; сигнал чужого пациента — в «Ризик», не в «Мої»", () => {
    expect(built.people.get("p8")!.mine).toBe(false);
    expect(built.people.get("p7")!.mine).toBe(false);
    expect(built.risk.map((p) => p.id)).toEqual(["p1", "p8"]);
  });

  test("числа видов — по тем же людям, что в списке", () => {
    expect(viewCounts(built, 248)).toEqual({ mine: 6, risk: 2, today: 2, msg: 1, res: 1, all: 248 });
  });

  test("вид «Усі» — по алфавиту без групп; поиск — по имени, телефону, подразделению", () => {
    const all = viewGroups(built, "all", "");
    expect(all).toHaveLength(1);
    expect(all[0]!.items.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    expect(viewGroups(built, "mine", "p5").flatMap((g) => g.items.map((p) => p.id))).toEqual(["p5"]);
    expect(viewGroups(built, "risk", "").flatMap((g) => g.items.map((p) => p.id))).toEqual(["p1", "p8"]);
  });

  test("J/K не заходят в свёрнутую группу «без відкритих дій»", () => {
    const withStable = buildList({ me: ME, patients: [patient("a"), patient("b")], cases: [alertCase("a")], today: [], threads: [], work: [], now: NOW });
    const groups = viewGroups(withStable, "mine", "");
    expect(flatIds(groups, false)).toEqual(["a"]);
    expect(flatIds(groups, true)).toEqual(["a", "b"]);
  });
});
