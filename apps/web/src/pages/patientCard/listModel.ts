import type { AlertCase, AppointmentView, PatientListItem, Sex, WorkItem } from "@quizzy/shared";

/*
 * Колонка «Мої пацієнти» — чистая логика: кто в ней, почему он здесь сейчас
 * и что дальше. Без React и сети (apps/web/test/patientCardList.test.ts).
 *
 * Причина собирается из того, что приложение уже знает о дне специалиста:
 *
 *   now   — открытый случай риска (GET /api/alert-cases, по человеку);
 *   today — приём сегодня, ещё не проведённый (GET /api/clinic/today);
 *   msg   — непрочитанное письмо в своём разговоре (GET /api/messages);
 *   res   — сдал методику за последние трое суток (lastResponseAt списка);
 *   miss  — неявка: из очереди работы и из сегодняшнего дня;
 *   work  — прочее из очереди работы: просроченный учёт, назначение,
 *           направление, повтор по протоколу — заголовком сервера;
 *   stable — «мой» (ведущий — я), но открытого ничего.
 *
 * У человека одна строка: в группе самой срочной причины. Остальные
 * причины едут с ним (`also`) — их показывает подсказка «хто це».
 */

export type ReasonKind = "now" | "today" | "msg" | "res" | "miss" | "work" | "stable";

export interface ThreadLike {
  id: string;
  patientId?: string;
  withName: string;
  lastMessageAt: string;
  unread: number;
}

export type Reason =
  | { kind: "now"; c: AlertCase }
  | { kind: "today"; a: AppointmentView }
  | { kind: "msg"; t: ThreadLike }
  | { kind: "res"; at: string }
  | { kind: "miss"; at: string }
  | { kind: "work"; w: WorkItem }
  | { kind: "stable" };

export interface ListPerson {
  id: string;
  name: string;
  unit: string | null;
  birthYear: number | null;
  sex: Sex | null;
  phone: string | null;
  lastResponseAt: string | null;
  /** Ведущий — я, или дело дня моё (приём, письмо, задача, взятый случай) */
  mine: boolean;
  reason: Reason;
  also: Reason[];
}

/** Порядок групп на экране — как в макете: сигнал, приём, письмо, результаты, неявка, прочее */
export const GROUP_ORDER: ReasonKind[] = ["now", "today", "msg", "res", "miss", "work"];

/** Какая причина главнее: сигнал, потом неявка (молчание — тоже сигнал), приём, письмо, задача, результаты */
const PRIORITY: Record<ReasonKind, number> = { now: 0, miss: 1, today: 2, msg: 3, work: 4, res: 5, stable: 6 };

/** «Нові результати» — сданное за последние трое суток */
export const FRESH_RESULT_MS = 3 * 86_400_000;

const SEV_RANK = { severe: 1, moderate: 0 } as const;

export interface ListInput {
  me: string;
  patients: readonly PatientListItem[];
  cases: readonly AlertCase[];
  today: readonly AppointmentView[];
  threads: readonly ThreadLike[];
  work: readonly WorkItem[];
  now: number;
}

export interface BuiltList {
  people: Map<string, ListPerson>;
  /** Открытый случай у любого человека зоны — вид «Ризик» */
  risk: ListPerson[];
}

function stamp(r: Reason): number {
  switch (r.kind) {
    case "now":
      return Date.parse(r.c.openedAt);
    case "today":
      return Date.parse(r.a.startsAt);
    case "msg":
      return Date.parse(r.t.lastMessageAt);
    case "work":
      return Date.parse(r.w.since);
    case "res":
    case "miss":
      return Date.parse(r.at);
    default:
      return 0;
  }
}

export function buildList(input: ListInput): BuiltList {
  const people = new Map<string, ListPerson>();
  const reasons = new Map<string, Reason[]>();
  const mineIds = new Set<string>();

  const seed = (id: string, name: string, extra: Partial<ListPerson> = {}): void => {
    if (people.has(id)) return;
    people.set(id, {
      id,
      name,
      unit: null,
      birthYear: null,
      sex: null,
      phone: null,
      lastResponseAt: null,
      mine: false,
      reason: { kind: "stable" },
      also: [],
      ...extra,
    });
  };
  const add = (id: string, r: Reason) => reasons.set(id, [...(reasons.get(id) ?? []), r]);

  for (const p of input.patients) {
    seed(p.id, p.name, {
      unit: p.unit,
      birthYear: p.birthYear,
      sex: p.sex,
      phone: p.phone,
      lastResponseAt: p.lastResponseAt,
    });
    if (p.leadSpecialistId === input.me) mineIds.add(p.id);
    if (p.lastResponseAt && input.now - Date.parse(p.lastResponseAt) <= FRESH_RESULT_MS) {
      add(p.id, { kind: "res", at: p.lastResponseAt });
    }
  }

  const risk: string[] = [];
  for (const c of input.cases) {
    if (c.acknowledgedAt) continue;
    seed(c.userId, c.userName, { unit: c.unit });
    add(c.userId, { kind: "now", c });
    risk.push(c.userId);
    if (c.assignedTo === input.me) mineIds.add(c.userId);
  }

  for (const a of input.today) {
    seed(a.patientId, a.patientName);
    mineIds.add(a.patientId);
    if (a.status === "no_show") add(a.patientId, { kind: "miss", at: a.startsAt });
    else if (a.status !== "done" && a.status !== "cancelled") add(a.patientId, { kind: "today", a });
  }

  for (const t of input.threads) {
    if (!t.patientId || t.unread <= 0) continue;
    seed(t.patientId, t.withName);
    mineIds.add(t.patientId);
    add(t.patientId, { kind: "msg", t });
  }

  for (const w of input.work) {
    seed(w.userId, w.userName, { unit: w.unit });
    if (w.assignedTo === input.me || w.assignedTo === null) mineIds.add(w.userId);
    if (w.kind === "noshow") add(w.userId, { kind: "miss", at: w.since });
    else if (w.kind !== "message") add(w.userId, { kind: "work", w });
  }

  for (const [id, p] of people) {
    const list = (reasons.get(id) ?? []).sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || stamp(b) - stamp(a));
    // одна неявка из двух источников (очередь работы и сегодняшний день) — одна причина
    const unique = list.filter((r, i) => r.kind !== "miss" || list.findIndex((x) => x.kind === "miss") === i);
    p.reason = unique[0] ?? { kind: "stable" };
    p.also = unique.slice(1);
    p.mine = mineIds.has(id);
  }

  const riskPeople = [...new Set(risk)].map((id) => people.get(id)!).sort(byUrgency);
  return { people, risk: riskPeople };
}

