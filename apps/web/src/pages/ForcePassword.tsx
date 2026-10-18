import { useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Avatar, Ic } from "../ui";
import { cx } from "../ui/cx";
import { Button, ErrorText } from "../ui/primitives";
import { AccessIcon } from "./public/accessIcons";
import { AuthCard, AuthLead, AuthTitle, BandAside, FactRow, NoteRow, PasswordField, WhoRow, fill } from "./public/authParts";
import { PublicFrame } from "./public/PublicFrame";
import { type PasswordDraft, PASSWORD_MIN, changePassword, passwordProblems, passwordReady } from "./passwordModel";

/**
 * Смена временного пароля — вместо рабочего места (набор «Виразна»,
 * access-force-password): лист формы слева, справа на полосе — как придумать
 * пароль, который знаете только вы, и что будет после смены.
 *
 * Пароль выдан техпанелью (заведение или сброс, users.must_change_password)
 * и его видел тот, кто выдавал. Консоль с таким паролем не открывает ни
 * списков, ни карт: сначала свой пароль. Экран общий для сотрудника и
 * пациента — кабинет пациента в вебе входит тем же путём.
 *
 * Экран — не единственный замок: сервер с временным паролем пускает только
 * к смене пароля, «кто я» и настройкам, остальное — 403 с кодом
 * password_change_required (решение заказчика 2026-09-26, внешний разбор;
 * apps/api/src/lib/tempPassword.ts). Цена для мобилки записана у поля в
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
    <PublicFrame signIn={false}>
      <ForcePasswordView
        email={user?.email ?? ""}
        name={user?.fullName ?? ""}
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
    </PublicFrame>
  );
}

/** Разметка экрана: всё, что она показывает, — из пропсов (test/passwordChange.test.tsx) */
export function ForcePasswordView({
  email,
  name = "",
  draft,
  busy,
  error,
  accepted,
  onEdit,
  onSubmit,
  onLogout,
}: {
  email: string;
  /** «Фамилия Имя» — в строке «кто входит»; пусто — строка держится на почте */
  name?: string;
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

  /*
   * Требования — те же правила, что и отказы у полей (passwordModel.ts), только
   * списком: какие уже выполнены, а какое мешает. Пока поле пусто, его правило
   * не горит ни зелёным, ни отказом — форма просто ещё не готова.
   */
  const rules: { ok: boolean; idle: boolean; text: string }[] = [
    {
      ok: draft.next.length >= PASSWORD_MIN,
      idle: !draft.next,
      text: fill(ut("ax.fp.ruleLen"), { n: draft.next.length }),
    },
    { ok: !!draft.next && draft.next !== draft.current, idle: !draft.next || !draft.current, text: ut("ax.fp.ruleDiff") },
    { ok: !!draft.repeat && draft.repeat === draft.next, idle: !draft.repeat, text: ut("ax.fp.ruleRepeat") },
  ];

  return (
    <div className="grid grid-cols-[440px_minmax(0,1fr)] items-start gap-14 pb-4 pt-6 max-[1100px]:gap-8 max-[1000px]:grid-cols-1 max-[1000px]:justify-items-center">
      <AuthCard labelledBy="fp-title" className="max-w-[440px]">
        <WhoRow
          lead={<Avatar name={name || email} size={28} tone="soft" />}
          title={name || email}
          sub={name ? email : undefined}
          aside={
            <Button variant="ghost" size="xs" icon={<ShellIcon name="log-out" size={14} />} onClick={onLogout}>
              {ut("nav.logout")}
            </Button>
          }
        />
        <AuthTitle id="fp-title" className="mt-5">
          {ut("ops.force.title")}
        </AuthTitle>
        <AuthLead>
          {ut("ops.force.sub")} {ut("ax.fp.closed")}
        </AuthLead>
        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <PasswordField
            label={ut("ops.force.temp")}
            hint={ut("ax.fp.tempHint")}
            value={draft.current}
            onChange={(e) => onEdit({ current: e.target.value })}
            autoComplete="current-password"
            autoFocus
            disabled={accepted}
          />
          <PasswordField
            label={ut("acct.newPassword")}
            error={problems.next ? ut(problems.next) : null}
            value={draft.next}
            onChange={(e) => onEdit({ next: e.target.value })}
            autoComplete="new-password"
            disabled={accepted}
          />
          <PasswordField
            label={ut("ops.force.repeat")}
            error={problems.repeat ? ut(problems.repeat) : null}
            value={draft.repeat}
            onChange={(e) => onEdit({ repeat: e.target.value })}
            autoComplete="new-password"
            disabled={accepted}
          />

          {accepted ? null : (
            <ul aria-label={ut("ax.fp.rules")} className="m-0 flex list-none flex-col gap-2 rounded-[12px] bg-sunk px-3.5 py-3">
              {rules.map((r) => (
                <li
                  key={r.text}
                  className={cx(
                    "flex items-center gap-2.5 text-small font-semibold leading-[17px]",
                    !r.ok && !r.idle ? "font-bold text-risk-ink" : "text-text-2",
                  )}
                >
                  <span
                    aria-hidden
                    className={cx(
                      "grid size-5 shrink-0 place-items-center rounded-full",
                      r.ok
                        ? "bg-good-tint text-good"
                        : r.idle
                          ? "shadow-[inset_0_0_0_1.5px_var(--ctl)]"
                          : "text-risk-ink shadow-[inset_0_0_0_1.5px_var(--riskline)]",
                    )}
                  >
                    {r.ok ? <Ic.check size={12} /> : r.idle ? null : <Ic.x size={12} />}
                  </span>
                  {r.text}
                </li>
              ))}
            </ul>
          )}

          {error ? (
            <div role="alert">
              <ErrorText>{error}</ErrorText>
            </div>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="md"
            className="w-full"
            disabled={!ready || busy}
            icon={<ShellIcon name="key-round" size={18} />}
          >
            {accepted ? ut("ax.fp.relogin") : ut("acct.changePassword")}
          </Button>
        </form>
        <p className="m-0 mt-2 text-center text-caption leading-4 text-muted">{ut("ax.fp.after")}</p>
      </AuthCard>

      <BandAside title={ut("ax.fp.sideTitle")} lead={ut("ax.fp.sideLead")} className="max-[1000px]:w-full max-[1000px]:max-w-[640px]">
        <ul className="m-0 mt-6 flex list-none flex-col gap-[18px] p-0">
          <NoteRow icon={<AccessIcon name="text-cursor" size={17} />} title={ut("ax.fp.tip1t")}>
            {ut("ax.fp.tip1")}
          </NoteRow>
          <NoteRow icon={<AccessIcon name="repeat" size={17} />} title={ut("ax.fp.tip2t")}>
            {ut("ax.fp.tip2")}
          </NoteRow>
          <NoteRow icon={<ShellIcon name="key-round" size={17} />} title={ut("ax.fp.tip3t")}>
            {ut("ax.fp.tip3")}
          </NoteRow>
          <NoteRow icon={<AccessIcon name="user-x" size={17} />} title={ut("ax.fp.tip4t")}>
            {ut("ax.fp.tip4")}
          </NoteRow>
        </ul>
        <Door icon={<ShellIcon name="scroll-text" size={19} />} title={ut("ax.fp.whyTitle")}>
          {ut("ax.fp.why")}
        </Door>
        <div className="my-6 h-px bg-band-card-line" />
        <h3 className="m-0 text-h3 font-extrabold text-text">{ut("ax.fp.afterTitle")}</h3>
        <ul className="m-0 mt-3 grid list-none grid-cols-2 gap-x-6 gap-y-3.5 p-0 max-[600px]:grid-cols-1">
          <FactRow icon={<ShellIcon name="log-in" size={16} />} title={ut("ax.fp.a1t")}>
            {ut("ax.fp.a1")}
          </FactRow>
          <FactRow icon={<ShellIcon name="key-round" size={16} />} title={ut("ax.fp.a2t")}>
            {ut("ax.fp.a2")}
          </FactRow>
          <FactRow icon={<ShellIcon name="monitor-smartphone" size={16} />} title={ut("ax.fp.a3t")}>
            {ut("ax.fp.a3")}
          </FactRow>
          <FactRow icon={<AccessIcon name="lock-keyhole" size={16} />} title={ut("ax.fp.a4t")}>
            {ut("ax.fp.a4")}
          </FactRow>
        </ul>
      </BandAside>
    </div>
  );
}

/** Карточка на полосе (.door): значок, заголовок и пояснение на листе полосы */
function Door({ icon, title, children }: { icon: ReactNode; title: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-[22px] grid grid-cols-[40px_minmax(0,1fr)] items-start gap-3.5 rounded-[16px] border border-band-card-line bg-band-card py-4 pl-4 pr-[18px]">
      <span aria-hidden className="grid size-10 place-items-center rounded-[12px] bg-violet-tint text-violet-ink">
        {icon}
      </span>
      <div>
        <b className="block text-h3 font-extrabold leading-5 text-text">{title}</b>
        <p className="m-0 mt-[3px] text-[13px] leading-[19px] text-text-2">{children}</p>
      </div>
    </div>
  );
}
