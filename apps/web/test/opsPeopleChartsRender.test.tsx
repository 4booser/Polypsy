import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type AuditDaily, type OpsSessionsSummary, type OpsUsersSummary, type WhoViewedReport } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import {
  AuditTimelineBody,
  GrantsOverviewBody,
  MfaCoverageChart,
  SessionsOverviewBody,
  SuspiciousOverviewBody,
  UsersOverviewBody,
  WhoViewedCharts,
} from "../src/pages/ops/people2/charts";

/**
 * Графики разделов людей рисуются на краях: пустая база, скрытые порогом
 * пациенты, отчёт без единого просмотра. Техпанель открывают как раз тогда,
 * когда что-то пошло не так, — и график, который падает на «ещё ничего не
 * было» или рисует скрытое нулём, там хуже пустого места.
 */
const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const uk = (key: keyof typeof UI) => UI[key].uk;
/* разметка экранирует кавычки и апострофы — сравниваем с экранированным */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;").replace(/</g, "&lt;");

const days = (n: number, v: (i: number) => { success: number; failed: number }) =>
  Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, ...v(i) }));

const summary: OpsUsersSummary = {
  roles: [
    {
      role: "superadmin",
      total: 3,
      states: [
        { key: "active", count: 2 },
        { key: "never", count: 0 },
        { key: "locked", count: 0 },
        { key: "disabled", count: 1 },
      ],
      mfa: { enabled: 1, total: 2 },
    },
    {
      role: "admin",
      total: 20,
      states: [
        { key: "active", count: 15 },
        { key: "never", count: 3 },
        { key: "locked", count: 1 },
        { key: "disabled", count: 1 },
      ],
      mfa: { enabled: 4, total: 19 },
    },
    { role: "user", total: null, states: ["active", "never", "locked", "disabled"].map((key) => ({ key: key as "active", count: null })), mfa: null },
  ],
  newByWeek: [
    { week: "2026-09-14", staff: 2, patients: null },
    { week: "2026-09-21", staff: 1, patients: 6 },
  ],
  loginsByDay: days(30, (i) => ({ success: i % 4, failed: i % 7 === 0 ? 2 : 0 })),
  smallCellFloor: 5,
};

