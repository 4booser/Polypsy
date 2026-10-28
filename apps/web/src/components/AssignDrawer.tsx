import { useMemo, useRef, useState, type ReactNode } from "react";
import { t, type SurveyListItem, type UiKey } from "@quizzy/shared";
import { api, type Patient } from "../api";
import { useAuth } from "../auth";
import { basisText, openSuggestions } from "../pages/methods/passport";
import { decideHit } from "./Suggestions";
import { useLang } from "../lang";
import { Mi } from "../pages/methods/icons";
import { shortDate, splitCode } from "../pages/methods/model";
import { useCount } from "../pages/methods/useCount";
import { Pi } from "../pages/patientGroups/icons";
import { surveyCode } from "../pages/patientGroups/model";
import { Avatar, Loading, useAction, useToast } from "../ui";
import { cx } from "../ui/cx";
import { Drawer, DrawerSection } from "../ui/Drawer";
import { SearchField } from "../ui/filters";
import { Ic } from "../ui/icons";
import { submitOnCtrlEnter } from "../ui/keys";
import { Button, ButtonLink, Field, Input, Radio, Segmented, Select, Tag } from "../ui/primitives";
import { Callout } from "../ui/states";
import { useResource } from "../useResource";
import { dueIn, pastDeadline, today } from "./deadline";
import { usePatientSearch } from "./PatientPicker";

/*
 * «Призначити» в ящике — один на консоль (волна 27, perf-bundle).
 *
 * Было два ящика с одним каркасом: у методик и наборов (methods-assign-
 * dialog) — кому назначить, когда методика уже выбрана; у групп пациентов —
 * какой тест назначить, когда адресаты уже известны. Каркас у них общий —
 * ящик, срок с быстрыми кнопками и проверкой прошедшей даты, Ctrl+Enter,
 * подвал, — а различается то, что выбирают:
 *
 *  - choose="recipients" — людей поимённо (поиск на сервере по набранному,
 *    фишки выбранных, предупреждение о прежнем назначении, отказы поимённо)
 *    или группу пациентов; плюс комментарий для пациента. Экран передаёт,
 *    что уходит на сервер (выдача методики, routes/access.ts, или
 *    назначение набора, routes/batteries.ts);
 *  - choose="test" — методику из каталога (поиск по названию и коду, пометка
 *    «вже призначено»), адресатов экран называет сам и сам назначает.
 *
 * Тексты срока и его умолчание у видов свои, и это не разнобой: «Пройти до»
 * у методики — к какому дню пройти, по умолчанию неделя; «Діє до» у теста
 * группе — до какого дня открыт доступ, и по умолчанию он без срока.
 * Поменять умолчание значило бы молча закрыть пациентам доступ через неделю.
 *
 * Строк из макета, которых в системе нет, здесь нет: повтора по расписанию у
 * ручного назначения не бывает (повторы — у правил и расписаний), каналы
 * уведомления сервер выбирает сам.
 */

/** Чем уже владеет человек — чтобы сказать, что новое назначение сделает с прежним */
export interface ExistingAssignment {
  /** Срок прежнего; null — без срока */
  until: string | null;
  /** Уже прошёл */
  done?: boolean;
}

/**
 * Назначить каждому по очереди: отказ одному (уже назначено, чужой пациент)
 * не отменяет остальных.
 *
 * Не прошедшие возвращаются людьми, а не именами. Прежде ящик оставлял в
 * выборе тех, чьё ФИО совпало с ФИО не прошедшего, — и тёзка, которому уже
 * назначили, оставался в выборе и получал назначение второй раз при повторе.
 * Причина отказа (текст сервера) — рядом, по id: ящик печатает её при имени,
 * а при назначении отмеченных методик она называет, какие не прошли.
 */
