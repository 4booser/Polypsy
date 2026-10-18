import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { LANGS, LANG_NAMES, ageAt, deviceTimeZone } from "@quizzy/shared";
import { api } from "@/api/client";
import { authenticate, isAvailable, isEnabled, setEnabled as setBiometrics } from "@/auth/biometrics";
import { useAuth } from "@/auth/AuthContext";
import { logoutNotice, type LogoutLine } from "@/offline/logout";
import { API_URL } from "@/config";
import { ErrorText } from "@/components/ui";
import { Avatar } from "@/components/patient/Avatar";
import { BandCard, Hero } from "@/components/patient/Hero";
import { radius, useColors, useIsDark, useTheme, type ThemeChoice } from "@/theme";
import { TEXT_STEPS, useTextScale } from "@/textScale";
import { useLang } from "@/lang";
import { Btn } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Icon, type IconName } from "@/ui/Icon";
import { Callout, List, SectionHead, Squircle } from "@/ui/Panel";
import { Pill } from "@/ui/Pill";
import { SettingRow, SwitchRow } from "@/ui/Rows";
import { Segmented } from "@/ui/Segmented";
import { BottomSheet } from "@/ui/Sheet";
import { T } from "@/ui/Text";

// ключи, а не подписи: карта вне компонента, язык — при отрисовке
const ROLE_KEY = {
  superadmin: "mp.roleSuper",
  admin: "mp.roleAdmin",
  user: "mp.rolePatient",
} as const;

const THEMES: { value: ThemeChoice; icon: IconName; key: "mp.themeSystem" | "mp.themeLight" | "mp.themeDark" | "mp.themeNight" }[] = [
  { value: "system", icon: "smartphone", key: "mp.themeSystem" },
  { value: "light", icon: "sun", key: "mp.themeLight" },
  { value: "dark", icon: "moon", key: "mp.themeDark" },
  { value: "night", icon: "moon-star", key: "mp.themeNight" },
];

/**
 * Профиль: кто я, как выглядит приложение, безопасность, мои данные и
 * этот телефон. Выход — последним и с честным предупреждением, если на
 * телефоне остались неотправленные ответы.
 */