/** Порядок внутри группы: сигнал — тяжесть и давность; приём — по времени; прочее — свежее первым */
export function byUrgency(a: ListPerson, b: ListPerson): number {
  const ra = a.reason;
  const rb = b.reason;
  if (ra.kind === "now" && rb.kind === "now") {
    return SEV_RANK[rb.c.severity] - SEV_RANK[ra.c.severity] || Date.parse(ra.c.openedAt) - Date.parse(rb.c.openedAt);
  }
  if (ra.kind === "today" && rb.kind === "today") return Date.parse(ra.a.startsAt) - Date.parse(rb.a.startsAt);
  if (ra.kind === "stable" && rb.kind === "stable") return a.name.localeCompare(b.name);
  return stamp(rb) - stamp(ra);
}

export interface ListGroupOut {
  key: ReasonKind;
  items: ListPerson[];
}

/** Группы вида «Мої»: только мои, по главной причине; «без відкритих дій» — последней */
export function mineGroups(built: BuiltList): ListGroupOut[] {
  const mine = [...built.people.values()].filter((p) => p.mine);
  const groups: ListGroupOut[] = [];
  for (const key of [...GROUP_ORDER, "stable" as const]) {
    const items = mine.filter((p) => p.reason.kind === key).sort(byUrgency);
    if (items.length) groups.push({ key, items });
  }
  return groups;
}

export type ListView = "mine" | "risk" | "today" | "msg" | "res" | "all";

export interface ViewCounts {
  mine: number;
  risk: number;
  today: number;
  msg: number;
  res: number;
  all: number;
}

export function viewCounts(built: BuiltList, total: number): ViewCounts {
  const mine = [...built.people.values()].filter((p) => p.mine);
  const has = (p: ListPerson, k: ReasonKind) => p.reason.kind === k || p.also.some((r) => r.kind === k);
  return {
    mine: mine.length,
    risk: built.risk.length,
    today: mine.filter((p) => has(p, "today")).length,
    msg: mine.filter((p) => has(p, "msg")).length,
    res: mine.filter((p) => has(p, "res")).length,
    all: Math.max(total, built.people.size),
  };
}

/**
 * Строки вида. «Мої» — группами; остальные — одной группой своей причины
 * (у «Усі» — по алфавиту, без групп). Поиск — по имени, телефону и
 * подразделению, без учёта регистра.
 */
export function viewGroups(built: BuiltList, view: ListView, q: string): ListGroupOut[] {
  const needle = q.trim().toLowerCase();
  const match = (p: ListPerson) =>
    !needle || `${p.name} ${p.phone ?? ""} ${p.unit ?? ""}`.toLowerCase().includes(needle);
  const has = (p: ListPerson, k: ReasonKind) => p.reason.kind === k || p.also.some((r) => r.kind === k);
  const filterGroups = (gs: ListGroupOut[]) =>
    gs.map((g) => ({ ...g, items: g.items.filter(match) })).filter((g) => g.items.length);

  switch (view) {
    case "mine":
      return filterGroups(mineGroups(built));
    case "risk":
      return filterGroups([{ key: "now", items: built.risk }]);
    case "today":
    case "msg":
    case "res": {
      const items = [...built.people.values()].filter((p) => p.mine && has(p, view)).sort(byUrgency);
      return filterGroups([{ key: view, items }]);
    }
    case "all": {
      const items = [...built.people.values()].sort((a, b) => a.name.localeCompare(b.name));
      return filterGroups([{ key: "stable", items }]);
    }
  }
}

/** Подряд все строки вида — по ним ходят J и K */
export function flatIds(groups: readonly ListGroupOut[], stableOpen: boolean): string[] {
  return groups.flatMap((g) => (g.key === "stable" && !stableOpen ? [] : g.items.map((p) => p.id)));
}
