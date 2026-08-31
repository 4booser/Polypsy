import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { UiKey } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Empty, Screen, useAction } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Field, Input, Num, SectionLabel, Select, Textarea } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

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
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.visitContext(id), [id]);
  const reload = res.reload;

  const notes = useResource(
    () => (res.data ? api.notes(res.data.patient.id) : Promise.resolve(null)),
    [res.data?.patient.id],
  );

  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (notes.data && text === null) setText(notes.data.current?.text ?? "");
  }, [notes.data, text]);

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
          <div className="grid gap-3 p-4 max-[1200px]:grid-cols-1 grid-cols-[minmax(0,320px)_minmax(0,1fr)_minmax(0,280px)]">
            <History data={data} />

            <Panel title={ut("visit.protocol")}>
              <div className="flex flex-col gap-2 p-4">
                <Textarea
                  rows={18}
                  value={text ?? ""}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={ut(
                    data.appointment.kind === "primary" ? "visit.tplIntake" : "visit.tplSession",
                  )}
                />
                <div className="flex flex-wrap gap-2">
                  {/*
                    Шаблон подставляется по нажатию, а не сам.
                    Автоподстановка в пустое поле выглядит удобной ровно до
                    первого раза, когда специалист начал писать своими
                    словами и получил поверх заготовку.
                  */}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!text}
                    onClick={() =>
                      setText(
                        ut(
                          data.appointment.kind === "primary"
                            ? "visit.tplIntake"
                            : "visit.tplSession",
                        ),
                      )
                    }
                  >
                    {ut("visit.template")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !text}
                    onClick={() =>
                      run(
                        () =>
                          api
                            .saveNote(
                              data.patient.id,
                              text ?? "",
                              notes.data?.current?.version ?? 0,
                              data.appointment.kind === "primary" ? "intake" : "session",
                              data.appointment.id,
                            )
                            .then(() => {
                              notes.reload();
                              reload();
                            }),
                        ut("visit.saved"),
                      )
                    }
                  >
                    {ut("visit.save")}
                  </Button>
                </div>
              </div>
            </Panel>

            <Actions data={data} busy={busy} run={run} reload={reload} />
          </div>
        </Page>
      )}
    </Screen>
  );
}

type Ctx = Awaited<ReturnType<typeof api.visitContext>>;

function History({ data }: { data: Ctx }) {
  const { ut } = useLang();
  return (
    <div className="flex flex-col gap-3">
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
              {data.previous.specialistName} · <Num>{day(data.previous.at)}</Num>
            </p>
          ) : (
            <p className="text-muted">{ut("visit.firstVisit")}</p>
          )}
          {data.followedSince ? (
            <p className="text-muted">
              {ut("visit.followedSince")} <Num>{day(data.followedSince)}</Num>
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

      <Panel title={ut("visit.changes")}>
        {data.changes.length === 0 ? (
          <Empty title={ut("visit.noChanges")} />
        ) : (
          <div className="flex flex-col">
            {data.changes.map((ch, i) => (
              <div
                key={i}
                className="flex items-baseline gap-2 border-t border-hairline px-4 py-2 text-caption first:border-t-0"
              >
                <Num className="w-[68px] shrink-0 text-muted">{day(ch.at)}</Num>
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
  const [surveyId, setSurveyId] = useState("");
  const [due, setDue] = useState("");
  const [attempts, setAttempts] = useState(1);
  const surveys = useResource(() => (open ? api.surveys() : Promise.resolve(null)), [open]);

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {ut("visit.assign")}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline p-2">
      <Field label={ut("visit.assignPick")}>
        <Select value={surveyId} onChange={(e) => setSurveyId(e.target.value)}>
          <option value="" />
          {(surveys.data ?? [])
            .filter((s) => s.status === "published")
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
        </Select>
      </Field>
      <Field label={ut("visit.assignDue")}>
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <Field label={ut("visit.assignAttempts")}>
        <Input
          type="number"
          min={1}
          max={10}
          value={attempts}
          onChange={(e) => setAttempts(Number(e.target.value))}
        />
      </Field>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !surveyId}
          onClick={() =>
            run(
              () =>
                api
                  .grant(surveyId, patientId, undefined, due || null, attempts)
                  .then(() => setOpen(false)),
              ut("visit.assigned"),
            )
          }
        >
          {ut("visit.assign")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
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
