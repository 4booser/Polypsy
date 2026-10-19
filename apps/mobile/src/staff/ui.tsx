import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import type { AlertCase, Severity } from "@quizzy/shared";
import { useAuth } from "../auth/AuthContext";
import { OfflineBar } from "../components/OfflineBar";
import { useLang } from "../lang";
import { useExit } from "../nav/useExit";
import { font } from "../fonts";
import { useTextScale } from "../textScale";
import { radius, useChart, useColors, useIsDark } from "../theme";
import { Btn } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { NavBar } from "../ui/NavBar";
import { Count, FilterChip, SevPill } from "../ui/Pill";
import { T } from "../ui/Text";
import { caseClock, clock, dm, durationParts, hm, hours, initials, normOf, num, type InstrumentRow } from "./model";

/*
 * Детали экранов сотрудника, общие для нескольких экранов: шапки на полосе,
 * блок «сигнал ризику» с часами разбора, строка шкалы с её сравнением, ряды
 * фильтров, полосы и столбики. Собраны из набора (src/ui) и токенов — своих
 * цветов здесь нет.
 */

/* ─────────── шапки ─────────── */

/** Кружок с инициалами: фиолетовый — человек, приглушённый — уже отмеченный */
export function Avatar({ name, size = 34, muted }: { name: string | null | undefined; size?: 34 | 36 | 44 | 56; muted?: boolean }) {
  const c = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: muted ? c.sunk2 : c.v,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T v="caption" size={size >= 56 ? 19 : size >= 44 ? 16 : 13} weight={800} color={muted ? c.text2 : c.onfill} scale={false}>
        {initials(name)}
      </T>
    </View>
  );
}

/** Кнопка-значок на полосе шапки — 40, цель нажатия 44 */
export function BandIcon({
  icon,
  label,
  onPress,
  pressed: on,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Нажатое состояние: поиск открыт */
  pressed?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={on === undefined ? undefined : { expanded: on }}
      hitSlop={2}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed || on ? c.vtint2 : c.bcard,
        borderWidth: on ? 1.5 : 1,
        borderColor: on ? c.v : c.bcardline,
      })}
    >
      <Icon name={icon} size={19} color={c.vink} />
    </Pressable>
  );
}

