import { useId, useState, type ReactNode } from "react";
import { useLang } from "../../lang";
import { Modal } from "../../ui";
import { Button, ErrorText, Field, Input } from "../../ui/primitives";
import { OpsIcon } from "./icons";

/*
 * Общие окна техпанели: подтверждение перепечатыванием и простое «да/нет».
 *
 * Перепечатывание — тот же приём, что ConfirmByName (ui/index.tsx): обычный
 * confirm снимается не глядя, а напечатать почту человека, которого
 * удаляешь, на автомате нельзя. Своим окном, а не ConfirmByName, потому что
 * тот стоит в потоке страницы, а не слоем: на вкладке техпанели он уехал бы
 * под список, и человек нажимал бы «Видалити» у одной строки, а
 * подтверждение появлялось бы в сотне строк ниже. Окно — Modal набора
 * «Виразної»: значок в квадрате, кнопки внизу через волосяную линию
 * (основная первой), ловушка фокуса, Esc и возврат фокуса.
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
  const formId = useId();
  const [typed, setTyped] = useState("");
  const match = typed.trim() === expected;
  return (
    <Modal
      title={title}
      onClose={onClose}
      icon={<OpsIcon name="triangle-alert" />}
      tone="warn"
      footer={
        <>
          <Button type="submit" form={formId} variant="danger" disabled={!match || busy}>
            {actionLabel}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (match && !busy) onConfirm();
        }}
      >
        <div className="mb-4 text-body leading-[21px] text-text-2">{warning}</div>
        <Field
          label={`${ut("ui.typeToConfirm")} «${expected}»`}
          labelClassName="mb-1.5 block text-caption font-bold text-muted [overflow-wrap:anywhere]"
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </Field>
        {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
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
    <Modal
      title={title}
      onClose={onClose}
      icon={<OpsIcon name={danger ? "triangle-alert" : "circle-help"} />}
      tone={danger ? "warn" : "violet"}
      footer={
        <>
          <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm} autoFocus>
            {actionLabel}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <div className="text-body leading-[21px] text-text-2">{children}</div>
      {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
    </Modal>
  );
}

/**
 * Пароль, показанный один раз, — с кнопкой копирования.
 *
 * Показывается плашкой данных (моноширинно, крупно), а не полем ввода: его
 * не правят, его переписывают или копируют. Копирование — через буфер
 * обмена браузера; если браузер его не дал (не https, запрет), пароль
 * остаётся на экране, и человек выделит его руками — сообщение об этом
 * стоит под плашкой, а не пропадает молча.
 */
export function OneTimePassword({ password }: { password: string }) {
  const { ut } = useLang();
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <output
          aria-label={ut("ops.users.tempPassword")}
          className="select-all rounded-control bg-violet-tint px-3 py-2 font-mono text-[20px] font-semibold leading-6 tracking-[0.04em] text-violet-ink tabular-nums"
        >
          {password}
        </output>
        <Button
          variant="ghost"
          icon={<OpsIcon name="copy" />}
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
      <p className="m-0 mt-2 text-small text-muted" aria-live="polite">
        {copied === "yes" ? ut("ops.users.copied") : copied === "no" ? ut("ops.users.copyFailed") : ut("ops.users.onceHint")}
      </p>
    </div>
  );
}
