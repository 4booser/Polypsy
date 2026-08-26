import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { InvitePreview } from "@quizzy/shared";
import { LangSwitch, useLang } from "../lang";

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
      <div className="join-card card">
        <div className="row" style={{ marginBottom: 6 }}>
          <div className="brand">
            <span className="brand-mark">Q</span>
            Quizzy
          </div>
          <div className="spacer" />
          <LangSwitch />
        </div>

        {preview === null ? <p className="muted">{ut("join.checking")}</p> : null}

        {preview && !preview.valid ? (
          <>
            <h1>{ut("join.invalidTitle")}</h1>
            <p className="muted">{REASON[preview.reason ?? "unknown"]}</p>
          </>
        ) : null}

        {done ? (
          <>
            <h1>{ut("join.doneTitle")}</h1>
            <p>
              {lang === "uk" ? "Обліковий запис створено" : "Учётная запись создана"}
              {preview?.batteryTitle
                ? lang === "uk"
                  ? `, обстеження «${preview.batteryTitle}» вже призначено`
                  : `, обследование «${preview.batteryTitle}» уже назначено`
                : null}
              .
            </p>
            <p className="muted">{ut("join.installApp")}</p>
          </>
        ) : null}

        {preview?.valid && !done ? (
          <>
            <h1>{ut("join.registerTitle")}</h1>
            <p className="muted">
              {lang === "uk" ? "Вас запросили пройти обстеження" : "Вас пригласили пройти обследование"}
              {preview.batteryTitle ? <>: «{preview.batteryTitle}»</> : null}
              {preview.unit ? <> · {preview.unit}</> : null}
            </p>

            <label className="field">
              <span>{ut("person.email")}</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            <label className="field">
              <span>{ut("person.password8")}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>

            <label className="check" style={{ margin: "6px 0 10px" }}>
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
              {ut("join.anonymous")}
            </label>
            {!anonymous ? (
              <div className="form-grid">
                <label className="field grow"><span>{ut("person.lastName")}</span>
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} /></label>
                <label className="field grow"><span>{ut("person.firstName")}</span>
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label>
                <label className="field grow"><span>{ut("person.middleName")}</span>
                  <input value={middleName} onChange={(e) => setMiddleName(e.target.value)} /></label>
              </div>
            ) : (
              <p className="hint">{ut("join.anonymousHint")}</p>
            )}

            <div className="form-grid">
              <label className="field"><span>{ut("person.sex")}</span>
                <select value={sex} onChange={(e) => setSex(e.target.value as never)}>
                  <option value="">—</option>
                  <option value="male">{ut("person.sex.male")}</option>
                  <option value="female">{ut("person.sex.female")}</option>
                </select></label>
              <label className="field"><span>{ut("person.birthDate")}</span>
                <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} /></label>
            </div>
            <p className="hint">{ut("person.normsHint")}</p>

            {error ? <p className="error">{error}</p> : null}
            <button
              className="primary"
              style={{ width: "100%", marginTop: 8 }}
              disabled={busy || !email || password.length < 8 || (!anonymous && (!firstName || !lastName))}
              onClick={submit}
            >
              {busy ? ut("join.creating") : ut("join.register")}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
