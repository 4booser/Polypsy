import { useMemo, useState } from "react";
import type { Referral, ReferralDestination, ReferralPage, ReferralUrgency, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { DrawerSection, Empty, Ic, Loading, TextAction, useAction, type DrawerPaneProps } from "../../ui";
import { Panel } from "../../ui/layout";
import { Button, ChoiceCard, Segmented, Tag, Textarea } from "../../ui/primitives";
import type { Resource } from "../../useResource";
import { ShellIcon } from "../../shell/icons";
import { capital, ddmm } from "../patients/model";
import { DESTINATION_KEY, URGENCY_KEY } from "../referrals/model";
import { NEXT_STATUS, StatusTag, UrgencyTag } from "../Referrals";
import { locale } from "../../format";
import type { CardView } from "./types";

/*
 * «Направлення» рабочего места: куда, срочность, состояние, повод и ответ
 * принимающей стороны — и следующий шаг состояния на месте строки. Прежде —
 * панель «Огляду справи» клинической карты, которая ради неё читала сводку
 * консилиума целиком (баллы и RCI по всем методикам); теперь — направления
 * этого человека из реестра (GET /api/referrals?patient=).
 *
 * Выписывают в ящике (кадр patients-referral-new): «Виписати направлення»
 * здесь и в меню шапки открывают один и тот же вид.
 */

export function ReferralsTab({ v, res }: { v: CardView; res: Resource<ReferralPage> }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const list = res.data?.items ?? [];
  const th = "h-9 border-b border-divider bg-panel-2 px-2.5 text-left text-caption font-bold text-muted first:pl-4 last:pr-4";
  const td = "border-b border-divider px-2.5 py-2.5 align-top first:pl-4 last:pr-4";
  return (
    <Panel
      title={ut("ref.title")}
      icon={<ShellIcon name="arrow-right-left" />}
      count={list.length || null}
      actions={
        <>
          <TextAction to="/referrals">{ut("case.allReferrals")}</TextAction>
          <Button size="xs" icon={<Ic.plus />} onClick={() => v.open("referral")}>
            {ut("ref.new")}
          </Button>
        </>
      }
      flush
    >
      {!res.data ? (
        <div className="px-4 pb-4">
          <Loading rows={3} bare error={res.error} onRetry={res.reload} />
        </div>
      ) : !list.length ? (
        <div className="px-4 pb-1">
          <Empty compact title={ut("ref.none")} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-small">
            <thead>
              <tr>
                <th className={th}>{ut("ref.where")}</th>
                <th className={th}>{ut("ref.urgency")}</th>
                <th className={th}>{ut("ref.status")}</th>
                <th className={th}>{ut("case.reasonAnswer")}</th>
                <th className={th}>{ut("ref.issued")}</th>
                <th className={th} aria-label={ut("kit.rowActions")} />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className={`${td} font-bold text-text`}>{capital(ut(DESTINATION_KEY[r.destination]))}</td>
                  {/* те же пилюли, что в реестре направлений: «негайно» — красным, это риск для человека */}
                  <td className={td}>
                    <UrgencyTag urgency={r.urgency} />
                  </td>
                  <td className={td}>
                    <StatusTag status={r.status} />
                  </td>
                  <td className={`${td} max-w-[320px]`}>
                    <span className="block text-text">{r.reason ?? "—"}</span>
                    {r.outcomeNote ? (
                      <span className="mt-0.5 block text-caption text-good">
                        <b>{ut("ref.answer")}:</b> {r.outcomeNote}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <span className="block text-text">{ddmm(r.createdAt, locale())}</span>
                    <span className="text-caption text-muted">{r.createdByName}</span>
                  </td>
                  <td className={td}>
                    <span className="flex justify-end gap-1.5 print:hidden">
                      {(NEXT_STATUS[r.status] ?? []).map((n) => (
                        <Button
                          key={n.value}
                          size="xs"
                          variant={n.value === "declined" ? "quiet" : "secondary"}
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              /*
                               * Перечитать и на отказе: 409 значит, что направление
                               * успел сдвинуть кто-то другой (волна 15), и кнопки
                               * должны встать по его нынешнему состоянию. Фраза
                               * отказа — от сервера.
                               */
                              try {
                                v.refresh.referral(await api.updateReferral(r.id, n.value));
                                v.refresh.timeline();
                              } finally {
                                res.reload();
                              }
                            }, ut(n.key))
                          }
                        >
                          {ut(n.key)}
                        </Button>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ─────────── «Виписати направлення» ─────────── */

const DESTINATIONS: { value: ReferralDestination; sub: UiKey }[] = [
  { value: "psychiatrist", sub: "case.destPsychiatrist" },
  { value: "inpatient", sub: "case.destInpatient" },
  { value: "outpatient", sub: "case.destOutpatient" },
  { value: "commander", sub: "case.destCommander" },
  { value: "other", sub: "case.destOther" },
];

/**
 * Ящик направления (кадр patients-referral-new): куда (пять вариантов),
 * терміновість с пояснением, підстава. Направление выписывается тем же
 * маршрутом, что и раньше (POST /api/referrals); дальше оно живёт на экране
 * направлений и здесь: виписано → прийнято → завершено (или відхилено).
 */
export function useReferralPane(v: CardView, onDone: (r: Referral) => void, onCancel: () => void): DrawerPaneProps {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [destination, setDestination] = useState<ReferralDestination>("psychiatrist");
  const [urgency, setUrgency] = useState<ReferralUrgency>("routine");
  const [reason, setReason] = useState("");
  const dirty = reason.trim() !== "" || destination !== "psychiatrist" || urgency !== "routine";
  const urgencyNote = useMemo(
    () => ({ routine: ut("case.urgRoutine"), urgent: ut("case.urgUrgent"), immediate: ut("case.urgImmediate") })[urgency],
    [urgency, ut],
  );
  const risky = !!v.cases?.length;
  const issue = () =>
    run(async () => {
      const created = await api.createReferral({ userId: v.id, destination, urgency, reason: reason.trim() || null });
      setReason("");
      setDestination("psychiatrist");
      setUrgency("routine");
      onDone(created);
    }, ut("ref.issuedToast"));

  return {
    mode: "referral",
    title: ut("ref.new"),
    sub: risky ? ut("case.refSubSignal") : ut("case.refSub"),
    icon: <ShellIcon name="arrow-right-left" />,
    dirty,
    draftName: ut("case.refDraft"),
    note: ut("case.refLifecycle"),
    noteIcon: <Ic.list />,
    footer: (
      <>
        <Button variant="primary" icon={<ShellIcon name="arrow-right-left" />} disabled={busy} onClick={() => void issue()}>
          {ut("ref.issue")}
        </Button>
        <Button onClick={onCancel}>{ut("common.cancel")}</Button>
      </>
    ),
    children: (
      <>
        <DrawerSection>
          <div className="flex items-center gap-3 rounded-panel bg-sunk px-3.5 py-3">
            <span className="min-w-0 flex-1">
              <b className="block truncate text-body font-extrabold text-text">{v.card.fullName}</b>
              {v.card.unit ? <small className="block truncate text-caption text-muted">{v.card.unit}</small> : null}
            </span>
            {risky ? (
              <Tag tone="danger" icon={<Ic.alert />}>
                {ut("card.case")}
              </Tag>
            ) : null}
          </div>
        </DrawerSection>
        <DrawerSection title={ut("ref.where")}>
          <div role="radiogroup" aria-label={ut("ref.where")} className="grid grid-cols-2 gap-1.5 max-[520px]:grid-cols-1">
            {DESTINATIONS.map((d) => (
              <ChoiceCard
                key={d.value}
                name="referral-destination"
                value={d.value}
                checked={destination === d.value}
                onChange={(val) => setDestination(val as ReferralDestination)}
                title={capital(ut(DESTINATION_KEY[d.value]))}
                sub={ut(d.sub)}
              />
            ))}
          </div>
        </DrawerSection>
        <DrawerSection title={ut("ref.urgency")}>
          <Segmented
            wide
            label={ut("ref.urgency")}
            value={urgency}
            onChange={setUrgency}
            items={(["routine", "urgent", "immediate"] as const).map((u) => ({ key: u, label: capital(ut(URGENCY_KEY[u])) }))}
          />
          <p className="m-0 mt-2 text-caption text-text-2">{urgencyNote}</p>
        </DrawerSection>
        <DrawerSection title={ut("ref.reason")}>
          <Textarea
            value={reason}
            rows={5}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            placeholder={ut("ref.reasonPlaceholder")}
            aria-label={ut("ref.reason")}
          />
        </DrawerSection>
      </>
    ),
  };
}
