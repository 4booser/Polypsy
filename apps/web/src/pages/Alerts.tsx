import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AlertCase, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime, day, severityColor } from "../format";
import { Avatar, Empty, HotkeyHint, Loading, useAction, useHotkeys, useUrlState } from "../ui";
import { Page } from "../ui/layout";
import { useLang } from "../lang";
import { SavedViews } from "../ui/SavedViews";
import { onAppEvent } from "../events";
import { Hint } from "../components/Hint";
import { usePagedResource, useResource } from "../useResource";

const OUTCOME = [
  { value: "confirmed", key: "cases.confirmed" },
  { value: "needs_followup", key: "cases.needsFollowup" },
  { value: "not_confirmed", key: "cases.notConfirmed" },
] as const;

/**
 * Сколько минут в человекочитаемом виде.
 *
 * Переводчик аргументом: функция чистая и живёт вне компонента, а сокращения
 * единиц в двух языках разные — «мин» против «хв». В очереди случаев эта
 * подпись стоит у каждой строки, то есть была самым частым русским словом на
 * украинском экране.
 */
function duration(minutes: number, ut: (k: UiKey) => string): string {
  if (minutes < 60) return `${minutes} ${ut("dur.min")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${ut("dur.hour")}`;
  return `${Math.round(hours / 24)} ${ut("dur.day")}`;
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
   * Какой случай «под рукой» — по идентификатору, а не по номеру строки.
   * Указатель на позицию сползал: после «взять на себя» список перечитывался,
   * порядок менялся, и на экране оказывался уже другой человек — тот, кто
   * занял освободившееся место.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { run } = useAction();
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

  /*
   * Очередь обновляется по событию: новая тревога должна появиться у
   * дежурного сразу, а взятый коллегой случай — сразу пометиться, иначе
   * двое разбирают одного человека.
   */
  useEffect(() => onAppEvent((e) => {
    if (e.kind === "alert.created" || e.kind === "case.changed") page.reload();
  }), [page.reload]);

  const open = (items ?? []).filter((c) => !c.acknowledgedAt);
  // выбранный либо тот, что выбрали, либо первый в очереди
  const current = (items ?? []).find((c) => c.id === selectedId) ?? open[0];

  /** Сдвиг по очереди клавишами: считается от текущего, а не от позиции */
  const move = (delta: number) => {
    if (!open.length) return;
    const at = open.findIndex((c) => c.id === current?.id);
    const next = open[Math.min(Math.max((at < 0 ? 0 : at) + delta, 0), open.length - 1)];
    if (next) setSelectedId(next.id);
  };

  const resolve = (outcome: string) => {
    if (!current) return;
    void run(async () => {
      await api.resolveCase(current.id, outcome, "");
      // разобранный уходит из очереди: следующий сам станет выбранным
      setSelectedId(null);
      page.reload();
    }, ut("work.done"));
  };

  /*
   * Клавиши подобраны так, чтобы рука не уходила с домашнего ряда: j/k —
   * движение по списку (как в почтовых клиентах и терминалах, где это
   * привычно), цифры 1–3 — исход в том же порядке, что кнопки на экране.
   */
  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
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
      const input = document.querySelector<HTMLInputElement>(".triage-filters input");
      input?.focus();
      input?.select();
    },
    Escape: () => (document.activeElement as HTMLElement | null)?.blur(),
  });

  if (!items) return <Loading error={error} />;

  const mine = items.filter((c) => c.assignedTo === user?.id && !c.acknowledgedAt).length;
  const overdue = items.filter((c) => c.overdue).length;
  const selected = current ?? items[0] ?? null;

  return (
    /* заголовок остаётся: без него экран теряет ориентацию, а диктор — точку входа */
    <Page
      bleed
      title={ut("cases.title")}
      count={all === "1" ? null : (total ?? items.length)}
      sub={
        all === "1"
          ? ut("cases.allSub")
          : `${ut("cases.openCount")}${overdue ? ` · ${ut("cases.overdue")} ${overdue}` : ""}${mine ? ` · ${ut("cases.mine")} ${mine}` : ""}`
      }
    >
    <div className="triage">
      {/* ── панель 1: очередь ── */}
      <aside className="triage-queue">
        <div className="triage-filters">
          <SavedViews scope="alerts" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={ut("ui.surname")}
          />
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
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label={ut("ui.unit")}>
            <option value="">{ut("ui.unitAll")}</option>
            {units.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>

        <div className="triage-list">
          {items.length === 0 ? (
            <Empty
              title={all === "1" ? ut("cases.emptyAll") : ut("cases.emptyOpen")}
              hint={ut("cases.emptyHint")}
            />
          ) : (
            items.map((c) => (
              <QueueRow
                key={c.id}
                c={c}
                active={c.id === selected?.id}
                me={user?.id}
                onPick={() => setSelectedId(c.id)}
              />
            ))
          )}
          {page.hasMore ? (
            <button className="load-more" disabled={page.loadingMore} onClick={page.loadMore}>
              {page.loadingMore ? ut("ui.loading") : ut("ui.loadMore")}
            </button>
          ) : items.length ? (
            <p className="end-of-list">{ut("ui.endOfList")}</p>
          ) : null}
        </div>
      </aside>

      {/* ── панель 2: сам случай ── */}
      <section className="triage-case">
        {selected ? (
          <CaseCard c={selected} focused onChanged={page.reload} run={run} me={user?.id} />
        ) : (
          <Empty title={ut("cases.emptyOpen")} hint={ut("cases.emptyHint")} />
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
      </section>

      {/* ── панель 3: контекст человека ── */}
      <aside className="triage-context">
        {selected ? <PatientContext userId={selected.userId} /> : null}
      </aside>
    </div>
    </Page>
  );
}

/**
 * Строка очереди.
 *
 * Всё, что нужно для выбора следующего: тяжесть полосой слева, кто держит
 * случай, сколько сигналов и сколько он ждёт. Разбор идёт подряд, и строка
 * не должна требовать чтения — только взгляда.
 */
function QueueRow({
  c,
  active,
  me,
  onPick,
}: {
  c: AlertCase;
  active: boolean;
  me: string | undefined;
  onPick: () => void;
}) {
  const { ut } = useLang();
  return (
    <button
      type="button"
      className={`queue-row${active ? " active" : ""}${c.overdue ? " overdue" : ""}${c.acknowledgedAt ? " done" : ""}`}
      onClick={onPick}
      aria-current={active}
    >
      <i
        className="queue-sev"
        style={{ background: severityColor[c.severity === "severe" ? "severe" : "moderate"] }}
      />
      <span className="queue-main">
        <span className="queue-name">{c.userName}</span>
        <span className="queue-meta">
          {c.unit ? `${c.unit} · ` : ""}
          {c.surveyTitle}
        </span>
      </span>
      <span className="queue-right">
        <span className="queue-since">{duration(c.minutesOpen, ut)}</span>
        {c.signalCount > 1 ? <span className="queue-signals">{c.signalCount}</span> : null}
        {c.assignedTo ? (
          <span className="queue-who" title={c.assignedToName ?? ""}>
            {c.assignedTo === me ? ut("cases.mine") : (c.assignedToName ?? "").slice(0, 1)}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Контекст пациента рядом со случаем.
 *
 * Раньше, чтобы понять, кого разбираешь, нужно было уйти на карту и потерять
 * место в очереди. Здесь то же самое стоит рядом: последние баллы, открытые
 * тревоги, направления и подписанные заключения.
 */
function PatientContext({ userId }: { userId: string }) {
  const { ut } = useLang();
  const res = useResource(() => api.caseSummary(userId), [userId]);
  const data = res.data;

  if (!data) return <Loading rows={4} error={res.error} />;

  return (
    <>
      <div className="ctx-head">
        <Avatar name={data.fullName} size={30} />
        <div className="grow">
          <Link to={`/patients/${userId}/summary`}>
            <strong>{data.fullName}</strong>
          </Link>
          <div className="hint" style={{ margin: 0 }}>
            {[data.unit, data.age ? `${data.age}` : null].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>

      {data.surveys.map((sv) => (
        <div key={sv.surveyId} className="ctx-block">
          <h3>{sv.title}</h3>
          {sv.scales.slice(0, 6).map((sc) => (
            <div key={sc.code} className="ctx-scale">
              <span className="grow">{sc.title}</span>
              <span className="ctx-value">{sc.lastValue}</span>
              {sc.severity ? (
                <i className="ctx-dot" style={{ background: severityColor[sc.severity] }} />
              ) : null}
            </div>
          ))}
        </div>
      ))}

      {data.referrals.length ? (
        <div className="ctx-block">
          <h3>{ut("nav.referrals")}</h3>
          {data.referrals.slice(0, 3).map((r) => (
            <div key={r.id} className="ctx-scale">
              <span className="grow">{r.destination}</span>
              <span className="muted">{day(r.createdAt)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {data.conclusions.length ? (
        <div className="ctx-block">
          <h3>{ut("an.conclusion")}</h3>
          <p className="hint" style={{ margin: 0 }}>
            {data.conclusions[0]!.text.slice(0, 180)}
            {data.conclusions[0]!.text.length > 180 ? "…" : ""}
          </p>
        </div>
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
    <div className="segmented" role="group">
      {options.map(([v, label]) => (
        <button
          key={v}
          className={value === v ? "active" : ""}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
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
  run: ReturnType<typeof useAction>["run"];
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
            {c.surveyTitle} · {ut("cases.signals")} {c.signalCount} · {ut("cases.openedAgo")} {duration(c.minutesOpen, ut)} {ut("cases.ago")}
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
            <p className="hint">…{ut("ui.andMore")} {c.signalCount - c.signals.length}</p>
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
            {/*
              Исходы разбора называются коротко, и «без исхода» читается как
              «ничего не сделал». Объяснение стоит рядом с кнопками, а не в
              документации, которую в разборе не открывают.
            */}
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
          <Hint id="case-status" text="hint.caseStatus" />
        </>
      )}
    </div>
  );
}
