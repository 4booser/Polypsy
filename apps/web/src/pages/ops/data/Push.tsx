import { useState, type ReactNode } from "react";
import type { PushReport } from "@quizzy/shared";
import { api } from "../../../api";
import { TimeColumns, TimeLines } from "../../../charts/clinical";
import { ATTENTION_COLOR } from "../../../charts/kit";
import { dateTime, dayFull } from "../../../format";
import { useLang } from "../../../lang";
import { DataTable, Empty, Screen, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { SectionPage } from "../people2/frame";
import { Ix } from "../people2/icons";
import { Id } from "./icons";
import {
  PLATFORM_LABEL,
  PUSH_KIND_LABEL,
  dayColumns,
  daysSince,
  errorShare,
  kindRows,
  pushCodeHint,
  pushErrors,
  pushPath,
  shareOf,
  shortPrint,
  type PathStep,
  type Window,
} from "./model";
import { Code, Facts, FootNote, Label, Masked, WindowSwitch, dayTick, dayWithYear, int, pct } from "./parts";

/**
 * Доля этапа пути — пилюлей: зелёной с галочкой, когда дошло почти всё
 * (от 99 %), янтарной, когда потеряна заметная часть (меньше 95 %): это
 * ровно «требует внимания». Между ними — нейтральной: число есть, тревоги нет.
 */
const SHARE_GOOD = 99;
const SHARE_WARN = 95;

/** Значок типа уведомления — тот же смысл, что у события в консоли */
const KIND_ICON: Record<string, ReactNode> = {
  alert: <Ic.alert size={15} />,
  mailing: <Id.megaphone size={15} />,
  appointment: <Id.calendarClock size={15} />,
  assignment: <Id.clipboardPlus size={15} />,
};

/**
 * «Пуш-сповіщення» — что ушло, что принял Expo, что он передал Apple и
 * Google, где и почему отказало.
 *
 * «Передано Apple/Google», а не «доставлено» — и это решение, а не
 * осторожность слога. Квитанция Expo говорит, что сообщение ушло в сервис
 * платформы; дошло ли оно до телефона, не сообщает никто — ни Expo, ни
 * Apple, ни Google. Цифра «доставлено» здесь была бы выдуманной, а цифры в
 * консоли — только настоящие.
 *
 * Путь — таблицей этапов, а не плитками: этап, сколько, доля от
 * предыдущего и что значит этап словами; плитки рядом читались бы как
 * четыре независимых числа, а это одна цепочка.
 *
 * Токенов на экране нет и быть не должно: токен — адрес устройства
 * человека, с ним уведомление уходит в обход системы. Сервер хранит и
 * отдаёт только отпечатки (lib/push.ts, tokenFingerprint), а панель
 * показывает на месте токена замок с точками.
 */
export default function OpsPush() {
  const { ut } = useLang();
  const [days, setDays] = useState<Window>(30);
  const res = useResource(() => api.opsPush(days), [days]);
  const data = res.data;
  const handed = data ? shareOf(data.totals.delivered, data.totals.sent) : null;

  return (
    <SectionPage
      title={ut("opsd.tab.push")}
      perm="ops.read"
      meta={
        data
          ? [
              fill(ut("oppd.p.metaSent"), { n: int(data.totals.sent) }),
              handed === null ? "" : fill(ut("oppd.p.metaHanded"), { p: pct(handed) }),
            ]
          : undefined
      }
      actions={<WindowSwitch value={days} onChange={setDays} />}
      lead={ut("oppd.p.lead")}
    >
      <Screen res={res}>{(d) => <PushBody data={d} />}</Screen>
    </SectionPage>
  );
}

export function PushBody({ data, now = Date.now() }: { data: PushReport; now?: number }) {
  const { ut } = useLang();
  const first = data.byDay[0]?.date;
  const last = data.byDay.at(-1)?.date;
  const anySent = data.byDay.some((d) => d.sent > 0);

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={ut("oppd.p.path")}
        icon={<Ix.send />}
        sub={first && last ? fill(ut("oppd.inWindow"), { from: dayTick(first), to: dayTick(last) }) : undefined}
        flush
        footer={
          <FootNote>
            {ut("oppd.p.pathNote")}{" "}
            {/*
              Журнал исходов появился с миграцией 0091: до неё сбой отправки
              снимал заявку и не оставлял следа. Пустые нули без этой строки
              читались бы как «сбоев не было никогда».
            */}
            {data.since === null ? ut("opsd.p.noneYet") : fill(ut("opsd.p.since"), { at: dateTime(data.since) })}
          </FootNote>
        }
      >
        <PathTable totals={data.totals} />
      </Panel>

      <div className="@container">
        <div className={cx("grid items-stretch gap-4", anySent && "@min-[860px]:grid-cols-2")}>
          <Panel title={ut("opsd.p.byDay")} icon={<Ix.chartColumn />} sub={ut("oppd.p.allKinds")}>
            <TimeColumns
              columns={dayColumns(data.byDay, (d) => d.sent, dayTick).map((c) => ({ ...c, tip: dayFull(c.key) }))}
              label={ut("opsd.p.byDay")}
            />
          </Panel>
          {/* доля ошибок — только когда было что отправлять: «0 % ошибок» в пустой день звучит как «всё дошло» */}
          {anySent ? (
            <Panel title={ut("sig.p.share")} icon={<Ic.chart />}>
              <TimeLines
                x={data.byDay.map((d) => ({ key: d.date, label: dayTick(d.date), tip: dayFull(d.date) }))}
                series={[
                  {
                    key: "share",
                    label: ut("sig.p.share"),
                    color: ATTENTION_COLOR,
                    values: errorShare(data.byDay, dayTick).map((p) => p.value),
                  },
                ]}
                label={ut("sig.p.share")}
                format={pct}
              />
              <p className="m-0 mt-2 text-caption text-muted">{ut("sig.p.shareCaption")}</p>
            </Panel>
          ) : null}
        </div>
      </div>

      <div className="@container">
        <div className="grid items-start gap-4 @min-[860px]:grid-cols-2">
          <Kinds byKind={data.byKind} events={data.events} />
          <Codes errors={data.errors} total={pushErrors(data.totals)} />
        </div>
      </div>

      <Tokens tokens={data.tokens} now={now} />
    </div>
  );
}

