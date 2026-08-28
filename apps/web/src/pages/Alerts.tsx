import { useState } from "react";
import { Link } from "react-router-dom";
import type { AlertCase } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime, severityColor } from "../format";
import { Avatar, Empty, HotkeyHint, Loading, PageHead, useAction, useHotkeys, useUrlState } from "../ui";
import { useLang } from "../lang";
import { usePagedResource, useResource } from "../useResource";

const OUTCOME = [
  { value: "confirmed", key: "cases.confirmed" },
  { value: "needs_followup", key: "cases.needsFollowup" },
  { value: "not_confirmed", key: "cases.notConfirmed" },
] as const;

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

  /*
   * Какой случай «под рукой». Разбор идёт подряд, и держать указатель
   * дешевле, чем каждый раз тянуться мышью: j/k ведут по списку, цифры
   * ставят исход.
   */
  const [cursorIdx, setCursorIdx] = useState(0);
  const run = useAction();
  const { ut } = useLang();

  const filters = { all, severity, unit, assigned, search };
  // ключ фильтров строкой: сравнивать объект в зависимостях эффекта бесполезно
  const filterKey = JSON.stringify(filters);

  // 300 мс на набор текста: поиск не дёргает сервер на каждую букву
  const page = usePagedResource<AlertCase>(
    (cursor) => api.alertCases({ ...filters, limit: "30", cursor: cursor ?? undefined }),
    [filterKey],
    { debounceMs: 300 },
  );
  const { items, total, error } = page;

  const units = useResource(() => api.alertCaseUnits(), []).data ?? [];

  const open = (items ?? []).filter((c) => !c.acknowledgedAt);
  const current = open[Math.min(cursorIdx, open.length - 1)];

  const resolve = (outcome: string) => {
    if (!current) return;
    void run(async () => {
      await api.resolveCase(current.id, outcome, "");
      page.reload();
    }, ut("work.done"));
  };

  /*
   * Клавиши подобраны так, чтобы рука не уходила с домашнего ряда: j/k —
   * движение по списку (как в почтовых клиентах и терминалах, где это
   * привычно), цифры 1–3 — исход в том же порядке, что кнопки на экране.
   */
  useHotkeys({
    j: () => setCursorIdx((i) => Math.min(i + 1, Math.max(open.length - 1, 0))),
    k: () => setCursorIdx((i) => Math.max(i - 1, 0)),
    "1": () => resolve("confirmed"),
    "2": () => resolve("needs_followup"),
    "3": () => resolve("not_confirmed"),
    t: () => {
      if (!current || current.assignedTo) return;
      void run(async () => {
        await api.assignCase(current.id);
        page.reload();
      }, ut("cases.tookToast"));
    },
    "/": () => {
      const input = document.querySelector<HTMLInputElement>(".page-head input");
      input?.focus();
      input?.select();
    },
    Escape: () => (document.activeElement as HTMLElement | null)?.blur(),
  });

  if (!items) return <Loading error={error} />;

  const mine = items.filter((c) => c.assignedTo === user?.id && !c.acknowledgedAt).length;
  const overdue = items.filter((c) => c.overdue).length;

  return (
    <>
      <PageHead
        title={ut("cases.title")}
        sub={
          all === "1"
            ? ut("cases.allSub")
            : `${ut("cases.openCount")}: ${total ?? items.length}${overdue ? ` · ${ut("cases.overdue")} ${overdue}` : ""}${mine ? ` · ${ut("cases.mine")} ${mine}` : ""}`
        }
        actions={
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={ut("ui.surname")}
            style={{ maxWidth: 200 }}
          />
        }
      />

      <div className="card filters">
        <Filter value={all} onChange={setAll} options={[["", ut("cases.filterOpen")], ["1", ut("cases.filterAll")]]} />
        <Filter
          value={severity}
          onChange={setSeverity}
          options={[["", ut("cases.anySeverity")], ["severe", ut("cases.severeOnly")], ["moderate", ut("cases.moderate")]]}
        />
        <Filter
          value={assigned}
          onChange={setAssigned}
          options={[["", ut("cases.assignedAny")], ["me", ut("cases.assignedMe")], ["none", ut("cases.assignedNone")]]}
        />
        <select
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          // без подписи диктор читает список как безымянный элемент
          aria-label={ut("ui.unit")}
          style={{ maxWidth: 200 }}
        >
          <option value="">{ut("ui.unitAll")}</option>
          {units.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        <Empty
          title={all === "1" ? ut("cases.emptyAll") : ut("cases.emptyOpen")}
          hint={ut("cases.emptyHint")}
        />
      ) : (
        items.map((c) => (
          <CaseCard
            key={c.id}
            c={c}
            focused={c.id === current?.id}
            onChanged={page.reload}
            run={run}
            me={user?.id}
          />
        ))
      )}

      <HotkeyHint
        keys={[
          ["J / K", ut("hotkey.next")],
          ["1", ut("hotkey.confirm")],
          ["2", ut("hotkey.followup")],
          ["3", ut("hotkey.reject")],
          ["T", ut("hotkey.take")],
          ["/", ut("hotkey.search")],
        ]}
      />

      {page.hasMore ? (
        <button
          style={{ width: "100%", marginTop: 12 }}
          disabled={page.loadingMore}
          onClick={page.loadMore}
        >
          {page.loadingMore ? ut("ui.loading") : ut("ui.loadMore")}
        </button>
      ) : items.length ? (
        <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
          {ut("ui.endOfList")}
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
  focused,
  onChanged,
  run,
  me,
}: {
  c: AlertCase;
  /** Случай «под рукой»: на нём сработают цифры и T */
  focused: boolean;
  onChanged: () => void;
  run: ReturnType<typeof useAction>;
  me: string | undefined;
}) {
  const { ut } = useLang();
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const done = !!c.acknowledgedAt;
  const takenByOther = !!c.assignedTo && c.assignedTo !== me;

  return (
    <div
      // ref-колбэк обязан ничего не возвращать: React трактует возврат как функцию очистки
      ref={(el) => {
        if (focused) el?.scrollIntoView({ block: "nearest" });
      }}
      className={`card case ${c.overdue ? "overdue" : ""} ${done ? "resolved" : ""} ${focused ? "focused" : ""}`}
    >
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
            {c.surveyTitle} · {ut("cases.signals")} {c.signalCount} · {ut("cases.openedAgo")} {duration(c.minutesOpen)} {ut("cases.ago")}
          </div>
        </div>
        {c.overdue ? <span className="chip static bad">{ut("cases.overdue")}</span> : null}
        {done ? (
          <span className="chip static">
            {(() => {
              const found = OUTCOME.find((o) => o.value === c.outcome);
              return found ? ut(found.key) : ut("work.done");
            })()}
          </span>
        ) : c.assignedTo ? (
          <span className="chip static">
            {takenByOther ? `${ut("cases.taken")}: ${c.assignedToName}` : ut("cases.mine")}
          </span>
        ) : null}
      </div>

      <button className="ghost case-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? ut("cases.hideSignals") : `${ut("cases.showSignals")} (${c.signalCount})`}
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
          {c.mergedFromLegacy ? ` · ${ut("cases.mergedNote")}` : ""}
        </p>
      ) : (
        <>
          {takenByOther ? (
            <p className="hint">
              {ut("cases.takenByOther")}
            </p>
          ) : null}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={ut("cases.whatDone")}
          />
          <div className="row tight" style={{ marginTop: 8, flexWrap: "wrap" }}>
            {!c.assignedTo ? (
              <button onClick={() => run(async () => { await api.assignCase(c.id); onChanged(); }, ut("cases.tookToast"))}>
                {ut("cases.take")}
              </button>
            ) : c.assignedTo === me ? (
              <button className="ghost" onClick={() => run(async () => { await api.assignCase(c.id, true); onChanged(); }, ut("cases.released"))}>
                {ut("cases.release")}
              </button>
            ) : null}
            {OUTCOME.map((o, i) => (
              <button
                key={o.value}
                className={i === 0 ? "primary" : ""}
                onClick={() => run(async () => { await api.resolveCase(c.id, o.value, note); onChanged(); }, ut("cases.resolved"))}
              >
                {ut(o.key)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
