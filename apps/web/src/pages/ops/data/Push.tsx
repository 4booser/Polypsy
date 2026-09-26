import { useState } from "react";
import type { PushReport } from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, HBars, Kpi, TimeColumns } from "../../../charts/clinical";
import { dateTime, day, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Screen } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { GapLine } from "../obs2b/charts";
import { PLATFORM_LABEL, PUSH_KIND_LABEL, dayColumns, errorShare, pushCodeHint, pushErrors, type Window } from "./model";
import { KPI_GRID, NUM, Note, PAIR_GRID, TD, TH, WindowSwitch } from "./parts";

/** Кодов в полосах: остальные — в таблице ниже */
const TOP_CODES = 8;

/** Доля в процентах: «4,2 %» — по языку экрана */
const pct = (v: number) => `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(v)} %`;

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
 * Токенов на экране нет и быть не должно: токен — адрес устройства
 * человека, с ним уведомление уходит в обход системы. Сервер хранит и
 * отдаёт только отпечатки, и ошибки считаются «на скольких устройствах» по
 * ним (lib/push.ts, tokenFingerprint).
 */
export default function OpsPush() {
  const [days, setDays] = useState<Window>(30);
  const res = useResource(() => api.opsPush(days), [days]);
  return <Screen res={res}>{(data) => <PushBody data={data} days={days} onDays={setDays} />}</Screen>;
}

export function PushBody({ data, days, onDays }: { data: PushReport; days: Window; onDays: (w: Window) => void }) {
  const { ut } = useLang();
  const t = data.totals;
  const errors = pushErrors(t);
  const kindName = (kind: string) => (PUSH_KIND_LABEL[kind] ? ut(PUSH_KIND_LABEL[kind]!) : kind);

  return (
    <>
      <RuleSection title={ut("opsd.p.totals")} hint={ut("opsd.p.totalsHint")} actions={<WindowSwitch value={days} onChange={onDays} />}>
        {/*
          Журнал исходов появился с миграцией 0091: до неё сбой отправки
          снимал заявку и не оставлял следа (push_deliveries отвечает «решили
          ли отправить», а не «что вышло»). Пустые нули без этой строки
          читались бы как «сбоев не было никогда».
        */}
        <p className="m-0 mb-[16px] text-[13px] leading-[18px] text-muted">
          {data.since === null ? ut("opsd.p.noneYet") : fill(ut("opsd.p.since"), { at: dateTime(data.since) })}
        </p>
        <div className={KPI_GRID}>
          <Kpi label={ut("opsd.p.sent")} value={t.sent} />
          <Kpi label={ut("opsd.p.accepted")} value={t.accepted} />
          <Kpi label={ut("opsd.p.delivered")} value={t.delivered} />
          <Kpi label={ut("opsd.q.errors")} value={errors} tone={errors > 0 ? "attention" : "plain"} />
          <Kpi label={ut("opsd.p.awaiting")} value={t.awaitingReceipt} hint={ut("opsd.p.awaitingHint")} />
        </div>
        <div className={cx(PAIR_GRID, "mt-[28px]")}>
          <Figure title={ut("opsd.p.byDay")}>
            <TimeColumns columns={dayColumns(data.byDay, (d) => d.sent, day)} label={ut("opsd.p.byDay")} />
          </Figure>
          <Figure title={ut("opsd.p.errorsByDay")}>
            <TimeColumns columns={dayColumns(data.byDay, (d) => d.errors, day)} label={ut("opsd.p.errorsByDay")} />
          </Figure>
        </div>
      </RuleSection>

      <RuleSection title={ut("opsd.p.byKind")}>
        {data.byKind.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={TH}>{ut("opsd.p.kind")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.p.sent")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.p.errorsCol")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.p.deliveredCol")}</th>
                </tr>
              </thead>
              <tbody>
                {data.byKind.map((k) => {
                  const name = kindName(k.kind);
                  return (
                    <tr key={k.kind}>
                      <td className={TD}>{name}</td>
                      <td className={cx(TD, NUM)}>{k.sent}</td>
                      <td className={cx(TD, NUM, k.errors > 0 ? "text-accent" : "text-muted")}>{k.errors}</td>
                      <td className={cx(TD, NUM, "text-muted")}>{k.delivered}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted">{ut("opsd.p.nothing")}</p>
        )}
      </RuleSection>

      <RuleSection title={ut("opsd.p.errorCodes")} hint={ut("opsd.p.errorCodesHint")}>
        {/*
          Волна 11: над таблицей кодов — доля ошибок по дням (столбцы выше
          говорят «сколько», эта линия — «насколько плохо») и коды полосами,
          форма таблицы ниже. День без отправок — разрыв линии, а не ноль.
        */}
        {data.byDay.some((d) => d.sent > 0) ? (
          <div className={cx(PAIR_GRID, "mb-[28px]")}>
            <Figure title={ut("sig.p.share")} caption={ut("sig.p.shareCaption")}>
              <GapLine points={errorShare(data.byDay, day)} label={ut("sig.p.share")} format={pct} tick={pct} />
            </Figure>
            {/* кодов нет — «помилок немає» скажет место таблицы ниже, второй раз не повторяем */}
            {data.errors.length ? (
              <Figure title={ut("sig.p.codes")} caption={ut("sig.p.codesCaption")}>
                <HBars
                  items={data.errors.slice(0, TOP_CODES).map((e) => ({
                    key: e.code,
                    label: <span className="font-mono text-[12px]">{e.code}</span>,
                    value: e.count,
                  }))}
                />
              </Figure>
            ) : null}
          </div>
        ) : null}
        {data.errors.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={TH}>{ut("opsd.p.code")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.p.count")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.m.devicesCol")}</th>
                  <th scope="col" className={TH}>{ut("opsd.p.meaning")}</th>
                </tr>
              </thead>
              <tbody>
                {data.errors.map((e) => {
                  const hint = pushCodeHint(e.code);
                  return (
                    <tr key={e.code}>
                      <td className={cx(TD, "font-mono text-[12px] text-text")}>{e.code}</td>
                      <td className={cx(TD, NUM)}>{e.count}</td>
                      <td className={cx(TD, NUM, "text-muted")}>{e.tokens}</td>
                      <td className={cx(TD, "text-muted")}>{hint ? ut(hint) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted">{ut("opsd.p.noErrors")}</p>
        )}
      </RuleSection>

      <RuleSection title={ut("opsd.p.tokens")}>
        <div className={PAIR_GRID}>
          <div className="min-w-0">
            <div className={KPI_GRID}>
              <Kpi label={ut("opsd.p.registered")} value={data.tokens.registered} />
              <Kpi label={ut("opsd.p.stale")} value={data.tokens.stale} hint={ut("opsd.p.staleHint")} />
            </div>
            {data.tokens.byPlatform.length ? (
              <ul className="m-0 mt-[16px] list-none p-0">
                {data.tokens.byPlatform.map((p) => (
                  <li key={p.platform} className="flex items-baseline justify-between gap-[12px] border-b border-hairline py-[6px] text-[13px]">
                    <span className="text-text-2">{PLATFORM_LABEL[p.platform] ? ut(PLATFORM_LABEL[p.platform]!) : p.platform}</span>
                    <Num className="text-muted">{p.count}</Num>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <Figure title={ut("opsd.p.events")} caption={ut("opsd.p.eventsHint")}>
            <HBars items={data.events.map((e) => ({ key: e.kind, label: kindName(e.kind), value: e.count }))} />
          </Figure>
        </div>
        <Note>{ut("opsd.p.fingerprints")}</Note>
      </RuleSection>
    </>
  );
}
