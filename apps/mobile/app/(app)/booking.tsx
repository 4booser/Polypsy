import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AppointmentView, FreeSlot } from "@quizzy/shared";
import { api } from "@/api/client";
import { Loader } from "@/components/ui";
import { Avatar, personName } from "@/components/patient/Avatar";
import { Hero } from "@/components/patient/Hero";
import { font } from "@/fonts";
import { useLang } from "@/lang";
import { radius, useColors, useIsDark, useShadows } from "@/theme";
import { useTextScale } from "@/textScale";
import { Btn } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Callout, List, SectionHead } from "@/ui/Panel";
import { Pill } from "@/ui/Pill";
import { BottomSheet } from "@/ui/Sheet";
import { T } from "@/ui/Text";
import { useToast } from "@/ui/Toast";

type Specialist = Awaited<ReturnType<typeof api.specialists>>["items"][number];
type Booked = { id: string; slot: FreeSlot; screeningSurveyId: string | null };

/** День по часам телефона: «2026-10-10» — ключ полосы дней */
const dayKey = (iso: string | Date) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Сколько дней вперёд показывает полоса — две недели, дальше листают к другому специалисту */
const HORIZON_DAYS = 14;

/**
 * Запись на приём.
 *
 * Записаться можно к любому свободному специалисту — это выбор в пользу
 * доступности. Плата за него, размывание преемственности, гасится здесь одной
 * вещью: свой специалист стоит первым и помечен. Человек выбирает другого
 * осознанно, а не потому, что не разобрался.
 *
 * Свободное время приходит одним запросом по всем специалистам: у каждого
 * в списке видно «найближче пт 09.10», и выбор не превращается в перебор
 * по одному.
 */
