import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Issue, SurveyFull, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../api";

type Tab = "basics" | "questions" | "scales" | "json";

/** Черновик методики в том же виде, какой принимает API */
interface Draft {
  title: Record<string, string>;
  description?: Record<string, string> | null;
  instructions?: Record<string, string> | null;
  groupId?: string | null;
  administration: "self" | "clinician";
  visibility: "public" | "restricted";
  scoringEnabled: boolean;
  allowRetake: boolean;
  showProgress: boolean;
  allowBack: boolean;
  anonymous: boolean;
  randomizeQuestions: boolean;
  timeLimitSec?: number | null;
  tooFastMs?: number | null;
  alertEscalateMinutes?: number | null;
  sections: unknown[];
  questions: DraftQuestion[];
  scales: DraftScale[];
}

interface DraftQuestion {
  type: string;
  title: Record<string, string>;
  help?: Record<string, string> | null;
  required: boolean;
  options: {
    text: Record<string, string>;
    score?: number;
    keyCode?: string | null;
    riskFlag?: boolean;
    riskLabel?: Record<string, string> | null;
    riskSeverity?: "moderate" | "severe" | null;
  }[];
}

interface DraftScale {
  code: string;
  title: Record<string, string>;
  kind: "clinical" | "validity";
  normalization: "raw" | "ratio" | "tscore" | "sten";
  aggregation?: "sum" | "average" | "count";
  ratioDenominator?: number | null;
  validityThreshold?: number | null;
  validityDirection?: "above" | "below" | null;
  validityMessage?: Record<string, string> | null;
  key: { item: number; matchKey?: string | null; weight?: number }[];
  corrections: { from: string; coefficient: number }[];
  norms: { sex?: "male" | "female" | null; mean: number; sd: number }[];
  stenTable: { rawMin: number; rawMax: number; sten: number }[];
  bands: {
    minScore: number;
    maxScore: number;
    label: Record<string, string>;
    severity: "none" | "mild" | "moderate" | "severe";
    grade?: number | null;
    recommendation?: Record<string, string> | null;
  }[];
}

const EMPTY: Draft = {
  title: { uk: "", ru: "" },
  administration: "self",
  visibility: "public",
  scoringEnabled: true,
  allowRetake: false,
  showProgress: true,
  allowBack: true,
  anonymous: false,
  randomizeQuestions: false,
  sections: [],
  questions: [],
  scales: [],
};

const TYPES = [
  ["yesno", "Да / Нет"],
  ["single", "Один ответ"],
  ["multiple", "Несколько"],
  ["scale", "Шкала"],
  ["slider", "Ползунок"],
  ["matrix", "Матрица"],
  ["ranking", "Ранжирование"],
  ["number", "Число"],
  ["text", "Строка"],
  ["longtext", "Текст"],
  ["date", "Дата"],
  ["info", "Информация"],
] as const;

/** Приводит методику из API к черновику: строки уже могут быть объектами языков */
function toDraft(s: SurveyFull, groups: SurveyGroupWithCounts[]): Draft {
  const loc = (v: unknown): Record<string, string> =>
    typeof v === "string" ? { ru: v } : ((v ?? {}) as Record<string, string>);
  const indexById = new Map(s.questions.map((q, i) => [q.id, i + 1]));
  const codeById = new Map(s.scales.map((sc) => [sc.id, sc.code]));

  return {
    title: loc(s.title),
    description: s.description ? loc(s.description) : null,
    instructions: s.instructions ? loc(s.instructions) : null,
    groupId: s.groupId ?? groups[0]?.id ?? null,
    administration: s.administration,
    visibility: s.visibility,
    scoringEnabled: s.scoringEnabled,
    allowRetake: s.allowRetake,
    showProgress: s.showProgress,
    allowBack: s.allowBack,
    anonymous: s.anonymous,
    randomizeQuestions: s.randomizeQuestions,
    timeLimitSec: s.timeLimitSec,
    tooFastMs: s.tooFastMs,
    alertEscalateMinutes: s.alertEscalateMinutes,
    sections: [],
    questions: s.questions.map((q) => ({
      type: q.type,
      title: loc(q.title),
      help: q.help ? loc(q.help) : null,
      required: q.required,
      options: q.options.map((o) => ({
        text: loc(o.text),
        score: o.score,
        keyCode: o.keyCode,
        riskFlag: o.riskFlag,
        riskLabel: o.riskLabel ? loc(o.riskLabel) : null,
        riskSeverity: o.riskSeverity,
      })),
    })),
    scales: s.scales.map((sc) => ({
      code: sc.code,
      title: loc(sc.title),
      kind: sc.kind,
      normalization: sc.normalization,
      aggregation: sc.aggregation,
      ratioDenominator: sc.ratioDenominator,
      validityThreshold: sc.validityThreshold,
      validityDirection: sc.validityDirection,
      validityMessage: sc.validityMessage ? loc(sc.validityMessage) : null,
      key: sc.items.flatMap((i) => {
        const item = indexById.get(i.questionId);
        return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
      }),
      corrections: sc.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
      norms: sc.norms.map((n) => ({ sex: n.sex, mean: n.mean, sd: n.sd })),
      stenTable: sc.stenTable.map((r) => ({ rawMin: r.rawMin, rawMax: r.rawMax, sten: r.sten })),
      bands: sc.bands.map((b) => ({
        minScore: b.minScore,
        maxScore: b.maxScore,
        label: loc(b.label),
        severity: b.severity,
        grade: b.grade,
        recommendation: b.recommendation ? loc(b.recommendation) : null,
      })),
    })),
  };
  void codeById;
}

