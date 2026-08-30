import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { InvitePreview } from "@quizzy/shared";
import { LangSwitch, useLang } from "../lang";
import { Button, Field, Input, Select, Spacer } from "../ui/primitives";
import { Grid } from "../ui/layout";

/**
 * Публичная регистрация по приглашению.
 *
 * Единственная страница консоли, доступная без входа. После регистрации
 * пациента не пускаем в консоль (она для персонала) — показываем, что дальше
 * делать в мобильном приложении.
 */
export default function Join() {
  const { token } = useParams<{ token: string }>();
  const { ut, lang } = useLang();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sex, setSex] = useState<"male" | "female" | "">("");
  const [birthDate, setBirthDate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/invites/preview/${token}`)
      .then((r) => r.json())
      .then(setPreview)
      .catch(() => setPreview({ valid: false, reason: "unknown" }));
  }, [token]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          anonymous,
          firstName: anonymous ? undefined : firstName,
          lastName: anonymous ? undefined : lastName,
          middleName: anonymous ? undefined : middleName || undefined,
          sex: sex || undefined,
          birthDate: birthDate || undefined,
          inviteCode: token,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Ошибка ${res.status}`);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("join.registerFailed"));
    } finally {
      setBusy(false);
    }
  }

  const REASON: Record<string, string> = {
    expired: ut("join.reason.expired"),
    revoked: ut("join.reason.revoked"),
    exhausted: ut("join.reason.exhausted"),
    unknown: ut("join.reason.unknown"),
  };

  return (
    <div className="join-page">
      <div className="w-full max-w-[520px]">
        {/*
          Карточка та же, что у входа: тень и рамка «плавающей» поверхности над
          градиентом, а не панель рабочей области — Panel из ui/layout рассчитан
          на рельсу консоли, здесь её нет.
        */}
        <div className="card flex w-full flex-col gap-4 !mb-0 !p-7 shadow-panel">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-md bg-primary font-display text-section font-bold text-primary-text"
            >
              Q
            </span>
            <div className="min-w-0">
              <h1 className="!m-0 font-display text-section font-semibold leading-tight">Quizzy</h1>
            </div>
            <Spacer />
            <LangSwitch />
          </div>

          {preview === null ? <p className="m-0 text-caption text-muted">{ut("join.checking")}</p> : null}

          {preview && !preview.valid ? (
            <>
              <h1 className="m-0">{ut("join.invalidTitle")}</h1>
              <p className="m-0 text-caption text-muted">{REASON[preview.reason ?? "unknown"]}</p>
            </>
          ) : null}

          {done ? (
            <>
              <h1 className="m-0">{ut("join.doneTitle")}</h1>
              <p className="m-0">
                {ut("join.accountCreated")}
                {preview?.batteryTitle
                  ? lang === "uk"
                    ? `, обстеження «${preview.batteryTitle}» вже призначено`
                    : `, обследование «${preview.batteryTitle}» уже назначено`
                  : null}
                .
              </p>
              <p className="m-0 text-caption text-muted">{ut("join.installApp")}</p>
            </>
          ) : null}

          {preview?.valid && !done ? (
            <>
              <h1 className="m-0">{ut("join.registerTitle")}</h1>
              <p className="m-0 text-caption text-muted">
                {ut("join.invited")}
                {preview.batteryTitle ? <>: «{preview.batteryTitle}»</> : null}
                {preview.unit ? <> · {preview.unit}</> : null}
              </p>

              <Field label={ut("person.email")} htmlFor="join-email">
                <Input
                  id="join-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </Field>
              <Field label={ut("person.password8")} htmlFor="join-password">
                <Input
                  id="join-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>

              <label className="check">
                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                {ut("join.anonymous")}
              </label>
              {!anonymous ? (
                <Grid min={220}>
                  <Field label={ut("person.lastName")} htmlFor="join-lastName">
                    <Input id="join-lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </Field>
                  <Field label={ut("person.firstName")} htmlFor="join-firstName">
                    <Input id="join-firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  </Field>
                  <Field label={ut("person.middleName")} htmlFor="join-middleName">
                    <Input id="join-middleName" value={middleName} onChange={(e) => setMiddleName(e.target.value)} />
                  </Field>
                </Grid>
              ) : (
                <p className="m-0 text-caption text-muted">{ut("join.anonymousHint")}</p>
              )}

              <Grid min={220}>
                <Field label={ut("person.sex")} htmlFor="join-sex">
                  <Select id="join-sex" value={sex} onChange={(e) => setSex(e.target.value as never)}>
                    <option value="">—</option>
                    <option value="male">{ut("person.sex.male")}</option>
                    <option value="female">{ut("person.sex.female")}</option>
                  </Select>
                </Field>
                <Field label={ut("person.birthDate")} htmlFor="join-birthDate">
                  <Input
                    id="join-birthDate"
                    type="date"
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                  />
                </Field>
              </Grid>
              <p className="m-0 text-caption text-muted">{ut("person.normsHint")}</p>

              {error ? (
                <p role="alert" className="m-0 text-caption text-danger">
                  {error}
                </p>
              ) : null}
              <Button
                variant="primary"
                className="mt-2 w-full"
                disabled={busy || !email || password.length < 8 || (!anonymous && (!firstName || !lastName))}
                onClick={submit}
              >
                {busy ? ut("join.creating") : ut("join.register")}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