export default function BookingScreen() {
  const c = useColors();
  const { ut, locale } = useLang();
  const router = useRouter();
  const toast = useToast();

  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [slots, setSlots] = useState<FreeSlot[]>([]);
  const [current, setCurrent] = useState<AppointmentView | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<FreeSlot | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [cancelOld, setCancelOld] = useState(true);

  useFocusEffect(
    useCallback(() => {
      void Promise.all([
        api.specialists().catch(() => ({ items: [] as Specialist[] })),
        api.freeSlots().catch(() => ({ items: [] as FreeSlot[] })),
        api.myAppointments().catch(() => ({ items: [] as AppointmentView[] })),
      ]).then(([spec, free, mine]) => {
        // свой специалист — первым: выбор другого должен быть осознанным
        const list = [...spec.items].sort((a, b) => Number(b.isLead) - Number(a.isLead));
        setSpecialists(list);
        setSlots(free.items);
        setCurrent(mine.items[0] ?? null);
        setPicked((p) => p ?? list.find((s) => s.isLead)?.userId ?? list[0]?.userId ?? null);
      });
    }, []),
  );

  const mine = useMemo(() => slots.filter((s) => s.specialistId === picked), [slots, picked]);
  const days = useMemo(() => {
    if (!mine.length) return [];
    const count = new Map<string, number>();
    for (const s of mine) count.set(dayKey(s.startsAt), (count.get(dayKey(s.startsAt)) ?? 0) + 1);
    /*
     * Полоса начинается сегодня; если до ближайшего свободного дня больше
     * двух недель — с него: иначе две недели «немає» прятали бы время,
     * которое есть.
     */
    const today = new Date();
    const first = new Date(mine[0]!.startsAt);
    const start = first.getTime() - today.getTime() > HORIZON_DAYS * 86_400_000 ? first : today;
    const out: { key: string; date: Date; free: number }[] = [];
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.push({ key: dayKey(d), date: d, free: count.get(dayKey(d)) ?? 0 });
    }
    // полоса кончается последним днём со свободным временем: пустой хвост из «немає» ничего не говорит
    const last = out.findLastIndex((d) => d.free > 0);
    return last < 0 ? [] : out.slice(0, last + 1);
  }, [mine]);
  const activeDay = day && days.some((d) => d.key === day && d.free > 0) ? day : (days.find((d) => d.free > 0)?.key ?? null);
  const daySlots = mine.filter((s) => dayKey(s.startsAt) === activeDay);

  if (specialists === null) return <Loader />;

  const spec = specialists.find((s) => s.userId === picked) ?? null;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const short = (iso: string) =>
    `${new Date(iso).toLocaleDateString(locale, { weekday: "short" })} ${new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })}`;
  const nearest = (id: string) => slots.find((s) => s.specialistId === id) ?? null;
  // свой нынешний приём у того же специалиста в тот же день — плиткой «ваш запис», а не дырой в сетке
  const ownTile = current && current.specialistId === picked && dayKey(current.startsAt) === activeDay ? current : null;

  const book = async () => {
    if (!slot) return;
    setBusy(true);
    try {
      const res = await api.book({ slotId: slot.id, reason: reason.trim() || null });
      setCancelOld(true);
      setBooked({ id: res.id, slot, screeningSurveyId: res.screeningSurveyId });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : ut("common.error"), { icon: "circle-alert" });
    } finally {
      setBusy(false);
    }
  };

  /*
   * Лист после записи закрывается любым путём — кнопкой, крестиком,
   * затемнением; отмена прежнего приёма (если отмечена) срабатывает при
   * любом, а не только при нажатии одной из кнопок.
   */
  const finish = async (then: () => void) => {
    const old = current;
    setBooked(null);
    setSlot(null);
    setReason("");
    if (old && cancelOld && booked) {
      await api.cancelAppointment(old.id).catch(() => toast.show(ut("mpt.bk.oldNotCancelled"), { icon: "circle-alert" }));
    }
    then();
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <ScrollView contentContainerStyle={{ paddingBottom: slot ? 96 : 24 }}>
        <Hero title={ut("mpt.bk.title")} />
        {current ? (
          <View style={{ marginTop: 16, marginHorizontal: 16 }}>
            <Callout
              kind="v"
              icon="calendar-check-2"
              text={ut("mpt.bk.already").replace("{when}", `${short(current.startsAt)}, ${time(current.startsAt)}`)}
            />
          </View>
        ) : null}

        <SectionHead title={ut("bk.pickSpecialist")} />
        {specialists.length ? (
          <List>
            <View accessibilityRole="radiogroup" accessibilityLabel={ut("bk.pickSpecialist")}>
              {specialists.map((s, i) => {
                const on = s.userId === picked;
                const near = nearest(s.userId);
                return (
                  <Pressable
                    key={s.userId}
                    onPress={() => {
                      setPicked(s.userId);
                      setDay(null);
                      setSlot(null);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={[personName(s.fullName), s.isLead ? ut("bk.yours") : null, s.position].filter(Boolean).join(", ")}
                  >
                    {({ pressed }) => (
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 12,
                          minHeight: 68,
                          paddingVertical: 10,
                          paddingHorizontal: 16,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: c.divider,
                          backgroundColor: on ? c.vtint : pressed ? c.panel2 : "transparent",
                        }}
                      >
                        <Avatar name={s.fullName} soft={!s.isLead} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                            <T v="headline">{personName(s.fullName)}</T>
                            {/*
                              Пометка «ваш фахівець» — не украшение: без неё человек, у
                              которого уже есть ведущий, выбирает по первому попавшемуся имени.
                            */}
                            {s.isLead ? <Pill kind="v" label={ut("bk.yours")} /> : null}
                          </View>
                          <T v="sub">
                            {[s.position, near ? ut("mpt.bk.nearest").replace("{d}", short(near.startsAt)) : ut("mpt.bk.noFreeShort")]
                              .filter(Boolean)
                              .join(", ")}
                          </T>
                        </View>
                        <Radio on={on} />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </List>
        ) : (
          <View style={{ marginHorizontal: 16 }}>
            <Callout kind="n" text={ut("bk.noFree")} />
          </View>
        )}

        {spec ? (
          <>
            <SectionHead
              title={ut("bk.pickTime")}
              right={spec.room ? <T v="sub">{`${ut("mpt.hm.room")} ${spec.room}`}</T> : undefined}
            />
            {days.length ? (
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 2 }}>
                  {days.map((d) => (
                    <DayTile
                      key={d.key}
                      date={d.date}
                      free={d.free}
                      on={d.key === activeDay}
                      onPress={() => {
                        setDay(d.key);
                        setSlot(null);
                      }}
                    />
                  ))}
                </ScrollView>
                {activeDay ? (
                  <View style={{ marginTop: 16, marginHorizontal: 16, gap: 8 }}>
                    <T v="body" size={15} weight={700} tone="text2">
                      {capitalize(new Date(`${activeDay}T12:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" }))}
                    </T>
                    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {ownTile ? <SlotTile label={time(ownTile.startsAt)} sub={ut("mpt.bk.yourVisit")} disabled /> : null}
                      {daySlots.map((s) => (
                        <SlotTile
                          key={s.id}
                          label={time(s.startsAt)}
                          sub={`${ut("mpt.bk.until")} ${time(s.endsAt)}`}
                          on={slot?.id === s.id}
                          onPress={() => setSlot(s)}
                        />
                      ))}
                    </View>
                  </View>
                ) : null}
              </>
            ) : (
              <View style={{ marginHorizontal: 16 }}>
                <Callout kind="n" icon="calendar" text={ut("bk.noFree")} />
              </View>
            )}

            {/*
              Причина обращения необязательна намеренно: принуждать
              формулировать проблему до встречи неверно. Но если человек
              написал — специалист прочитает это до приёма, и разговор
              начнётся не с нуля.
            */}
            <SectionHead title={ut("bk.reason")} right={<T v="sub">{ut("mpt.bk.optional")}</T>} />
            <ReasonField value={reason} onChange={setReason} placeholder={ut("bk.reasonHint")} label={ut("bk.reason")} />
          </>
        ) : null}
      </ScrollView>

      {slot ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 10,
            paddingHorizontal: 16,
            backgroundColor: c.panel,
            borderTopWidth: 1,
            borderTopColor: c.divider,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="headline" size={17} num>{`${capitalize(short(slot.startsAt))}, ${time(slot.startsAt)}–${time(slot.endsAt)}`}</T>
            <T v="sub" numberOfLines={1}>
              {[personName(slot.specialistName), slot.room ? `${ut("mpt.hm.room")} ${slot.room}` : null].filter(Boolean).join(", ")}
            </T>
          </View>
          <Btn title={ut("bk.book")} kind="primary" size="m" loading={busy} onPress={() => void book()} />
        </View>
      ) : null}

      <BottomSheet
        visible={!!booked}
        onClose={() => void finish(() => router.replace("/home"))}
        title={ut("bk.booked")}
        sub={
          booked
            ? [
                `${capitalize(short(booked.slot.startsAt))}, ${time(booked.slot.startsAt)}–${time(booked.slot.endsAt)}`,
                booked.slot.room ? `${ut("mpt.hm.room")} ${booked.slot.room}` : null,
                personName(booked.slot.specialistName),
              ]
                .filter(Boolean)
                .join(", ")
            : undefined
        }
        footer={
          booked?.screeningSurveyId ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn title={ut("bk.screeningLater")} size="l" flex={1} onPress={() => void finish(() => router.replace("/home"))} />
              {/*
                Поверх вкладок, а не вместо них: замена оставляла прохождение
                единственным экраном приложения — без стрелки «назад».
              */}
              <Btn
                title={ut("bk.screeningStart")}
                kind="primary"
                size="l"
                flex={2}
                icon="arrow-right"
                iconEnd
                onPress={() => void finish(() => router.push(`/survey/${booked.screeningSurveyId}`))}
              />
            </View>
          ) : (
            <Btn title={ut("hint.gotIt")} kind="primary" size="l" full onPress={() => void finish(() => router.replace("/home"))} />
          )
        }
      >
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          {current ? (
            <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: radius.tile, overflow: "hidden" }}>
              <CheckRow
                on={cancelOld}
                onPress={() => setCancelOld((v) => !v)}
                label={ut("mpt.bk.cancelOld").replace("{when}", `${short(current.startsAt)}, ${time(current.startsAt)}`)}
                sub={ut("mpt.bk.cancelOldSub")}
              />
            </View>
          ) : null}
          {/*
            Скрининг предлагается сразу после записи, а не напоминанием назавтра.
            Человек только что нажал «записаться» и находится ровно в той точке,
            где готов потратить пять минут; через день он забудет.
          */}
          {booked?.screeningSurveyId ? (
            <Callout kind="v" icon="clipboard-check" title={ut("mpt.bk.beforeVisit")} text={`${ut("bk.screeningOffer")}. ${ut("bk.screeningNoScore")}.`} />
          ) : null}
        </View>
      </BottomSheet>
    </View>
  );
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function Radio({ on }: { on: boolean }) {
  const c = useColors();
  const dark = useIsDark();
  return (
    <View
      style={{
        width: 26,
        height: 26,
        borderRadius: 13,
        borderWidth: on ? 8 : 2,
        borderColor: on ? (dark ? c.vink : c.v) : c.ctl,
        backgroundColor: c.panel,
      }}
    />
  );
}

/** День в полосе: день недели, число, сколько свободного; без свободного — не нажимается */
function DayTile({ date, free, on, onPress }: { date: Date; free: number; on: boolean; onPress: () => void }) {
  const c = useColors();
  const sh = useShadows();
  const { ut, locale } = useLang();
  const off = free === 0;
  const ink = on ? c.onfill : off ? c.muted : c.text;
  const sub = off ? ut("mpt.bk.none") : ut("mpt.bk.free").replace("{n}", String(free));
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="radio"
      accessibilityState={{ checked: on, disabled: off }}
      accessibilityLabel={`${date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })}, ${sub}`}
      style={({ pressed }) => ({
        width: 78,
        height: 80,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        backgroundColor: on ? c.v : off ? c.sunk : pressed ? c.panel2 : c.panel,
        borderWidth: on || off ? 0 : 1,
        borderColor: c.border,
        boxShadow: on ? sh.primary : undefined,
      })}
    >
      <T v="sub" size={14} color={on ? c.onfill : c.muted} scale={false}>
        {date.toLocaleDateString(locale, { weekday: "short" })}
      </T>
      <T v="headline" size={22} weight={800} color={ink} num scale={false} style={{ lineHeight: 26 }}>
        {date.getDate()}
      </T>
      <T v="sub" size={13} color={on ? c.onfill : c.muted} scale={false} numberOfLines={1}>
        {sub}
      </T>
    </Pressable>
  );
}

/** Время: «18:00 / до 18:50» — четыре в ряд; свой нынешний приём — серым «ваш запис» */
function SlotTile({ label, sub, on, disabled, onPress }: { label: string; sub: string; on?: boolean; disabled?: boolean; onPress?: () => void }) {
  const c = useColors();
  const sh = useShadows();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: !!on, disabled: !!disabled }}
      accessibilityLabel={`${label}, ${sub}`}
      style={({ pressed }) => ({
        width: "23.3%",
        flexGrow: 0,
        height: 56,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: on ? c.v : disabled ? c.sunk : pressed ? c.panel2 : c.panel,
        borderWidth: on || disabled ? 0 : 1,
        borderColor: c.border,
        boxShadow: on ? sh.primary : undefined,
      })}
    >
      <T v="headline" size={17} num scale={false} color={on ? c.onfill : disabled ? c.muted : c.text}>
        {label}
      </T>
      <T v="caption" size={12} scale={false} color={on ? c.onfill : c.muted} numberOfLines={1}>
        {sub}
      </T>
    </Pressable>
  );
}

function ReasonField({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  const c = useColors();
  const dark = useIsDark();
  const { fs } = useTextScale();
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ marginHorizontal: 16 }}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        accessibilityLabel={label}
        multiline
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          minHeight: 72,
          paddingVertical: 12,
          paddingHorizontal: 14,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: focus ? (dark ? c.vink : c.v) : c.field,
          backgroundColor: c.panel,
          color: c.text,
          fontSize: fs(16),
          lineHeight: fs(23),
          textAlignVertical: "top",
          boxShadow: focus ? `0px 0px 0px 3px ${c.vtint}` : undefined,
          ...font(500),
        }}
      />
    </View>
  );
}

/** Строка с галочкой в листе: квадрат 24, жирная подпись и пояснение; нажимается вся строка */
function CheckRow({ on, onPress, label, sub }: { on: boolean; onPress: () => void; label: string; sub?: string }) {
  const c = useColors();
  const dark = useIsDark();
  const fill = dark ? c.vink : c.v;
  return (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={label} accessibilityHint={sub}>
      {({ pressed }) => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, minHeight: 64, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: pressed ? c.panel2 : "transparent" }}>
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: on ? fill : c.panel,
              borderWidth: on ? 0 : 2,
              borderColor: c.ctl,
            }}
          >
            {on ? <Icon name="check" size={16} strokeWidth={3} color={dark ? c.ground : c.onfill} /> : null}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="headline" weight={700}>
              {label}
            </T>
            {sub ? <T v="sub">{sub}</T> : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}
