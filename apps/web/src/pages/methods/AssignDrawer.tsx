import { useMemo, useRef, useState } from "react";
import type { UiKey } from "@quizzy/shared";
import type { Patient } from "../../api";
import { api } from "../../api";
import { pastDeadline, today } from "../../components/deadline";
import { usePatientSearch } from "../../components/PatientPicker";
import { useLang } from "../../lang";
import { Avatar, useAction, useToast } from "../../ui";
import { Callout } from "../../ui/states";
import { cx } from "../../ui/cx";
import { Drawer, DrawerSection } from "../../ui/Drawer";
import { Ic } from "../../ui/icons";
import { Button, Field, Input, Segmented, Select } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { Mi } from "./icons";
import { dueIn, shortDate } from "./model";

/*
 * «Призначити» в ящике (methods-assign-dialog): кому — людям поимённо или
 * группе пациентов, до какого дня, с каким комментарием. Один ящик на
 * методику (выдача доступа, routes/access.ts) и на набор (назначение
 * набора, routes/batteries.ts): разница — в том, что уходит на сервер, и
 * это экран передаёт функциями.
 *
 * Строк из макета, которых в системе нет, здесь нет: повтора по
 * расписанию у ручного назначения не бывает (повторы — у правил и
 * расписаний), каналы уведомления сервер выбирает сам.
 */

/** Чем уже владеет человек — чтобы сказать, что новое назначение сделает с прежним */
export interface ExistingAssignment {
  /** Срок прежнего; null — без срока */
  until: string | null;
  /** Уже прошёл */
  done?: boolean;
}

/** Быстрые сроки: календарные дни от сегодня; null — без срока */
const QUICK: { key: UiKey; days: number | null }[] = [
  { key: "mc.due3", days: 3 },
  { key: "mc.dueWeek", days: 7 },
  { key: "mc.due2Weeks", days: 14 },
  { key: "mc.dueNone", days: null },
];

