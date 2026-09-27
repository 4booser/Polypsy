import { type RefObject, useEffect, useReducer, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SurveyListItem, UiKey } from "@quizzy/shared";
import { api, type NoteState, openInTab } from "../api";
import { day } from "../format";
import { NotLoaded, Screen, useAction } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Field, Input, SectionLabel, Select, Textarea } from "../ui/primitives";
import { useLang } from "../lang";
import { type Resource, useResource } from "../useResource";
import { TemplatePicker } from "../components/TemplatePicker";
import { VisitRecorder } from "../components/VisitRecorder";
import { Episodes } from "../components/Episodes";
import { today } from "../components/deadline";
import { staleMessage } from "../components/versioned";
import {
  ATTEMPTS_MAX,
  type AssignDraft,
  EMPTY_PROTOCOL,
  NEW_ASSIGN,
  type Protocol,
  type ProtocolEvent,
  assignBody,
  assignProblems,
  assignReady,
  assignable,
  protocolSavable,
  protocolStep,
} from "./visitModel";

const SOURCE_KEY: Record<string, UiKey> = {
  self: "visit.sourceSelf",
  assigned: "visit.sourceAssigned",
  intake: "visit.sourceIntake",
  kiosk: "visit.sourceKiosk",
  clinician: "visit.sourceClinician",
  informant: "visit.sourceInformant",
};

const CHANGE_KEY: Record<string, UiKey> = {
  response: "visit.changeResponse",
  alert: "visit.changeAlert",
  noShow: "visit.changeNoShow",
};

/**
 * Экран приёма.
 *
 * Три панели без переходов между вкладками: слева что было, в центре
 * протокол, справа действия. Специалист открывает этот экран, когда человек
 * уже сидит перед ним, и любой переход отсюда стоит либо набранного текста,
 * либо внимания пациента.
 *
 * Панели именно в этом порядке. Слева — то, что читают до разговора; в
 * центре — то, что пишут во время; справа — то, что делают в конце. Порядок
 * панелей совпадает с порядком приёма, и искать ничего не приходится.
 */
export default function VisitPage() {
  const { id = "" } = useParams();
  /*
   * Другой приём — другой экран целиком, а не тот же с новым адресом
   * (w14:webtails). Переход между приёмами (палитра, «назад» браузера)
   * оставлял компонент на месте, и с ним — набранный протокол и его базу:
   * текст о прежнем человеке стоял в поле нового и по «Зберегти» ложился в
   * его записи. Ключ по приёму начинает всё с чистого листа.
   */
  return <VisitScreen key={id} id={id} />;
}