export async function assignEach<P extends { id: string }>(
  people: readonly P[],
  assignOne: (userId: string) => Promise<unknown>,
): Promise<{ done: number; failed: P[]; reasons: Map<string, string> }> {
  const failed: P[] = [];
  const reasons = new Map<string, string>();
  let done = 0;
  for (const p of people) {
    try {
      await assignOne(p.id);
      done += 1;
    } catch (e) {
      failed.push(p);
      if (e instanceof Error && e.message) reasons.set(p.id, e.message);
    }
  }
  return { done, failed, reasons };
}

/* ─────────── срок ─────────── */

/** Срок вида назначения: подписи, быстрые кнопки (календарные дни от сегодня; null — без срока) и умолчание */
interface DueSetup {
  title: UiKey;
  field: UiKey;
  quick: readonly { days: number | null; key: UiKey }[];
  initial: number | null;
}

/** Методика и набор: к какому дню пройти — по умолчанию неделя */
const DUE_RECIPIENTS: DueSetup = {
  title: "mc.dueTitle",
  field: "mc.dueField",
  quick: [
    { days: 3, key: "mc.due3" },
    { days: 7, key: "mc.dueWeek" },
    { days: 14, key: "mc.due2Weeks" },
    { days: null, key: "mc.dueNone" },
  ],
  initial: 7,
};

/** Тест группе или выбранным: до какого дня открыт доступ — по умолчанию без срока */
const DUE_TEST: DueSetup = {
  title: "pg2.deadline",
  field: "pg2.deadlineDate",
  quick: [
    { days: 7, key: "pg2.inDays" },
    { days: 14, key: "pg2.inDays" },
    { days: 30, key: "pg2.inDays" },
    { days: null, key: "pg2.noDeadline" },
  ],
  initial: null,
};

const dueValue = (days: number | null) => (days === null ? "" : dueIn(days));

/** Срок: поле даты, под ним быстрые сроки; прошедшая дата не отправляется (components/deadline.ts) */
function DueSection({
  setup,
  value,
  onChange,
  children,
}: {
  setup: DueSetup;
  value: string;
  onChange: (v: string) => void;
  children?: ReactNode;
}) {
  const { ut } = useLang();
  return (
    <DrawerSection title={ut(setup.title)}>
      <Field label={ut(setup.field)} error={pastDeadline(value, today()) ? ut("uit.form.pastDeadline") : null}>
        <Input type="date" value={value} min={today()} onChange={(e) => onChange(e.target.value)} icon={<Mi.calendar />} />
      </Field>
      <div role="group" aria-label={ut("mc.dueQuick")} className="-mt-1 mb-3.5 flex flex-wrap gap-1.5">
        {setup.quick.map((q) => {
          const v = dueValue(q.days);
          const on = value === v;
          return (
            <button
              key={q.days ?? "none"}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(v)}
              className={cx(
                "h-7 min-h-0 cursor-pointer rounded-[14px] border-0 px-[11px] text-caption font-bold",
                on ? "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk text-text-2 hover:bg-sunk-2",
              )}
            >
              {ut(q.key).replace("{n}", String(q.days))}
            </button>
          );
        })}
      </div>
      {children}
    </DrawerSection>
  );
}

/* ─────────── ящик ─────────── */

/** То, что задаёт экран, чем бы ни был ящик */
interface Frame {
  open: boolean;
  onClose: () => void;
  onReturn: () => void;
}

/** Кому — выбирают в ящике; что назначить, известно заранее (методика, набор) */
export interface ToRecipients extends Frame {
  choose: "recipients";
  title: string;
  sub?: string;
  /** Строка над кнопками: «9 пунктів, пацієнт побачить методику одразу» */
  note?: string;
  /** Родительный падеж для «Чернетку … збережено» */
  draftName: string;
  /** userId → прежнее назначение (если есть) */
  existing?: ReadonlyMap<string, ExistingAssignment>;
  /**
   * Прежнее назначение не заменяется, а запрещает новое (набор: одно
   * открытое на человека, routes/batteries.ts): такого человека не
   * предлагать, а сказать, почему.
   */
  exclusive?: boolean;
  /** Назначить одному человеку; срок — «ГГГГ-ММ-ДД» или null */
  assignOne: (userId: string, due: string | null, note: string | null) => Promise<unknown>;
  /** Назначить группе пациентов; без него — только поимённо */
  assignGroup?: (groupId: string, due: string | null, note: string | null) => Promise<{ recipients: number }>;
  /** С чего начинает ящик: «Призначити групі» в меню конструктора открывает его на группе */
  initialMode?: "people" | "group";
  onAssigned: () => void;
}