export default function Constructor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [groups, setGroups] = useState<SurveyGroupWithCounts[]>([]);
  const [tab, setTab] = useState<Tab>("basics");
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  const [issues, setIssues] = useState<Issue[] | null>(null);

  useEffect(() => {
    api.groups().then(setGroups).catch(() => setGroups([]));
    if (!id) return;
    api
      .surveyRaw(id)
      .then((s) => {
        setDraft(toDraft(s, []));
        setLoaded(true);
      })
      .catch((e) => {
        setError(e.message);
        setLoaded(true);
      });
  }, [id]);

  useEffect(() => {
    setJson(JSON.stringify(draft, null, 2));
  }, [tab === "json"]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const asked = useMemo(() => draft.questions.filter((q) => q.type !== "info").length, [draft.questions]);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.validateSurvey(draft);
      setIssues(res.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось проверить");
    } finally {
      setBusy(false);
    }
  }

  async function save(publish: boolean) {
    setBusy(true);
    setError(null);
    try {
      const survey = id
        ? await api.updateSurvey(id, { ...draft, versionNote: "Правка через конструктор" })
        : await api.createSurvey(draft);
      if (publish) await api.updateSurvey(survey.id, { status: "published" });
      navigate(`/surveys/${survey.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  function applyJson() {
    setError(null);
    try {
      const parsed = JSON.parse(json) as Draft;
      if (!parsed.title) throw new Error("В JSON нет поля title");
      setDraft({ ...EMPTY, ...parsed });
      setTab("basics");
    } catch (e) {
      setError(e instanceof Error ? `JSON не разобран: ${e.message}` : "JSON не разобран");
    }
  }

  if (!loaded) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <h1>{id ? "Правка методики" : "Новая методика"}</h1>
      <p className="sub">
        {id ? (
          <>
            Правка создаёт новую версию — собранные прохождения останутся на прежней.{" "}
            <Link to={`/surveys/${id}`}>к аналитике</Link>
          </>
        ) : (
          "Заполните вручную или вставьте описание методики целиком во вкладке «JSON»"
        )}
      </p>

      <div className="tabs">
        {([
          ["basics", "Основное"],
          ["questions", `Вопросы ${asked}`],
          ["scales", `Шкалы ${draft.scales.length}`],
          ["json", "JSON"],
        ] as [Tab, string][]).map(([v, label]) => (
          <button key={v} className={tab === v ? "active" : ""} onClick={() => setTab(v)}>
            {label}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {issues ? (
        <div
          className="card"
          style={{
            borderColor: issues.some((i) => i.level === "error")
              ? "var(--sev-severe)"
              : issues.length
                ? "var(--sev-mild)"
                : "var(--sev-none)",
          }}
        >
          <h2>
            {issues.length === 0
              ? "Структурных замечаний нет"
              : `Замечаний: ${issues.filter((i) => i.level === "error").length} ошибок, ${issues.filter((i) => i.level === "warning").length} предупреждений`}
          </h2>
          <p className="hint">
            Проверка формальная: она ловит ошибки переноса ключей и норм, но не знает
            содержания методики
          </p>
          {issues.map((i, k) => (
            <p key={k} style={{ margin: "4px 0", fontSize: 13 }}>
              <span style={{ color: i.level === "error" ? "var(--sev-severe)" : "var(--sev-mild)" }}>
                {i.level === "error" ? "✖" : "⚠"}
              </span>{" "}
              <strong>{i.where}:</strong> <span className="muted">{i.message}</span>
            </p>
          ))}
        </div>
      ) : null}

      {tab === "basics" ? <Basics draft={draft} groups={groups} patch={patch} /> : null}
      {tab === "questions" ? <Questions draft={draft} setDraft={setDraft} /> : null}
      {tab === "scales" ? <Scales draft={draft} setDraft={setDraft} /> : null}
      {tab === "json" ? (
        <div className="card">
          <h2>Описание методики целиком</h2>
          <p className="hint">
            Для методик на сотни пунктов заполнять форму бессмысленно. Вставьте сюда описание
            в том же виде, какой принимает API — с ключами шкал, нормами и таблицами стенов.
          </p>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={22}
            spellCheck={false}
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={applyJson}>Применить</button>
            <button onClick={() => navigator.clipboard?.writeText(json)}>Скопировать</button>
          </div>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 18 }}>
        <button onClick={check} disabled={busy}>Проверить структуру</button>
        <button onClick={() => save(false)} disabled={busy}>Сохранить черновиком</button>
        <button className="primary" onClick={() => save(true)} disabled={busy}>
          {busy ? "Сохранение…" : "Сохранить и опубликовать"}
        </button>
      </div>
    </>
  );
}

/* ─────────── вкладки ─────────── */

function Loc({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: Record<string, string> | null | undefined;
  onChange: (v: Record<string, string>) => void;
  multiline?: boolean;
}) {
  const v = value ?? {};
  const Field = multiline ? "textarea" : "input";
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {(["uk", "ru"] as const).map((lang) => (
          <div key={lang} style={{ flex: 1 }}>
            <Field
              value={v[lang] ?? ""}
              rows={multiline ? 3 : undefined}
              placeholder={lang === "uk" ? "українською" : "по-русски"}
              onChange={(e: { target: { value: string } }) =>
                onChange({ ...v, [lang]: e.target.value })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 8, marginBottom: 8, cursor: "pointer" }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ width: 16 }} />
      <span style={{ color: "var(--text)", fontSize: 13 }}>{label}</span>
    </label>
  );
}

function Basics({
  draft,
  groups,
  patch,
}: {
  draft: Draft;
  groups: SurveyGroupWithCounts[];
  patch: (p: Partial<Draft>) => void;
}) {
  return (
    <>
      <div className="card">
        <h2>Название и описание</h2>
        <p className="hint">Слева украинский вариант, справа русский</p>
        <Loc label="Название" value={draft.title} onChange={(v) => patch({ title: v })} />
        <Loc label="Описание" value={draft.description} onChange={(v) => patch({ description: v })} multiline />
        <Loc
          label="Инструкция перед прохождением"
          value={draft.instructions}
          onChange={(v) => patch({ instructions: v })}
          multiline
        />
      </div>

      <div className="card">
        <h2>Кто и как проходит</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Группа</label>
            <select value={draft.groupId ?? ""} onChange={(e) => patch({ groupId: e.target.value || null })}>
              <option value="">— без группы —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Кто заполняет</label>
            <select
              value={draft.administration}
              onChange={(e) => patch({ administration: e.target.value as Draft["administration"] })}
            >
              <option value="self">Респондент сам</option>
              <option value="clinician">Специалист за респондента</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Видимость</label>
            <select
              value={draft.visibility}
              onChange={(e) => patch({ visibility: e.target.value as Draft["visibility"] })}
            >
              <option value="public">Всем пациентам</option>
              <option value="restricted">Только по назначению</option>
            </select>
          </div>
        </div>

        <Toggle label="Считать баллы по шкалам" value={draft.scoringEnabled} onChange={(v) => patch({ scoringEnabled: v })} />
        <Toggle label="Показывать прогресс" value={draft.showProgress} onChange={(v) => patch({ showProgress: v })} />
        <Toggle label="Разрешить возврат назад" value={draft.allowBack} onChange={(v) => patch({ allowBack: v })} />
        <Toggle label="Разрешить повторные прохождения" value={draft.allowRetake} onChange={(v) => patch({ allowRetake: v })} />
        <Toggle label="Перемешивать вопросы" value={draft.randomizeQuestions} onChange={(v) => patch({ randomizeQuestions: v })} />
        <Toggle label="Анонимно" value={draft.anonymous} onChange={(v) => patch({ anonymous: v })} />
      </div>

      <div className="card">
        <h2>Пороги</h2>
        <p className="hint">
          Порог «слишком быстро» задаётся отдельно: матричный вопрос требует заметно больше
          времени, чем «да/нет», и общий порог либо пропускает небрежность, либо клевещет
        </p>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>Лимит времени, минут</label>
            <input
              type="number"
              value={draft.timeLimitSec ? draft.timeLimitSec / 60 : ""}
              onChange={(e) => patch({ timeLimitSec: e.target.value ? Number(e.target.value) * 60 : null })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>«Слишком быстро», мс на вопрос</label>
            <input
              type="number"
              placeholder="1500 по умолчанию"
              value={draft.tooFastMs ?? ""}
              onChange={(e) => patch({ tooFastMs: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Эскалация тревоги, минут</label>
            <input
              type="number"
              placeholder="без эскалации"
              value={draft.alertEscalateMinutes ?? ""}
              onChange={(e) => patch({ alertEscalateMinutes: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function Questions({ draft, setDraft }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const upd = (i: number, q: Partial<DraftQuestion>) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((x, k) => (k === i ? { ...x, ...q } : x)) }));

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="hint" style={{ margin: 0 }}>
            Номера пунктов — это то, на что ссылаются ключи шкал. Перестановка вопросов
            сдвигает ключи, поэтому меняйте порядок до того, как зададите ключ.
          </p>
          <button
            className="primary"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                questions: [
                  ...d.questions,
                  {
                    type: "yesno",
                    title: { uk: "", ru: "" },
                    required: true,
                    options: [
                      { text: { uk: "Так", ru: "Да" }, keyCode: "yes" },
                      { text: { uk: "Ні", ru: "Нет" }, keyCode: "no" },
                    ],
                  },
                ],
              }))
            }
          >
            Добавить вопрос
          </button>
        </div>
      </div>

      {draft.questions.length === 0 ? (
        <p className="muted">Вопросов пока нет</p>
      ) : null}

      {draft.questions.map((q, i) => (
        <div className="card" key={i}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Пункт {i + 1}</strong>
            <div className="row">
              <select value={q.type} onChange={(e) => upd(i, { type: e.target.value })} style={{ width: 180 }}>
                {TYPES.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <button className="danger" onClick={() => setDraft((d) => ({ ...d, questions: d.questions.filter((_, k) => k !== i) }))}>
                Удалить
              </button>
            </div>
          </div>
          <Loc label="Текст пункта" value={q.title} onChange={(v) => upd(i, { title: v })} multiline />
          <Toggle label="Обязательный" value={q.required} onChange={(v) => upd(i, { required: v })} />

          {q.options.length ? (
            <table>
              <thead>
                <tr><th>Вариант (uk / ru)</th><th className="num">Балл</th><th>Код ключа</th><th>Тревога</th></tr>
              </thead>
              <tbody>
                {q.options.map((o, oi) => (
                  <tr key={oi}>
                    <td>
                      <div className="row">
                        <input
                          value={o.text.uk ?? ""}
                          onChange={(e) =>
                            upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, text: { ...x.text, uk: e.target.value } } : x)) })
                          }
                        />
                        <input
                          value={o.text.ru ?? ""}
                          onChange={(e) =>
                            upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, text: { ...x.text, ru: e.target.value } } : x)) })
                          }
                        />
                      </div>
                    </td>
                    <td className="num" style={{ width: 90 }}>
                      <input
                        type="number"
                        value={o.score ?? 0}
                        onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, score: Number(e.target.value) } : x)) })}
                      />
                    </td>
                    <td style={{ width: 110 }}>
                      <input
                        value={o.keyCode ?? ""}
                        placeholder="yes / no"
                        onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, keyCode: e.target.value || null } : x)) })}
                      />
                    </td>
                    <td style={{ width: 130 }}>
                      <label className="row" style={{ gap: 6, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={!!o.riskFlag}
                          style={{ width: 16 }}
                          onChange={(e) => upd(i, { options: q.options.map((x, k) => (k === oi ? { ...x, riskFlag: e.target.checked } : x)) })}
                        />
                        <span style={{ fontSize: 12 }}>критический</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <button
            style={{ marginTop: 8 }}
            onClick={() => upd(i, { options: [...q.options, { text: { uk: "", ru: "" }, score: 0 }] })}
          >
            Добавить вариант
          </button>
        </div>
      ))}
    </>
  );
}

function Scales({ draft, setDraft }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const upd = (i: number, s: Partial<DraftScale>) =>
    setDraft((d) => ({ ...d, scales: d.scales.map((x, k) => (k === i ? { ...x, ...s } : x)) }));

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="hint" style={{ margin: 0 }}>
            Ключ задаётся номерами пунктов через запятую — так же, как он напечатан в пособии
          </p>
          <button
            className="primary"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                scales: [
                  ...d.scales,
                  {
                    code: "",
                    title: { uk: "", ru: "" },
                    kind: "clinical",
                    normalization: "raw",
                    key: [],
                    corrections: [],
                    norms: [],
                    stenTable: [],
                    bands: [],
                  },
                ],
              }))
            }
          >
            Добавить шкалу
          </button>
        </div>
      </div>

      {draft.scales.map((s, i) => (
        <div className="card" key={i}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{s.code || "новая шкала"}</strong>
            <button className="danger" onClick={() => setDraft((d) => ({ ...d, scales: d.scales.filter((_, k) => k !== i) }))}>
              Удалить
            </button>
          </div>

          <div className="row">
            <div className="field" style={{ width: 140 }}>
              <label>Код</label>
              <input value={s.code} onChange={(e) => upd(i, { code: e.target.value })} placeholder="Sr" />
            </div>
            <div className="field" style={{ width: 170 }}>
              <label>Роль</label>
              <select value={s.kind} onChange={(e) => upd(i, { kind: e.target.value as DraftScale["kind"] })}>
                <option value="clinical">Содержательная</option>
                <option value="validity">Достоверности</option>
              </select>
            </div>
            <div className="field" style={{ width: 190 }}>
              <label>Нормирование</label>
              <select
                value={s.normalization}
                onChange={(e) => upd(i, { normalization: e.target.value as DraftScale["normalization"] })}
              >
                <option value="raw">Сырой балл</option>
                <option value="ratio">Доля от максимума</option>
                <option value="tscore">T-баллы</option>
                <option value="sten">Стены</option>
              </select>
            </div>
            {s.normalization === "ratio" ? (
              <div className="field" style={{ width: 150 }}>
                <label>Знаменатель</label>
                <input
                  type="number"
                  value={s.ratioDenominator ?? ""}
                  onChange={(e) => upd(i, { ratioDenominator: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
            ) : null}
          </div>

          <Loc label="Название шкалы" value={s.title} onChange={(v) => upd(i, { title: v })} />

          {s.kind === "validity" ? (
            <div className="row">
              <div className="field" style={{ width: 150 }}>
                <label>Порог</label>
                <input
                  type="number"
                  step="0.01"
                  value={s.validityThreshold ?? ""}
                  onChange={(e) => upd(i, { validityThreshold: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
              <div className="field" style={{ width: 180 }}>
                <label>Нарушается</label>
                <select
                  value={s.validityDirection ?? "above"}
                  onChange={(e) => upd(i, { validityDirection: e.target.value as "above" | "below" })}
                >
                  <option value="above">выше порога</option>
                  <option value="below">ниже порога</option>
                </select>
              </div>
            </div>
          ) : null}

          <div className="field">
            <label>Ключ: номера пунктов с ответом «Да»</label>
            <input
              value={s.key.filter((k) => k.matchKey === "yes").map((k) => k.item).join(", ")}
              placeholder="1, 2, 3, 5, 7"
              onChange={(e) =>
                upd(i, {
                  key: [
                    ...parseItems(e.target.value).map((item) => ({ item, matchKey: "yes" })),
                    ...s.key.filter((k) => k.matchKey !== "yes"),
                  ],
                })
              }
            />
          </div>
          <div className="field">
            <label>Ключ: номера пунктов с ответом «Нет»</label>
            <input
              value={s.key.filter((k) => k.matchKey === "no").map((k) => k.item).join(", ")}
              placeholder="4, 6, 8"
              onChange={(e) =>
                upd(i, {
                  key: [
                    ...s.key.filter((k) => k.matchKey !== "no"),
                    ...parseItems(e.target.value).map((item) => ({ item, matchKey: "no" })),
                  ],
                })
              }
            />
          </div>

          <p className="hint" style={{ marginBottom: 4 }}>
            В ключе {s.key.length} пунктов
            {s.corrections.length ? ` · поправки: ${s.corrections.map((c) => `${c.from}×${c.coefficient}`).join(", ")}` : ""}
            {s.norms.length ? ` · норм: ${s.norms.length}` : ""}
            {s.stenTable.length ? ` · строк стенов: ${s.stenTable.length}` : ""}
          </p>
          <p className="hint">
            Поправки, нормы по полу и таблицы стенов задаются во вкладке «JSON» — в форме
            они занимали бы больше места, чем экономят
          </p>

          <h2 style={{ fontSize: 14, marginTop: 14 }}>Интерпретационные нормы</h2>
          <table>
            <thead>
              <tr><th className="num">От</th><th className="num">До</th><th>Вывод (uk / ru)</th><th>Выраженность</th><th className="num">Оценка</th><th /></tr>
            </thead>
            <tbody>
              {s.bands.map((b, bi) => (
                <tr key={bi}>
                  <td className="num" style={{ width: 80 }}>
                    <input type="number" step="0.01" value={b.minScore}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, minScore: Number(e.target.value) } : x)) })} />
                  </td>
                  <td className="num" style={{ width: 80 }}>
                    <input type="number" step="0.01" value={b.maxScore}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, maxScore: Number(e.target.value) } : x)) })} />
                  </td>
                  <td>
                    <div className="row">
                      <input value={b.label.uk ?? ""} placeholder="українською"
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, label: { ...x.label, uk: e.target.value } } : x)) })} />
                      <input value={b.label.ru ?? ""} placeholder="по-русски"
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, label: { ...x.label, ru: e.target.value } } : x)) })} />
                    </div>
                  </td>
                  <td style={{ width: 150 }}>
                    <select value={b.severity}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, severity: e.target.value as DraftScale["bands"][number]["severity"] } : x)) })}>
                      <option value="none">Норма</option>
                      <option value="mild">Лёгкая</option>
                      <option value="moderate">Умеренная</option>
                      <option value="severe">Выраженная</option>
                    </select>
                  </td>
                  <td className="num" style={{ width: 80 }}>
                    <input type="number" value={b.grade ?? ""}
                      onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, grade: e.target.value ? Number(e.target.value) : null } : x)) })} />
                  </td>
                  <td style={{ width: 40 }}>
                    <button className="danger" onClick={() => upd(i, { bands: s.bands.filter((_, k) => k !== bi) })}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            style={{ marginTop: 8 }}
            onClick={() => upd(i, { bands: [...s.bands, { minScore: 0, maxScore: 0, label: { uk: "", ru: "" }, severity: "none" }] })}
          >
            Добавить норму
          </button>
        </div>
      ))}
    </>
  );
}

/** «1, 2, 3, 5-7» → [1,2,3,5,6,7] */
function parseItems(input: string): number[] {
  const out: number[] = [];
  for (const chunk of input.split(/[,\s]+/).filter(Boolean)) {
    const range = chunk.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
    } else if (/^\d+$/.test(chunk)) {
      out.push(Number(chunk));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function SurveyList() {
  const [rows, setRows] = useState<SurveyListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setRows(await api.surveys());
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  if (!rows) return <p className="muted">{error ?? "Загрузка…"}</p>;

  return (
    <>
      <h1>Методики</h1>
      <p className="sub">Создание, правка и назначение</p>
      <Link className="btn" to="/constructor">Создать методику</Link>

      <div className="card scroll-x" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr><th>Название</th><th>Статус</th><th>Заполняет</th><th>Видимость</th><th className="num">Вопросов</th><th className="num">Прохождений</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/surveys/${s.id}`}>{s.title}</Link></td>
                <td className="muted">{s.status}</td>
                <td className="muted">{s.administration === "clinician" ? "специалист" : "респондент"}</td>
                <td className="muted">{s.visibility === "restricted" ? "по назначению" : "общая"}</td>
                <td className="num">{s.questionCount}</td>
                <td className="num">{s.responseCount}</td>
                <td>
                  <div className="row">
                    <Link className="btn" to={`/constructor/${s.id}`}>Править</Link>
                    <Link className="btn" to={`/surveys/${s.id}/key`}>Ключи</Link>
                    <Link className="btn" to={`/surveys/${s.id}/access`}>Доступ</Link>
                    <button
                      onClick={async () => {
                        await api.duplicateSurvey(s.id).catch(() => null);
                        await load();
                      }}
                    >
                      Копия
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