/** Учётная запись — кружок с инициалами справа в шапке корневых экранов */
function MeButton() {
  const c = useColors();
  const { ut } = useLang();
  const { user } = useAuth();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push("/(app)/profile")}
      accessibilityRole="button"
      accessibilityLabel={ut("mst.account").replace("{name}", user?.fullName ?? "")}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
    >
      {({ pressed }) => (
        <View style={{ borderRadius: 20, padding: 2, backgroundColor: c.bcard, borderWidth: 1, borderColor: pressed ? c.vline : c.bcardline }}>
          <Avatar name={user?.fullName} size={34} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * Шапка корневого экрана сотрудника: крупный заголовок на полосе, под ним
 * подзаголовок и то, что управляет списком (поиск, фильтр, переключатель);
 * справа — действия экрана и учётная запись. Полоса очереди «нет связи» —
 * последней, как у шапки вкладок.
 */
export function StaffTop({ title, lead, actions, children }: { title: string; lead?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <NavBar
      large
      title={title}
      lead={lead}
      right={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {actions}
          <MeButton />
        </View>
      }
      below={<OfflineBar />}
    >
      {children}
    </NavBar>
  );
}

/**
 * Шапка вложенного экрана: «‹ куда вернёт», заголовок по центру, действие
 * справа, под строкой — своё на полосе (шапка пациента, переключатели).
 * Позади ничего нет (открыто по ссылке) — «назад» уводит на запасное место
 * (nav/exits.ts), а не в никуда.
 */
export function StaffNav({ back, title, right, children }: { back: string; title?: string; right?: ReactNode; children?: ReactNode }) {
  const exit = useExit();
  return (
    <NavBar title={title} back={{ label: back, onPress: exit }} right={right}>
      {children}
    </NavBar>
  );
}

/**
 * Поиск на полосе шапки — 44, карточкой полосы. Подпись поля — сама
 * подсказка: диктор читает её как имя поля.
 */
export function SearchField({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (t: string) => void; placeholder: string; autoFocus?: boolean }) {
  const c = useColors();
  const { ut } = useLang();
  const { fs } = useTextScale();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 44, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: c.bcardline, backgroundColor: c.bcard }}>
      <Icon name="search" size={18} color={c.muted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        accessibilityLabel={placeholder}
        autoFocus={autoFocus}
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, height: 42, color: c.text, fontSize: fs(16), ...font(500) }}
      />
      {value ? (
        <Pressable onPress={() => onChange("")} accessibilityRole="button" accessibilityLabel={ut("mst.clearSearch")} hitSlop={10}>
          <Icon name="x" size={18} color={c.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/* ─────────── состояния ─────────── */

export function Loading() {
  const c = useColors();
  return (
    <View style={{ paddingVertical: 48, alignItems: "center" }}>
      <ActivityIndicator color={c.vink} />
    </View>
  );
}

/** Пусто или ошибка: что случилось и что делать; действие — кнопкой */
export function StateBlock({ title, text, action, icon = "info" }: { title: string; text?: string; action?: { label: string; onPress: () => void }; icon?: IconName }) {
  const c = useColors();
  return (
    <View style={{ marginHorizontal: 16, marginTop: 16, paddingVertical: 28, paddingHorizontal: 20, alignItems: "center", gap: 6, borderRadius: radius.tile, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel }}>
      <Icon name={icon} size={22} color={c.muted} />
      <T v="headline" center>
        {title}
      </T>
      {text ? (
        <T v="note" center>
          {text}
        </T>
      ) : null}
      {action ? <Btn title={action.label} onPress={action.onPress} size="s" style={{ marginTop: 8 }} /> : null}
    </View>
  );
}

/** Строка-пояснение на фоне: значок и приглушённый текст */
export function Line({ icon = "info", children, tone }: { icon?: IconName; children: ReactNode; tone?: "warn" }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 8, marginTop: 12, marginHorizontal: 20 }}>
      <View style={{ marginTop: 2 }}>
        <Icon name={icon} size={15} color={tone === "warn" ? c.warn : c.muted} />
      </View>
      <T v="sub" color={tone === "warn" ? c.warn : c.muted} style={{ flex: 1 }}>
        {children}
      </T>
    </View>
  );
}

/** Заголовок раздела над списком: 18, счётчик, ссылка справа, подпись под ним */
export function Section({ title, count, countKind, right, sub }: { title: string; count?: number; countKind?: "r" | "v" | "t"; right?: ReactNode; sub?: string }) {
  return (
    <View style={{ paddingTop: 20, paddingHorizontal: 20, paddingBottom: 10 }}>
      <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T v="section">{title}</T>
        {count !== undefined ? <Count n={count} kind={countKind} /> : null}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {sub ? <T v="sub">{sub}</T> : null}
    </View>
  );
}

/** Текстовая ссылка-действие: «Уся динаміка», «Показати ще» */
export function LinkButton({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <T v="sub" size={15} weight={700} color={c.vink}>
        {label}
      </T>
    </Pressable>
  );
}