/* ─────────── путь уведомления ─────────── */

function PathTable({ totals }: { totals: PushReport["totals"] }) {
  const { ut } = useLang();
  const columns: Column<PathStep>[] = [
    { key: "stage", header: ut("oppd.p.stage"), required: true, width: 240, render: (s) => <b className="font-extrabold text-text">{ut(s.label)}</b> },
    {
      key: "value",
      header: ut("oppd.q.count"),
      num: true,
      required: true,
      width: 110,
      render: (s) => <b className="text-[15px] font-extrabold text-text">{int(s.value)}</b>,
    },
    {
      key: "share",
      header: ut("oppd.p.fromPrev"),
      required: true,
      width: 180,
      render: (s) =>
        s.share !== null ? (
          <Tag
            tone={s.share >= SHARE_GOOD ? "good" : s.share < SHARE_WARN ? "attention" : "plain"}
            icon={s.share >= SHARE_GOOD ? <Ic.check /> : s.share < SHARE_WARN ? <Ic.alert /> : undefined}
            className="tabular-nums"
          >
            {pct(s.share)}
          </Tag>
        ) : (
          <span className="text-muted">
            {s.key === "sent" ? ut("oppd.p.start") : s.key === "awaiting" ? ut("oppd.p.inTransit") : "—"}
          </span>
        ),
    },
    { key: "means", header: ut("opsd.p.meaning"), required: true, render: (s) => <span className="text-text-2">{ut(s.means)}</span> },
  ];
  return <DataTable rows={pushPath(totals)} columns={columns} rowKey={(s) => s.key} label={ut("oppd.p.path")} dense sticky={false} />;
}

/* ─────────── по типам ─────────── */

function Kinds({ byKind, events }: { byKind: PushReport["byKind"]; events: PushReport["events"] }) {
  const { ut } = useLang();
  const rows = kindRows(byKind, events);
  const name = (kind: string) => (PUSH_KIND_LABEL[kind] ? ut(PUSH_KIND_LABEL[kind]!) : kind);
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "kind",
      header: ut("opsd.p.kind"),
      required: true,
      render: (k) => {
        /* тип — словом из словаря; незнакомый сервер присылает кодом, и он печатается как есть */
        const title = name(k.kind);
        return (
          <span className="flex items-center gap-2">
            <span aria-hidden className="inline-flex shrink-0 text-muted">
              {KIND_ICON[k.kind] ?? <Ic.bell size={15} />}
            </span>
            <b className="font-bold text-text">{title}</b>
          </span>
        );
      },
    },
    { key: "events", header: ut("oppd.p.events"), num: true, required: true, width: 76, render: (k) => int(k.events) },
    { key: "sent", header: ut("opsd.p.sent"), num: true, required: true, width: 104, render: (k) => int(k.sent) },
    {
      key: "errors",
      header: ut("opsd.p.errorsCol"),
      num: true,
      required: true,
      width: 88,
      render: (k) => <span className={cx(k.errors > 0 ? "font-extrabold text-warn" : "text-muted")}>{int(k.errors)}</span>,
    },
    { key: "delivered", header: ut("opsd.p.deliveredCol"), num: true, required: true, width: 92, render: (k) => int(k.delivered) },
  ];
  return (
    <Panel title={ut("opsd.p.byKind")} icon={<Ic.bell />} flush footer={<FootNote>{ut("opsd.p.eventsHint")}</FootNote>}>
      {rows.length ? (
        <DataTable rows={rows} columns={columns} rowKey={(k) => k.kind} label={ut("opsd.p.byKind")} dense sticky={false} />
      ) : (
        <div className="px-4">
          <Empty compact title={ut("opsd.p.nothing")} />
        </div>
      )}
    </Panel>
  );
}

