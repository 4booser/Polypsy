import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import type { AlertCase, AlertSignalBasis, RespondentDynamics, SafetyPlan } from "@quizzy/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useLang } from "../lang";
import { radius, useColors } from "../theme";
import { Btn } from "../ui/Button";
import { Field } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { Callout } from "../ui/Panel";
import { BottomSheet } from "../ui/Sheet";
import { T } from "../ui/Text";
import { useToast } from "../ui/Toast";
import { refreshStaffBadges } from "./badges";
import { caseClock, clock, dm, hm, num, shortName } from "./model";
import { reviewDrafts, type ReviewOutcome } from "./reviewDrafts";
import { Chip, History, TimerBar, useClockText } from "./ui";

/*
 * Разбор сигнала — лист снизу, телефонная форма ящика разбора консоли.
 *
 * Что в нём: часы до нормы, основание каждого сигнала (пункт и что
 * отмечено, или полоса шкалы), ход шкалы этой методики, план безопасности
 * с теми, кому звонить, и доступом к средствам, решение и что вжито.
 * Решение обязательно: «посмотрел и закрыл» здесь нельзя, по исходам
 * калибруются пороги скрининга.
 *
 * Чего нет, хотя в макете есть: C-SSRS (в приложении такой методики разбора
 * нет) и передачи черговому (дежурств в приложении нет — duty_shifts
 * выведены из схемы). Вместо передачи — «Взяти на себе / Відпустити»: так
 * двое не разбирают одного человека дважды.
 */

type Outcome = ReviewOutcome;
const OUTCOMES: { value: Outcome; key: "mal.confirmed" | "mal.needsFollowup" | "mal.notConfirmed"; sub: "mst.outConfirmed" | "mst.outFollowup" | "mst.outNot" }[] = [
  { value: "confirmed", key: "mal.confirmed", sub: "mst.outConfirmed" },
  { value: "needs_followup", key: "mal.needsFollowup", sub: "mst.outFollowup" },
  { value: "not_confirmed", key: "mal.notConfirmed", sub: "mst.outNot" },
];