/** Что назначить — выбирают в ящике (тест из каталога); кому, известно заранее (группа, выбранные люди) */
export interface TestToKnown extends Frame {
  choose: "test";
  /** Кому: «Група «Вечірня», 7 учасників» или «Вибрано: 3» */
  who: string;
  /** Что получат адресаты — строка над кнопкой */
  whoNote: string;
  /** Уже назначенные этим адресатам методики — пометка в списке */
  already?: ReadonlySet<string>;
  /**
   * Адресат один, и всех его назначений экран заранее не знает (карточка
   * пациента): прежнее назначение выбранной методики спрашивается, когда её
   * выбрали, и ящик говорит «вже призначено до …» до того, как нажали
   * «Призначити». Пройденное прежнее — не помеха: новое — это новый замер.
   */
  existingFor?: (surveyId: string) => Promise<ExistingAssignment | null>;
  /** Поле «Коментар для пацієнта»; без него поля нет, и комментарий — null */
  comment?: boolean;
  /** Назначить; возвращает строку итога для сообщения */
  onAssign: (surveyId: string, expiresAt: string | null, note: string | null) => Promise<string>;
  /**
   * Можно назначить и набор: над списком — «Методика / Набір». Срок у набора
   * свой — к какому дню пройти, по умолчанию неделя (как у ящика набора), —
   * а не «діє до» доступа. Назначает экран (routes/batteries.ts).
   */
  sets?: { onAssign: (batteryId: string, dueAt: string | null, note: string | null) => Promise<string> };
  /**
   * Человек, которому назначают (карточка пациента): над списком — что ему
   * предложили правила, «Рекомендовано: PHQ-9 — PHQ-2 = 4 від 12.10»
   * (ступенчатый скрининг каталога), и назначение одним нажатием — с тем же
   * сроком и комментарием, что выбраны ниже. Предложение при этом принимается:
   * специалист сделал то, что правило предложило. Без поля — ящик как был.
   */
  recommendFor?: string;
}

export function AssignDrawer(props: ToRecipients | TestToKnown) {
  return props.choose === "test" ? <AssignTest {...props} /> : <AssignRecipients {...props} />;
}

