import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { ResponseDetail } from "@quizzy/shared";
import { api, openInTab, type ConclusionState } from "../../api";
import { useAuth } from "../../auth";
import { dateTime, timeOfDay } from "../../format";
import { useDecimal } from "../../charts/kit";
import { useLang } from "../../lang";
import { AlertChip, AlertStrip, Avatar, Ic, RiskChip, RiskTimer, useAction, useHotkeys } from "../../ui";
import { cx } from "../../ui/cx";
import { Button, ButtonLink } from "../../ui/primitives";
import { reviewHref, signalStrip, signalTimer, signLockedBySignal, type ResponseContext } from "./context";
import { Rx } from "./icons";

/**
 * Рамка экранов прохождения (Polypsy 2.0): шапка пациента на полосе
 * тонировки — кружок, имя, факты, действия и строка открытого — липнет к
 * верху, под ней — содержимое с полями 20.
 *
 * Своя прокрутка, а не Page: шапка набора (`Page`) рисует заголовок экрана,
 * а здесь заголовок — имя человека в карточке на полосе, как в карточке
 * пациента (кадры methods-response, methods-conclusion).
 */
export function ResponseFrame({ banner, children }: { banner: ReactNode; children: ReactNode }) {
  return (
    <div tabIndex={0} className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden outline-none">
      {banner}
      <div className="px-5 pb-8 pt-4 max-[700px]:px-4">{children}</div>
    </div>
  );
}

export type BannerPlace = "protocol" | "charts" | "conclusion";

/**
 * Шапка пациента над протоколом.
 *
 * Строка открытого — то, что о человеке открыто сейчас: неразобранный
 * сигнал с таймером нормы разбора и «Розібрати», черновик заключения этого
 * прохождения (с замком, пока сигнал этого протокола не разобран),
 * недостоверный протокол, незавершённое прохождение. Всё — из данных; чего
 * сервер не знает (переписка, неявки, согласие), здесь нет.
 */