export function ReviewSheet({
  item,
  norm,
  onClose,
  onDone,
}: {
  /** Случай; null — лист закрыт */
  item: AlertCase | null;
  norm: number | null;
  onClose: () => void;
  /** Решение сохранено или случай взят — список перечитать */
  onDone: () => void;
}) {
  const c = useColors();
  const { ut } = useLang();
  const { user } = useAuth();
  const toast = useToast();
  const of = useClockText();

  const [shown, setShown] = useState<AlertCase | null>(item);
  const [basis, setBasis] = useState<AlertSignalBasis[] | null>(null);
  const [plan, setPlan] = useState<SafetyPlan | null | undefined>(undefined);
  const [dyn, setDyn] = useState<RespondentDynamics | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "assign" | null>(null);
  const [now, setNow] = useState(Date.now());
  const touched = useRef(false);

  // лист закрывается анимацией: случай держим, пока он уезжает
  useEffect(() => {
    if (item) setShown(item);
  }, [item]);

  /*
   * Черновик разбора — того, кто его набирал (staff/reviewDrafts.ts): на
   * общем планшете следующий специалист чужого решения и заметки не видит.
   */
  const owner = user?.id ?? null;

  useEffect(() => {
    if (!item) return;
    const d = reviewDrafts.get(owner, item.id);
    setOutcome(d?.outcome ?? null);
    setNote(d?.note ?? "");
    touched.current = false;
    setMissing(false);
    setError(null);
    setBasis(null);
    setPlan(undefined);
    setDyn(null);
    setNow(Date.now());
    let live = true;
    api
      .caseSignals(item.id)
      .then((r) => live && setBasis(r.items))
      .catch(() => live && setBasis([]));
    api
      .patientSafetyPlan(item.userId)
      .then((r) => live && setPlan(r.versions[0] ?? null))
      .catch(() => live && setPlan(null));
    api
      .respondentDynamics(item.userId)
      .then((d) => live && setDyn(d))
      .catch(() => {});
    // часы разбора идут, пока лист открыт
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [item, owner]);

  const remember = (next: { outcome?: Outcome | null; note?: string }) => {
    if (!item) return;
    touched.current = true;
    const d = { outcome: next.outcome !== undefined ? next.outcome : outcome, note: next.note !== undefined ? next.note : note };
    reviewDrafts.set(owner, item.id, d);
  };

  const close = () => {
    if (item && touched.current && (outcome || note.trim())) {
      toast.show(ut("mst.draftKept").replace("{who}", shortName(item.userName)), { icon: "cloud-check" });
    }
    onClose();
  };

  const save = async () => {
    if (!item) return;
    if (!outcome) {
      setMissing(true);
      return;
    }
    setBusy("save");
    setError(null);
    try {
      await api.resolveCase(item.id, outcome, note.trim() || undefined, item.lastAlertAt);
      reviewDrafts.drop(owner, item.id);
      touched.current = false;
      toast.show(ut("mst.reviewSaved").replace("{t}", hm(new Date())), { icon: "check-check" });
      refreshStaffBadges();
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : ut("mal.saveFailed");
      /*
       * 409 — пока человек читал основание, случай изменился: пришёл новый
       * сигнал или его разобрал другой. Решение по старому случаю не
       * сохраняется; лист закрывается, список перечитывается, а черновик
       * остаётся — открыть заново и решить уже с новым сигналом.
       */
      if ((e as { status?: number }).status === 409) {
        toast.show(message, { icon: "circle-alert" });
        onDone();
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  };

  const mine = !!shown?.assignedTo && shown.assignedTo === user?.id;
  const other = !!shown?.assignedTo && !mine;
  const assign = async () => {
    if (!item) return;
    setBusy("assign");
    setError(null);
    try {
      await api.assignCase(item.id, mine);
      toast.show(mine ? ut("mst.released") : ut("mst.taken"), { icon: "check" });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("mal.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const k = shown ? caseClock(shown.openedAt, norm, now) : null;
  const survey = dyn?.surveys.find((s) => s.surveyId === shown?.surveyId);
  const course = survey?.scales.filter((s) => s.points.length > 1) ?? [];

  return (
    <BottomSheet
      visible={!!item}
      onClose={close}
      title={ut("mst.reviewTitle")}
      sub={shown ? `${shortName(shown.userName)}, ${shown.surveyTitle}, ${dm(shown.lastAlertAt)}, ${hm(shown.lastAlertAt)}` : undefined}
      footer={
        <>
          {error ? (
            <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }} accessibilityLiveRegion="polite">
              <Icon name="circle-alert" size={16} color={c.riskink} />
              <T v="sub" weight={700} color={c.riskink} style={{ flex: 1 }}>
                {error}
              </T>
            </View>
          ) : null}
          <Btn title={ut("mst.saveReview")} kind="primary" size="l" icon="check-check" full loading={busy === "save"} disabled={!!busy && busy !== "save"} onPress={() => void save()} />
          {other ? (
            <T v="sub" center>
              {ut("mal.takenBy").replace("{who}", shown?.assignedToName ?? "—")}
            </T>
          ) : (
            <Btn title={mine ? ut("mst.release") : ut("mal.take")} size="m" icon={mine ? "x" : "user-round"} full loading={busy === "assign"} disabled={!!busy && busy !== "assign"} onPress={() => void assign()} />
          )}
        </>
      }
    >
      {shown && k ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          {/* часы разбора: сколько прошло, норма и когда она истекает */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 54, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.panel, backgroundColor: c.risktint }}>
            <Icon name="timer" size={16} color={c.riskink} />
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
              <T v="number" size={26} color={c.riskink} num scale={false}>
                {clock(k.elapsed)}
              </T>
              <T v="sub" size={13.5} weight={700} tone="text2" scale={false}>
                {of(k)}
              </T>
            </View>
            {k.norm ? <TimerBar pct={k.pct} width={48} /> : null}
            {k.due && k.left !== null ? (
              <T v="sub" size={13.5} tone="text2" style={{ flex: 1, textAlign: "right" }} num>
                {(k.over ? ut("mst.dueOver") : ut("mst.dueLeft")).replace("{t}", hm(k.due)).replace("{l}", clock(Math.abs(k.left)))}
              </T>
            ) : null}
          </View>

          {/* основание: что именно сработало */}
          {basis === null ? (
            <Sec title={ut("mst.basis")}>
              <T v="sub">{ut("mst.loading")}</T>
            </Sec>
          ) : basis.length === 0 ? (
            <Sec title={ut("mst.basis")}>
              {shown.signals.map((s) => (
                <T key={s.id} v="note">
                  {s.label}
                </T>
              ))}
            </Sec>
          ) : (
            basis.map((b) => <BasisBlock key={b.id} b={b} />)
          )}

          {course.length ? (
            <View style={{ marginTop: 10, gap: 4 }}>
              {course.map((s) => (
                <View key={s.scaleId} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                  <T v="sub" weight={700} tone="text2">
                    {s.code || s.title}
                  </T>
                  <History values={[...s.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).slice(-4).map((p) => p.rawScore)} />
                </View>
              ))}
            </View>
          ) : null}

          {/* план безопасности: кому звонить и доступ к средствам */}
          <Sec
            title={ut("mst.safetyPlan")}
            sub={plan ? ut("mst.planVersion").replace("{v}", String(plan.version)).replace("{d}", dm(plan.reviewedAt ?? plan.createdAt)) : undefined}
          >
            {plan === undefined ? (
              <T v="sub">{ut("mst.loading")}</T>
            ) : plan === null ? (
              <Callout kind="warn" icon="shield-alert" text={ut("mst.noPlan")} />
            ) : (
              <View>
                {[...plan.content.people, ...plan.content.professionals].map((p, i) => (
                  <Contact key={`${p.name}${i}`} name={p.name} contact={p.contact} first={i === 0} />
                ))}
                {plan.content.meansRestriction ? (
                  <View style={{ flexDirection: "row", gap: 10, marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: c.sunk }}>
                    <Icon name="shield-alert" size={17} color={c.vink} />
                    <View style={{ flex: 1 }}>
                      <T v="sub" weight={800} tone="text">
                        {ut("mst.means")}
                      </T>
                      <T v="sub" tone="text2">
                        {plan.content.meansRestriction}
                      </T>
                    </View>
                  </View>
                ) : null}
              </View>
            )}
          </Sec>

          {/* решение: одно о человеке, а не о каждом пункте */}
          <Sec title={ut("mst.decision")} sub={ut("mst.decisionRequired")}>
            <View accessibilityRole="radiogroup" accessibilityLabel={ut("mst.decision")} style={{ gap: 8 }}>
              {OUTCOMES.map((o) => (
                <Choice
                  key={o.value}
                  title={ut(o.key)}
                  sub={ut(o.sub)}
                  on={outcome === o.value}
                  onPress={() => {
                    setOutcome(o.value);
                    setMissing(false);
                    remember({ outcome: o.value });
                  }}
                />
              ))}
            </View>
            {missing ? (
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center", marginTop: 8 }} accessibilityLiveRegion="polite">
                <Icon name="circle-alert" size={16} color={c.riskink} />
                <T v="sub" weight={700} color={c.riskink}>
                  {ut("mst.pickDecision")}
                </T>
              </View>
            ) : null}
            <View style={{ marginTop: 14 }}>
              <Field
                label={ut("mal.whatDone")}
                value={note}
                multiline
                onChangeText={(t) => {
                  setNote(t);
                  remember({ note: t });
                }}
                placeholder={ut("mal.example")}
              />
            </View>
          </Sec>
        </View>
      ) : null}
    </BottomSheet>
  );
}

function Sec({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={{ paddingTop: 16, marginTop: 16, borderTopWidth: 1, borderTopColor: c.divider, gap: 8 }}>
      <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: 8 }}>
        <T v="headline" size={17}>
          {title}
        </T>
        {sub ? (
          <T v="sub" size={13.5}>
            {sub}
          </T>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** Основание одного сигнала: пункт, вопрос, что отмечено — или шкала, значение и полоса */
function BasisBlock({ b }: { b: AlertSignalBasis }) {
  const c = useColors();
  const { ut } = useLang();
  const head =
    b.kind === "band"
      ? (b.scaleCode || b.scaleTitle || b.surveyTitle)
      : b.questionNumber !== null
        ? `${b.surveyTitle}, ${ut("mst.item").replace("{n}", String(b.questionNumber))}`
        : b.surveyTitle;
  return (
    <Sec title={head ?? b.label} sub={`${dm(b.at)}, ${hm(b.at)}`}>
      {b.kind === "band" ? (
        <View style={{ gap: 6 }}>
          <T v="note">{b.scaleTitle ?? b.label}</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {b.scaleValue !== null ? (
              <T v="number" size={26} num scale={false}>
                {num(b.scaleValue)}
              </T>
            ) : null}
            {b.bandLabel ? <Chip label={b.bandLabel} kind={b.severity === "severe" ? "risk" : "warn"} /> : null}
            {b.bandMin !== null && b.bandMax !== null ? (
              <T v="sub">{ut("mst.bandRange").replace("{a}", num(b.bandMin)).replace("{b}", num(b.bandMax))}</T>
            ) : null}
          </View>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {b.questionTitle ? (
            <View style={{ padding: 12, borderRadius: 12, backgroundColor: c.sunk }}>
              <T v="note" tone="text">
                {b.questionTitle}
              </T>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <T v="sub" size={13} weight={700}>
              {ut("mst.answer")}
            </T>
            {b.pickedOptions.length
              ? b.pickedOptions.map((o) => <Chip key={o} label={o} kind={b.severity === "severe" ? "risk" : "warn"} />)
              : b.answeredNumber !== null
                ? <Chip label={num(b.answeredNumber)} kind={b.severity === "severe" ? "risk" : "warn"} />
                : <T v="sub">{b.label}</T>}
          </View>
        </View>
      )}
    </Sec>
  );
}

/** Контакт плана: имя, как связаться и звонок одним нажатием, если это номер */
function Contact({ name, contact, first }: { name: string; contact: string; first: boolean }) {
  const c = useColors();
  const { ut } = useLang();
  const tel = contact.replace(/[^\d+]/g, "");
  const callable = tel.replace(/\D/g, "").length >= 3;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderTopWidth: first ? 0 : 1, borderTopColor: c.divider }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="body" size={15} weight={700}>
          {name}
        </T>
        <T v="sub" num>
          {contact}
        </T>
      </View>
      {callable ? (
        <Btn title="" icon="phone" size="d" accessibilityLabel={ut("mst.call").replace("{who}", name)} onPress={() => void Linking.openURL(`tel:${tel}`)} />
      ) : null}
    </View>
  );
}

/** Карточка-выбор решения: кружок, решение и что оно значит */
function Choice({ title, sub, on, onPress }: { title: string; sub: string; on: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${title}. ${sub}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: on ? 1.5 : 1,
        borderColor: on ? c.v : c.border,
        backgroundColor: on ? c.vtint : pressed ? c.panel2 : c.panel,
      })}
    >
      <View style={{ width: 20, height: 20, marginTop: 1, borderRadius: 10, borderWidth: 2, borderColor: on ? c.v : c.field, alignItems: "center", justifyContent: "center" }}>
        {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.v }} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="body" size={15} weight={800}>
          {title}
        </T>
        <T v="sub" size={13.5}>
          {sub}
        </T>
      </View>
    </Pressable>
  );
}