export default function AccountScreen() {
  const c = useColors();
  const router = useRouter();
  const { user, logout, refresh } = useAuth();
  const { lang, setLang, ut, locale } = useLang();
  const { choice, setChoice } = useTheme();
  const { scale, set: setScale } = useTextScale();
  const [editing, setEditing] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [form, setForm] = useState({
    lastName: user?.lastName ?? "",
    firstName: user?.firstName ?? "",
    middleName: user?.middleName ?? "",
    birthDate: user?.birthDate ?? "",
    unit: user?.unit ?? "",
    position: user?.position ?? "",
    specialty: user?.specialty ?? "",
    rank: user?.rank ?? "",
  });
  const [sex, setSex] = useState(user?.sex ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile({
        lastName: form.lastName.trim(),
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim() || null,
        sex,
        birthDate: form.birthDate.trim() || null,
        unit: form.unit.trim() || null,
        position: form.position.trim() || null,
        specialty: form.specialty.trim() || null,
        rank: form.rank.trim() || null,
      });
      await refresh();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("mp.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const [queueLeft, setQueueLeft] = useState(0);
  useEffect(() => {
    const update = () => setQueueLeft(api.pendingCount() + api.rejectedCount());
    update();
    const timer = setInterval(update, 5_000);
    return () => clearInterval(timer);
  }, []);

  /*
   * Выход разрешён всегда. Раньше с непустой очередью он запрещался — и на
   * общем планшете это запирало двоих: выходящий ждал сети, следующий ждал
   * его. Неотправленное остаётся за владельцем до его следующего входа
   * (offline/queue.ts); перед выходом человеку говорят, сколько его ответов
   * остаётся здесь, и выходит он вторым нажатием. Подтверждение — листом на
   * экране, а не системным окном: в веб-сборке Alert не показывается, и
   * кнопка выхода там перестала бы работать вовсе.
   */
  const [leaving, setLeaving] = useState<LogoutLine[] | null>(null);

  async function doLogout() {
    setLeaving(null);
    await logout();
    router.replace("/login");
  }

  async function onLogout() {
    const notice = logoutNotice(api.unsentOfMine());
    if (notice) {
      setLeaving(notice);
      return;
    }
    await doLogout();
  }

  const age = ageAt(user?.birthDate ?? null, new Date().toISOString(), deviceTimeZone());
  const since = user?.createdAt ? new Date(user.createdAt).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }) : null;
  const sexLabel = user?.sex === "male" ? ut("person.sex.male") : user?.sex === "female" ? ut("person.sex.female") : null;
  let host = API_URL;
  try {
    host = new URL(API_URL).host;
  } catch {
    /* адрес без схемы — как есть */
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
        <Hero title={ut("mui.profile")}>
          <BandCard style={{ alignItems: "center" }}>
            <Avatar name={user?.fullName ?? ""} size={56} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T v="headline" size={17} numberOfLines={2}>
                {user?.fullName}
              </T>
              <T v="note" tone="text2" numberOfLines={1}>
                {user?.email}
              </T>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                <Pill kind="v" icon="user-round" label={ut(ROLE_KEY[(user?.role ?? "user") as keyof typeof ROLE_KEY] ?? "mp.rolePatient")} />
                {since ? <Pill kind="n" icon="calendar" label={ut("mpt.pf.since").replace("{d}", since)} /> : null}
              </View>
            </View>
          </BandCard>
        </Hero>

        {/*
          Раскрытие — первым блоком, а не в конце настроек.
          Человек под кодом упирается в него в единственный момент: когда ему
          понадобилась справка и он услышал «нужно имя». Искать эту кнопку под
          выбором темы он не будет.
        */}
        <RevealCard />

        {/* ── вигляд ── */}
        <SectionHead title={ut("acct.appearance")} />
        <List>
          <View style={{ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Squircle icon="a-large-small" />
              <View style={{ flex: 1 }}>
                <T v="headline">{ut("mpt.pf.textSize")}</T>
                <T v="sub">{ut("mpt.pf.textSizeSub")}</T>
              </View>
            </View>
            <View accessibilityRole="radiogroup" accessibilityLabel={ut("mpt.pf.textSize")} style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              {TEXT_STEPS.map((s, i) => (
                <Choice
                  key={s}
                  on={scale === s}
                  label={`${Math.round(s * 100)} %`}
                  onPress={() => setScale(s)}
                  glyph={
                    <T v="body" size={[15, 19, 23][i]} weight={800} color={scale === s ? c.vink : c.text} scale={false} style={{ lineHeight: 26 }}>
                      A
                    </T>
                  }
                />
              ))}
            </View>
          </View>
          {/*
            Тема выбирается явно: приложение открывают и в казарме после отбоя, и
            в кабинете при дневном свете, а системная настройка телефона об этом
            не знает.
          */}
          <View style={{ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: c.divider }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Squircle icon="sun-moon" />
              <View style={{ flex: 1 }}>
                <T v="headline">{ut("mp.theme")}</T>
                <T v="sub">{ut("mpt.pf.themeSub")}</T>
              </View>
            </View>
            <View accessibilityRole="radiogroup" accessibilityLabel={ut("mp.theme")} style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              {THEMES.map((t) => (
                <Choice
                  key={t.value}
                  on={choice === t.value}
                  label={ut(t.key)}
                  onPress={() => setChoice(t.value)}
                  glyph={<Icon name={t.icon} size={20} color={choice === t.value ? c.vink : c.text2} />}
                />
              ))}
            </View>
          </View>
          <SettingRow icon="languages" label={ut("profile.language")} value={LANG_NAMES[lang].full} onPress={() => setLangOpen(true)} />
        </List>
        <T v="sub" style={{ marginTop: 8, marginHorizontal: 20 }}>
          {ut("mpt.pf.textSizeFoot")}
        </T>

        {/* ── безпека ── */}
        <SectionHead title={ut("mpt.pf.security")} />
        <List>
          <SettingRow first icon="key-round" tone="n" label={ut("acct.changePassword")} sub={ut("mpt.pf.passwordSub")} onPress={() => router.push("/password")} />
          <BiometricsRow />
        </List>

        {/* ── особисті дані ── */}
        <SectionHead
          title={ut("acct.data")}
          right={
            editing ? null : (
              <Pressable onPress={() => setEditing(true)} accessibilityRole="button" hitSlop={12} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}>
                <T v="body" size={16} weight={700} color={c.vink}>
                  {ut("mp.edit")}
                </T>
              </Pressable>
            )
          }
        />
        {editing ? (
          <View style={{ marginHorizontal: 16, gap: 14 }}>
            <Field label={ut("person.lastName")} value={form.lastName} onChangeText={(t) => setForm({ ...form, lastName: t })} />
            <Field label={ut("person.firstName")} value={form.firstName} onChangeText={(t) => setForm({ ...form, firstName: t })} />
            <Field label={ut("person.middleName")} value={form.middleName} onChangeText={(t) => setForm({ ...form, middleName: t })} />
            <View style={{ gap: 6 }}>
              <T v="sub" size={15} weight={700} tone="text2">
                {ut("person.sex")}
              </T>
              <Segmented
                value={sex ?? "none"}
                onChange={(v) => setSex(v === "none" ? null : v)}
                accessibilityLabel={ut("person.sex")}
                options={[
                  { value: "male", label: ut("mp.male") },
                  { value: "female", label: ut("mp.female") },
                ]}
              />
            </View>
            <Field
              label={`${ut("person.birthDate")} (${ut("mp.dateFormat")})`}
              value={form.birthDate}
              onChangeText={(t) => setForm({ ...form, birthDate: t })}
              placeholder="1994-03-12"
              keyboardType="numbers-and-punctuation"
            />
            <Field label={ut("person.unit")} value={form.unit} onChangeText={(t) => setForm({ ...form, unit: t })} />
            <Field label={ut("mp.position")} value={form.position} onChangeText={(t) => setForm({ ...form, position: t })} />
            <Field label={ut("mp.specialty")} value={form.specialty} onChangeText={(t) => setForm({ ...form, specialty: t })} />
            <Field label={ut("mp.rank")} value={form.rank} onChangeText={(t) => setForm({ ...form, rank: t })} />
            <ErrorText>{error}</ErrorText>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Btn title={ut("common.cancel")} size="l" flex={1} onPress={() => setEditing(false)} />
              <Btn title={ut("common.save")} kind="primary" size="l" flex={2} icon="check" loading={busy} onPress={() => void save()} />
            </View>
          </View>
        ) : (
          <List>
            <Kv first label={ut("person.sex")} value={sexLabel} />
            <Kv label={ut("person.birthDate")} value={user?.birthDate ? `${new Date(`${user.birthDate}T12:00:00`).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" })}${age !== null ? `, ${ut("mpt.pf.age").replace("{n}", String(age))}` : ""}` : null} />
            <Kv label={ut("person.unit")} value={user?.unit} />
            <Kv label={ut("mp.position")} value={user?.position} />
            <Kv label={ut("mp.specialty")} value={user?.specialty} />
            <Kv label={ut("mp.rank")} value={user?.rank} />
          </List>
        )}
        {!editing && (!user?.sex || !user?.birthDate) ? (
          <T v="sub" style={{ marginTop: 8, marginHorizontal: 20 }}>
            {ut("mp.noSexBirth")}
          </T>
        ) : null}

        {/* ── на цьому телефоні ── */}
        <SectionHead title={ut("mpt.pf.device")} />
        <List>
          <SettingRow
            first
            icon="cloud-upload"
            tone={queueLeft ? "warn" : "n"}
            label={ut("mq.title")}
            sub={queueLeft ? undefined : ut("mq.allSent")}
            right={queueLeft ? <Pill kind="warn" icon="cloud-off" label={ut("mpt.pf.waiting").replace("{n}", String(queueLeft))} /> : undefined}
            onPress={() => router.push("/(app)/queue")}
          />
          <SettingRow icon="server" tone="n" label={ut("mp.server")} sub={host} />
        </List>

        <View style={{ marginTop: 20, marginHorizontal: 16 }}>
          <Btn title={ut("auth.logout")} size="l" icon="log-out" full onPress={() => void onLogout()} />
        </View>
      </ScrollView>

      <BottomSheet
        visible={langOpen}
        onClose={() => setLangOpen(false)}
        title={ut("profile.language")}
      >
        <View style={{ marginHorizontal: 16, borderWidth: 1, borderColor: c.border, borderRadius: radius.tile, overflow: "hidden" }}>
          {/*
            Языки — перечнем и их собственными именами из общей записи: подпись
            на своём языке, чтобы тот, кто не читает текущий, нашёл свой.
          */}
          {LANGS.map((code, i) => (
            <SettingRow
              key={code}
              first={i === 0}
              label={LANG_NAMES[code].full}
              right={lang === code ? <Icon name="check" size={20} color={c.vink} /> : undefined}
              onPress={() => {
                setLang(code);
                setLangOpen(false);
              }}
            />
          ))}
        </View>
      </BottomSheet>

      <BottomSheet
        visible={!!leaving}
        onClose={() => setLeaving(null)}
        title={ut("mpt.pf.logoutTitle")}
        footer={
          <>
            <Btn title={ut("mpt.pf.stay")} kind="primary" size="l" full onPress={() => setLeaving(null)} />
            <Btn title={ut("mp.logoutAnyway")} size="l" icon="log-out" full onPress={() => void doLogout()} />
          </>
        }
      >
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <Callout kind="warn" icon="cloud-off">
            {(leaving ?? []).map((line) => (
              <T key={line.key} v="note" weight={600}>
                {ut(line.key).replace("{n}", String(line.n))}
              </T>
            ))}
          </Callout>
          <T v="note">{ut("mpt.pf.logoutNote")}</T>
        </View>
      </BottomSheet>
    </View>
  );
}

/** Вариант выбора плиткой: размер текста, тема — три-четыре в ряд, выбранный обведён */
function Choice({ on, label, glyph, onPress }: { on: boolean; label: string; glyph: React.ReactNode; onPress: () => void }) {
  const c = useColors();
  const dark = useIsDark();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: 1,
        height: 64,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        backgroundColor: on ? c.vtint : pressed ? c.sunk2 : c.sunk,
        borderWidth: on ? 2 : 0,
        borderColor: dark ? c.vink : c.v,
      })}
    >
      {glyph}
      <T v="caption" size={13.5} weight={700} color={on ? c.vink : c.text2} scale={false} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

