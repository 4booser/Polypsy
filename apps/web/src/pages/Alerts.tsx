import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AlertCase, AlertSignal, AlertSignalBasis, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime, day, severityColor, severityKey } from "../format";
import { Avatar, Empty, HotkeyHint, Loading, Modal, useAction, useHotkeys, useUrlState } from "../ui";
import { Page } from "../ui/layout";
import { Button, Num, SectionLabel, SeverityTag, Tag } from "../ui/primitives";
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
          <Link to={`/patients/${userId}`}>
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
            <Link to={`/patients/${c.userId}`}>
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

      {expanded ? <CaseBasis caseId={c.id} preview={c.signals} total={c.signalCount} /> : null}

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

/**
 * Основание тревог случая.
 *
 * Раньше здесь стояли три поля из очереди: время, готовая подпись и
 * «заголовок» — который у половины строк был вовсе не заголовком пункта, а
 * названием шкалы. Разбирающий видел «Суицидальный риск» и не мог узнать
 * главного: человек это отметил или так посчиталось. Разница клиническая:
 * отмеченный вариант — прямое высказывание, полоса — вывод из суммы баллов.
 *
 * Поэтому оба вида подписаны прямо и показываются по-разному, а рядом стоит
 * ход к самому прохождению: ответы по пунктам — единственное, что закрывает
 * вопрос «на основании чего» окончательно.
 *
 * Грузится по раскрытию, а не вместе с очередью: очередь отдаёт тридцать
 * случаев, а основание читают у одного.
 */