/* ─────────── коды ошибок ─────────── */

function Codes({ errors, total }: { errors: PushReport["errors"]; total: number }) {
  const { ut } = useLang();
  const columns: Column<PushReport["errors"][number]>[] = [
    { key: "code", header: ut("opsd.p.code"), required: true, width: 190, render: (e) => <span className="break-all font-mono text-[12px] text-text">{e.code}</span> },
    { key: "count", header: ut("opsd.p.count"), num: true, required: true, width: 64, render: (e) => <b className="font-extrabold">{int(e.count)}</b> },
    { key: "tokens", header: ut("opsd.m.devicesCol"), num: true, required: true, width: 84, render: (e) => <span className="text-muted">{int(e.tokens)}</span> },
    {
      key: "meaning",
      header: ut("opsd.p.meaning"),
      required: true,
      render: (e) => {
        const hint = pushCodeHint(e.code);
        return <span className="text-text-2">{hint ? ut(hint) : "—"}</span>;
      },
    },
  ];
  return (
    <Panel
      title={ut("opsd.p.errorCodes")}
      icon={<Ix.octagonAlert />}
      sub={fill(ut("oppd.inWindowN"), { n: int(total) })}
      flush
      footer={<FootNote>{ut("opsd.p.errorCodesHint")}</FootNote>}
    >
      {errors.length ? (
        <DataTable rows={errors} columns={columns} rowKey={(e) => e.code} label={ut("opsd.p.errorCodes")} dense sticky={false} />
      ) : (
        <div className="px-4">
          <Empty compact title={ut("opsd.p.noErrors")} />
        </div>
      )}
    </Panel>
  );
}

/* ─────────── токены ─────────── */

function Tokens({ tokens, now }: { tokens: PushReport["tokens"]; now: number }) {
  const { ut } = useLang();
  const platform = (p: string) => (PLATFORM_LABEL[p] ? ut(PLATFORM_LABEL[p]!) : p);
  return (
    <Panel title={ut("opsd.p.tokens")} icon={<Ix.keyRound />}>
      <div className="@container">
        <div className="grid gap-x-8 gap-y-5 @min-[760px]:grid-cols-[300px_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="m-0 mb-2 text-caption text-muted">{ut("opsd.p.fingerprints")}</p>
            <Facts
              rows={[
                {
                  key: "registered",
                  label: ut("opsd.p.registered"),
                  value: int(tokens.registered),
                  note: tokens.byPlatform.map((p) => `${platform(p.platform)} ${int(p.count)}`).join(", ") || undefined,
                },
                {
                  key: "stale",
                  label: ut("opsd.p.stale"),
                  value: int(tokens.stale),
                  warn: tokens.stale > 0,
                  note: ut("opsd.p.staleHint"),
                },
              ]}
            />
          </div>
          {tokens.oldest.length ? (
            <div className="min-w-0">
              <Label className="mb-1">{ut("oppd.p.oldest")}</Label>
              <ul className="m-0 list-none p-0">
                {tokens.oldest.map((t) => (
                  <li
                    key={t.fingerprint}
                    className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider py-2 first:border-t-0"
                  >
                    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-sunk text-muted">
                      <Ix.smartphone size={14} />
                    </span>
                    <span className="w-[72px] shrink-0 text-small font-semibold text-text-2">{platform(t.platform)}</span>
                    <Masked />
                    <span className="flex items-center gap-1.5 text-caption text-muted">
                      {ut("oppd.p.print")}
                      <Code>{shortPrint(t.fingerprint)}</Code>
                    </span>
                    <span className="ml-auto text-caption text-muted">
                      {fill(ut("oppd.p.lastSeen"), { at: dayWithYear(t.lastSeenAt), n: daysSince(t.lastSeenAt, now) })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
