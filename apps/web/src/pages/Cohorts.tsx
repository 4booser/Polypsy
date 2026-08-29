import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { CohortPreview, CohortSpec, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { PageHead, useAction } from "../ui";

/**
 * Конструктор когорт.
 *
 * «Мужчины 20–30 из рот 1–3, прошедшие МЛО за квартал, с ЛАП ниже четырёх, у
 * которых есть повторный замер» — вопрос, который задают постоянно, а отвечают
 * на него выгрузкой в SPSS и обратно.
 *
 * Счётчик пересчитывается на каждое изменение условия: смысл конструктора в
 * том, чтобы видеть, во что превращается сужение, до того как нажать. Сужать
 * вслепую и проверять результатом — это тот же SPSS, только медленнее.
 *
 * Имена показываются отдельным действием. Посмотреть распределение и увидеть,
 * кто это, — разные вещи с разными последствиями, и в журнале они различаются.
 */
export default function Cohorts() {
  const { ut } = useLang();
  const { run, busy } = useAction();

  const [spec, setSpec] = useState<CohortSpec>({});
  const [preview, setPreview] = useState<CohortPreview | null>(null);
  const [names, setNames] = useState<{ userId: string; fullName: string; unit: string | null }[] | null>(null);
  const [title, setTitle] = useState("");

  const surveys = useResource(() => api.surveys(), []);
  const units = useResource(() => api.unitReportUnits(), []);
  const saved = useResource(() => api.cohorts(), []);

  const survey = useResource(
    () => api.survey(spec.surveyId!),
    [spec.surveyId],
    { enabled: !!spec.surveyId },
  );

  /*
   * Ключ спецификации, а не объект: иначе эффект перезапускался бы на каждый
   * рендер, потому что объект каждый раз новый.
   */
  const key = useMemo(() => JSON.stringify(spec), [spec]);

  useEffect(() => {
    let alive = true;
    // имена сбрасываются при смене условий: список от прошлого запроса
    // относится к другой когорте
    setNames(null);
    void api
      .cohortPreview(JSON.parse(key) as CohortSpec)
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview(null));
    return () => {
      alive = false;
    };
  }, [key]);

  const patch = (next: Partial<CohortSpec>) => setSpec((s) => ({ ...s, ...next }));

  return (
    <>
      <PageHead title={ut("coh.title")} sub={ut("coh.sub")} />

      <div className="card">
        <div className="row tight" style={{ flexWrap: "wrap" }}>
          <select
            value={spec.sex ?? ""}
            onChange={(e) => patch({ sex: (e.target.value || null) as CohortSpec["sex"] })}
          >
            <option value="">{ut("coh.anySex")}</option>
            <option value="male">{ut("adm.male")}</option>
            <option value="female">{ut("adm.female")}</option>
          </select>

          <label className="row tight">
            <span className="muted">{ut("coh.ageFrom")}</span>
            <input
              type="number"
              style={{ width: 70 }}
              value={spec.ageMin ?? ""}
              onChange={(e) => patch({ ageMin: e.target.value ? Number(e.target.value) : null })}
            />
            <span className="muted">{ut("coh.ageTo")}</span>
            <input
              type="number"
              style={{ width: 70 }}
              value={spec.ageMax ?? ""}
              onChange={(e) => patch({ ageMax: e.target.value ? Number(e.target.value) : null })}
            />
          </label>

          <select
            value={spec.surveyId ?? ""}
            onChange={(e) => patch({ surveyId: e.target.value || null, scales: [] })}
          >
            <option value="">{ut("coh.anySurvey")}</option>
            {(surveys.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>

          <label className="row tight">
            <input
              type="checkbox"
              checked={!!spec.repeatedOnly}
              onChange={(e) => patch({ repeatedOnly: e.target.checked })}
            />
            <span>{ut("coh.repeated")}</span>
          </label>
          <label className="row tight">
            <input
              type="checkbox"
              checked={!!spec.riskOnly}
              onChange={(e) => patch({ riskOnly: e.target.checked })}
            />
            <span>{ut("coh.risk")}</span>
          </label>
        </div>

        {/* подразделения выбираются метками: их десятки, и список в select не читается */}
        <div className="row tight" style={{ flexWrap: "wrap", marginTop: 8 }}>
          {(units.data ?? []).map((u) => {
            const on = spec.units?.includes(u) ?? false;
            return (
              <button
                key={u}
                className={`chip${on ? " active" : ""}`}
                aria-pressed={on}
                onClick={() =>
                  patch({
                    units: on
                      ? (spec.units ?? []).filter((x) => x !== u)
                      : [...(spec.units ?? []), u],
                  })
                }
              >
                {u}
              </button>
            );
          })}
        </div>

        {/* условия по шкалам появляются только когда выбрана методика */}
        {spec.surveyId && survey.data ? (
          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {(spec.scales ?? []).map((cond, i) => (
              <div key={i} className="row tight">
                <select
                  value={cond.code}
                  onChange={(e) => {
                    const next = [...(spec.scales ?? [])];
                    next[i] = { ...cond, code: e.target.value };
                    patch({ scales: next });
                  }}
                >
                  {survey.data!.scales.map((sc) => (
                    <option key={sc.code} value={sc.code}>
                      {sc.code} — {sc.title}
                    </option>
                  ))}
                </select>
                <select
                  value={cond.op}
                  onChange={(e) => {
                    const next = [...(spec.scales ?? [])];
                    next[i] = { ...cond, op: e.target.value as typeof cond.op };
                    patch({ scales: next });
                  }}
                >
                  {[">=", "<=", ">", "<"].map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  style={{ width: 90 }}
                  value={cond.value}
                  onChange={(e) => {
                    const next = [...(spec.scales ?? [])];
                    next[i] = { ...cond, value: Number(e.target.value) };
                    patch({ scales: next });
                  }}
                />
                <button
                  className="ghost"
                  onClick={() => patch({ scales: (spec.scales ?? []).filter((_, k) => k !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            <div>
              <button
                onClick={() =>
                  patch({
                    scales: [
                      ...(spec.scales ?? []),
                      { code: survey.data!.scales[0]?.code ?? "", op: ">=", value: 0 },
                    ],
                  })
                }
              >
                {ut("coh.addCond")}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {preview ? (
        <div className="card">
          <div className="row tight">
            <h2 style={{ margin: 0 }}>
              {ut("coh.size")}:{" "}
              {preview.size === null ? (
                <span className="muted">{ut("coh.tooSmall")}</span>
              ) : (
                <span className="stat-num">{preview.size}</span>
              )}
            </h2>
            <div style={{ flex: 1 }} />
            <input
              placeholder={ut("coh.name")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <button
              disabled={busy || !title.trim()}
              onClick={() =>
                void run(async () => {
                  await api.saveCohort(title.trim(), spec);
                  setTitle("");
                  saved.reload();
                })
              }
            >
              {ut("coh.save")}
            </button>
          </div>

          {!preview.breakdownAllowed ? (
            <p className="hint">{ut("coh.noBreakdown")}</p>
          ) : (
            <div className="grid cols-3" style={{ marginTop: 10 }}>
              <Breakdown title={ut("coh.byUnit")} rows={preview.byUnit} />
              <Breakdown
                title={ut("coh.bySex")}
                rows={preview.bySex.map((r) => ({ ...r, key: label(r.key, ut) }))}
              />
              <Breakdown
                title={ut("coh.bySeverity")}
                rows={preview.bySeverity.map((r) => ({ ...r, key: label(r.key, ut) }))}
              />
            </div>
          )}

          <div className="row tight" style={{ marginTop: 10 }}>
            <button
              disabled={busy || preview.size === null}
              onClick={() =>
                void run(async () => {
                  setNames(await api.cohortMembers(spec));
                })
              }
            >
              {ut("coh.showNames")}
            </button>
            <span className="hint">{ut("coh.namesWarn")}</span>
          </div>

          {names ? (
            <table style={{ marginTop: 10 }}>
              <tbody>
                {names.map((p) => (
                  <tr key={p.userId}>
                    <td>
                      <Link to={`/patients/${p.userId}/summary`}>{p.fullName}</Link>
                    </td>
                    <td className="muted">{p.unit ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>{ut("coh.saved")}</h2>
          <span className="muted">{ut("coh.savedHint")}</span>
        </div>
        {(saved.data ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{ut("coh.noneSaved")}</p>
        ) : (
          <ul className="inf-list">
            {(saved.data ?? []).map((c) => (
              <li key={c.id}>
                <button className="ghost" onClick={() => setSpec(c.spec)}>
                  {c.title}
                </button>
                <div style={{ flex: 1 }} />
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.deleteCohort(c.id);
                      saved.reload();
                    })
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/*
 * Перевод ключей разбивки. Из базы приходят значения перечислений — «male»,
 * «moderate»; показывать их человеку значит показывать устройство таблицы, а
 * не данные.
 */
const KEYS: Record<string, UiKey> = {
  male: "adm.male",
  female: "adm.female",
  none: "severity.none",
  mild: "severity.mild",
  moderate: "severity.moderate",
  severe: "severity.severe",
};

function label(key: string, ut: (k: UiKey) => string): string {
  const known = KEYS[key];
  return known ? ut(known) : key;
}

function Breakdown({ title, rows }: { title: string; rows: { key: string; count: number | null }[] }) {
  return (
    <div>
      <h3>{title}</h3>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              {/* прочерк вместо числа: скрытая ячейка не должна выглядеть нулём */}
              <td className="num">{r.count === null ? <span className="muted">—</span> : r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
