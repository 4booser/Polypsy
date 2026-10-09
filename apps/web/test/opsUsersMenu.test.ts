import { describe, expect, test } from "bun:test";
import {
  accountRefusal,
  accountStanding,
  type OpsUserRow,
  type Role,
  roleRank,
  SUPERADMIN_RANK,
  type UiKey,
} from "@quizzy/shared";
import * as serverRule from "../../api/src/lib/accountRule";
import { rowExtrasFor } from "../src/pages/ops/people2/UserTools";
import { userRowMenu } from "../src/pages/ops/Users";
import { accountOutOfReach } from "../src/pages/ops/usersModel";

/**
 * Техпанель → «Користувачі»: меню строки не предлагает действий над
 * учётками на ступени смотрящего и выше (w19:ui).
 *
 * С волны 15 сервер отказывает в любом действии над чужой учёткой не строго
 * ниже своего положения (err.accountAtOrAboveYours; над суперадмином —
 * err.superadminOnly). Меню же показывало заведующему у главного врача
 * «скинути пароль», «вимкнути», «змінити роль» живыми — и каждое кончалось
 * отказом. Теперь такие пункты скрыты (не погашены), остаются переходы
 * «посмотреть»; суперадмину — меню как прежде.
 *
 * Меню собирается функцией userRowMenu (Users.tsx) с подставными ut и can:
 * подпись пункта здесь — его ключ словаря.
 */

const ut = (key: UiKey) => key;

/** Пункты-действия: всё, что меняет учётку или открывает окно над ней */
const ACTIONS: UiKey[] = [
  "ops.users.changeRole",
  "ops.users.permissions",
  "dev.title",
  "ops.users.resetPassword",
  "ops.users.revokeSessions",
  "ops.users.disable",
  "ops.users.enable",
  "ops.users.delete",
  "ops.imp.action",
  "ops.mfa.reset",
];
/** Переходы «посмотреть»: остаются у любой строки */
const VIEWS: UiKey[] = ["ops.users.sessionsOf", "ops.users.actorLog", "ops.users.subjectLog"];

interface Person {
  id: string;
  role: Role;
  ladderRank: number;
}

const SUPER: Person = { id: "u-super", role: "superadmin", ladderRank: SUPERADMIN_RANK };
const SUPER2: Person = { id: "u-super2", role: "superadmin", ladderRank: SUPERADMIN_RANK };
const CHIEF: Person = { id: "u-chief", role: "admin", ladderRank: roleRank("chief") };
const HEAD: Person = { id: "u-head", role: "admin", ladderRank: roleRank("head") };
const HEAD2: Person = { id: "u-head2", role: "admin", ladderRank: roleRank("head") };
const SPEC: Person = { id: "u-spec", role: "admin", ladderRank: roleRank("specialist") };
const SPEC2: Person = { id: "u-spec2", role: "admin", ladderRank: roleRank("specialist") };
/** Сотрудник вне лестницы (встроенный «психолог»): ступень 0, положение 1 */
const PSY: Person = { id: "u-psy", role: "admin", ladderRank: 0 };
const PATIENT: Person = { id: "u-patient", role: "user", ladderRank: 0 };

const row = (p: Person, over: Partial<OpsUserRow> = {}): OpsUserRow => ({
  id: p.id,
  email: `${p.id}@clinic.ua`,
  fullName: `Коваль ${p.id}`,
  role: p.role,
  anonymous: false,
  roleTitles: [],
  ladderRank: p.ladderRank,
  exceptions: 0,
  createdAt: "2026-09-01T09:00:00.000Z",
  lastSeenAt: null,
  disabledAt: null,
  disabledReason: null,
  disabledByEmail: null,
  mustChangePassword: false,
  sessions: 2,
  trace: {
    responses: 0,
    conclusions: 0,
    notes: 0,
    cases: 0,
    surveys: 0,
    referrals: 0,
    appointments: 0,
    episodes: 0,
    safetyPlans: 0,
    recordings: 0,
    consents: 0,
    threads: 0,
    dispensary: 0,
  },
  journalEntries: 0,
  ...over,
});

const menu = (me: Person, target: Person, over: Partial<OpsUserRow> = {}) =>
  userRowMenu(row(target, over), {
    me,
    can: () => true,
    ut,
    open: () => {},
    extras: rowExtrasFor(ut, me),
  });

const labels = (me: Person, target: Person, over: Partial<OpsUserRow> = {}) => menu(me, target, over).map((e) => e.label);
const actionsOf = (me: Person, target: Person) => labels(me, target).filter((l) => ACTIONS.includes(l as UiKey));

