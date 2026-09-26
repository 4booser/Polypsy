import { useState, type ReactNode } from "react";
import { useLang } from "../../lang";
import { Modal } from "../../ui";
import { Button, Field, Input } from "../../ui/primitives";

/*
 * Общие окна техпанели: подтверждение перепечатыванием и простое «да/нет».
 *
 * Перепечатывание — тот же приём, что ConfirmByName (ui/index.tsx): обычный
 * confirm снимается не глядя, а напечатать почту человека, которого
 * удаляешь, на автомате нельзя. Своим окном, а не ConfirmByName, потому что
 * тот ещё свёрстан классами прежней оболочки (card, danger-card, field) и
 * стоит в потоке страницы, а не слоем: на вкладке техпанели он уехал бы
 * под список, и человек нажимал бы «Видалити» у одной строки, а
 * подтверждение появлялось бы в сотне строк ниже. Окно — Modal из общего
 * набора: ловушка фокуса, Esc и возврат фокуса там уже есть.
 */

export function ConfirmTyped({
  title,
  expected,
  warning,
  actionLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  /** Что перепечатать: почту учётки, имя устройства */
  expected: string;
  warning: ReactNode;
  actionLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const [typed, setTyped] = useState("");
  const match = typed.trim() === expected;
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (match && !busy) onConfirm();
        }}
      >
        <div className="mb-[15px] text-[15px] leading-[21px] text-text-2">{warning}</div>
        <Field
          label={`${ut("ui.typeToConfirm")} «${expected}»`}
          labelClassName="mb-[6px] block text-[13px] font-bold text-muted [overflow-wrap:anywhere]"
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </Field>
        {error ? <p className="m-0 mt-[15px] text-[13px] text-danger">{error}</p> : null}
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={!match || busy}>
            {actionLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Подтверждение обратимого действия: завершить сессии, включить, сбросить пароль */
export function ConfirmPlain({
  title,
  children,
  actionLabel,
  busy,
  error,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  actionLabel: string;
  busy?: boolean;
  error?: string | null;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-[15px] leading-[21px] text-text-2">{children}</div>
      {error ? <p className="m-0 mt-[15px] text-[13px] text-danger">{error}</p> : null}
      <div className="mt-[20px] flex justify-end gap-[14px]">
        <Button variant="ghost" onClick={onClose}>
          {ut("common.cancel")}
        </Button>
        <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm} autoFocus>
          {actionLabel}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Пароль, показанный один раз, — с кнопкой копирования.
 *
 * Показывается плашкой данных (моноширинно, крупно, группами), а не полем
 * ввода: его не правят, его переписывают или копируют. Копирование — через
 * буфер обмена браузера; если браузер его не дал (не https, запрет),
 * пароль остаётся на экране, и человек выделит его руками — сообщение об
 * этом стоит под плашкой, а не пропадает молча.
 */
export function OneTimePassword({ password }: { password: string }) {
  const { ut } = useLang();
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-[12px]">
        <output
          aria-label={ut("ops.users.tempPassword")}
          className="select-all rounded-[5px] bg-primary-soft px-[12px] py-[8px] font-mono text-[20px] leading-[24px] tracking-[0.04em] text-primary tabular-nums"
        >
          {password}
        </output>
        <Button
          variant="ghost"
          onClick={() => {
            if (!navigator.clipboard) {
              setCopied("no");
              return;
            }
            navigator.clipboard.writeText(password).then(
              () => setCopied("yes"),
              () => setCopied("no"),
            );
          }}
        >
          {ut("co.copy")}
        </Button>
      </div>
      <p className="m-0 mt-[8px] text-[13px] leading-[18px] text-muted" aria-live="polite">
        {copied === "yes" ? ut("ops.users.copied") : copied === "no" ? ut("ops.users.copyFailed") : ut("ops.users.onceHint")}
      </p>
    </div>
  );
}