export function AssignDrawer({
  open,
  onClose,
  onReturn,
  title,
  sub,
  note,
  draftName,
  existing,
  assignOne,
  assignGroup,
  onAssigned,
}: {
  open: boolean;
  onClose: () => void;
  onReturn: () => void;
  title: string;
  sub?: string;
  /** Строка над кнопками: «9 пунктів, пацієнт побачить методику одразу» */
  note?: string;
  /** Родительный падеж для «Чернетку … збережено» */
  draftName: string;
  /** userId → прежнее назначение (если есть) */
  existing?: ReadonlyMap<string, ExistingAssignment>;
  /** Назначить одному человеку; срок — «ГГГГ-ММ-ДД» или null */
  assignOne: (userId: string, due: string | null, note: string | null) => Promise<unknown>;
  /** Назначить группе пациентов; без него — только поимённо */
  assignGroup?: (groupId: string, due: string | null, note: string | null) => Promise<{ recipients: number }>;
  onAssigned: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const toast = useToast();
  const [mode, setMode] = useState<"people" | "group">("people");
  const [picked, setPicked] = useState<Patient[]>([]);
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState("");
  const [due, setDue] = useState(() => dueIn(7));
  const [comment, setComment] = useState("");
  const [failed, setFailed] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const found = usePatientSearch(query, { onlyTyped: true });
  const groups = useResource(() => api.patientGroups(), [], { enabled: !!assignGroup && mode === "group" });
  const choices = useMemo(
    () => (found.data?.items ?? []).filter((p) => !picked.some((x) => x.id === p.id)).slice(0, 8),
    [found.data, picked],
  );
  const conflicts = picked.filter((p) => existing?.get(p.id) && !existing.get(p.id)!.done);
  const dueInPast = pastDeadline(due, today());
  const dirty = picked.length > 0 || comment.trim() !== "" || groupId !== "";
  const ready = !dueInPast && (mode === "people" ? picked.length > 0 : groupId !== "");

  const reset = () => {
    setPicked([]);
    setQuery("");
    setGroupId("");
    setComment("");
    setFailed([]);
    setDue(dueIn(7));
  };

  const submit = async () => {
    const dueValue = due || null;
    const noteValue = comment.trim() || null;
    if (mode === "group") {
      let recipients = 0;
      const ok = await run(async () => {
        recipients = (await assignGroup!(groupId, dueValue, noteValue)).recipients;
      });
      if (ok) {
        toast(ut("mc.assignedGroup").replace("{n}", String(recipients)), "ok");
        onAssigned();
        reset();
        onClose();
      }
      return;
    }
    /* поимённо — по одному: отказ одному (уже назначено, чужой пациент) не отменяет остальных */
    const miss: string[] = [];
    let done = 0;
    await run(async () => {
      for (const p of picked) {
        try {
          await assignOne(p.id, dueValue, noteValue);
          done += 1;
        } catch {
          miss.push(p.fullName);
        }
      }
      if (!done && miss.length) throw new Error(ut("mc.assignFailedAll"));
    });
    if (done) {
      toast(ut("mc.assignedN").replace("{n}", String(done)), "ok");
      onAssigned();
    }
    if (miss.length) {
      setPicked((prev) => prev.filter((p) => miss.includes(p.fullName)));
      setFailed(miss);
    } else if (done) {
      reset();
      onClose();
    }
  };

  const countLabel =
    mode === "group" ? ut("mc.assignGroupBtn") : picked.length > 1 ? ut("mc.assignN").replace("{n}", String(picked.length)) : ut("acc.grant");

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={title}
      sub={sub}
      icon={<Mi.clipboardPlus />}
      dirty={dirty}
      draftName={draftName}
      kbd="A"
      note={note}
      noteIcon={<Ic.timer />}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Mi.send />}
            disabled={!ready || busy}
            onClick={() => {
              void submit();
            }}
          >
            {countLabel}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
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
              {picked.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-[15px] bg-violet-tint pl-[3px] pr-1 text-[12.5px] font-bold text-violet-ink"
                >
                  <Avatar name={p.fullName} size={24} />
                  {p.fullName}
                  <button
                    type="button"
                    aria-label={ut("mc.unpick").replace("{name}", p.fullName)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPicked((prev) => prev.filter((x) => x.id !== p.id));
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
                  {choices.map((p) => {
                    const had = existing?.get(p.id);
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPicked((prev) => [...prev, p]);
                            setQuery("");
                            searchRef.current?.focus();
                          }}
                          className="flex w-full min-h-0 cursor-pointer items-center gap-2.5 rounded-[8px] border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-sunk"
                        >
                          <Avatar name={p.fullName} size={28} />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-body font-bold text-text">{p.fullName}</span>
                            <small className="truncate text-caption text-muted">
                              {had
                                ? had.done
                                  ? ut("mc.alreadyPassed")
                                  : had.until
                                    ? ut("mc.alreadyUntil").replace("{date}", shortDate(had.until))
                                    : ut("mc.alreadyForever")
                                : (p.unit ?? p.email)}
                            </small>
                          </span>
                          <Ic.plus size={15} className="ml-auto text-violet-ink" />
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
                    .map((p) => {
                      const was = existing!.get(p.id)!;
                      return was.until
                        ? ut("mc.conflictUntil").replace("{name}", p.fullName).replace("{date}", shortDate(was.until))
                        : ut("mc.conflictForever").replace("{name}", p.fullName);
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
            <Field label={ut("mc.assignGroup")}>
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

      <DrawerSection title={ut("mc.dueTitle")}>
        <Field label={ut("mc.dueField")} error={dueInPast ? ut("uit.form.pastDeadline") : null}>
          <Input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} icon={<Mi.calendar />} />
        </Field>
        <div role="group" aria-label={ut("mc.dueQuick")} className="-mt-1 mb-3.5 flex flex-wrap gap-1.5">
          {QUICK.map((q) => {
            const value = q.days === null ? "" : dueIn(q.days);
            const on = due === value;
            return (
              <button
                key={q.key}
                type="button"
                aria-pressed={on}
                onClick={() => setDue(value)}
                className={cx(
                  "h-7 min-h-0 cursor-pointer rounded-[14px] border-0 px-[11px] text-caption font-bold",
                  on ? "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk text-text-2 hover:bg-sunk-2",
                )}
              >
                {ut(q.key)}
              </button>
            );
          })}
        </div>
        <Field label={ut("mc.commentForPatient")} optional>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={ut("acc.commentExample")} maxLength={500} />
        </Field>
      </DrawerSection>
    </Drawer>
  );
}