/** Скруглённая карточка-список строк на фоне */
export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: "risk" }) {
  const c = useColors();
  return (
    <View
      style={[
        {
          marginHorizontal: 16,
          borderRadius: radius.tile,
          backgroundColor: tone === "risk" ? c.risktint : c.panel,
          borderWidth: 1,
          borderColor: tone === "risk" ? c.riskline : c.border,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/* ─────────── фильтры ─────────── */

export interface PillItem<K extends string> {
  key: K;
  label: string;
  count?: number;
}

/**
 * Ряд пилюль-фильтров, который листается вбок: на узком телефоне все
 * варианты в строку не помещаются, а перенос второй строкой съел бы список.
 */
export function PillRow<K extends string>({
  items,
  value,
  onChange,
  onBand,
  inline,
}: {
  items: PillItem<K>[];
  value: K;
  onChange: (k: K) => void;
  onBand?: boolean;
  /** Внутри строки с подписью: без выноса к краям экрана */
  inline?: boolean;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={inline ? undefined : onBand ? { marginHorizontal: -20 } : { marginTop: 16 }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: inline ? 0 : onBand ? 20 : 16 }}
    >
      {items.map((p) => (
        <FilterChip key={p.key} label={p.label} count={p.count} selected={p.key === value} onPress={() => onChange(p.key)} onBand={onBand} />
      ))}
    </ScrollView>
  );
}

/* ─────────── риск ─────────── */

/** Полоска доли нормы разбора */
export function TimerBar({ pct, width }: { pct: number; width?: number }) {
  const c = useColors();
  return (
    <View style={{ width: width ?? "100%", height: 6, borderRadius: 3, backgroundColor: c.riskline, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: 6, borderRadius: 3, backgroundColor: c.risk }} />
    </View>
  );
}

/** Часы разбора числом: «2:48», от суток — «9 дн.», как в консоли (model.ts, clock) */
export function useClock() {
  const { ut } = useLang();
  return (minutes: number) => clock(minutes, ut("rr.days"));
}

/** «2:48 з 4 год» — часы разбора словами */
export function useClockText() {
  const { ut } = useLang();
  return (k: ReturnType<typeof caseClock>) =>
    k.norm ? ut("mst.clockOf").replace("{h}", hours(k.norm)) : ut("mst.clockOpen");
}

/**
 * Блок «сигнал ризику» сверху экрана: человек, что сработало, часы до
 * нормы и «Розібрати». Красный — только здесь и на кнопке: это риск для
 * человека, а не «требует внимания».
 */
export function RiskNow({
  item,
  now,
  text,
  onReview,
}: {
  item: AlertCase;
  now: number;
  /** Свой текст вместо «кто и что сработало» — на карте пациента имя уже в шапке */
  text?: string;
  onReview: () => void;
}) {
  const c = useColors();
  const { ut } = useLang();
  // норма — со случаем, та же, по которой сервер ставит «прострочено» (model.ts, normOf)
  const k = caseClock(item.openedAt, normOf(item), now);
  const of = useClockText();
  const clockOf = useClock();
  const first = item.signals[0];
  const title = k.due
    ? (k.over ? ut("mst.riskOverdue") : ut("mst.riskDue")).replace("{t}", hm(k.due))
    : ut("mst.riskOpen");
  return (
    <View
      accessibilityRole="summary"
      style={{ marginHorizontal: 16, marginTop: 16, paddingTop: 14, paddingBottom: 14, paddingLeft: 16, paddingRight: 14, borderRadius: 16, backgroundColor: c.risktint, borderWidth: 1, borderColor: c.riskline }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="triangle-alert" size={18} color={c.riskink} />
        <T v="headline" color={c.riskink} style={{ flex: 1 }}>
          {title}
        </T>
      </View>
      <T v="note" style={{ marginTop: 4 }}>
        {text ??
          // с датой: сигнал девятидневной давности с одним «01:25» читался как сегодняшний
          [item.userName, `${item.surveyTitle}, ${dm(item.lastAlertAt)}, ${hm(item.lastAlertAt)}`, first ? first.label : null].filter(Boolean).join(": ")}
      </T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
            <T v="number" size={26} color={c.riskink} num scale={false}>
              {clockOf(k.elapsed)}
            </T>
            <T v="sub" weight={700} tone="text2" numberOfLines={1}>
              {of(k)}
            </T>
          </View>
          {k.norm ? <TimerBar pct={k.pct} /> : null}
        </View>
        {k.left !== null ? (
          <T v="sub" size={13} tone="text2" num>
            {(k.over ? ut("mst.overBy") : ut("mst.leftFor")).replace("{t}", clockOf(Math.abs(k.left)))}
          </T>
        ) : null}
        <Btn title={ut("mst.review")} kind="risk" onPress={onReview} accessibilityHint={ut("mst.reviewHint")} />
      </View>
    </View>
  );
}

/* ─────────── плашки ─────────── */

export type ChipKind = "risk" | "riskOutline" | "warn" | "msg" | "v" | "good" | "n";

/** Плашка открытого по человеку: значок, слово, приглушённая подробность */
export function Chip({ label, detail, icon, kind = "n", onPress }: { label: string; detail?: string; icon?: IconName; kind?: ChipKind; onPress?: () => void }) {
  const c = useColors();
  const t =
    kind === "risk"
      ? { bg: c.risktint2, fg: c.riskink, line: undefined }
      : kind === "riskOutline"
        ? { bg: "transparent", fg: c.riskink, line: c.riskline }
        : kind === "warn"
          ? { bg: c.warntint2, fg: c.warn, line: undefined }
          : kind === "msg"
            ? { bg: c.infotint, fg: c.info, line: undefined }
            : kind === "v"
              ? { bg: c.vtint, fg: c.vink, line: undefined }
              : kind === "good"
                ? { bg: c.goodtint, fg: c.good, line: undefined }
                : { bg: c.panel, fg: c.text2, line: c.border };
  const body = (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, minHeight: 30, paddingLeft: icon ? 9 : 11, paddingRight: 11, paddingVertical: 4, borderRadius: 15, backgroundColor: t.bg },
        t.line ? { borderWidth: 1, borderColor: t.line } : null,
      ]}
    >
      {icon ? <Icon name={icon} size={15} color={t.fg} /> : null}
      <T v="sub" size={13.5} weight={800} color={t.fg} scale={false} style={{ flexShrink: 1 }}>
        {label}
        {detail ? (
          <T v="sub" size={13.5} weight={600} tone={kind === "n" ? "muted" : undefined} color={kind === "n" ? undefined : t.fg} scale={false}>
            {` ${detail}`}
          </T>
        ) : null}
      </T>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  );
}

/* ─────────── числа ─────────── */

/** Длительность крупным числом и единица подписью: «3:12» и «хв», «43,3» и «с» */
export function useDurationValue() {
  const { ut } = useLang();
  return (ms: number): { value: string; unit?: string } => {
    const p = durationParts(ms);
    return p ? { value: p.value, unit: ut(p.unit === "sec" ? "mst.unitSec" : "mst.unitMin") } : { value: "—" };
  };
}

/** «19 → 16 → 14»: история числами, последнее — жирным */
export function History({ values, unit }: { values: number[]; unit?: string }) {
  const c = useColors();
  return (
    <T v="sub" size={14} weight={600} tone="text2" num>
      {values.map((v, i) => (
        <T key={i} v="sub" size={14} weight={i === values.length - 1 ? 800 : 600} color={i === values.length - 1 ? c.text : c.text2} num>
          {`${i ? " → " : ""}${num(v)}${unit ?? ""}`}
        </T>
      ))}
    </T>
  );
}

/** «краще ↓» — пилюля направления шкалы */
export function BetterPill({ better }: { better: "up" | "down" }) {
  const c = useColors();
  const { ut } = useLang();
  return (
    <View style={{ height: 24, paddingHorizontal: 9, borderRadius: 12, backgroundColor: c.sunk, justifyContent: "center" }}>
      <T v="caption" size={12.5} weight={700} tone="text2" scale={false}>
        {`${ut("mui.better")} ${better === "up" ? "↑" : "↓"}`}
      </T>
    </View>
  );
}

/**
 * Строка шкалы: код и «краще ↓», что измеряет; крупное значение с
 * выраженностью словом; история и сдвиг от старта с его надёжностью
 * («поріг 6»). Число без сравнения и слова — это цифра, а не результат.
 */
export function InstrumentLine({ row, first, onPress }: { row: InstrumentRow; first?: boolean; onPress?: () => void }) {
  const c = useColors();
  const { ut } = useLang();
  const verdictText =
    row.delta === null
      ? null
      : `${row.delta > 0 ? "+" : row.delta < 0 ? "−" : ""}${num(Math.abs(row.delta))}, ${ut(`mst.verdict.${row.verdict}`)}`;
  const good = row.verdict === "better";
  const inner = (pressed: boolean) => (
    <View style={{ paddingTop: 12, paddingBottom: 13, paddingLeft: 16, paddingRight: 14, borderTopWidth: first ? 0 : 1, borderTopColor: c.divider, backgroundColor: pressed ? c.panel2 : "transparent", gap: 4 }}>
      {/* код и направление слева, крупное значение справа; слово полосы — ниже: у методик оно бывает в полстроки */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <T v="headline">{row.code || row.title}</T>
          {row.better ? <BetterPill better={row.better} /> : null}
        </View>
        <T v="number" size={28} num scale={false}>
          {num(row.last.rawScore)}
        </T>
      </View>
      <T v="sub" numberOfLines={2}>
        {row.code && row.title !== row.code ? row.title : row.surveyTitle}
      </T>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 4, marginTop: 4 }}>
        {row.last.severity || row.last.bandLabel ? (
          <SevPill small severity={(row.last.severity ?? "none") as Severity} label={row.last.bandLabel ?? undefined} />
        ) : null}
        {row.history.length > 1 ? <History values={row.history} /> : <T v="sub">{ut("mst.oneMeasure")}</T>}
        {verdictText ? (
          <T v="sub" size={14} weight={700} color={good ? c.good : c.text2}>
            {verdictText}
          </T>
        ) : null}
        {row.rc !== null && row.delta !== null ? (
          <T v="sub" size={14}>
            {ut("mst.threshold").replace("{n}", num(row.rc))}
          </T>
        ) : null}
      </View>
    </View>
  );
  if (!onPress) return inner(false);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${row.code || row.title}: ${num(row.last.rawScore)}`}>
      {({ pressed }) => inner(pressed)}
    </Pressable>
  );
}

/**
 * Числа сводки списком, а не плитками: подпись, под ней сравнение и смысл,
 * справа крупное значение с единицей.
 */
export function SumRows({ rows }: { rows: { label: string; sub?: string; change?: string; good?: boolean; value: string; unit?: string }[] }) {
  const c = useColors();
  return (
    <View style={{ marginTop: -4 }}>
      {rows.map((r, i) => (
        <View key={r.label} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: c.divider }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="body" size={15} weight={700}>
              {r.label}
            </T>
            {r.sub || r.change ? (
              <T v="sub" size={13.5}>
                {r.change ? (
                  <T v="sub" size={13.5} weight={700} color={r.good ? c.good : c.text2}>
                    {`${r.change} `}
                  </T>
                ) : null}
                {r.sub ?? ""}
              </T>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 3 }}>
            <T v="number" size={24} num scale={false}>
              {r.value}
            </T>
            {r.unit ? (
              <T v="sub" size={14} weight={700} scale={false}>
                {r.unit}
              </T>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Горизонтальные полосы: подпись слева, полоса, значение справа. mark —
 * риска сравнения (медиана всех пунктов, порог), hl — выделенная строка,
 * warn — строка внимания (слабый пункт).
 */
export function HBars({
  rows,
  max,
  mark,
  labelWidth = 140,
  stacked,
}: {
  rows: { key: string; label: string; value: number | null; text?: string; hl?: boolean; warn?: boolean }[];
  max?: number;
  mark?: number;
  labelWidth?: number;
  /** Подпись над полосой целиком — для длинных подписей (полосы методики, пункты) */
  stacked?: boolean;
}) {
  const c = useColors();
  const chart = useChart();
  const dark = useIsDark();
  const top = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0), mark ?? 0);
  const fill = dark ? c.vink : c.v;
  return (
    <View style={{ gap: 8 }}>
      {rows.map((r) => (
        <View key={r.key} style={stacked ? { gap: 4 } : { flexDirection: "row", alignItems: "center", gap: 10 }} accessible accessibilityLabel={`${r.label}: ${r.text ?? (r.value ?? "—")}`}>
          <T v="sub" size={14} weight={r.hl || r.warn ? 800 : 600} color={r.warn ? c.warn : r.hl ? c.text : c.text2} numberOfLines={stacked ? 2 : 1} style={stacked ? undefined : { width: labelWidth }}>
            {r.label}
          </T>
          <View style={stacked ? { flexDirection: "row", alignItems: "center", gap: 10 } : { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1, height: 10, borderRadius: 5, backgroundColor: chart.track }}>
            {r.value !== null ? (
              <View style={{ width: `${Math.max(1.5, Math.min(100, (r.value / top) * 100))}%`, height: 10, borderRadius: 5, backgroundColor: r.warn ? c.warn : r.hl || mark === undefined ? fill : chart.series[4] }} />
            ) : null}
            {mark !== undefined ? (
              <View style={{ position: "absolute", left: `${Math.min(100, (mark / top) * 100)}%`, top: -3, width: 2, height: 16, marginLeft: -1, borderRadius: 1, backgroundColor: c.text }} />
            ) : null}
          </View>
          <T v="sub" size={14} weight={800} num style={{ minWidth: 36, textAlign: "right" }}>
            {r.text ?? (r.value === null ? "—" : num(r.value))}
          </T>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Столбики по дням: значение над столбиком, день под ним; последний —
 * фиолетовым, прочие приглушены, чтобы «сегодня» читалось сразу.
 */
export function DayBars({ days, height = 120 }: { days: { key: string; label: string; value: number }[]; height?: number }) {
  const c = useColors();
  const chart = useChart();
  const dark = useIsDark();
  const top = Math.max(1, ...days.map((d) => d.value));
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: height + 40 }} accessible accessibilityLabel={days.map((d) => `${d.label} ${d.value}`).join(", ")}>
      {days.map((d, i) => {
        const last = i === days.length - 1;
        return (
          <View key={d.key} style={{ flex: 1, alignItems: "center", gap: 4 }}>
            <T v="caption" size={12} weight={800} color={last ? c.text : c.text2} num scale={false}>
              {d.value}
            </T>
            <View style={{ width: "72%", height: Math.max(3, (d.value / top) * height), borderTopLeftRadius: 5, borderTopRightRadius: 5, backgroundColor: last ? (dark ? c.vink : c.v) : chart.series[4] }} />
            <T v="caption" size={11.5} weight={last ? 800 : 600} color={last ? c.text : c.muted} scale={false} numberOfLines={1}>
              {d.label}
            </T>
          </View>
        );
      })}
    </View>
  );
}

/** Две доли одной полосой с подписями: завершено против покинутого */
export function SplitBar({ parts }: { parts: { key: string; label: string; value: number; strong?: boolean }[] }) {
  const c = useColors();
  const chart = useChart();
  const dark = useIsDark();
  const total = Math.max(1, parts.reduce((s, p) => s + p.value, 0));
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", height: 14, borderRadius: 7, overflow: "hidden", backgroundColor: chart.track, gap: 2 }}>
        {parts.map((p) =>
          p.value > 0 ? <View key={p.key} style={{ flex: p.value / total, backgroundColor: p.strong ? (dark ? c.vink : c.v) : chart.series[4] }} /> : null,
        )}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6 }}>
        {parts.map((p) => (
          <View key={p.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: p.strong ? (dark ? c.vink : c.v) : chart.series[4] }} />
            <T v="sub" size={13.5} tone="text2" num>
              {p.label}
            </T>
          </View>
        ))}
      </View>
    </View>
  );
}
