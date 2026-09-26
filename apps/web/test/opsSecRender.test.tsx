import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type OpsIntegrityState, type OpsKeysReport, type OpsSqlResult } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { AuditResult, RlsResult } from "../src/pages/ops/sec/Integrity";
import { KeySection, RotationSection, SecretsSection } from "../src/pages/ops/sec/Keys";
import { Result } from "../src/pages/ops/sec/Sql";

/**
 * Разделы безопасности техпанели рисуются на краях: потеря ключа, идущая
 * перешифровка, разрыв журнала, обход политик, отказ и ошибка консоли.
 * Как в analyticsTestsRender.test.tsx: разметка получилась, в ней нет NaN и
 * «undefined», а главные слова стоят на месте. Ни ключ, ни секрет в разметку
 * попасть не может — их нет в данных, — и это тоже проверяется.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const clean = (html: string) => {
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("{n}");
};

/** Строка словаря до первой подстановки: по ней ищем в разметке на любом языке */
const head = (key: keyof typeof UI) => [UI[key].uk, UI[key].ru].map((s) => s.split("{")[0]!.trim());
const has = (html: string, key: keyof typeof UI) => expect(head(key).some((h) => html.includes(h))).toBe(true);

const rotating: OpsKeysReport = {
  encryption: true,
  activeKey: "v2",
  loadedKeys: ["v2", "v1"],
  keys: [
    { id: "v2", active: true, loaded: true, values: 30, files: 0, opens: true },
    { id: "v1", active: false, loaded: true, values: 90, files: 2, opens: true },
    { id: "v0", active: false, loaded: false, values: 4, files: 0, opens: null },
  ],
  columns: [
    { table: "users", column: "last_name", byKey: { v2: 10, v1: 40 }, plain: 0, rewrappable: true },
    { table: "answers", column: "text", byKey: { v1: 50, v0: 4 }, plain: 3, rewrappable: true },
  ],
  files: { byKey: { v1: 2 }, legacy: 1, missing: 1 },
  plainTotal: 3,
  lostTotal: 4,
  staleTotal: 96,
  job: {
    id: "j1",
    status: "running",
    startedAt: "2026-09-26T10:00:00.000Z",
    finishedAt: null,
    startedBy: "root@test",
    targetKey: "v2",
    total: 100,
    processed: 40,
    skipped: 4,
    error: null,
  },
  secrets: [
    { name: "ENCRYPTION_KEY", state: "set", seenSince: "2026-09-25T10:00:00.000Z", trackedSince: "2026-09-01T10:00:00.000Z" },
    { name: "JWT_SECRET", state: "set", seenSince: "2026-09-01T10:00:00.000Z", trackedSince: "2026-09-01T10:00:00.000Z" },
    { name: "PHONE_INDEX_SECRET", state: "default", seenSince: null, trackedSince: null },
    { name: "EXPORT_SECRET", state: "set", seenSince: "2026-09-01T10:00:00.000Z", trackedSince: "2026-09-01T10:00:00.000Z" },
    { name: "METRICS_TOKEN", state: "unset", seenSince: "2026-09-01T10:00:00.000Z", trackedSince: "2026-09-01T10:00:00.000Z" },
  ],
  countedAt: "2026-09-26T10:05:00.000Z",
};

describe("ключі й секрети", () => {
  test("потеря ключа названа, версии и колонки на месте", () => {
    const html = draw(<KeySection report={rotating} />);
    clean(html);
    has(html, "ops.sec.keys.lost");
    has(html, "ops.sec.keys.stateMissing");
    has(html, "ops.sec.keys.filesLegacy");
    expect(html).toContain("users.last_name");
  });

  test("мастер: идёт перешифровка — полоса хода и числа", () => {
    const html = draw(<RotationSection report={rotating} job={rotating.job} onStarted={() => {}} />);
    clean(html);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("width:40%");
    has(html, "ops.sec.rot.blocked");
    // посреди ротации третий ключ не предлагается
    expect(html).not.toContain("v3:");
  });

  test("мастер: ротация не идёт — команды нового ключа со следующим именем", () => {
    const calm: OpsKeysReport = {
      ...rotating,
      activeKey: "v2",
      loadedKeys: ["v2"],
      keys: [rotating.keys[0]!],
      files: { byKey: {}, legacy: 0, missing: 0 },
      lostTotal: 0,
      staleTotal: 0,
      plainTotal: 0,
      job: null,
    };
    const html = draw(<RotationSection report={calm} job={null} onStarted={() => {}} />);
    clean(html);
    expect(html).toContain("ENCRYPTION_KEY=&quot;v3:&lt;");
    has(html, "ops.sec.rot.idle");
  });

  test("мастер: всё перешифровано — старый ключ можно убрать", () => {
    const done: OpsKeysReport = {
      ...rotating,
      keys: [rotating.keys[0]!, { ...rotating.keys[1]!, values: 0, files: 0 }],
      files: { byKey: {}, legacy: 0, missing: 0 },
      lostTotal: 0,
      staleTotal: 0,
      plainTotal: 0,
      job: { ...rotating.job!, status: "done", finishedAt: "2026-09-26T10:30:00.000Z", processed: 100, skipped: 0 },
    };
    const html = draw(<RotationSection report={done} job={done.job} onStarted={() => {}} />);
    clean(html);
    has(html, "ops.sec.rot.removable");
    expect(html).toContain("ENCRYPTION_KEY=&quot;v2:&lt;");
    expect(html).not.toContain("v1:&lt;");
  });

  test("секреты: состояние, возраст, последствия; значения — нигде", () => {
    const html = draw(<SecretsSection report={rotating} />);
    clean(html);
    for (const name of ["JWT_SECRET", "PHONE_INDEX_SECRET", "EXPORT_SECRET", "METRICS_TOKEN"]) expect(html).toContain(name);
    has(html, "ops.sec.secrets.state.default");
    has(html, "ops.sec.secrets.EXPORT_SECRET.risks");
    has(html, "ops.sec.phones.run");
  });
});

