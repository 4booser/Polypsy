import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { Page } from "../ui/layout";
import { Button, Field, Input } from "../ui/primitives";

/**
 * Смена временного пароля — вместо рабочего места.
 *
 * Пароль выдан техпанелью (заведение или сброс, users.must_change_password)
 * и его видел тот, кто выдавал. Консоль с таким паролем не открывает ни
 * списков, ни карт: сначала свой пароль. Экран общий для сотрудника и
 * пациента — кабинет пациента в вебе входит тем же путём.
 *
 * Сервер вход с временным паролем не запрещает: мобильное приложение этого
 * шага не знает, и запереть пациента в нём значило бы отнять назначенное.
 * Это решение и его цена записаны у поля в packages/shared/src/types.ts.
 *
 * Смена пароля обрывает все сессии (routes/auth.ts, POST /password), в том
 * числе эту. Поэтому после смены экран сам входит заново новым паролем —
 * человек его только что набрал, и спрашивать его второй раз незачем.
 */
export default function ForcePassword() {
  const { ut } = useLang();
  const { user, login, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* 10 — граница changePasswordSchema: меньше сервер отвергнет уже после нажатия */
  const tooShort = next.length > 0 && next.length < 10;
  const mismatch = repeat.length > 0 && repeat !== next;
  const ready = current && next.length >= 10 && next === repeat && next !== current;

  return (
    <main className="mx-auto w-full max-w-[1200px]">
      <Page title={ut("ops.force.title")} sub={ut("ops.force.sub")}>
        <form
          className="flex max-w-[420px] flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || busy || !user) return;
            setBusy(true);
            setError(null);
            api
              .changePassword(current, next)
              .then(() => login(user.email, next))
              .catch((err) => setError(err instanceof Error ? err.message : ut("ui.actionFailed")))
              .finally(() => setBusy(false));
          }}
        >
          <p className="m-0 mb-[15px] text-[15px] text-text-2 [overflow-wrap:anywhere]">{user?.email}</p>
          <Field label={ut("ops.force.temp")}>
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
          </Field>
          <Field label={ut("acct.newPassword")} error={tooShort ? ut("ops.force.short") : null}>
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label={ut("ops.force.repeat")} error={mismatch ? ut("ops.force.mismatch") : null}>
            <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
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
            <Button variant="ghost" onClick={logout}>
              {ut("nav.logout")}
            </Button>
          </div>
        </form>
      </Page>
    </main>
  );
}