export function ResponseBanner({
  detail,
  ctx,
  conclusion,
  place,
}: {
  detail: ResponseDetail;
  /** null — обстановка ещё грузится или не пришла: шапка без строки открытого */
  ctx: ResponseContext | null;
  conclusion: ConclusionState | null;
  place: BannerPlace;
}) {
  const { ut } = useLang();
  const { can } = useAuth();
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const dec = useDecimal();
  const patient = ctx?.patient ?? null;
  const strip = signalStrip(ctx?.signals ?? null);
  const locked = signLockedBySignal(ctx?.signals ?? null);
  const conclusionHref = `/responses/${detail.id}/conclusion`;
  const protocolHref = `/surveys/${detail.survey.id}/responses/${detail.id}`;
  const completed = detail.status === "completed";
  const open = [...strip.openHere, ...strip.openElsewhere];
  const review = reviewHref(patient?.id ?? detail.userId);

  useHotkeys(
    {
      r: () => {
        if (open.length) navigate(review);
      },
      c: () => {
        if (completed && place !== "conclusion") navigate(conclusionHref);
      },
    },
    !!ctx,
  );

  const name = patient?.fullName ?? (detail.userId ? "—" : ut("rp.anonymous"));
  const facts: ReactNode[] = [];
  if (patient) {
    const sexWord = patient.sex ? ut(patient.sex === "male" ? "rp.sexMale" : "rp.sexFemale") : null;
    const age = patient.age !== null ? ut("rp.age").replace("{n}", String(patient.age)) : null;
    if (age || sexWord)
      facts.push(
        <Fact key="who" icon={<Rx.userRound size={15} />}>
          {age ? <b className="font-extrabold text-text">{age}</b> : null}
          {age && sexWord ? ", " : null}
          {sexWord}
        </Fact>,
      );
    if (patient.unit) facts.push(<Fact key="unit" icon={<Ic.idCard size={15} />}>{patient.unit}</Fact>);
    if (patient.lead)
      facts.push(
        <Fact key="lead" icon={<Ic.user size={15} />}>
          <span className="font-medium text-muted">{ut("rp.leads")}</span>{" "}
          <b className="font-extrabold text-text">{patient.lead.mine ? ut("rp.leadsMe") : patient.lead.name}</b>
        </Fact>,
      );
  } else {
    facts.push(
      <Fact key="survey" icon={<Ic.clipboard size={15} />}>
        {detail.survey.title}
      </Fact>,
    );
  }

  const timer = strip.oldest ? signalTimer(strip.oldest, ut("rp.hours"), dec) : null;
  const draft = conclusion?.current?.status === "draft" ? conclusion.current : null;
  const signed = conclusion?.versions.find((v) => v.status === "signed") ?? null;

  const chips: ReactNode[] = [];
  if (open.length) {
    chips.push(
      <RiskChip
        key="risk"
        title={open.length === 1 ? ut("rp.signal") : ut("rp.signals").replace("{n}", String(open.length))}
        timer={
          timer ? (
            <RiskTimer elapsed={timer.elapsed} of={timer.of} pct={timer.pct} />
          ) : (
            <span className="text-caption font-semibold text-text-2">{ut("rp.atTime").replace("{t}", timeOfDay(strip.oldest!.at))}</span>
          )
        }
        popTitle={open.length === 1 ? ut("rp.signal") : ut("rp.signals").replace("{n}", String(open.length))}
        pop={<SignalList signals={open} />}
        action={
          <ButtonLink to={review} variant="risk" size="xs" title={ut("rp.reviewHint")}>
            {ut("rp.review")}
          </ButtonLink>
        }
      />,
    );
  } else if (strip.reviewedHere.length) {
    const last = strip.reviewedHere[0]!;
    chips.push(
      <RiskChip
        key="risk-done"
        state="done"
        title={ut("rp.signalReviewed")}
        pop={<SignalList signals={strip.reviewedHere} />}
        popNote={last.reviewedAt ? dateTime(last.reviewedAt) : undefined}
      />,
    );
  }
  if (!completed) {
    chips.push(
      <AlertChip key="status" kind="warn" icon={<Ic.circleAlert />} label={ut(`rstatus.${detail.status}`, detail.status)} detail={dateTime(detail.startedAt)} />,
    );
  }
  if (ctx && !ctx.reliable) {
    chips.push(
      <AlertChip
        key="reliable"
        kind="warn"
        icon={<Ic.alert />}
        label={ut("rp.unreliable")}
        pop={<p className="m-0">{ut("rp.unreliableWhy")}</p>}
      />,
    );
  }
  if (draft) {
    chips.push(
      <AlertChip
        key="draft"
        icon={<Rx.filePen />}
        label={ut("rp.draftChip")}
        detail={ut("rp.versionN").replace("{n}", String(draft.version))}
        to={place === "conclusion" ? undefined : conclusionHref}
        onClick={place === "conclusion" ? focusEditor : undefined}
        pressed={place === "conclusion"}
        locked={locked}
        draft
        popTitle={ut("rp.draftChip")}
        pop={
          <>
            <p className="m-0">
              {draft.authorName}, {dateTime(draft.createdAt)}
            </p>
            {locked ? <p className="m-0 mt-1.5 text-risk-ink">{ut("rp.signLocked")}</p> : null}
          </>
        }
      />,
    );
  } else if (signed) {
    chips.push(
      <AlertChip
        key="signed"
        icon={<Ic.circleCheck />}
        label={ut("rp.signedChip")}
        detail={signed.signedAt ? dateTime(signed.signedAt) : undefined}
        to={place === "conclusion" ? undefined : conclusionHref}
        onClick={place === "conclusion" ? focusEditor : undefined}
        pressed={place === "conclusion"}
      />,
    );
  }

  const actions: ReactNode[] = [
    <Button
      key="print"
      size="icon"
      icon={<Rx.printer />}
      aria-label={ut("rp.print")}
      title={ut("rp.print")}
      disabled={busy}
      onClick={() => void run(() => openInTab(api.reportUrl(detail.id)))}
    />,
  ];
  if (place === "conclusion") {
    actions.push(
      <ButtonLink key="protocol" to={protocolHref}>
        <Ic.clipboard />
        {ut("rp.toProtocol")}
      </ButtonLink>,
    );
  }
  if (patient && can("patients.read")) {
    actions.push(
      <ButtonLink key="card" to={`/patients/${patient.id}`}>
        <Rx.contact />
        {ut("rp.card")}
      </ButtonLink>,
    );
  }
  if (place !== "conclusion" && completed) {
    actions.push(
      <ButtonLink key="concl" to={conclusionHref} title={ut("rp.conclusionHint")}>
        <Rx.filePen />
        {ut("rp.conclusion")}
      </ButtonLink>,
    );
  }

  return (
    <section
      aria-label={ut("rp.patient")}
      className="sticky top-0 z-30 shrink-0 border-b border-band-card-line bg-band px-4 pb-3.5 pt-3.5 max-[700px]:static"
    >
      <div className="rounded-drawer border border-band-card-line bg-band-card py-3 pl-3.5 pr-3 shadow-banner">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-3.5">
            <Avatar name={name} size={56} />
            <div className="flex min-w-0 flex-col gap-[5px]">
              <h1 className="m-0 truncate text-title font-extrabold tracking-[-0.03em] text-text">{name}</h1>
              <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[13px] font-semibold text-text-2">{facts}</span>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        </div>
        {chips.length ? <AlertStrip className="mt-3">{chips}</AlertStrip> : null}
      </div>
    </section>
  );
}

/** На экране заключения пилюля черновика ведёт к полю текста, а не на тот же адрес */
function focusEditor() {
  const area = document.getElementById("cn-text");
  area?.scrollIntoView({ block: "center" });
  area?.focus();
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span className="inline-flex text-violet-ink">{icon}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}

function SignalList({ signals }: { signals: ResponseContext["signals"] }) {
  const { ut } = useLang();
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {(signals ?? []).map((s) => (
        <li key={s.id} className="flex flex-col gap-0.5">
          <span className={cx("font-bold", s.reviewedAt ? "text-text" : "text-risk-ink")}>{s.label}</span>
          <span className="text-caption text-muted">
            {s.here ? ut("rp.signalHere") : s.surveyTitle}, {dateTime(s.at)}
            {s.reviewedAt
              ? `. ${ut("rp.reviewedBy").replace("{name}", s.reviewedByName ?? "—")}${s.outcome ? `: ${ut(`rp.outcome.${s.outcome}`)}` : ""}`
              : s.overdue
                ? `. ${ut("rp.overdue")}`
                : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Ссылка на соседнюю попытку той же вкладки: протокол ведёт к протоколу, графики — к графикам */
export function attemptHref(surveyId: string, id: string, charts: boolean): string {
  return charts ? `/surveys/${surveyId}/responses/${id}/charts` : `/surveys/${surveyId}/responses/${id}`;
}