/** Строка «ключ — значение» личных данных: пустое — прочерком, а не пропуском строки */
function Kv({ label, value, first }: { label: string; value: string | null | undefined; first?: boolean }) {
  const c = useColors();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value ?? "—"}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 52,
        paddingVertical: 6,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.divider,
      }}
    >
      <T v="body" size={15} weight={600} tone="text2" style={{ width: 142 }}>
        {label}
      </T>
      <T v="body" weight={700} color={value ? c.text : c.muted} style={{ flex: 1, textAlign: "right" }}>
        {value || "—"}
      </T>
    </View>
  );
}

/**
 * Замок по отпечатку или лицу.
 *
 * Формулировки честные: замок закрывает экран, а не шифрует данные — токен и
 * так лежит в защищённом хранилище системы. И отдельно сказано, чего делать
 * не надо: на общем планшете в кабинете биометрия принадлежит не
 * обследуемому, и замок привяжет учётную запись к чужому пальцу.
 */
function BiometricsRow() {
  const { ut } = useLang();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    void isAvailable().then(setAvailable);
    void isEnabled().then(setOn);
  }, []);

  if (!available) return null;

  const toggle = async () => {
    // включение подтверждаем прямо сейчас: иначе человек узнает, что замок не
    // работает, только когда окажется от него заперт
    if (!on && !(await authenticate())) return;
    await setBiometrics(!on);
    setOn(!on);
  };

  return (
    <>
      <SwitchRow icon="scan-face" tone="good" label={ut("mp.appLock")} sub={ut("mp.lockHint")} value={on} onChange={() => void toggle()} />
      <View style={{ paddingHorizontal: 14, paddingBottom: 12, marginTop: -4 }}>
        <T v="sub" tone="text2">
          {ut("mp.lockShared")}
        </T>
      </View>
    </>
  );
}