function VisitScreen({ id }: { id: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.visitContext(id), [id]);
  const reload = res.reload;

  /*
   * Запись о человеке — только когда известно, о ком: прежде до ответа о
   * приёме здесь «грузился» null, и он выглядел как «записей нет».
   */
  const patientId = res.data?.patient.id ?? "";
  const notes = useResource(() => api.notes(patientId), [patientId], { enabled: !!patientId });

  /*
   * Протокол — текст поля вместе с базой, поверх которой он набран
   * (visitModel.ts): поле открывается только ответом сервера, а база —
   * то, что видел человек, а не то, что пришло последним.
   */
  const [protocol, dispatch] = useReducer(protocolStep, EMPTY_PROTOCOL);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (notes.data) dispatch({ type: "loaded", state: notes.data });
  }, [notes.data]);
  /* отказ 409 — запись переписали, пока протокол был открыт: строкой у кнопок, с «перечитати» (как в NotesEditor) */
  const [stale, setStale] = useState<string | null>(null);

  return (
    <Screen res={res} rows={6}>
      {(data) => (
        <Page
          title={ut("visit.title")}
          sub={`${data.patient.fullName}${data.patient.unit ? ` · ${data.patient.unit}` : ""}`}
          bleed
        >
          {/*
            Три колонки на широком экране, одна на узком. Порядок при
            схлопывании тот же: что было → протокол → действия. Ставить
            действия наверх при узком экране было бы удобнее пальцу и хуже
            по смыслу — их делают в конце.
          */}
          {/*
            Столбцы тянутся до общего низа, а не кончаются каждый на своей
            высоте. Панели разной длины оставляли под короткой дыру, и экран
            читался как сломанный: глазу не за что зацепиться, где кончается
            одна колонка и начинается другая. Тянется ПАНЕЛЬ, а не её
            содержимое, — внутри всё по-прежнему прижато к верху, и пустота
            уходит вниз, где ей и место.
          */}
          <div className="grid items-stretch gap-3 p-4 max-[1200px]:grid-cols-1 grid-cols-[minmax(0,320px)_minmax(0,1fr)_minmax(0,280px)]">
            <History data={data} />

            <Panel title={ut("visit.protocol")} className="h-full">
              <ProtocolBody
                notes={notes}
                protocol={protocol}
                template={ut(data.appointment.kind === "primary" ? "visit.tplIntake" : "visit.tplSession")}
                busy={busy}
                stale={stale}
                areaRef={areaRef}
                onEvent={dispatch}
                onSave={() =>
                  run(async () => {
                    try {
                      const saved = await api.saveNote(
                        data.patient.id,
                        protocol.text ?? "",
                        // база — то, поверх чего набран текст (null — записей не было): сервер сверит
                        protocol.seen,
                        data.appointment.kind === "primary" ? "intake" : "session",
                        data.appointment.id,
                      );
                      // ответ сервера ложится сразу: следующее «Зберегти» уйдёт с его редакцией, а не с прежней
                      notes.patch(saved);
                      dispatch({ type: "saved", state: saved });
                      setStale(null);
                      reload();
                    } catch (e) {
                      const message = staleMessage(e);
                      if (message === null) throw e;
                      setStale(message);
                      return false;
                    }
                  }, ut("visit.saved"))
                }
                onReread={() =>
                  run(async () => {
                    const fresh = await api.notes(data.patient.id);
                    notes.patch(fresh);
                    dispatch({ type: "reread", state: fresh });
                    setStale(null);
                  })
                }
              />
            </Panel>

            <div className="flex h-full flex-col gap-3">
              {/*
                Запись — первая в колонке, потому что её включают на первой
                минуте приёма. Стояла третьей, под действиями и обращениями,
                то есть ниже сгиба: чтобы начать запись, надо было сначала
                прокрутить экран, — а начинают её тогда, когда человек уже
                сел и разговор пошёл.

                Действия под ней намеренно: назначить методику, выписать
                направление и справку — это конец приёма, а не начало.

                Стенограмма приезжает сюда же и вставляется в протокол по
                нажатию — сама она в протокол не попадает: стенограмма это то,
                что было сказано, а протокол — то, что специалист из этого
                вынес.
              */}
              <VisitRecorder
                appointmentId={data.appointment.id}
                onTranscript={(t) => dispatch({ type: "append", text: t })}
              />
              <Actions data={data} busy={busy} run={run} reload={reload} />
              {/*
                Обращение — здесь же: приём относят к нему в тот момент, когда
                он идёт, а не вспоминают потом, разбирая хронологию.
              */}
              <Episodes
                patientId={data.patient.id}
                appointmentId={data.appointment.id}
                className="flex-1"
              />
            </div>
          </div>
        </Page>
      )}
    </Screen>
  );
}

type Ctx = Awaited<ReturnType<typeof api.visitContext>>;

/**
 * Протокол приёма: поле, шаблоны и «Зберегти» — всё из состояния, без
 * своих решений и без сети, поэтому проверяется без браузера
 * (test/visitProtocol.test.tsx).
 *
 * Пока ответа о записи нет, поля нет: на его месте скелет, а при отказе —
 * отказ с «повторити». Прежде здесь стояло пустое поле, и отказ загрузки
 * выглядел как «записей о человеке нет»: специалист писал протокол с нуля
 * поверх черновика, которого не видел.
 */