describe("зведення реєстру", () => {
  test("роли полосами с числами, пациенты под порогом — словами, а не пустой полосой", () => {
    const html = draw(<UsersOverviewBody data={summary} />);
    expect(html).toContain(uk("adm.roleSuper"));
    expect(html).toContain(uk("opsp.state.disabled"));
    // скрытое целое — «приховано», и полосы у пациентов нет
    expect(html).toContain(uk("kit.hidden"));
    expect(html).not.toContain(`${esc(uk("adm.rolePatient"))}: ${esc(uk("opsp.state.active"))}`);
    // второй фактор — только у персонала: две полосы, у каждой своя легенда с долей
    expect(html.split(`>${uk("opsp.mfa.on")}<`).length - 1).toBe(2);
    expect(html).toContain("4 · 21%");
  });

  test("столбцы с подписью для диктора; неделя со скрытыми пациентами названа в ней", () => {
    const html = draw(<UsersOverviewBody data={summary} />);
    expect(html).toContain('role="img"');
    expect(html).toContain(esc(`${uk("opsp.users.newByWeek")} (${uk("opsp.series.staff")}, ${uk("opsp.series.patients")})`));
    expect(html).toContain(esc(`${uk("kit.hidden")}: 1`));
    // неудачные входы — янтарём, и легенда рядом: статус не цветом в одиночку
    expect(html).toContain('fill="var(--accent)"');
    expect(html).toContain(uk("opsp.series.failed"));
  });

  test("ни одного хекса в разметке: цвета — только токены", () => {
    const html = draw(<UsersOverviewBody data={summary} />);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  test("ни одного входа за месяц — «немає даних» словами, а не пустые оси", () => {
    const html = draw(<UsersOverviewBody data={{ ...summary, loginsByDay: days(30, () => ({ success: 0, failed: 0 })) }} />);
    expect(html).toContain(uk("chart.noData"));
  });
});

describe("зведення сесій", () => {
  const data: OpsSessionsSummary = {
    byRole: [
      { role: "superadmin", sessions: 2 },
      { role: "admin", sessions: 9 },
      { role: "user", sessions: null },
    ],
    byAge: [
      {
        group: "staff",
        total: 11,
        buckets: [
          { key: "day", count: 6 },
          { key: "week", count: 3 },
          { key: "month", count: 2 },
          { key: "older", count: 0 },
        ],
      },
      { group: "patients", total: null, buckets: (["day", "week", "month", "older"] as const).map((key) => ({ key, count: null })) },
    ],
    smallCellFloor: 5,
  };

  test("роль полосами, пациенты под порогом — прочерк; возраст — у персонала полосой", () => {
    const html = draw(<SessionsOverviewBody data={data} />);
    expect(html).toContain(uk("opsp.sess.byRole"));
    expect(html).toContain(uk("opsp.age.day"));
    expect(html).toContain(uk("kit.hidden"));
    expect(html).toContain("6 · 55%");
  });
});

describe("журнал у часі", () => {
  test("период и шаг — в подписи, отказы — янтарём", () => {
    const data: AuditDaily = {
      step: "week",
      from: "2025-01-01",
      to: "2026-09-26",
      buckets: [
        { start: "2026-09-14", ok: 40, refused: 0 },
        { start: "2026-09-21", ok: 35, refused: 3 },
      ],
    };
    const html = draw(<AuditTimelineBody data={data} />);
    expect(html).toContain(uk("opsp.audit.stepWeek"));
    expect(html).toContain('fill="var(--accent)"');
    expect(html).toContain(uk("opsp.series.refused"));
  });

  test("за период ничего — «немає даних», а не нули на осях", () => {
    const html = draw(<AuditTimelineBody data={{ step: "day", from: "2026-09-01", to: "2026-09-02", buckets: [] }} />);
    expect(html).toContain(uk("chart.noData"));
  });
});

describe("підозріла активність і доступи", () => {
  test("правила полосами, дни столбцами; пусто — словами", () => {
    const full = draw(
      <SuspiciousOverviewBody
        stats={{
          days: 2,
          byRule: [{ rule: "massReads", total: 3, open: 1 }],
          byDay: [
            { date: "2026-09-25", open: 0, resolved: 2 },
            { date: "2026-09-26", open: 1, resolved: 0 },
          ],
        }}
      />,
    );
    expect(full).toContain(uk("ops.rule.massReads"));
    expect(full).toContain(`3 · ${uk("opsp.susp.newOf")} 1`);
    const empty = draw(<SuspiciousOverviewBody stats={{ days: 30, byRule: [], byDay: [{ date: "2026-09-26", open: 0, resolved: 0 }] }} />);
    expect(empty.split(uk("chart.noData")).length - 1).toBe(2);
  });

  test("доступы: доли состояний с числами; ни одной выдачи — словами", () => {
    const html = draw(
      <GrantsOverviewBody stats={{ active: 2, permanent: 6, expired: 1, revoked: 1, byWeek: [{ week: "2026-09-21", count: 0 }] }} />,
    );
    expect(html).toContain(uk("opsp.grant.permanent"));
    expect(html).toContain("6 · 60%");
    expect(html).toContain(uk("chart.noData"));
  });
});

describe("хто переглядав і другий фактор", () => {
  const report: WhoViewedReport = {
    patient: { id: "p", fullName: "Пацієнт", email: "p@test" },
    from: "2026-09-20",
    to: "2026-09-22",
    total: 2,
    generatedAt: "2026-09-25T10:00:00.000Z",
    actors: [
      {
        actorId: "a",
        actorEmail: "a@test",
        actorName: "Олена Петренко",
        actorRole: "admin",
        total: 2,
        days: [
          {
            day: "2026-09-21",
            actions: [{ action: "patient.card_read", count: 2, first: "2026-09-21T08:00:00Z", last: "2026-09-21T09:00:00Z", asUserEmail: null }],
          },
        ],
      },
    ],
  };

  test("графики отчёта — без имён: «кто» остаётся разделам ниже", () => {
    const html = draw(<WhoViewedCharts report={report} label={(a) => `[${a}]`} />);
    expect(html).toContain("[patient.card_read]");
    expect(html).not.toContain("Олена");
    expect(html).not.toContain("a@test");
  });

  test("пустой отчёт графиков не получает", () => {
    expect(draw(<WhoViewedCharts report={{ ...report, total: 0, actors: [] }} label={(a) => a} />)).toBe("");
  });

  test("охват — долей от 0 до 100 с «з»; без действующих учёток — ничего", () => {
    const row = { id: "1", email: "x@test", fullName: "X", role: "superadmin" as const, because: "superadmin" as const, confirmedAt: null, disabled: false };
    const html = draw(<MfaCoverageChart coverage={[{ ...row, enabled: true }, { ...row, id: "2", enabled: false }]} />);
    expect(html).toContain(`1 ${uk("an.of")} 2 · 50%`);
    expect(html).toContain("width:50.00%");
    expect(draw(<MfaCoverageChart coverage={[{ ...row, enabled: false, disabled: true }]} />)).toBe("");
  });
});
