import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AlertCase } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime, severityColor } from "../format";
import { Avatar, Empty, Loading, PageHead, useAction, useUrlState } from "../ui";

const OUTCOME: { value: string; label: string; hint: string }[] = [
  { value: "confirmed", label: "Риск подтверждён", hint: "приняты меры, случай реальный" },
  { value: "needs_followup", label: "Требует наблюдения", hint: "решение отложено, не диагноз" },
  { value: "not_confirmed", label: "Не подтверждён", hint: "при разборе риска не оказалось" },
];

/** Сколько минут в человекочитаемом виде */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.round(hours / 24)} дн`;
}

/**
 * Разбор случаев риска.
 *
 * Единица работы — человек, а не сработавший пункт. До этого экран показывал
 * строку на каждый отмеченный пункт: на четырёхстах обследуемых получалось
 * 397 карточек, где один человек встречался пять раз подряд, и дежурный не
 * мог ни расставить приоритеты, ни найти нужного.
 *
 * Порядок разбора задан, а не оставлен на усмотрение: просроченные сверху,
 * дальше по времени последнего сигнала. Кто взял случай — видно всем, иначе
 * двое дежурных разбирают одного человека дважды.
 */
export default function Alerts() {
  const { user } = useAuth();
  const [all, setAll] = useUrlState("all");
  const [severity, setSeverity] = useUrlState("severity");
  const [unit, setUnit] = useUrlState("unit");
  const [assigned, setAssigned] = useUrlState("assigned");
  const [search, setSearch] = useUrlState("q");

  const [items, setItems] = useState<AlertCase[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useAction();

  const filters = { all, severity, unit, assigned, search };
  // ключ фильтров строкой: сравнивать объект в зависимостях эффекта бесполезно
  const filterKey = JSON.stringify(filters);

  const load = useCallback(
    async (more = false) => {
      setBusy(true);
      try {
        const page = await api.alertCases({
          ...filters,
          limit: "30",
          cursor: more ? (cursor ?? undefined) : undefined,
        });
        setItems((prev) => (more && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        if (!more) setTotal(page.total ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось загрузить");
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, cursor],
  );

  // поиск не дёргает сервер на каждую букву
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      setCursor(null);
      void load(false);
    }, search ? 300 : 0);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    api.alertCaseUnits().then(setUnits).catch(() => {});
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!items) return <Loading />;

  const mine = items.filter((c) => c.assignedTo === user?.id && !c.acknowledgedAt).length;
  const overdue = items.filter((c) => c.overdue).length;

  return (
    <>
      <PageHead
        title="Разбор случаев"
        sub={
          all === "1"
            ? "Все случаи, включая разобранные"
            : `Открытых: ${total ?? items.length}${overdue ? ` · просрочено ${overdue}` : ""}${mine ? ` · на мне ${mine}` : ""}`
        }
        actions={
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Фамилия"
            style={{ maxWidth: 200 }}
          />
        }
      />

      <div className="card filters">
        <Filter value={all} onChange={setAll} options={[["", "Открытые"], ["1", "Все"]]} />
        <Filter
          value={severity}
          onChange={setSeverity}
          options={[["", "Любая срочность"], ["severe", "Только тяжёлые"], ["moderate", "Умеренные"]]}
        />
        <Filter
          value={assigned}
          onChange={setAssigned}
          options={[["", "Все"], ["me", "На мне"], ["none", "Никем не взяты"]]}
        />
        <select
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          // без подписи диктор читает список как безымянный элемент
          aria-label="Подразделение"
          style={{ maxWidth: 200 }}
        >
          <option value="">Все подразделения</option>
          {units.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        <Empty
          title={all === "1" ? "Случаев нет" : "Открытых случаев нет"}
          hint="Случай заводится, когда обследуемый отмечает критический пункт"
        />
      ) : (
        items.map((c) => <CaseCard key={c.id} c={c} onChanged={() => { setCursor(null); void load(false); }} run={run} me={user?.id} />)
      )}

      {cursor ? (
        <button style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={() => void load(true)}>
          {busy ? "Загружаю…" : "Показать ещё"}
        </button>
      ) : items.length ? (
        <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
          Больше случаев нет
        </p>
      ) : null}
    </>
  );
}

function Filter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="tabs">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? "active" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function CaseCard({
  c,
  onChanged,
  run,
  me,
}: {
  c: AlertCase;
  onChanged: () => void;
  run: ReturnType<typeof useAction>;
  me: string | undefined;
}) {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const done = !!c.acknowledgedAt;
  const takenByOther = !!c.assignedTo && c.assignedTo !== me;

  return (
    <div className={`card case ${c.overdue ? "overdue" : ""} ${done ? "resolved" : ""}`}>
      <div className="case-head">
        <i className="sev-bar" style={{ background: severityColor[c.severity === "severe" ? "severe" : "moderate"] }} />
        <Avatar name={c.userName} size={30} />
        <div className="grow">
          <div className="row tight">
            <Link to={`/patients/${c.userId}/summary`}>
              <strong>{c.userName}</strong>
            </Link>
            {c.unit ? <span className="muted">· {c.unit}</span> : null}
          </div>
          <div className="hint" style={{ margin: 0 }}>
            {c.surveyTitle} · сигналов {c.signalCount} · открыт {duration(c.minutesOpen)} назад
          </div>
        </div>
        {c.overdue ? <span className="chip static bad">просрочен</span> : null}
        {done ? (
          <span className="chip static">{OUTCOME.find((o) => o.value === c.outcome)?.label ?? "разобран"}</span>
        ) : c.assignedTo ? (
          <span className="chip static">{takenByOther ? `у ${c.assignedToName}` : "на мне"}</span>
        ) : null}
      </div>

      <button className="ghost case-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Свернуть сигналы" : `Показать сигналы (${c.signalCount})`}
      </button>

      {expanded ? (
        <div className="signals">
          {c.signals.map((s) => (
            <div key={s.id} className="signal">
              <span className="muted">{dateTime(s.at)}</span>
              <span>{s.label}</span>
              <span className="muted">{s.questionTitle}</span>
            </div>
          ))}
          {c.signalCount > c.signals.length ? (
            <p className="hint">…и ещё {c.signalCount - c.signals.length}</p>
          ) : null}
        </div>
      ) : null}

      {done ? (
        <p className="hint" style={{ marginBottom: 0 }}>
          {c.acknowledgedByName}, {dateTime(c.acknowledgedAt)}
          {c.note ? ` · ${c.note}` : ""}
          {c.mergedFromLegacy ? " · случай собран автоматически при переходе на новую модель" : ""}
        </p>
      ) : (
        <>
          {takenByOther ? (
            <p className="hint">
              Случай взял {c.assignedToName}. Разбирать одного человека вдвоём не нужно.
            </p>
          ) : null}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Что предпринято"
          />
          <div className="row tight" style={{ marginTop: 8, flexWrap: "wrap" }}>
            {!c.assignedTo ? (
              <button onClick={() => run(async () => { await api.assignCase(c.id); onChanged(); }, "Случай взят")}>
                Взять на себя
              </button>
            ) : c.assignedTo === me ? (
              <button className="ghost" onClick={() => run(async () => { await api.assignCase(c.id, true); onChanged(); }, "Случай отпущен")}>
                Отпустить
              </button>
            ) : null}
            {OUTCOME.map((o, i) => (
              <button
                key={o.value}
                className={i === 0 ? "primary" : ""}
                title={o.hint}
                onClick={() => run(async () => { await api.resolveCase(c.id, o.value, note); onChanged(); }, "Случай разобран")}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