/**
 * Назвать имя: раскрытие учётной записи под кодом.
 *
 * Показывается только тем, у кого имени нет. Необратимость названа до
 * нажатия, а не после: пройденные под кодом методики привяжутся к имени, и
 * обратной операции нет — карта уже собрана, и притворяться, что данные
 * исчезли, было бы обманом. Подтверждение — листом, а не системным окном:
 * в веб-сборке Alert не показывается.
 */
function RevealCard() {
  const c = useColors();
  const { ut } = useLang();
  const { user, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [passed, setPassed] = useState<number | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!user?.anonymous && !done) return null;

  const start = async () => {
    setOpen(true);
    /*
     * Число уже пройденного берётся у сервера. Считать его на клиенте
     * значило бы показать «0 методик» тому, кто прошёл двенадцать, — то
     * есть предупредить не о том.
     */
    setPassed(await api.myResponsesCount().catch(() => null));
  };

  const reveal = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await api.reveal({ firstName: firstName.trim(), lastName: lastName.trim() });
      await refresh();
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("join.registerFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <View style={{ marginTop: 16, marginHorizontal: 16 }}>
        <Callout kind="good" icon="circle-check" text={ut("rv.done")} />
      </View>
    );
  }

  return (
    <View style={{ marginTop: 16, marginHorizontal: 16, gap: 12, padding: 16, borderRadius: radius.panel, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel }}>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Squircle icon="user-round" />
        <View style={{ flex: 1 }}>
          <T v="headline">{ut("rv.title")}</T>
          <T v="note" style={{ marginTop: 2 }}>
            {ut("rv.why")}
          </T>
        </View>
      </View>
      {!open ? (
        <Btn title={ut("rv.title")} icon="pencil-line" full onPress={() => void start()} />
      ) : (
        <>
          <Callout kind="warn" icon="circle-alert" text={ut("rv.irreversible")}>
            {passed !== null && passed > 0 ? (
              <T v="note" weight={700} color={c.warn} style={{ marginTop: 4 }}>
                {ut("rv.alreadyPassed").replace("{n}", String(passed))}
              </T>
            ) : null}
          </Callout>
          <Field label={ut("person.lastName")} value={lastName} onChangeText={setLastName} />
          <Field label={ut("person.firstName")} value={firstName} onChangeText={setFirstName} />
          <ErrorText>{error}</ErrorText>
          <Btn
            title={ut("rv.confirm")}
            kind="primary"
            size="l"
            full
            loading={busy}
            disabled={!firstName.trim() || !lastName.trim()}
            onPress={() => setConfirming(true)}
          />
        </>
      )}
      <BottomSheet
        visible={confirming}
        onClose={() => setConfirming(false)}
        title={ut("rv.title")}
        sub={ut("rv.irreversible")}
        footer={
          <>
            <Btn title={ut("rv.confirm")} kind="primary" size="l" full onPress={() => void reveal()} />
            <Btn title={ut("common.cancel")} size="l" full onPress={() => setConfirming(false)} />
          </>
        }
      />
    </View>
  );
}