describe("цілісність", () => {
  test("обход политик ролью владельца — словами", () => {
    const html = draw(
      <RlsResult
        check={{
          at: "2026-09-26T10:00:00.000Z",
          trigger: "manual",
          ok: false,
          actorEmail: "root@test",
          summary: {
            at: "2026-09-26T10:00:00.000Z",
            ok: false,
            role: "quizzy",
            bypasses: true,
            reason: "владеет 60 табл. с включённой RLS",
            tables: 80,
            rlsTables: 60,
            policies: 70,
            policiesWithoutRls: ["probe"],
            rlsWithoutPolicies: [],
            personTablesWithoutRls: ["schedule_targets"],
            forced: [],
            auditWritable: true,
          },
        }}
      />,
    );
    clean(html);
    has(html, "ops.sec.int.rlsBypass");
    has(html, "ops.sec.int.auditWritable");
    expect(html).toContain("schedule_targets");
    expect(html).toContain("root@test");
  });

  test("разрыв цепочки и плановая сверка", () => {
    const report = { at: "2026-09-26T10:00:00.000Z", ok: false, checked: 41, legacy: 0, brokenAtSeq: 42, headSeq: null, headHash: null };
    const state: OpsIntegrityState = {
      rls: null,
      audit: { at: report.at, trigger: "schedule", ok: false, actorEmail: null, summary: report },
      auditScheduled: { at: report.at, trigger: "schedule", ok: false, actorEmail: null, summary: report },
      scheduleHours: 24,
      nextScheduledAfter: "2026-09-27T09:55:00.000Z",
    };
    const html = draw(<AuditResult state={state} />);
    clean(html);
    has(html, "ops.sec.int.auditBroken");
    expect(html).toContain("42");
    has(html, "ops.sec.int.scheduler");
  });

  test("проверок ещё не было", () => {
    const html = draw(<RlsResult check={null} />);
    has(html, "ops.sec.int.never");
  });
});

describe("SQL (читання)", () => {
  test("таблица результата: NULL, скрытая колонка, обрезано", () => {
    const result: OpsSqlResult = {
      status: "ok",
      columns: [
        { name: "email", type: "text" },
        { name: "password_hash", type: "text", masked: true },
      ],
      rows: [
        ["root@test", "•••"],
        [null, null],
      ],
      rowCount: 2,
      truncated: true,
      ms: 12,
    };
    const html = draw(<Result result={result} onCopy={() => {}} />);
    clean(html);
    expect(html).toContain("NULL");
    has(html, "ops.sec.sql.masked");
    has(html, "ops.sec.sql.truncated");
    has(html, "ops.sec.sql.copyCsv");
    expect(html).toContain("overflow-auto");
  });

  test("отказ и ошибка базы", () => {
    clean(draw(<Result result={{ status: "refused", code: "side_effect", detail: "nextval" }} onCopy={() => {}} />));
    expect(draw(<Result result={{ status: "refused", code: "side_effect", detail: "nextval" }} onCopy={() => {}} />)).toContain(
      "nextval()",
    );
    const html = draw(<Result result={{ status: "error", code: "25006", message: "cannot execute DELETE in a read-only transaction", ms: 3 }} onCopy={() => {}} />);
    expect(html).toContain("25006");
    expect(html).toContain("read-only transaction");
  });
});
