import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { PatientGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { pastDeadline, today } from "../../components/deadline";
import { useLang } from "../../lang";
import { Avatar, DrawerSection, Ic, SearchField, useToast, type DrawerPaneProps } from "../../ui";
import { Button, ChoiceCard, ErrorText, Field, Input, Segmented, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { grantEach, newProgress, partialFailure } from "../patientGroups/model";
import { initialsName } from "./model";

/*
 * Действия над людьми реестра — виды ящика, а не окна поверх и не переход
 * (KIT.md § 2): «Призначити тест», «Додати до групи», «Написати». Страница
 * остаётся на месте; Esc закрывает ящик и сохраняет набранное.
 *
 * Каждый вид — хук, который отдаёт свойства DrawerPane (шапка, подвал,
 * «есть ввод») и тело: Drawer набора узнаёт виды по самому элементу
 * DrawerPane, и обёртка-компонент между ними его бы спрятала.
 */

export interface Who {
  id: string;
  name: string;
}

export type PaneParts = Omit<DrawerPaneProps, "mode" | "children" | "hidden" | "onRequestClose"> & { body: ReactNode };

/** Кому: имена пилюлями — кто получит назначение или попадёт в группу */
function Recipients({ people }: { people: Who[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {people.slice(0, 12).map((p) => (
        <span key={p.id} className="inline-flex h-8 items-center gap-1.5 rounded-pill bg-sunk pl-1 pr-3 text-small font-semibold text-text">
          <Avatar name={p.name} size={24} />
          <span title={p.name}>{initialsName(p.name)}</span>
        </span>
      ))}
      {people.length > 12 ? (
        <span className="inline-flex h-8 items-center rounded-pill bg-sunk px-3 text-small font-bold text-text-2">+{people.length - 12}</span>
      ) : null}
    </div>
  );
}

/** Дата «через N дней» в виде значения поля даты (YYYY-MM-DD) по часам консоли */
function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ─────────── «Призначити тест» ─────────── */

/**
 * Назначить методику выбранным — поимённо, тем же маршрутом, что ручная
 * выдача (grant). Отказ посередине не теряет сделанного: повтор идёт только
 * к тем, кому ещё не выдано (patientGroups/model.ts, grantEach). Кому эта
 * методика уже выдана и не пройдена — сказано у самой методики: назначение
 * повторно не дублируется, сервер перезаписывает выдачу.
 */
export function useAssignPane(people: Who[], onDone: () => void): PaneParts {
  const { ut } = useLang();
  const toast = useToast();
  const surveys = useResource(() => api.surveys(), []);
  const [q, setQ] = useState("");
  const [surveyId, setSurveyId] = useState("");
  const [due, setDue] = useState(inDays(14));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useRef(newProgress());
  const key = people.map((p) => p.id).join(",");
  /* другие люди — другое назначение: память о выданных и выбор — с чистого листа */
  useEffect(() => {
    progress.current = newProgress();
    setError(null);
  }, [key]);

  const usable = (surveys.data ?? []).filter((s: SurveyListItem) => s.status === "published" && !s.archivedAt);
  const needle = q.trim().toLowerCase();
  const found = needle ? usable.filter((s) => s.title.toLowerCase().includes(needle)) : usable;
  const grants = useResource(() => (surveyId ? api.grants(surveyId) : Promise.resolve([])), [surveyId], {
    enabled: !!surveyId,
  });
  const ids = new Set(people.map((p) => p.id));
  const already = (grants.data ?? []).filter((g) => ids.has(g.userId) && !g.completed);
  const pastDue = pastDeadline(due, today());
  const quick = due === inDays(7) ? "7" : due === inDays(14) ? "14" : due === inDays(30) ? "30" : due === "" ? "none" : "custom";

  const assign = async () => {
    if (!surveyId || pastDue || !people.length) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await grantEach(progress.current, `${surveyId}|${due}`, [...ids], (userId) =>
        api.grant(surveyId, userId, undefined, due || null),
      );
      if (outcome.error) {
        const reason = outcome.error instanceof Error ? outcome.error.message : ut("acc.grantFailed");
        setError(partialFailure(outcome, reason, { done: ut("pg.assigned"), of: ut("an.of") }));
        return;
      }
      toast(`${ut("pg.assigned")}: ${outcome.done}`, "ok");
      setSurveyId("");
      progress.current = newProgress();
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return {
    title: ut("pg.assignTest"),
    sub: people.length === 1 ? people[0]!.name : ut("asg.forPicked").replace("{n}", String(people.length)),
    icon: <Ic.clipboard />,
    dirty: surveyId !== "",
    draftName: ut("asg.draftName"),
    footer: (
      <>
        <Button variant="primary" icon={<Ic.clipboard />} disabled={!surveyId || busy || pastDue || !people.length} onClick={() => void assign()}>
          {people.length > 1 ? ut("asg.assignN").replace("{n}", String(people.length)) : ut("pg.assignTest")}
        </Button>
        <Button onClick={onDone}>{ut("common.cancel")}</Button>
      </>
    ),
    body: (
      <>
        <DrawerSection title={ut("asg.who")} sub={people.length > 1 ? ut("asg.pickedN").replace("{n}", String(people.length)) : undefined}>
          <Recipients people={people} />
        </DrawerSection>
        <DrawerSection title={ut("pg.test")} sub={ut("asg.onePer")}>
          <SearchField value={q} onChange={setQ} placeholder={ut("asg.searchPh")} width={0} className="mb-2.5 w-full" />
          {surveys.error ? <ErrorText className="mt-2.5">{surveys.error}</ErrorText> : null}
          <div role="radiogroup" aria-label={ut("pg.test")} className="flex max-h-[340px] flex-col gap-1.5 overflow-y-auto pr-0.5">
            {found.slice(0, 40).map((s) => (
              <ChoiceCard
                key={s.id}
                name="assign-survey"
                value={s.id}
                checked={surveyId === s.id}
                onChange={setSurveyId}
                title={s.title}
                sub={
                  surveyId === s.id && already.length ? (
                    <span className="font-semibold text-warn">
                      {ut("asg.already").replace("{names}", already.map((g) => g.fullName).join(", "))}
                    </span>
                  ) : (
                    ut("asg.items").replace("{n}", String(s.questionCount))
                  )
                }
              />
            ))}
            {surveys.data && !found.length ? <p className="m-0 py-2 text-small text-muted">{ut("asg.noneFound")}</p> : null}
          </div>
        </DrawerSection>
        <DrawerSection title={ut("asg.due")}>
          <Field label={ut("acc.until")} error={pastDue ? ut("uit.form.pastDeadline") : undefined} hint={due ? undefined : ut("asg.noDueHint")}>
            <Input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Segmented
            className="mt-2.5"
            label={ut("asg.due")}
            value={quick}
            onChange={(k) => setDue(k === "none" ? "" : k === "custom" ? due : inDays(Number(k)))}
            items={[
              { key: "7", label: ut("asg.plusDays").replace("{n}", "7") },
              { key: "14", label: ut("asg.plusDays").replace("{n}", "14") },
              { key: "30", label: ut("asg.plusDays").replace("{n}", "30") },
              { key: "none", label: ut("asg.noDue") },
            ]}
          />
          {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
        </DrawerSection>
      </>
    ),
  };
}

/* ─────────── «Додати до групи» ─────────── */

/**
 * Положить людей в свою группу — одним запросом на выборку, как и «Додати
 * пацієнтів» карточки группы (api.addPatientGroupMembers): сервер проверяет
 * пачку целиком до первой записи, и «троих добавил, на четвёртом отказал» не
 * бывает. Повтор сервер читает как «уже там»; строка журнала — у каждого
 * человека своя, как и прежде.
 */
export function useGroupPane(people: Who[], groups: PatientGroupWithCounts[], onDone: () => void): PaneParts {
  const { ut } = useLang();
  const toast = useToast();
  const navigate = useNavigate();
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!groupId) return;
    setBusy(true);
    setError(null);
    try {
      await api.addPatientGroupMembers(
        groupId,
        people.map((p) => p.id),
      );
      toast(ut("pg.added"), "ok");
      setGroupId("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  };
  return {
    title: ut("pg.addToGroup"),
    sub: people.length === 1 ? people[0]!.name : ut("asg.forPicked").replace("{n}", String(people.length)),
    icon: <Ic.users />,
    footer: (
      <>
        <Button variant="primary" icon={<Ic.users />} disabled={!groupId || busy} onClick={() => void add()}>
          {ut("pg.addToGroup")}
        </Button>
        <Button onClick={onDone}>{ut("common.cancel")}</Button>
      </>
    ),
    body: (
      <>
        <DrawerSection title={ut("asg.who")}>
          <Recipients people={people} />
        </DrawerSection>
        <DrawerSection
          title={ut("cn.patientGroup")}
          right={
            <Button variant="ghost" size="xs" icon={<Ic.plus />} onClick={() => navigate("/patient-groups")}>
              {ut("pg.add")}
            </Button>
          }
        >
          {groups.length === 0 ? (
            <p className="m-0 text-small text-text-2">{ut("cn.noPatientGroups")}</p>
          ) : (
            <div role="radiogroup" aria-label={ut("cn.patientGroup")} className="flex flex-col gap-1.5">
              {groups.map((g) => (
                <ChoiceCard
                  key={g.id}
                  name="pick-group"
                  value={g.id}
                  checked={groupId === g.id}
                  onChange={setGroupId}
                  title={g.title}
                  sub={ut("asg.members").replace("{n}", String(g.memberCount))}
                />
              ))}
            </div>
          )}
          {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
        </DrawerSection>
      </>
    ),
  };
}

/* ─────────── «Написати» ─────────── */

/** Черновик письма и отказ его отправки — при адресате */
export interface MessageDraft {
  to: string | null;
  text: string;
  error: string | null;
}

export const EMPTY_MESSAGE: MessageDraft = { to: null, text: "", error: null };

/**
 * Черновик для этого адресата. Набранное другому — не его: письмо,
 * написанное одному пациенту, не подставляется в «Написати» другому.
 */
export function messageDraft(box: MessageDraft, to: string | null): MessageDraft {
  return to !== null && box.to === to ? box : { to, text: "", error: null };
}

/**
 * Письмо одному человеку — в его разговор (тот же маршрут, что экран
 * «Листування»). Отправленное открывается из сообщения: перейти к
 * разговору — дело специалиста, а не автоматический переход.
 */
export function useMessagePane(person: Who | null, onDone: () => void): PaneParts {
  const { ut } = useLang();
  const toast = useToast();
  const navigate = useNavigate();
  /*
   * Черновик — того, кому его писали. Ящик хранит набранное и после Esc,
   * и прежде «Написати» у другого человека открывалось с чужим письмом в
   * поле: одно нажатие «Надіслати» — и слова, написанные одному пациенту,
   * уходили другому. Теперь текст и отказ живут при адресате (messageDraft).
   */
  const to = person?.id ?? null;
  const [box, setBox] = useState<MessageDraft>(EMPTY_MESSAGE);
  const { text, error } = messageDraft(box, to);
  const edit = (patch: Partial<Pick<MessageDraft, "text" | "error">>) => setBox((b) => ({ ...messageDraft(b, to), ...patch }));
  const [busy, setBusy] = useState(false);
  const draft = useMemo(() => text.trim(), [text]);
  const send = async () => {
    if (!person || !draft) return;
    const id = person.id;
    /* исход отправки — тому же адресату: ящик тем временем мог открыться для другого */
    const forId = (patch: Partial<Pick<MessageDraft, "text" | "error">>) =>
      setBox((b) => (b.to === id ? { ...b, ...patch } : b));
    setBusy(true);
    forId({ error: null });
    try {
      const res = await api.sendMessage({ patientId: id, text: draft });
      forId({ text: "" });
      onDone();
      toast(ut("msg.sentTo").replace("{name}", person.name), "ok", {
        action: { label: ut("msg.openThread"), onClick: () => navigate(`/messages/${res.threadId}`) },
      });
    } catch (e) {
      forId({ error: e instanceof Error ? e.message : ut("ui.actionFailed") });
    } finally {
      setBusy(false);
    }
  };
  return {
    title: ut("plist.write"),
    sub: person?.name,
    icon: <Ic.message />,
    tone: "info",
    dirty: draft !== "",
    draftName: ut("msg.draftName"),
    kbd: "W",
    /* специалист пишет пациенту: строка — о том, где письмо увидят (прежде стояла памятка пациента «не екстрений зв’язок») */
    note: ut("card.willSee"),
    noteIcon: <Ic.info />,
    footer: (
      <>
        <Button variant="primary" icon={<Ic.reply />} disabled={!draft || busy || !person} onClick={() => void send()}>
          {ut("msg.send")}
        </Button>
        <Button onClick={onDone}>{ut("common.cancel")}</Button>
      </>
    ),
    body: (
      <DrawerSection title={ut("msg.text")}>
        <Textarea
          data-autofocus
          value={text}
          rows={7}
          maxLength={4000}
          onChange={(e) => edit({ text: e.target.value })}
          placeholder={ut("msg.placeholder")}
          aria-label={ut("msg.text")}
        />
        {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
      </DrawerSection>
    ),
  };
}
