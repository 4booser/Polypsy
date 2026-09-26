import { useState } from "react";
import { t, type BulkResult, type BulkUserAction, type ImportCreated, type ImportPreview, type OpsUserRow, type UiKey } from "@quizzy/shared";
import { api, ApiError, impersonationStore } from "../../../api";
import { useAuth } from "../../../auth";
import { useLang } from "../../../lang";
import { Loading, Modal, useAction } from "../../../ui";
import { IconCaret } from "../../../ui/glyphs";
import { ActionMenu, type MenuEntry } from "../../../ui/menu";
import { Button, Field, Input, Select, Textarea } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { metaClass } from "../controls";
import { ConfirmPlain } from "../dialogs";
import { importErrorKey, importTemplateCsv, pageSelection, passwordsCsv, skipKey, skippedByReason } from "./model";
import { RowCheck, saveText } from "./parts";

/*
 * «Користувачі» → массовые действия, импорт из CSV и вход «от имени»
 * (people2, пункты 16 и 20). Отдельным файлом, а не внутри вкладки
 * accounts: там строки и одиночные действия, здесь — пачки и файлы.
 */

/* ═══════════ строка выбора над списком ═══════════ */

/**
 * «Вибрано N · Вибрати всіх у відборі (M) · Зняти вибір · Дії з вибраними».
 *
 * Флажок «вся страница» — здесь, а не в шапке колонок: шапка скрыта от
 * диктора (aria-hidden) и пропадает на узком окне, а выбор страницы нужен
 * везде. Выбор переживает листание — отмеченное на второй странице не
 * пропадает, когда человек уходит на третью.
 */
export function SelectionBar({
  selected,
  pageIds,
  total,
  onPage,
  onAll,
  onClear,
  onAction,
  canAssign,
}: {
  selected: ReadonlySet<string>;
  pageIds: readonly string[];
  total: number;
  onPage: (on: boolean) => void;
  onAll: () => void;
  onClear: () => void;
  onAction: (action: BulkUserAction) => void;
  canAssign: boolean;
}) {
  const { ut } = useLang();
  const state = pageSelection(selected, pageIds);
  const entries: MenuEntry[] = [
    { label: ut("ops.bulk.disable"), onSelect: () => onAction("disable"), danger: true },
    { label: ut("ops.bulk.enable"), onSelect: () => onAction("enable") },
    { label: ut("ops.bulk.revoke"), onSelect: () => onAction("revoke-sessions") },
    {
      label: ut("ops.bulk.assignRole"),
      onSelect: () => onAction("assign-role"),
      disabled: !canAssign,
      hint: ut("ops.bulk.notAssigner"),
    },
  ];
  return (
    <div className="mb-[6px] flex min-h-[44px] flex-wrap items-center gap-x-[14px] gap-y-[4px] print:hidden">
      <span className="flex items-center">
        <RowCheck
          checked={state === "all"}
          mixed={state === "some"}
          onChange={() => onPage(state !== "all")}
          label={ut("ops.bulk.selectPage")}
        />
        <span className="text-[13px] text-muted">{ut("ops.bulk.selectPage")}</span>
      </span>
      {selected.size > 0 ? (
        <>
          <span className="text-[15px] text-text-2" aria-live="polite">
            {ut("ops.bulk.selected")}: <span className="font-mono font-bold tabular-nums text-primary">{selected.size}</span>
          </span>
          {selected.size < total ? (
            <Button variant="quiet" onClick={onAll}>
              {ut("ops.bulk.selectFilter")} ({total})
            </Button>
          ) : null}
          <Button variant="quiet" onClick={onClear}>
            {ut("ops.bulk.clear")}
          </Button>
          <ActionMenu
            label={ut("ops.bulk.actions")}
            glyph={
              <span className="flex items-center gap-[6px] text-[15px] font-bold">
                {ut("ops.bulk.actions")}
                <IconCaret />
              </span>
            }
            entries={entries}
            plateClassName="min-w-[260px]"
          />
        </>
      ) : null}
    </div>
  );
}

/* ═══════════ массовое действие ═══════════ */

