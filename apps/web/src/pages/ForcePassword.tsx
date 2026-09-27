import { useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { Page } from "../ui/layout";
import { Button, Field, Input } from "../ui/primitives";
import { type PasswordDraft, changePassword, passwordProblems, passwordReady } from "./passwordModel";

/**
 * Смена временного пароля — вместо рабочего места.
 *
 * Пароль выдан техпанелью (заведение или сброс, users.must_change_password)
 * и его видел тот, кто выдавал. Консоль с таким паролем не открывает ни
 * списков, ни карт: сначала свой пароль. Экран общий для сотрудника и
 * пациента — кабинет пациента в вебе входит тем же путём.
 *
 * Экран — не единственный замок: сервер с временным паролем пускает только
 * к смене пароля, «кто я» и настройкам, остальное — 403 с кодом
 * password_change_required (решение заказчика 2026-09-26, внешний разбор;
 * apps/api/src/lib/tempPassword.ts). Раньше ограничивал только этот экран,
 * и запросы мимо консоли проходили. Цена для мобилки записана у поля в
 * packages/shared/src/types.ts.
 *
 * Смена пароля обрывает все сессии (routes/auth.ts, POST /password), в том
 * числе эту. Поэтому после смены экран сам входит заново новым паролем —
 * человек его только что набрал, и спрашивать его второй раз незачем.
 */
export default function ForcePassword() {
  const { ut } = useLang();
  const { user, login, logout } = useAuth();
  const [draft, setDraft] = useState<Required<PasswordDraft>>({ current: "", next: "", repeat: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Пароль, который сервер уже принял. Смена гасит сессию, и если вход
   * новым паролем не удался, повтор только входит — второй смены со старым
   * паролем не будет (passwordModel.ts, changePassword).
   */
  const [accepted, setAccepted] = useState<string | null>(null);
  /* отправка по ref, а не по busy из замыкания: два Enter подряд успевают до перерисовки */
  const inFlight = useRef(false);

  const submit = () => {
    if (inFlight.current || !user || (accepted === null && !passwordReady(draft))) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    changePassword(
      draft,
      accepted,
      { change: (current, next) => api.changePassword(current, next), relogin: (password) => login(user.email, password) },
      setAccepted,
    )
      .catch((err) => setError(err instanceof Error ? err.message : ut("ui.actionFailed")))
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <ForcePasswordView
      email={user?.email ?? ""}
      draft={draft}
      busy={busy}
      error={error}
      accepted={accepted !== null}
      onEdit={(patch) => {
        setDraft((d) => ({ ...d, ...patch }));
        /* отказ относится к отправленному: правка поля его снимает */
        setError(null);
      }}
      onSubmit={submit}
      onLogout={logout}
    />
  );
}

/** Разметка экрана: всё, что она показывает, — из пропсов (test/passwordChange.test.tsx) */
export function ForcePasswordView({
  email,
  draft,
  busy,
  error,
  accepted,
  onEdit,
  onSubmit,
  onLogout,
}: {
  email: string;
  draft: Required<PasswordDraft>;
  busy: boolean;
  error: string | null;
  /** Пароль уже сменён, не удался только вход: повтор войдёт, поля больше ничего не решают */
  accepted: boolean;
  onEdit: (patch: Partial<PasswordDraft>) => void;
  onSubmit: () => void;
  onLogout: () => void;
}) {
  const { ut } = useLang();
  const problems = passwordProblems(draft);
  const ready = accepted || passwordReady(draft);

  return (
    <main className="mx-auto w-full max-w-[1200px]">
      <Page title={ut("ops.force.title")} sub={ut("ops.force.sub")}>
        <form
          className="flex max-w-[420px] flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <p className="m-0 mb-[15px] text-[15px] text-text-2 [overflow-wrap:anywhere]">{email}</p>
          <Field label={ut("ops.force.temp")}>
            <Input
              type="password"
              value={draft.current}
              onChange={(e) => onEdit({ current: e.target.value })}
              autoComplete="current-password"
              autoFocus
              disabled={accepted}
            />
          </Field>
          <Field label={ut("acct.newPassword")} error={problems.next ? ut(problems.next) : null}>
            <Input
              type="password"
              value={draft.next}
              onChange={(e) => onEdit({ next: e.target.value })}
              autoComplete="new-password"
              disabled={accepted}
            />
          </Field>
          <Field label={ut("ops.force.repeat")} error={problems.repeat ? ut(problems.repeat) : null}>
            <Input
              type="password"
              value={draft.repeat}
              onChange={(e) => onEdit({ repeat: e.target.value })}
              autoComplete="new-password"
              disabled={accepted}
            />
          </Field>
          {error ? (
            <p role="alert" className="m-0 mb-[15px] text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex gap-[14px]">
            <Button type="submit" size="form" disabled={!ready || busy}>
              {ut("acct.changePassword")}
            </Button>
            <Button variant="ghost" onClick={onLogout}>
              {ut("nav.logout")}
            </Button>
          </div>
        </form>
      </Page>
    </main>
  );
}
