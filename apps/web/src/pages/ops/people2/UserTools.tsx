import { useId, useRef, useState, type ReactNode } from "react";
import {
  IMPERSONATION_MINUTES,
  t,
  type BulkResult,
  type BulkUserAction,
  type ImportCreated,
  type ImportPreview,
  type OpsUserRow,
  type UiKey,
} from "@quizzy/shared";
import { api, ApiError, impersonationStore } from "../../../api";
import { useAuth } from "../../../auth";
import { useLang } from "../../../lang";
import { Callout, DataTable, Loading, Modal, useAction, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import type { MenuEntry } from "../../../ui/menu";
import { Button, ErrorText, Field, Select, Tag, Textarea } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { AccountAvatar, clock, fill, RolePill } from "../users/parts";
import { Ix } from "./icons";
import { importErrorKey, importTemplateCsv, passwordsCsv, skipKey, skippedByReason } from "./model";
import { saveText } from "./parts";

/*
 * «Користувачі» → массовые действия, импорт из CSV и вход «от имени»
 * (people2, пункты 16 и 20). Отдельным файлом, а не внутри вкладки
 * accounts: там строки и одиночные действия, здесь — пачки и файлы.
 *
 * Polypsy 2.0: окна набора («Виразна») — значок и подпись в шапке, основная
 * кнопка первой в подвале; импорт — шагами «Файл → Перевірка → Паролі»,
 * перегляд від імені — с тем, что будет видно и что пойдёт в журнал.
 */

/* ═══════════ массовое действие ═══════════ */

const ACTION_LABEL: Record<BulkUserAction, UiKey> = {
  disable: "ops.bulk.disable",
  enable: "ops.bulk.enable",
  "revoke-sessions": "ops.bulk.revoke",
  "assign-role": "ops.bulk.assignRole",
};

const ACTION_ICON: Record<BulkUserAction, ReactNode> = {
  disable: <Ic.ban />,
  enable: <Ic.circleCheck />,
  "revoke-sessions": <Ix.logOut />,
  "assign-role": <Ix.shieldPlus />,
};

/**
 * Подтверждение — и итог «зроблено N, пропущено M (чому)».
 *
 * Правила одиночных действий сервер применяет к каждой строке сам
 * (lib/people.ts, bulkSkip); экран их не повторяет, а честно показывает,
 * что вышло: сделанные — числом, пропущенные — по причинам с почтами.
 */
export function BulkDialog({
  action,
  ids,
  onClose,
  onDone,
}: {
  action: BulkUserAction;
  ids: readonly string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const [reason, setReason] = useState("");
  const [roleId, setRoleId] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);
  const roles = useResource(() => api.permissionRoles(), [], { enabled: action === "assign-role" });
  const title = ut(ACTION_LABEL[action]).replace(/…$/, "");
  const sub = fill(ut("oppu.bulkSub"), { n: ids.length });

  if (result) {
    const groups = skippedByReason(result);
    return (
      <Modal
        title={title}
        sub={sub}
        icon={ACTION_ICON[action]}
        onClose={onDone}
        footer={
          <Button variant="primary" onClick={onDone}>
            {ut("ops.users.gotIt")}
          </Button>
        }
      >
        <p className="m-0 pt-3.5 text-body text-text-2">
          {ut("ops.bulk.done")}: <b className="font-extrabold tabular-nums text-text">{result.done.length}</b>, {ut("ops.bulk.skipped").toLowerCase()}:{" "}
          <b className="font-extrabold tabular-nums text-text">{result.skipped.length}</b>
        </p>
        {groups.length ? (
          <ul className="m-0 mt-3 list-none p-0">
            {groups.map((g) => (
              <li key={g.reason} className="border-t border-divider py-1.5 first:border-t-0">
                <span className="flex justify-between gap-3 text-body">
                  <span className="text-text-2">{ut(skipKey(g.reason))}</span>
                  <b className="font-extrabold tabular-nums text-text">{g.count}</b>
                </span>
                <span className="block text-caption text-muted [overflow-wrap:anywhere]">
                  {g.emails.slice(0, 8).join(", ") + (g.emails.length > 8 ? ", …" : "")}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>
    );
  }

  const ready = action === "disable" ? reason.trim().length >= 3 : action === "assign-role" ? Boolean(roleId) : true;
  const submit = () =>
    void run(async () => {
      const list = [...ids];
      const body =
        action === "disable"
          ? { action, ids: list, reason: reason.trim() }
          : action === "assign-role"
            ? { action, ids: list, roleId }
            : { action, ids: list };
      setResult(await api.bulkUsers(body as never));
    });

  return (
    <Modal
      title={title}
      sub={sub}
      icon={ACTION_ICON[action]}
      tone={action === "disable" ? "warn" : "violet"}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={ACTION_ICON[action]} disabled={busy || !ready} onClick={submit}>
            {title}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pt-3.5">
        <p className="m-0 text-body text-text-2">{ut("ops.bulk.confirm").replace("{n}", String(ids.length))}</p>
        {action === "disable" ? (
          <Field label={ut("ops.users.reason")}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus required />
          </Field>
        ) : null}
        {action === "assign-role" ? (
          roles.error ? (
            <Loading error={roles.error} onRetry={roles.reload} bare />
          ) : !roles.data ? (
            <Loading rows={1} bare />
          ) : (
            <Field label={ut("ops.bulk.role")}>
              <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">—</option>
                {roles.data
                  .filter((r) => r.assignable)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {t(r.title, lang)} ({r.code})
                    </option>
                  ))}
              </Select>
            </Field>
          )
        ) : null}
      </div>
    </Modal>
  );
}

/* ═══════════ импорт из CSV ═══════════ */

/** Шаги импорта: файл, проверка, пароли — номер текущего и пройденные галочкой */
function ImportSteps({ at }: { at: 1 | 2 | 3 }) {
  const { ut } = useLang();
  const steps: UiKey[] = ["oppu.stepFile", "oppu.stepCheck", "oppu.stepPasswords"];
  return (
    <ol className="m-0 flex list-none flex-wrap items-center gap-2.5 p-0 text-small font-bold text-muted" aria-label={ut("oppu.steps")}>
      {steps.map((k, i) => {
        const n = i + 1;
        const done = n < at;
        const cur = n === at;
        return (
          <li key={k} className="flex items-center gap-2.5" aria-current={cur ? "step" : undefined}>
            {i ? <i aria-hidden className="block h-px w-8 bg-control" /> : null}
            <span className={cx("inline-flex items-center gap-2 whitespace-nowrap", cur && "text-text")}>
              <span
                className={cx(
                  "inline-grid size-[22px] place-items-center rounded-full text-[11px] font-extrabold leading-none",
                  done ? "bg-good text-panel" : cur ? "bg-violet text-onfill" : "bg-sunk text-muted shadow-[inset_0_0_0_1.5px_var(--ctl)]",
                )}
              >
                {done ? <Ic.check size={12} /> : n}
              </span>
              {ut(k)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type PreviewRow = ImportPreview["rows"][number];

/**
 * Импорт сотрудников: шаблон, файл, предпросмотр с ошибками по строкам,
 * создание пачкой — и временные пароли один раз, списком и файлом.
 *
 * Файл читается в браузере, на сервер уходит текст: сервер проверяет ровно
 * то, что человек видел в предпросмотре, и проверяет заново при создании —
 * между двумя нажатиями кто-то мог завести ту же почту. Пока в файле есть
 * хоть одна ошибка, «Створити» не нажимается: импорт — всё или ничего.
 */
export function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [created, setCreated] = useState<ImportCreated["created"] | null>(null);

  if (created) {
    return (
      <Modal
        title={ut("ops.import.createdTitle")}
        onClose={onDone}
        wide
        secret
        sub={ut("oppu.stepPasswords")}
        icon={<Ix.keyRound />}
        footer={
          <>
            <Button variant="primary" onClick={onDone}>
              {ut("ops.users.gotIt")}
            </Button>
            <Button
              icon={<Ic.download />}
              onClick={() =>
                saveText(
                  passwordsCsv(created, [ut("ops.grants.person"), ut("person.email"), ut("ops.users.tempPassword")]),
                  "polypsy-import-passwords.csv",
                )
              }
            >
              {ut("ops.import.downloadPasswords")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pt-3.5">
          <ImportSteps at={3} />
          <Callout kind="warn">{ut("ops.import.createdHint")}</Callout>
          <ul className="m-0 max-h-[50vh] list-none overflow-y-auto p-0">
            {created.map((p) => (
              <li
                key={p.id}
                className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_auto] items-center gap-x-3.5 border-t border-divider py-1.5 first:border-t-0 max-[700px]:grid-cols-1"
              >
                <span className="text-body font-bold text-text [overflow-wrap:anywhere]">{p.fullName}</span>
                <span className="text-small text-muted [overflow-wrap:anywhere]">{p.email}</span>
                <output className="select-all rounded-[6px] bg-sunk px-2 py-1 font-mono text-[13px] text-text">{p.password}</output>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    );
  }

  const check = (text: string) =>
    void run(async () => {
      setPreview(await api.importPreview(text));
    });

  const pick = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    void file.text().then((text) => {
      setCsv(text);
      setPreview(null);
      check(text);
    });
  };

  const bad = preview ? preview.rows.length - preview.valid : 0;
  const canCreate = preview && preview.rows.length > 0 && preview.valid === preview.rows.length && !preview.missingColumns.length;

  const columns: Column<PreviewRow>[] = [
    { key: "line", header: ut("ops.import.line"), required: true, width: 64, render: (r) => <span className="font-mono text-text-2">{r.line}</span> },
    {
      key: "name",
      header: ut("oppu.colName"),
      required: true,
      render: (r) => <span className="block truncate">{[r.lastName, r.firstName, r.middleName].filter(Boolean).join(" ") || "—"}</span>,
    },
    {
      key: "email",
      header: ut("person.email"),
      required: true,
      width: 200,
      render: (r) => (
        <span className={cx("block truncate font-mono text-[12px] font-semibold", r.errors.length ? "text-risk-ink" : "text-text-2")}>
          {r.email || "—"}
        </span>
      ),
    },
    { key: "tpl", header: ut("ops.bulk.role"), required: true, width: 110, render: (r) => r.roleTemplate || "—" },
    { key: "pos", header: ut("oppu.colPosition"), required: true, width: 130, render: (r) => <span className="text-text-2">{r.position || "—"}</span> },
    {
      key: "state",
      header: ut("ops.users.state"),
      required: true,
      width: 180,
      render: (r) =>
        r.errors.length ? (
          <ErrorText>{r.errors.map((e) => ut(importErrorKey(e))).join("; ")}</ErrorText>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-semibold text-text-2">
            <Ic.check size={14} className="text-good" />
            {ut("ops.import.ok")}
          </span>
        ),
    },
  ];

  return (
    <Modal
      title={ut("ops.import.title")}
      sub={preview ? ut("oppu.importSubCheck") : ut("oppu.importSubFile")}
      icon={<Ix.fileUp />}
      width={900}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Ix.userPlus />}
            disabled={busy || !canCreate}
            onClick={() =>
              void run(async () => {
                try {
                  const res = await api.importUsers(csv);
                  setCreated(res.created);
                } catch (e) {
                  /* 400 с ошибками по строкам — показать их, а не голую ошибку */
                  const again = e instanceof ApiError ? (e.body as { preview?: ImportPreview } | undefined)?.preview : undefined;
                  if (again) setPreview(again);
                  throw e;
                }
              })
            }
          >
            {preview ? fill(ut("oppu.createN"), { n: preview.rows.length }) : ut("ops.import.create")}
          </Button>
          {csv ? (
            <Button icon={<Ic.refresh />} disabled={busy} onClick={() => check(csv)}>
              {ut("oppu.checkAgain")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <span className="ml-auto">
            <Button variant="quiet" icon={<Ic.download />} onClick={() => saveText(importTemplateCsv(), "polypsy-staff-template.csv")}>
              {ut("oppu.templateCsv")}
            </Button>
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-3 pt-3.5">
        <ImportSteps at={preview ? 2 : 1} />
        <input
          ref={fileRef}
          id={inputId}
          type="file"
          accept=".csv,text/csv,text/plain"
          aria-label={ut("ops.import.file")}
          className="sr-only"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <div className="flex items-center gap-3 rounded-[12px] bg-sunk py-2 pl-2.5 pr-2">
          <span className="inline-grid size-9 shrink-0 place-items-center rounded-[11px] bg-panel text-muted">
            <Ix.fileSpreadsheet size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-h3 font-extrabold text-text">{fileName || ut("oppu.noFile")}</b>
            <span className="block text-caption text-muted">
              {preview ? fill(ut("oppu.fileRows"), { n: preview.rows.length }) : ut("oppu.pickHint")}
            </span>
          </span>
          <Button size="xs" variant={fileName ? "quiet" : "secondary"} icon={fileName ? <Ix.repeat /> : <Ix.fileUp />} onClick={() => fileRef.current?.click()}>
            {fileName ? ut("oppu.otherFile") : ut("ops.import.file")}
          </Button>
        </div>

        {preview ? (
          <>
            <p className="m-0 text-body text-text">
              <b className="font-extrabold">{fill(ut("oppu.rowsN"), { n: preview.rows.length })}</b>
              {": "}
              {fill(ut("oppu.readyN"), { n: preview.valid })}
              {bad ? (
                <>
                  {", "}
                  <b className="font-bold text-warn">{fill(ut("oppu.badN"), { n: bad })}</b>
                  {` ${ut("oppu.fixInFile")}`}
                </>
              ) : null}
              {preview.unknownColumns.length ? (
                <>
                  {` ${ut("ops.import.unknownColumns")}: `}
                  {preview.unknownColumns.map((c) => (
                    <Tag key={c} className="ml-1 h-5 font-mono font-semibold">
                      {c}
                    </Tag>
                  ))}
                </>
              ) : null}
            </p>
            {preview.missingColumns.length ? (
              <ErrorText>
                {ut("ops.import.missingColumns")}: {preview.missingColumns.join(", ")}
              </ErrorText>
            ) : null}
            <div className="max-h-[42vh] overflow-auto rounded-[12px] border border-border">
              <DataTable rows={preview.rows} columns={columns} rowKey={(r) => String(r.line)} dense sticky={false} label={ut("ops.import.title")} />
            </div>
            {!canCreate ? (
              <Callout kind="warn" icon={<Ic.alert />}>
                {ut("ops.import.fixFirst")}
              </Callout>
            ) : null}
          </>
        ) : null}
        <p className="m-0 text-caption text-muted">{ut("ops.import.hint")}</p>
      </div>
    </Modal>
  );
}

/* ═══════════ вход «от имени» ═══════════ */

/**
 * «Переглянути як ця людина» — с причиной словами и предупреждением.
 *
 * Токен кладётся в хранилище ЭТОЙ вкладки (api.ts, impersonationStore), и
 * страница перезагружается: профиль, права и меню собираются заново — уже
 * его глазами. Пациента встречает его кабинет, сотрудника — консоль.
 *
 * Окно говорит заранее всё, что будет: срок (IMPERSONATION_MINUTES — тот же,
 * что у сервера), «лише перегляд», каждая дія — в журнал с именем
 * смотрящего, и как выглядит полоса, которая всё это время будет сверху.
 */
export function ImpersonateDialog({ row, onClose }: { row: OpsUserRow; onClose: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [reason, setReason] = useState("");
  const formId = useId();
  const until = clock(new Date(Date.now() + IMPERSONATION_MINUTES * 60_000).toISOString());
  const name = row.fullName || row.email;
  const ok = reason.trim().length >= 10;
  return (
    <Modal
      title={ut("ops.imp.title")}
      sub={fill(ut("oppu.impSub"), { name, t: until })}
      icon={<Ix.venetianMask />}
      tone="warn"
      width={600}
      onClose={onClose}
      footer={
        <>
          <Button type="submit" form={formId} variant="primary" icon={<Ic.eye />} disabled={busy || !ok}>
            {fill(ut("oppu.impStart"), { name })}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3 pt-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          void run(async () => {
            const start = await api.impersonate(row.id, reason.trim());
            impersonationStore.set({ token: start.token, sessionId: start.sessionId, expiresAt: start.expiresAt });
            window.location.assign(row.role === "user" ? "/me" : "/");
          });
        }}
      >
        <div className="flex items-center gap-3 rounded-[12px] bg-sunk py-2 pl-2.5 pr-3">
          <AccountAvatar row={row} size={44} />
          <span className="min-w-0 flex-1">
            <b className="block truncate text-h3 font-extrabold text-text">{name}</b>
            <span className="block truncate text-caption text-muted">{row.email}</span>
          </span>
          <RolePill role={row.role} />
        </div>
        <p className="m-0 text-body text-text-2">{ut("ops.imp.warn")}</p>
        <dl className="m-0 flex flex-col">
          {(
            [
              [ut("oppu.impLasts"), fill(ut("oppu.minutesN"), { n: IMPERSONATION_MINUTES }), fill(ut("oppu.impLastsNote"), { t: until })],
              [ut("oppu.impMode"), ut("ops.imp.readOnly"), ut("oppu.impModeNote")],
              [ut("oppu.impJournal"), ut("oppu.impJournalValue"), ut("oppu.impJournalNote")],
            ] as const
          ).map(([k, v, note], i) => (
            <div key={k} className={cx("flex items-baseline gap-2.5 py-[7px] text-small", i ? "border-t border-divider" : "pt-0")}>
              <dt className="min-w-0 text-text-2">{k}</dt>
              <dd className="m-0 ml-auto whitespace-nowrap font-extrabold text-text">{v}</dd>
              <dd className="m-0 w-[170px] text-caption text-muted">{note}</dd>
            </div>
          ))}
        </dl>
        <Field label={ut("ops.users.reason")} hint={ut("oppu.impReasonHint")}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus required />
        </Field>
        <div>
          <span className="mb-2 block text-caption font-bold text-text-2">{ut("oppu.impBarPreview")}</span>
          <div aria-hidden className="overflow-hidden rounded-[10px]">
            <div className="flex h-10 items-center gap-2.5 bg-warn-tint pl-3 pr-1.5 text-small text-text">
              <Ix.venetianMask size={16} className="text-warn" />
              <span className="min-w-0 truncate">
                {ut("ops.imp.banner")} <b className="font-extrabold">{name}</b>
              </span>
              <Tag tone="attention">{ut("ops.imp.readOnly")}</Tag>
              <span className="text-caption text-muted">{`${ut("ops.imp.until")} ${until}`}</span>
              <span className="ml-auto inline-flex h-8 items-center rounded-[9px] bg-panel px-3 text-small font-bold text-text-2">
                {ut("ops.imp.exit")}
              </span>
            </div>
            <div className="flex h-10 items-center gap-2 bg-sunk px-3">
              <span className="h-2.5 w-[120px] rounded-full bg-sunk-2" />
              <span className="h-2.5 w-20 rounded-full bg-sunk-2" />
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** Открыть окно пункта people2 по строке */
export interface RowExtrasOpen {
  impersonate: () => void;
  resetMfa: () => void;
}

/** Пункты меню строки «Користувачів» от people2: вход «от имени» и сброс второго фактора */
export function useRowExtras() {
  const { ut } = useLang();
  const { user } = useAuth();
  return rowExtrasFor(ut, user);
}

/**
 * То же без хуков — для сборки меню строки в проверке
 * (test/opsUsersMenu.test.ts); экран берёт его через useRowExtras.
 */
export function rowExtrasFor(
  ut: (key: UiKey) => string,
  user: { id: string; role: string } | null | undefined,
): (row: OpsUserRow, open: RowExtrasOpen) => MenuEntry[] {
  const isSuper = user?.role === "superadmin";
  return (row: OpsUserRow, open: RowExtrasOpen): MenuEntry[] => {
    const self = row.id === user?.id;
    const superRow = row.role === "superadmin";
    return [
      {
        label: ut("ops.imp.action"),
        onSelect: open.impersonate,
        icon: <Ic.eye />,
        disabled: !isSuper || self || superRow || Boolean(row.disabledAt),
        hint: !isSuper
          ? ut("ops.users.superOnly")
          : self
            ? ut("ops.users.notSelf")
            : superRow
              ? ut("ops.imp.notSuper")
              : ut("ops.users.disabledOne"),
      },
      {
        label: ut("ops.mfa.reset"),
        onSelect: open.resetMfa,
        icon: <Ix.shieldAlert />,
        disabled: !isSuper || self,
        hint: self ? ut("ops.users.notSelf") : ut("ops.users.superOnly"),
      },
    ];
  };
}

/** Сбросить второй фактор другому — только суперадмин; и из меню «Користувачів», и из раздела «Другий фактор» */
export function ResetMfaDialog({ id, email, onClose, onDone }: { id: string; email: string; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  return (
    <Modal
      title={ut("ops.mfa.reset")}
      sub={email}
      icon={<Ix.shieldAlert />}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Ix.shieldAlert />}
            disabled={busy}
            autoFocus
            onClick={() =>
              void run(async () => {
                await api.resetUserMfa(id);
                onDone();
              }, ut("ops.mfa.resetDone"))
            }
          >
            {ut("oppu.resetFactor")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 pt-3.5 text-body text-text-2 [overflow-wrap:anywhere]">
        {email}: {ut("ops.mfa.resetWarn")}
      </p>
    </Modal>
  );
}