describe("не-суперадмину — без действий над теми, кто на его ступени и выше", () => {
  test("заведующий: у главного врача, другого заведующего и суперадмина — только «посмотреть»", () => {
    for (const target of [CHIEF, HEAD2, SUPER]) {
      expect(labels(HEAD, target), target.id).toEqual(VIEWS);
    }
  });

  test("скрыты, а не погашены: пунктов-действий в меню нет вовсе", () => {
    const entries = menu(HEAD, CHIEF);
    expect(entries.some((e) => e.disabled)).toBe(false);
    expect(entries.every((e) => !!e.to && !e.onSelect)).toBe(true);
  });

  test("ниже по лестнице, вне её и пациенты — меню как прежде", () => {
    for (const target of [SPEC, PSY, PATIENT]) {
      expect(actionsOf(HEAD, target), target.id).toEqual(ACTIONS.filter((k) => k !== "ops.users.enable"));
    }
    // выключенному — «увімкнути» вместо «вимкнути»
    expect(labels(HEAD, SPEC, { disabledAt: "2026-10-01T09:00:00.000Z" })).toContain("ops.users.enable");
  });

  test("специалист равного не трогает; сотрудник вне лестницы — только пациентов", () => {
    expect(labels(SPEC, SPEC2)).toEqual(VIEWS);
    expect(labels(SPEC, HEAD)).toEqual(VIEWS);
    expect(actionsOf(SPEC, PSY).length).toBeGreaterThan(0);
    for (const target of [SPEC, PSY, HEAD, CHIEF]) {
      expect(labels({ ...PSY, id: "u-psy2" }, target), target.id).toEqual(VIEWS);
    }
    expect(actionsOf(PSY, PATIENT).length).toBeGreaterThan(0);
  });

  test("главный врач действует над всеми сотрудниками и пациентами, кроме суперадмина", () => {
    for (const target of [HEAD, SPEC, PSY, PATIENT]) {
      expect(actionsOf(CHIEF, target).length, target.id).toBeGreaterThan(0);
    }
    expect(labels(CHIEF, SUPER)).toEqual(VIEWS);
  });

  test("без права журнала у недосягаемой строки остаются сессии — меню не пустеет", () => {
    const entries = userRowMenu(row(CHIEF), {
      me: HEAD,
      can: () => false,
      ut,
      open: () => {},
      extras: rowExtrasFor(ut, HEAD),
    });
    expect(entries.map((e) => e.label)).toEqual(["ops.users.sessionsOf"]);
  });
});

describe("суперадмину — как прежде", () => {
  test("у любой чужой строки, включая другого суперадмина, все пункты на месте", () => {
    for (const target of [SUPER2, CHIEF, HEAD, SPEC, PSY]) {
      expect(actionsOf(SUPER, target), target.id).toEqual(ACTIONS.filter((k) => k !== "ops.users.enable"));
    }
    // у пациента «Права й винятки» погашены с объяснением, как было: прав персонала у него нет
    const perms = menu(SUPER, PATIENT).find((e) => e.label === "ops.users.permissions");
    expect(perms?.disabled).toBe(true);
    expect(perms?.hint).toBe("ops.users.patientNoPerms");
  });

  test("удаление и вход «от имени» у суперадмина живые", () => {
    const entries = menu(SUPER, HEAD);
    expect(entries.find((e) => e.label === "ops.users.delete")?.disabled).toBe(false);
    expect(entries.find((e) => e.label === "ops.imp.action")?.disabled).toBe(false);
  });
});

describe("своя строка — прежняя причина: погашено с объяснением", () => {
  test("заведующий у себя видит пункты погашенными, «не з власним обліковим записом»", () => {
    const entries = menu(HEAD, HEAD);
    const own = (k: UiKey) => entries.find((e) => e.label === k);
    for (const k of ["ops.users.changeRole", "ops.users.resetPassword", "ops.users.disable"] as UiKey[]) {
      expect(own(k)?.disabled, k).toBe(true);
      expect(own(k)?.hint, k).toBe("ops.users.notSelf");
    }
    // свои сессии завершить можно — это выход
    expect(own("ops.users.revokeSessions")?.disabled).toBe(false);
  });
});

describe("одно правило с сервером", () => {
  test("сервер берёт «кто над кем» из общего пакета, а не из своей копии", () => {
    expect(serverRule.accountRefusal).toBe(accountRefusal);
    expect(serverRule.standingFromRank).toBe(accountStanding);
  });

  test("недосягаемость меню — ровно отказы сервера «выше» и «только суперадмин»", () => {
    const people = [SUPER, SUPER2, CHIEF, HEAD, HEAD2, SPEC, SPEC2, PSY, PATIENT];
    const side = (p: Person) => ({ id: p.id, role: p.role, standing: accountStanding(p.role, p.ladderRank) });
    for (const me of people.filter((p) => p.role !== "user")) {
      for (const target of people) {
        const refusal = accountRefusal(side(me), side(target));
        const expected = refusal === "aboveYours" || refusal === "superadminOnly";
        expect(accountOutOfReach(me, target), `${me.id} → ${target.id}: ${refusal}`).toBe(expected);
      }
    }
  });

  test("строго ниже: равная ступень — уже вне досягаемости", () => {
    expect(accountOutOfReach(HEAD, HEAD2)).toBe(true);
    expect(accountOutOfReach(HEAD, SPEC)).toBe(false);
    // ступень из /api/auth/me может не прийти — тогда сотрудник считается вне лестницы
    expect(accountOutOfReach({ id: "u-x", role: "admin" }, PSY)).toBe(true);
    expect(accountOutOfReach({ id: "u-x", role: "admin" }, PATIENT)).toBe(false);
  });
});
