import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { InvitePreview } from "@quizzy/shared";

/**
 * Публичная регистрация по приглашению.
 *
 * Единственная страница консоли, доступная без входа. После регистрации
 * пациента не пускаем в консоль (она для персонала) — показываем, что дальше
 * делать в мобильном приложении.
 */
export default function Join() {
  const { token } = useParams<{ token: string }>();
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
      setError(e instanceof Error ? e.message : "Не удалось зарегистрироваться");
    } finally {
      setBusy(false);
    }
  }

  const REASON: Record<string, string> = {
    expired: "Срок приглашения истёк. Попросите новое у своего специалиста.",
    revoked: "Приглашение отозвано.",
    exhausted: "Приглашение уже использовано.",
    unknown: "Такого приглашения нет. Проверьте ссылку.",
  };

  return (
    <div className="join-page">
      <div className="join-card card">
        <div className="brand" style={{ marginBottom: 6 }}>
          <span className="brand-mark">Q</span>
          Quizzy
        </div>

        {preview === null ? <p className="muted">Проверяем приглашение…</p> : null}

        {preview && !preview.valid ? (
          <>
            <h1>Приглашение не действует</h1>
            <p className="muted">{REASON[preview.reason ?? "unknown"]}</p>
          </>
        ) : null}

        {done ? (
          <>
            <h1>Готово</h1>
            <p>
              Учётная запись создана{preview?.batteryTitle ? <>, обследование «{preview.batteryTitle}» уже назначено</> : null}.
            </p>
            <p className="muted">
              Установите мобильное приложение Quizzy и войдите с этой почтой и паролем — обследование
              будет ждать на главном экране.
            </p>
          </>
        ) : null}

        {preview?.valid && !done ? (
          <>
            <h1>Регистрация</h1>
            <p className="muted">
              Вас пригласили пройти обследование
              {preview.batteryTitle ? <>: «{preview.batteryTitle}»</> : null}
              {preview.unit ? <> · {preview.unit}</> : null}
            </p>

            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            <label className="field">
              <span>Пароль (минимум 8 символов)</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>

            <label className="check" style={{ margin: "6px 0 10px" }}>
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
              Без имени (в списках — только код)
            </label>
            {!anonymous ? (
              <div className="form-grid">
                <label className="field grow"><span>Фамилия</span>
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} /></label>
                <label className="field grow"><span>Имя</span>
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label>
                <label className="field grow"><span>Отчество</span>
                  <input value={middleName} onChange={(e) => setMiddleName(e.target.value)} /></label>
              </div>
            ) : (
              <p className="hint">
                Имя не сохраняется. Почта остаётся для входа — полной анонимности это не даёт.
              </p>
            )}

            <div className="form-grid">
              <label className="field"><span>Пол</span>
                <select value={sex} onChange={(e) => setSex(e.target.value as never)}>
                  <option value="">—</option>
                  <option value="male">мужской</option>
                  <option value="female">женский</option>
                </select></label>
              <label className="field"><span>Дата рождения</span>
                <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} /></label>
            </div>
            <p className="hint">Пол и возраст нужны для правильного расчёта норм — без них часть методик покажет сырые баллы.</p>

            {error ? <p className="error">{error}</p> : null}
            <button
              className="primary"
              style={{ width: "100%", marginTop: 8 }}
              disabled={busy || !email || password.length < 8 || (!anonymous && (!firstName || !lastName))}
              onClick={submit}
            >
              {busy ? "Создаём…" : "Зарегистрироваться"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