const ACTION_LABEL: Record<BulkUserAction, UiKey> = {
  disable: "ops.bulk.disable",
  enable: "ops.bulk.enable",
  "revoke-sessions": "ops.bulk.revoke",
  "assign-role": "ops.bulk.assignRole",
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

  if (result) {
    const groups = skippedByReason(result);
    return (
      <Modal title={title} onClose={onDone}>
        <p className="m-0 text-[15px] leading-[21px] text-text-2">
          {ut("ops.bulk.done")}: <span className="font-mono font-bold tabular-nums text-primary">{result.done.length}</span> ·{" "}
          {ut("ops.bulk.skipped")}: <span className="font-mono font-bold tabular-nums">{result.skipped.length}</span>
        </p>
        {groups.length ? (
          <ul className="m-0 mt-[12px] list-none p-0">
            {groups.map((g) => (
              <li key={g.reason} className="border-b border-hairline py-[6px]">
                <span className="flex justify-between gap-[12px] text-[15px]">
                  <span className="text-text-2">{ut(skipKey(g.reason))}</span>
                  <span className="font-mono tabular-nums text-muted">{g.count}</span>
                </span>
                <span className={metaClass}>{g.emails.slice(0, 8).join(", ") + (g.emails.length > 8 ? ", …" : "")}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-[20px] flex justify-end">
          <Button onClick={onDone}>{ut("ops.users.gotIt")}</Button>
        </div>
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
    <Modal title={title} onClose={onClose}>
      <p className="m-0 mb-[15px] text-[15px] leading-[21px] text-text-2">
        {ut("ops.bulk.confirm").replace("{n}", String(ids.length))}
      </p>
      {action === "disable" ? (
        <Field label={ut("ops.users.reason")}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus required />
        </Field>
      ) : null}
      {action === "assign-role" ? (
        roles.error ? (
          <Loading error={roles.error} onRetry={roles.reload} />
        ) : !roles.data ? (
          <Loading rows={1} />
        ) : (
          <Field label={ut("ops.bulk.role")} labelClassName="mb-[6px] block text-[13px] font-bold text-muted">
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
      <div className="mt-[20px] flex justify-end gap-[14px]">
        <Button variant="ghost" onClick={onClose}>
          {ut("common.cancel")}
        </Button>
        <Button variant={action === "disable" ? "danger" : "primary"} disabled={busy || !ready} onClick={submit}>
          {title}
        </Button>
      </div>
    </Modal>
  );
}

/* ═══════════ импорт из CSV ═══════════ */

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
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [created, setCreated] = useState<ImportCreated["created"] | null>(null);

  if (created) {
    return (
      <Modal title={ut("ops.import.createdTitle")} onClose={onDone} wide>
        <p className="m-0 mb-[12px] text-[15px] leading-[21px] text-text-2">{ut("ops.import.createdHint")}</p>
        <ul className="m-0 mb-[12px] max-h-[50vh] list-none overflow-y-auto p-0">
          {created.map((p) => (
            <li key={p.id} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_auto] gap-x-[14px] border-b border-hairline py-[6px] max-[700px]:grid-cols-1">
              <span className="text-[15px] font-bold text-text [overflow-wrap:anywhere]">{p.fullName}</span>
              <span className="text-[13px] text-muted [overflow-wrap:anywhere]">{p.email}</span>
              <output className="select-all font-mono text-[15px] tabular-nums text-primary">{p.password}</output>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-[14px]">
          <Button
            variant="ghost"
            onClick={() =>
              saveText(passwordsCsv(created, [ut("ops.grants.person"), ut("person.email"), ut("ops.users.tempPassword")]), "polypsy-import-passwords.csv")
            }
          >
            {ut("ops.import.downloadPasswords")}
          </Button>
          <Button onClick={onDone}>{ut("ops.users.gotIt")}</Button>
        </div>
      </Modal>
    );
  }

  const check = (text: string) =>
    void run(async () => {
      setPreview(await api.importPreview(text));
    });

  const canCreate = preview && preview.rows.length > 0 && preview.valid === preview.rows.length && !preview.missingColumns.length;

  return (
    <Modal title={ut("ops.import.title")} onClose={onClose} wide>
      <p className="m-0 mb-[12px] max-w-[80ch] text-[13px] leading-[18px] text-muted">{ut("ops.import.hint")}</p>
      <div className="mb-[12px] flex flex-wrap items-center gap-[12px]">
        <Button variant="ghost" onClick={() => saveText(importTemplateCsv(), "polypsy-staff-template.csv")}>
          {ut("ops.import.template")}
        </Button>
        <label className="flex min-w-0 cursor-pointer items-center gap-[10px] text-[15px] text-primary">
          <span className="font-bold">{ut("ops.import.file")}</span>
          <Input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label={ut("ops.import.file")}
            className="min-w-0 max-w-[280px]"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setFileName(file.name);
              void file.text().then((text) => {
                setCsv(text);
                setPreview(null);
                check(text);
              });
            }}
          />
        </label>
        {fileName ? <span className={metaClass}>{fileName}</span> : null}
      </div>

      {preview ? (
        <>
          <p className="m-0 mb-[8px] text-[15px] text-text-2">
            {ut("ops.import.rows")}: <span className="font-mono tabular-nums">{preview.rows.length}</span> · {ut("ops.import.valid")}:{" "}
            <span className="font-mono tabular-nums">{preview.valid}</span>
          </p>
          {preview.missingColumns.length ? (
            <p className="m-0 mb-[8px] text-[13px] text-danger">
              {ut("ops.import.missingColumns")}: {preview.missingColumns.join(", ")}
            </p>
          ) : null}
          {preview.unknownColumns.length ? (
            <p className={`${metaClass} mb-[8px]`}>
              {ut("ops.import.unknownColumns")}: {preview.unknownColumns.join(", ")}
            </p>
          ) : null}
          <div className="max-h-[45vh] overflow-auto">
            <ul className="m-0 list-none p-0">
              {preview.rows.map((r) => (
                <li
                  key={r.line}
                  className="grid grid-cols-[56px_minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,1.6fr)] gap-x-[12px] border-b border-hairline py-[6px] text-[13px] leading-[18px] max-[700px]:grid-cols-1"
                >
                  <span className="font-mono tabular-nums text-muted">
                    {ut("ops.import.line")} {r.line}
                  </span>
                  <span className="text-text [overflow-wrap:anywhere]">
                    {[r.lastName, r.firstName, r.middleName].filter(Boolean).join(" ") || "—"}
                  </span>
                  <span className="text-text-2 [overflow-wrap:anywhere]">
                    {r.email || "—"}
                    {r.roleTemplate ? ` · ${r.roleTemplate}` : ""}
                  </span>
                  <span className={r.errors.length ? "text-danger" : "text-muted"}>
                    {r.errors.length ? r.errors.map((e) => ut(importErrorKey(e))).join("; ") : ut("ops.import.ok")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {!canCreate ? <p className="m-0 mt-[10px] text-[13px] text-muted">{ut("ops.import.fixFirst")}</p> : null}
        </>
      ) : null}

      <div className="mt-[20px] flex justify-end gap-[14px]">
        <Button variant="ghost" onClick={onClose}>
          {ut("common.cancel")}
        </Button>
        <Button variant="ghost" disabled={busy || !csv} onClick={() => check(csv)}>
          {ut("ops.import.check")}
        </Button>
        <Button
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
          {ut("ops.import.create")} {preview ? preview.valid : ""}
        </Button>
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
 */
export function ImpersonateDialog({ row, onClose }: { row: OpsUserRow; onClose: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [reason, setReason] = useState("");
  return (
    <Modal title={`${ut("ops.imp.title")} · ${row.fullName || row.email}`} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length < 10) return;
          void run(async () => {
            const start = await api.impersonate(row.id, reason.trim());
            impersonationStore.set({ token: start.token, sessionId: start.sessionId, expiresAt: start.expiresAt });
            window.location.assign(row.role === "user" ? "/me" : "/");
          });
        }}
      >
        <p className="m-0 mb-[15px] text-[15px] leading-[21px] text-text-2">{ut("ops.imp.warn")}</p>
        <Field label={ut("ops.users.reason")}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus required />
        </Field>
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || reason.trim().length < 10}>
            {ut("ops.imp.start")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Пункты меню строки «Користувачів» от people2: вход «от имени» и сброс второго фактора */
export function useRowExtras() {
  const { ut } = useLang();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  return (row: OpsUserRow, open: { impersonate: () => void; resetMfa: () => void }): MenuEntry[] => {
    const self = row.id === user?.id;
    const superRow = row.role === "superadmin";
    return [
      {
        label: ut("ops.imp.action"),
        onSelect: open.impersonate,
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
    <ConfirmPlain
      title={ut("ops.mfa.reset")}
      actionLabel={ut("ops.mfa.reset")}
      danger
      busy={busy}
      onClose={onClose}
      onConfirm={() =>
        void run(async () => {
          await api.resetUserMfa(id);
          onDone();
        }, ut("ops.mfa.resetDone"))
      }
    >
      <p className="m-0 [overflow-wrap:anywhere]">
        {email}: {ut("ops.mfa.resetWarn")}
      </p>
    </ConfirmPlain>
  );
}