/** Ящик назначения: каркас, общий для обоих видов; Ctrl/Cmd+Enter — то же, что кнопка */
function AssignFrame({
  frame,
  title,
  sub,
  icon,
  note,
  noteIcon,
  dirty,
  draftName,
  kbd,
  submit,
  submitLabel,
  canSubmit,
  busy,
  children,
}: {
  frame: Frame;
  title: string;
  sub?: string;
  icon: ReactNode;
  note?: string;
  noteIcon: ReactNode;
  dirty: boolean;
  draftName: string;
  kbd?: string;
  submit: () => void;
  submitLabel: string;
  /** Выбрано всё, что нужно, и срок не в прошлом */
  canSubmit: boolean;
  /** Назначение в пути: второе не начинается */
  busy: boolean;
  children: ReactNode;
}) {
  const { ut } = useLang();
  const go = () => {
    if (canSubmit && !busy) submit();
  };
  return (
    <Drawer
      open={frame.open}
      onClose={frame.onClose}
      onReturn={frame.onReturn}
      title={title}
      sub={sub}
      icon={icon}
      dirty={dirty}
      draftName={draftName}
      kbd={kbd}
      note={note}
      noteIcon={noteIcon}
      footer={
        <>
          <Button variant="primary" icon={<Mi.send />} disabled={!canSubmit || busy} onClick={go}>
            {submitLabel}
          </Button>
          <Button variant="secondary" onClick={frame.onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
    >
      <div onKeyDown={(e) => submitOnCtrlEnter(e, go)}>{children}</div>
    </Drawer>
  );
}

/* ─────────── кому: люди поимённо или группа ─────────── */

function AssignRecipients(p: ToRecipients) {
  const { onClose, existing, exclusive, assignOne, assignGroup, initialMode = "people", onAssigned } = p;
  const { ut } = useLang();
  const { run, busy } = useAction();
  const toast = useToast();
  const [mode, setMode] = useState<"people" | "group">(assignGroup ? initialMode : "people");
  const [picked, setPicked] = useState<Patient[]>([]);
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState("");
  const [due, setDue] = useState(() => dueValue(DUE_RECIPIENTS.initial));
  const [comment, setComment] = useState("");
  const [failed, setFailed] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const found = usePatientSearch(query, { onlyTyped: true });
  const groups = useResource(() => api.patientGroups(), [], { enabled: !!assignGroup && mode === "group" });
  const choices = useMemo(
    () => (found.data?.items ?? []).filter((x) => !picked.some((y) => y.id === x.id)).slice(0, 8),
    [found.data, picked],
  );
  const conflicts = exclusive ? [] : picked.filter((x) => existing?.get(x.id) && !existing.get(x.id)!.done);
  const busyOne = (id: string) => !!exclusive && !!existing?.get(id) && !existing.get(id)!.done;
  const addable = choices.filter((x) => !busyOne(x.id));
  const dirty = picked.length > 0 || comment.trim() !== "" || groupId !== "";
  const ready = !pastDeadline(due, today()) && (mode === "people" ? picked.length > 0 : groupId !== "");

  const reset = () => {
    setPicked([]);
    setQuery("");
    setGroupId("");
    setComment("");
    setFailed([]);
    setDue(dueValue(DUE_RECIPIENTS.initial));
  };

  const submit = async () => {
    const dueOrNull = due || null;
    const noteValue = comment.trim() || null;
    if (mode === "group") {
      let recipients = 0;
      const ok = await run(async () => {
        recipients = (await assignGroup!(groupId, dueOrNull, noteValue)).recipients;
      });
      if (ok) {
        toast(ut("mc.assignedGroup").replace("{n}", String(recipients)), "ok");
        onAssigned();
        reset();
        onClose();
      }
      return;
    }
    /* поимённо — по одному (assignEach): отказ одному не отменяет остальных */
    let outcome: { done: number; failed: Patient[]; reasons: Map<string, string> } = { done: 0, failed: [], reasons: new Map() };
    await run(async () => {
      outcome = await assignEach(picked, (userId) => assignOne(userId, dueOrNull, noteValue));
      if (!outcome.done && outcome.failed.length) throw new Error(ut("mc.assignFailedAll"));
    });
    const { done, failed: missed, reasons } = outcome;
    if (done) {
      toast(ut("mc.assignedN").replace("{n}", String(done)), "ok");
      onAssigned();
    }
    if (missed.length) {
      const left = new Set(missed.map((x) => x.id));
      setPicked((prev) => prev.filter((x) => left.has(x.id)));
      setFailed(missed.map((x) => (reasons.has(x.id) ? `${x.fullName} (${reasons.get(x.id)})` : x.fullName)));
    } else if (done) {
      reset();
      onClose();
    }
  };

  const submitLabel =
    mode === "group" ? ut("mc.assignGroupBtn") : picked.length > 1 ? ut("mc.assignN").replace("{n}", String(picked.length)) : ut("acc.grant");

  return (
    <AssignFrame
      frame={p}
      title={p.title}
      sub={p.sub}
      icon={<Mi.clipboardPlus />}
      note={p.note}
      noteIcon={<Ic.timer />}
      dirty={dirty}
      draftName={p.draftName}
      kbd="A"
      submit={() => void submit()}
      submitLabel={submitLabel}
      canSubmit={ready}
      busy={busy}
    >
      <DrawerSection>
        {assignGroup ? (
          <Segmented
            wide
            label={ut("mc.assignWhom")}
            value={mode}
            onChange={setMode}
            items={[
              { key: "people", label: ut("mc.assignPeople") },
              { key: "group", label: ut("mc.assignGroup") },
            ]}
          />
        ) : null}
        <p className={cx("m-0 text-small text-muted", assignGroup && "mt-2.5")}>
          {mode === "people" ? ut("mc.assignEachHint") : ut("mc.assignGroupHint")}
        </p>

        {mode === "people" ? (
          <div className="mt-3">
            <span className="mb-1.5 block text-caption font-bold text-muted">{ut("mc.assignTo")}</span>
            <div
              className={cx(
                "flex min-h-11 flex-wrap items-center gap-1.5 rounded-control border border-field-border bg-panel px-2 py-1.5",
                "focus-within:border-violet-ring focus-within:shadow-[0_0_0_3px_var(--vtint)]",
              )}
              onClick={() => searchRef.current?.focus()}
            >
              {picked.map((x) => (
                <span
                  key={x.id}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-[15px] bg-violet-tint pl-[3px] pr-1 text-[12.5px] font-bold text-violet-ink"
                >
                  <Avatar name={x.fullName} size={24} />
                  {x.fullName}
                  <button
                    type="button"
                    aria-label={ut("mc.unpick").replace("{name}", x.fullName)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPicked((prev) => prev.filter((y) => y.id !== x.id));
                    }}
                    className="inline-grid size-[22px] min-h-0 cursor-pointer place-items-center rounded-[11px] border-0 bg-transparent p-0 text-violet-ink hover:bg-violet-tint-2"
                  >
                    <Ic.x size={13} />
                  </button>
                </span>
              ))}
              <input
                ref={searchRef}
                type="search"
                data-autofocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={ut("ui.findRespondent")}
                aria-label={ut("ui.findRespondent")}
                autoComplete="off"
                maxLength={120}
                className="h-[30px] min-w-[120px] flex-1 border-0 bg-transparent px-1 text-body font-medium text-text outline-none placeholder:text-muted"
              />
            </div>
            {query.trim() ? (
              found.error ? (
                <p className="m-0 mt-2 text-caption text-risk-ink">{found.error}</p>
              ) : !found.data ? (
                <p className="m-0 mt-2 text-caption text-muted">{ut("common.loading")}</p>
              ) : choices.length ? (
                <ul className="m-0 mt-1.5 list-none rounded-control border border-border bg-panel p-1 shadow-pop">
                  {/* всех показанных разом: поиск по подразделу или фамилии иначе разбирался по одному */}
                  {addable.length > 1 ? (
                    <li className="border-b border-divider pb-1">
                      <button
                        type="button"
                        onClick={() => {
                          setPicked((prev) => [...prev, ...addable]);
                          setQuery("");
                          searchRef.current?.focus();
                        }}
                        className="flex w-full min-h-0 cursor-pointer items-center justify-start gap-2.5 rounded-[8px] border-0 bg-transparent px-2.5 py-1.5 text-left text-body font-bold text-violet-ink hover:bg-sunk"
                      >
                        <Ic.users size={16} />
                        {ut("mc.addAllFound").replace("{n}", String(addable.length))}
                      </button>
                    </li>
                  ) : null}
                  {choices.map((x) => {
                    const had = existing?.get(x.id);
                    return (
                      <li key={x.id}>
                        <button
                          type="button"
                          disabled={busyOne(x.id)}
                          onClick={() => {
                            setPicked((prev) => [...prev, x]);
                            setQuery("");
                            searchRef.current?.focus();
                          }}
                          className="flex w-full min-h-0 cursor-pointer items-center justify-start gap-2.5 rounded-[8px] border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                        >
                          <Avatar name={x.fullName} size={28} />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-body font-bold text-text">{x.fullName}</span>
                            <small className="truncate text-caption text-muted">
                              {had
                                ? had.done
                                  ? ut("mc.alreadyPassed")
                                  : had.until
                                    ? ut("mc.alreadyUntil").replace("{date}", shortDate(had.until))
                                    : ut("mc.alreadyForever")
                                : (x.unit ?? x.email)}
                            </small>
                          </span>
                          {busyOne(x.id) ? null : <Ic.plus size={15} className="ml-auto text-violet-ink" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="m-0 mt-2 text-caption text-muted">{ut("pt.nobodyFound")}</p>
              )
            ) : null}
            {found.data?.truncated && query.trim() ? <p className="m-0 mt-1.5 text-caption text-muted">{ut("pg.truncated")}</p> : null}
            {conflicts.length ? (
              <div className="mt-3">
                <Callout kind="warn" icon={<Mi.repeat />}>
                  {conflicts
                    .map((x) => {
                      const was = existing!.get(x.id)!;
                      return was.until
                        ? ut("mc.conflictUntil").replace("{name}", x.fullName).replace("{date}", shortDate(was.until))
                        : ut("mc.conflictForever").replace("{name}", x.fullName);
                    })
                    .join(" ")}{" "}
                  {ut("mc.conflictTail")}
                </Callout>
              </div>
            ) : null}
            {failed.length ? (
              <div className="mt-3">
                <Callout kind="warn" icon={<Ic.circleAlert />}>
                  {ut("mc.assignFailedSome").replace("{names}", failed.join(", "))}
                </Callout>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-3">
            <Field label={ut("ant.group")}>
              <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={!groups.data}>
                <option value="">{groups.data ? ut("sel.pick") : ut("common.loading")}</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title} ({g.memberCount})
                  </option>
                ))}
              </Select>
            </Field>
            {groups.error ? <p className="m-0 text-caption text-risk-ink">{groups.error}</p> : null}
            {groups.data && !groups.data.length ? <p className="m-0 text-caption text-muted">{ut("mc.noPatientGroups")}</p> : null}
          </div>
        )}
      </DrawerSection>

      <DueSection setup={DUE_RECIPIENTS} value={due} onChange={setDue}>
        <Field label={ut("mc.commentForPatient")} optional>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={ut("acc.commentExample")} maxLength={500} />
        </Field>
      </DueSection>
    </AssignFrame>
  );
}

/* ─────────── что назначить: тест из каталога ─────────── */

/**
 * Методика выбирается из списка с поиском, а не селектом: у отделения их
 * десятки, и код в начале строки («PHQ-9») ищется глазами быстрее, чем
 * прокручивается выпадающий список. Уже назначенные помечены — повтор не
 * запрещён (это новый замер с новым сроком), но о нём надо знать.
 *
 * В списке — только опубликованные и не снятые: черновик назначить нельзя,
 * сервер откажет, и предлагать его значило бы обещать отказ.
 */
function AssignTest(p: TestToKnown) {
  const { open, already, onAssign, onClose, sets, existingFor, recommendFor } = p;
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const toast = useToast();
  const count = useCount();
  /*
   * Предложения правил этому человеку, ждущие решения (право на них — то же,
   * что на очередь предложений: alerts.review). Одна строка на методику —
   * по свежему срабатыванию; назначенное и пройденное не предлагается.
   */
  const hits = useResource(() => api.ruleHits("suggested", recommendFor), [recommendFor], {
    enabled: open && !!recommendFor && can("alerts.review"),
    keep: false,
  });
  const recommended = useMemo(() => openSuggestions(hits.data ?? []), [hits.data]);
  /* «Методика / Набір» — только когда экран умеет назначить набор */
  const [what, setWhat] = useState<"survey" | "set">("survey");
  const setMode = !!sets && what === "set";
  const due = setMode ? DUE_RECIPIENTS : DUE_TEST;
  const surveys = useResource(() => api.surveys(), [], { enabled: open && !setMode });
  const batteries = useResource(() => api.batteries(), [], { enabled: open && setMode });
  const [q, setQ] = useState("");
  const [surveyId, setSurveyId] = useState("");
  const [batteryId, setBatteryId] = useState("");
  const [expires, setExpires] = useState(() => dueValue(DUE_TEST.initial));
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usable = useMemo(
    () =>
      (surveys.data ?? [])
        .filter((s: SurveyListItem) => s.status === "published" && !s.archivedAt)
        .sort((a, b) => t(a.title, lang).localeCompare(t(b.title, lang))),
    [surveys.data, lang],
  );
  /* набор без методик сервер не назначит (err.batteryEmpty), снятый — тоже: их не предлагаем */
  const usableSets = useMemo(
    () => (batteries.data ?? []).filter((b) => !b.archived && b.items.length > 0).sort((a, b) => a.title.localeCompare(b.title)),
    [batteries.data],
  );
  const needle = q.trim().toLowerCase();
  const shown = needle ? usable.filter((s) => t(s.title, lang).toLowerCase().includes(needle)) : usable;
  const shownSets = needle ? usableSets.filter((b) => b.title.toLowerCase().includes(needle)) : usableSets;
  const picked = setMode ? batteryId : surveyId;
  const existing = useResource(() => (existingFor && surveyId ? existingFor(surveyId) : Promise.resolve(null)), [surveyId], {
    enabled: !!existingFor && !!surveyId && !setMode,
    keep: false,
  });
  const prior = !setMode && existing.data && !existing.data.done ? existing.data : null;
  const dirty = surveyId !== "" || batteryId !== "" || comment.trim() !== "" || expires !== dueValue(due.initial);

  /* срок у методики и у набора значит разное: при смене вида — умолчание вида, а не прежнее число */
  const switchTo = (next: "survey" | "set") => {
    setWhat(next);
    setQ("");
    setError(null);
    setExpires(dueValue((next === "set" ? DUE_RECIPIENTS : DUE_TEST).initial));
  };

  /*
   * Назначенная методика, которую предлагало правило, — предложение принято:
   * специалист сделал ровно то, что оно предложило, и в очереди оно больше не
   * висит. Отказ решения (его успел принять другой) назначение не отменяет.
   */
  async function acceptRecommended(assigned: string) {
    for (const r of recommended.filter((x) => x.target.surveyId === assigned)) {
      await decideHit(() => api.decideHit(r.hit.id, "accepted"), () => undefined).catch(() => undefined);
    }
  }

  async function assign(target?: string) {
    const survey = target ?? surveyId;
    if ((!target && !picked) || pastDeadline(expires, today()) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const note = p.comment ? comment.trim() || null : null;
      const done =
        setMode && !target ? await sets!.onAssign(batteryId, expires || null, note) : await onAssign(survey, expires || null, note);
      if (!setMode || target) await acceptRecommended(survey);
      toast(done, "ok");
      setSurveyId("");
      setBatteryId("");
      setComment("");
      setWhat("survey");
      setExpires(dueValue(DUE_TEST.initial));
      setQ("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("acc.grantFailed"));
    } finally {
      setBusy(false);
    }
  }

  const list = setMode ? batteries : surveys;
  const items = setMode
    ? shownSets.map((b) => ({ id: b.id, head: b.title, sub: count(b.items.length, "methods"), already: false }))
    : shown.map((s) => {
        const title = t(s.title, lang);
        const code = surveyCode(title);
        return { id: s.id, head: code, sub: code !== title ? title : null, already: !!already?.has(s.id) || (!!prior && s.id === surveyId) };
      });
  const label = setMode ? ut("asgd.set") : ut("pg.test");

  return (
    <AssignFrame
      frame={p}
      title={setMode ? ut("mc.btAssignTitle") : ut("pg.assignTest")}
      sub={p.who}
      icon={<Pi.clipboardPlus />}
      note={p.whoNote}
      noteIcon={<Pi.usersRound />}
      dirty={dirty}
      draftName={ut("pg2.assignDraft")}
      submit={() => void assign()}
      submitLabel={busy ? ut("co.saving") : ut("acc.grant")}
      canSubmit={!!picked && !pastDeadline(expires, today())}
      busy={busy}
    >
      {recommended.length && !setMode ? (
        <DrawerSection title={ut("dpc.recommendedTitle")}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {recommended.map(({ hit, target }) => {
              const names = splitCode(target.title);
              const code = names.code ?? names.name;
              return (
                <li key={target.surveyId} className="flex items-center gap-2.5 rounded-[10px] bg-violet-tint px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[13px] font-extrabold text-violet-ink">
                      {code}
                      {names.code ? <span className="font-semibold text-text-2">{` ${names.name}`}</span> : null}
                    </b>
                    {/* на чём сработало правило: «PHQ-2 = 4 від 12.10» */}
                    <small className="block truncate text-caption text-text-2">
                      {ut("dpc.basisOn").replace("{basis}", basisText(hit, lang)).replace("{date}", shortDate(hit.createdAt))}
                    </small>
                  </span>
                  {target.clinician ? (
                    /* заполняет специалист — не назначают, а проводят */
                    <ButtonLink size="xs" to={`/surveys/${target.surveyId}/administer`}>
                      {ut("dpc.administerOne").replace("{code}", code)}
                    </ButtonLink>
                  ) : (
                    <Button size="xs" variant="primary" disabled={busy || pastDeadline(expires, today())} onClick={() => void assign(target.surveyId)}>
                      {ut("dpc.assignOne").replace("{code}", code)}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </DrawerSection>
      ) : null}
      <DrawerSection title={sets ? undefined : label}>
        {sets ? (
          <Segmented
            wide
            className="mb-3"
            label={ut("asgd.what")}
            value={what}
            onChange={switchTo}
            items={[
              { key: "survey", label: ut("pg.test") },
              { key: "set", label: ut("asgd.set") },
            ]}
          />
        ) : null}
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={setMode ? ut("asgd.setSearch") : ut("pg2.testSearch")}
          width={0}
          className="w-full"
        />
        {list.error ? (
          <Loading error={list.error} onRetry={list.reload} bare />
        ) : !list.data ? (
          /* закрытый ящик не размонтируется: скелет — только пока он открыт и список в пути */
          open ? <Loading rows={3} bare /> : null
        ) : items.length === 0 ? (
          <p className="m-0 mt-3 text-small text-muted">{setMode && !needle ? ut("asgd.noSets") : ut("srch.nothing")}</p>
        ) : (
          <div role="radiogroup" aria-label={label} className="mt-2.5 flex max-h-[min(46vh,420px)] flex-col gap-1 overflow-y-auto">
            {items.map((it) => {
              const on = it.id === picked;
              return (
                <label
                  key={it.id}
                  className={cx(
                    "m-0 flex cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2",
                    on ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "hover:bg-sunk",
                  )}
                >
                  <Radio name="assign-survey" checked={on} onChange={() => (setMode ? setBatteryId(it.id) : setSurveyId(it.id))} />
                  <span className="min-w-0 flex-1">
                    <b className={cx("block truncate text-[13px] font-extrabold", on ? "text-violet-ink" : "text-text")}>{it.head}</b>
                    {it.sub ? <small className="block truncate text-caption text-muted">{it.sub}</small> : null}
                  </span>
                  {it.already ? <Tag tone="primary">{ut("pg2.alreadyAssigned")}</Tag> : null}
                </label>
              );
            })}
          </div>
        )}
        {prior ? (
          <div className="mt-3">
            <Callout kind="warn" icon={<Mi.repeat />}>
              {prior.until ? ut("asgd.priorUntil").replace("{date}", shortDate(prior.until)) : ut("asgd.priorForever")}{" "}
              {ut("mc.conflictTail")}
            </Callout>
          </div>
        ) : null}
      </DrawerSection>
      <DueSection setup={due} value={expires} onChange={setExpires}>
        {p.comment ? (
          <Field label={ut("mc.commentForPatient")} optional>
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={ut("acc.commentExample")} maxLength={500} />
          </Field>
        ) : null}
        {error ? (
          <p role="alert" className="m-0 mt-2 text-small font-semibold text-risk-ink">
            {error}
          </p>
        ) : null}
      </DueSection>
    </AssignFrame>
  );
}