export function ProtocolBody({
  notes,
  protocol,
  template,
  busy,
  stale,
  areaRef,
  onEvent,
  onSave,
  onReread,
}: {
  notes: Pick<Resource<NoteState>, "error" | "loading" | "reload">;
  protocol: Protocol;
  /** Заготовка протокола по виду приёма: плейсхолдер и кнопка «Шаблон» */
  template: string;
  busy: boolean;
  stale: string | null;
  areaRef: RefObject<HTMLTextAreaElement | null>;
  onEvent: (e: ProtocolEvent) => void;
  onSave: () => void;
  onReread: () => void;
}) {
  const { ut } = useLang();
  if (protocol.text === null) {
    return (
      <div className="p-4">
        <NotLoaded res={notes} rows={6} />
      </div>
    );
  }
  const text = protocol.text;
  const edit = (next: string) => onEvent({ type: "edit", text: next });
  return (
    <div className="flex flex-col gap-2 p-4">
      <Textarea ref={areaRef} rows={18} value={text} onChange={(e) => edit(e.target.value)} placeholder={template} />
      {stale ? (
        <div role="alert" className="rounded-[5px] bg-accent-soft px-[14px] py-[10px]">
          <p className="m-0 text-[15px] leading-[20px] text-text">{stale}</p>
          <p className="m-0 mt-[4px] text-[13px] text-muted">{ut("integrity.rereadHint")}</p>
          <Button variant="quiet" className="mt-[8px]" disabled={busy} onClick={onReread}>
            {ut("integrity.reread")}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {/*
          Шаблон подставляется по нажатию, а не сам.
          Автоподстановка в пустое поле выглядит удобной ровно до
          первого раза, когда специалист начал писать своими
          словами и получил поверх заготовку.
        */}
        <Button size="sm" variant="ghost" disabled={!!text} onClick={() => edit(template)}>
          {ut("visit.template")}
        </Button>
        <TemplatePicker kind="note" value={text} onChange={edit} textareaRef={areaRef} />
        <Button size="sm" disabled={busy || !protocolSavable(protocol)} onClick={onSave}>
          {ut("visit.save")}
        </Button>
      </div>
    </div>
  );
}

function History({ data }: { data: Ctx }) {
  const { ut } = useLang();
  return (
    <div className="flex h-full flex-col gap-3">
      <Panel title={ut("visit.history")}>
        <div className="flex flex-col gap-2 p-4 text-caption">
          {/*
            Первой строкой — у кого человек был до этого.
            Записаться можно к любому свободному специалисту, и человек легко
            попадает к третьему подряд. Принимающий сегодня должен видеть, что
            он не первый, ДО того как начнёт задавать вопросы, которые
            человеку уже задавали дважды.
          */}
          {data.previous ? (
            <p>
              <SectionLabel>{ut("visit.wasWith")}</SectionLabel>{" "}
              {data.previous.specialistName} · {day(data.previous.at)}
            </p>
          ) : (
            <p className="text-muted">{ut("visit.firstVisit")}</p>
          )}
          {data.followedSince ? (
            <p className="text-muted">
              {ut("visit.followedSince")} {day(data.followedSince)}
            </p>
          ) : null}
          <p className={data.patient.leadName ? "text-muted" : "text-accent"}>
            {data.patient.leadName
              ? `${ut("visit.lead")} ${data.patient.leadName}`
              : ut("visit.noLead")}
          </p>
          {data.appointment.reason ? (
            <p className="mt-1">
              <SectionLabel>{ut("visit.reason")}</SectionLabel> {data.appointment.reason}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel title={ut("visit.changes")} className="flex-1">
        {data.changes.length === 0 ? (
          /*
            Отсутствие новостей — не заголовок.
            Стояло <Empty>: крупным полужирным по центру, как важное
            утверждение. Но «с прошлого приёма ничего не произошло» — это не
            событие, о котором надо сообщить, а пустая строка списка: у
            человека между приёмами не случилось ничего, и набирать это
            крупнее самих событий значит переставить их местами по важности.
            Ровно та же мысль, по которой <Empty> уместен там, где пустота
            требует действия («приглашений нет — выпишите»), — здесь она не
            требует ничего.
          */
          <p className="px-4 py-2 text-caption text-muted">{ut("visit.noChanges")}</p>
        ) : (
          <div className="flex flex-col">
            {data.changes.map((ch, i) => (
              <div
                key={i}
                className="flex items-baseline gap-2 border-t border-hairline px-4 py-2 text-caption first:border-t-0"
              >
                <span className="w-[68px] shrink-0 text-muted">{day(ch.at)}</span>
                <span className="min-w-0">
                  {ut(CHANGE_KEY[ch.kind] ?? "visit.changeResponse")}
                  {ch.title ? ` · ${ch.title}` : ""}
                  {ch.kind === "response" && ch.detail && SOURCE_KEY[ch.detail]
                    ? ` · ${ut(SOURCE_KEY[ch.detail]!)}`
                    : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Actions({
  data,
  busy,
  run,
  reload,
}: {
  data: Ctx;
  busy: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  reload: () => void;
}) {
  const { ut } = useLang();
  return (
    <Panel title={ut("visit.actions")}>
      <div className="flex flex-col gap-2 p-4">
        {/*
          Действия ведут либо туда, где их выполняют, либо выполняются здесь.
          Закрепление и завершение приёма — здесь: они не требуют экрана, а
          уход с этого экрана стоит набранного протокола.
        */}
        {data.patient.leadSpecialistId === null ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run(() => api.takeLead(data.patient.id, true).then(reload))}
          >
            {ut("visit.takeLead")}
          </Button>
        ) : null}

        {/*
          Назначение и направление делаются здесь, а не по ссылке отсюда.
          Уход с экрана стоит набранного протокола: текстовое поле не
          переживает навигацию, и специалист либо теряет написанное, либо не
          назначает вовсе. Обе формы раскрываются на месте.
        */}
        <Assign patientId={data.patient.id} busy={busy} run={run} />
        <Refer patientId={data.patient.id} busy={busy} run={run} />

        <Link to={`/patients/${data.patient.id}`} className="btn">
          {ut("visit.openCard")}
        </Link>
        {/*
          Справка выдаётся о состоявшемся приёме, поэтому кнопка появляется
          только тогда, когда человек уже пришёл: предложить её раньше значило
          бы предложить документ о том, чего не было.
        */}
        {["arrived", "in_progress", "done"].includes(data.appointment.status) ? (
          <button
            type="button"
            className="btn"
            onClick={() => openInTab(`/api/reports/visits/${data.appointment.id}`)}
          >
            {ut("visit.certificate")}
          </button>
        ) : null}

        {data.appointment.status === "in_progress" ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run(() => api.appointmentStatus(data.appointment.id, "done").then(reload))}
          >
            {ut("visit.finish")}
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}


/**
 * Назначить методику — не уходя с приёма.
 *
 * Срок и число попыток задаются явно, без умолчаний в разметке: одна попытка
 * по умолчанию не потому, что так строже, а потому что вторая портит
 * измерение — человек помнит вопросы.
 */
function Assign({
  patientId,
  busy,
  run,
}: {
  patientId: string;
  busy: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}) {
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AssignDraft>(NEW_ASSIGN);
  const surveys = useResource(() => api.surveys(), [], { enabled: open });

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {ut("visit.assign")}
      </Button>
    );
  }

  const todayKey = today();
  return (
    <AssignForm
      surveys={surveys}
      draft={draft}
      todayKey={todayKey}
      busy={busy}
      onEdit={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      onSubmit={() => {
        if (!assignReady(draft, todayKey)) return;
        const body = assignBody(draft);
        void run(
          () =>
            api.grant(body.surveyId, patientId, undefined, body.expiresAt, body.attempts).then(() => {
              // следующее назначение начинается с чистой формы: прежняя методика в выборе — путь к повторной выдаче
              setDraft(NEW_ASSIGN);
              setOpen(false);
            }),
          ut("visit.assigned"),
        );
      }}
      onCancel={() => setOpen(false)}
    />
  );
}

/**
 * Форма назначения — всё из состояния, проверяется без браузера
 * (test/visitProtocol.test.tsx). Правила полей — visitModel.ts
 * (assignProblems): срок в прошлом и попытки вне 1…10 называются у поля и
 * гасят кнопку, а не уходят на сервер.
 */
export function AssignForm({
  surveys,
  draft,
  todayKey,
  busy,
  onEdit,
  onSubmit,
  onCancel,
}: {
  surveys: Pick<Resource<SurveyListItem[]>, "data" | "error" | "loading" | "reload">;
  draft: AssignDraft;
  todayKey: string;
  busy: boolean;
  onEdit: (patch: Partial<AssignDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { ut } = useLang();
  const problems = assignProblems(draft, todayKey);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline p-2">
      {/* методики не пришли — отказ с «повторити» на месте выбора, а не пустой выбор, будто назначать нечего */}
      {surveys.data === null ? (
        <NotLoaded res={surveys} rows={1} />
      ) : (
        <Field label={ut("visit.assignPick")}>
          <Select value={draft.surveyId} onChange={(e) => onEdit({ surveyId: e.target.value })}>
            <option value="" />
            {assignable(surveys.data).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={ut("visit.assignDue")} error={problems.due ? ut(problems.due) : null}>
        <Input
          type="date"
          value={draft.due}
          min={todayKey}
          aria-invalid={problems.due ? true : undefined}
          onChange={(e) => onEdit({ due: e.target.value })}
        />
      </Field>
      <Field label={ut("visit.assignAttempts")} error={problems.attempts ? ut(problems.attempts) : null}>
        <Input
          type="number"
          min={1}
          max={ATTEMPTS_MAX}
          value={draft.attempts}
          aria-invalid={problems.attempts ? true : undefined}
          onChange={(e) => onEdit({ attempts: e.target.value })}
        />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !assignReady(draft, todayKey)} onClick={onSubmit}>
          {ut("visit.assign")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {ut("visit.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Выписать направление — тоже здесь: уход с экрана стоит протокола */
function Refer({
  patientId,
  busy,
  run,
}: {
  patientId: string;
  busy: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
}) {
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState<
    "psychiatrist" | "inpatient" | "outpatient" | "commander" | "other"
  >("psychiatrist");
  const [urgency, setUrgency] = useState<"routine" | "urgent" | "immediate">("routine");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {ut("visit.refer")}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline p-2">
      <Field label={ut("visit.referDest")}>
        <Select
          value={destination}
          onChange={(e) => setDestination(e.target.value as typeof destination)}
        >
          {(["psychiatrist", "inpatient", "outpatient", "commander", "other"] as const).map((d) => (
            <option key={d} value={d}>
              {ut(`dest.${d}` as UiKey)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={ut("visit.referUrgency")}>
        <Select value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
          {(["routine", "urgent", "immediate"] as const).map((u) => (
            <option key={u} value={u}>
              {ut(`urg.${u}` as UiKey)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={ut("visit.referReason")}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            run(
              () =>
                api
                  .createReferral({ userId: patientId, destination, urgency, reason: reason || null })
                  .then(() => setOpen(false)),
              ut("visit.referred"),
            )
          }
        >
          {ut("visit.refer")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {ut("visit.cancel")}
        </Button>
      </div>
    </div>
  );
}