function CaseBasis({
  caseId,
  preview,
  total,
}: {
  caseId: string;
  /** Что уже пришло со случаем: показывается, пока грузится основание */
  preview: AlertSignal[];
  total: number;
}) {
  const { ut } = useLang();
  const [openResponse, setOpenResponse] = useState<string | null>(null);
  const res = useResource(() => api.alertCaseSignals(caseId), [caseId]);
  const items = res.data;

  if (!items) {
    return (
      <div className="signals">
        {preview.map((s) => (
          <div key={s.id} className="signal">
            <span className="muted">{dateTime(s.at)}</span>
            <span>{s.label}</span>
            <span className="muted">{s.questionTitle}</span>
          </div>
        ))}
        {res.error ? <p className="hint">{ut("cases.loadBasisFailed")}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <SectionLabel>{ut("cases.basis")}</SectionLabel>
      {/*
        Пояснение стоит здесь, а не в документации: два вида сигнала —
        отмеченный вариант и полоса шкалы — разные по клиническому весу, и
        разбирающий должен знать это в момент чтения, а не когда-нибудь.
      */}
      <p className="m-0 max-w-[68ch] text-caption text-muted">{ut("cases.basisHint")}</p>
      {items.map((s) => (
        <SignalBasisRow key={s.id} s={s} onOpen={() => setOpenResponse(s.responseId)} />
      ))}
      {/*
        Число сигналов в шапке считается по доступным методикам, а список
        здесь — тоже. Расхождение возможно только если тревогу разобрали
        между двумя запросами, и тогда честнее сказать, сколько не показано,
        чем молча показать меньше.
      */}
      {total > items.length ? (
        <p className="hint">…{ut("ui.andMore")} {total - items.length}</p>
      ) : null}
      {openResponse ? (
        <ResponseModal id={openResponse} onClose={() => setOpenResponse(null)} />
      ) : null}
    </div>
  );
}

/** Одна строка основания: слева вид сигнала, справа — на чём он держится */
function SignalBasisRow({ s, onOpen }: { s: AlertSignalBasis; onOpen: () => void }) {
  const { ut } = useLang();
  const answered = s.pickedOptions.length > 0 || s.answeredNumber !== null;

  return (
    <div className="rounded-sm border border-hairline p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityTag level={s.severity}>{ut(severityKey[s.severity])}</SeverityTag>
        <Tag>{ut(s.kind === "option" ? "cases.kind.option" : "cases.kind.band")}</Tag>
        <span className="text-caption text-muted">{s.surveyTitle}</span>
        <span className="text-caption text-muted">{dateTime(s.at)}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={onOpen}>
          {ut("cases.openResponse")}
        </Button>
      </div>

      {s.kind === "option" ? (
        <div className="mt-1.5 text-small">
          <div>
            <span className="text-muted">{ut("cases.item")}</span>{" "}
            {s.questionNumber !== null ? <Num>{s.questionNumber}</Num> : null}
            {s.questionNumber !== null ? ". " : ""}
            {s.questionTitle}
          </div>
          {answered ? (
            <div>
              <span className="text-muted">{ut("cases.picked")}:</span>{" "}
              <strong>
                {s.pickedOptions.length ? s.pickedOptions.join(", ") : String(s.answeredNumber)}
              </strong>
            </div>
          ) : (
            /*
             * Ответа нет, а тревога есть: так бывает у сигнала, поднятого
             * автосохранением черновика, который потом переписали. Молчать
             * об этом нельзя — иначе пустая строка читается как «человек
             * ничего не отмечал», и сигнал выглядит ложным.
             */
            <p className="m-0 text-caption text-muted">{ut("cases.noAnswerStored")}</p>
          )}
        </div>
      ) : (
        <div className="mt-1.5 text-small">
          <div>
            <span className="text-muted">{ut("cases.scale")}:</span> {s.scaleTitle}
            {s.scaleCode ? <span className="text-muted"> · {s.scaleCode}</span> : null}
          </div>
          <div>
            {s.scaleValue !== null ? (
              <>
                <strong>
                  <Num>{s.scaleValue}</Num>
                </strong>{" "}
                {s.normalization ? ut(`norm.${s.normalization}`) : ""}
                {s.scaleRawScore !== null ? (
                  <span className="text-muted">
                    {" "}
                    · {ut("cases.rawScore")} <Num>{s.scaleRawScore}</Num>
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
          {s.bandLabel ? (
            <div>
              <span className="text-muted">{ut("cases.band")}:</span> <strong>{s.bandLabel}</strong>
              {/*
                Границы полосы — не украшение: без них значение нечитаемо.
                «2 стена» — это много или мало, зависит от того, где проходит
                полоса, и держать это в голове разбирающий не обязан.
              */}
              {s.bandMin !== null && s.bandMax !== null ? (
                <span className="text-muted">
                  {" "}
                  (<Num>{s.bandMin}</Num>–<Num>{s.bandMax}</Num>)
                </span>
              ) : null}
            </div>
          ) : null}
          {s.bandRecommendation ? (
            <p className="m-0 text-caption text-muted">{s.bandRecommendation}</p>
          ) : s.bandDescription ? (
            <p className="m-0 text-caption text-muted">{s.bandDescription}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Прохождение целиком: ответы по пунктам и баллы по шкалам.
 *
 * Открывается прямо из разбора, а не переходом на другой экран: уйдя из
 * очереди, дежурный теряет место в ней, а вернувшись — уже другой порядок.
 *
 * Варианты ответа приходят вместе с прохождением и той версии, которую
 * человек реально видел. Сопоставлять их с действующей версией методики
 * нельзя: после правки набор вариантов другой, и «что он ответил» получилось
 * бы не из того списка.
 */
function ResponseModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { ut } = useLang();
  const res = useResource(() => api.responseDetail(id), [id]);
  const data = res.data;

  return (
    <Modal title={ut("cases.responseTitle")} onClose={onClose} wide>
      {!data ? (
        <Loading rows={5} error={res.error} />
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <strong>{data.survey.title}</strong>
            <span className="text-muted"> · {dateTime(data.submittedAt ?? data.startedAt)}</span>
          </div>

          {data.scores.length ? (
            <div>
              <SectionLabel className="mb-2">{ut("cases.scoresTitle")}</SectionLabel>
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>{ut("cs.scaleTitle")}</th>
                      <th>{ut("cs.raw")}</th>
                      <th>{ut("cs.normalization")}</th>
                      <th>{ut("cs.bands")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.scores.map((sc) => (
                      <tr key={sc.scaleId}>
                        <td>{sc.scaleTitle}</td>
                        <td><Num>{sc.rawScore}</Num></td>
                        <td>
                          <Num>{sc.value}</Num> <span className="text-muted">{ut(`norm.${sc.normalization}`)}</span>
                        </td>
                        <td>
                          {sc.band ? (
                            <SeverityTag level={sc.band.severity}>{sc.band.label}</SeverityTag>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div>
            <SectionLabel className="mb-2">{ut("cases.answersTitle")}</SectionLabel>
            <ol className="m-0 flex flex-col gap-1.5 pl-6">
              {data.answers.map((a) => {
                const picked = new Set([
                  ...(a.optionIds ?? []),
                  ...Object.values(a.matrix ?? {}),
                ]);
                const chosen = a.options.filter((o) => picked.has(o.id));
                return (
                  <li key={a.questionId} className="text-small">
                    <div>{a.title}</div>
                    {!a.answered ? (
                      <span className="text-muted">{ut("cases.skipped")}</span>
                    ) : chosen.length ? (
                      <span>
                        {chosen.map((o, i) => (
                          <span key={o.id}>
                            {i ? ", " : ""}
                            <strong className={o.riskFlag ? "text-danger" : undefined}>{o.text}</strong>
                            {/*
                              Критический вариант помечается словом, а не
                              только цветом: цвет один не работает, и на
                              разборе риска это не тот случай, где можно
                              положиться на оттенок.
                            */}
                            {o.riskFlag ? (
                              <span className="text-caption text-danger"> · {ut("cases.criticalOption")}</span>
                            ) : null}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span>
                        {a.text ?? (a.number !== null ? String(a.number) : (a.date ?? "—"))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
}
