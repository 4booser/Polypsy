import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { type Lang, type PermissionEffectKind, type Sex, roleRank, t } from "@quizzy/shared";
import { ApiError, api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { Callout, Ic, Loading, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { Page, Panel } from "../../ui/layout";
import { Button, ChoiceCard, ErrorText, Field, Input, Select, Switch } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { loadDirectory } from "./data";
import { facetValues, isDoctor, workplaceOf } from "./model";
import { AIc, fill, plural, shortName } from "./parts";

/*
 * «Додати лікаря» и «Додати адміністратора» — Polypsy 2.0, макет
 * admin-staff-new: форма разделами (хто це, де працює, вхід, роль) и колонка
 * справа — что откроет роль, кто уже есть в выбранном відділенні, что будет
 * после создания.
 *
 * Как устроено заведение на сервере — и почему форма такая:
 *
 *   учётная запись — POST /api/users: ФИО, анкета, почта, пароль, класс и
 *   «сменить пароль при первом входе». Писем-приглашений сотрудникам сервер
 *   не шлёт, поэтому «Надіслати запрошення» с макета здесь нет: пароль
 *   задаёт администратор (можно сгенерировать), а флаг временного пароля
 *   включён по умолчанию — человек сменит его при первом входе;
 *
 *   роль-шаблон — второй вызов (PUT /api/permissions/users/:id/roles):
 *   встроенную роль сервер выдаёт сам, набор дописывается, а не заменяется;
 *
 *   відділення и кабинет — профиль приёма (PUT /api/clinic/specialists/:id),
 *   только у того, кому открыто departments.manage; без права поля нет.
 *
 * Телефон с макета не принимается: у сервера для него свой путь со слепым
 * индексом и проверкой дублей, и при заведении сотрудника его нет (см.
 * отчёт участка). «Вимагати другий фактор» — политика по классам в
 * техпанели, а не флаг одной записи; его здесь тоже нет.
 */

export type NewKind = "doctor" | "admin";

/** Класс superadmin в списке ролей — отдельным значением, не id справочника */
const SUPER = "superadmin";
/** Без роли-шаблона: только встроенная */
const NONE = "none";

const KINDS: PermissionEffectKind[] = ["screen", "action", "analysis"];

export default function StaffNew({ kind }: { kind: NewKind }) {
  const { ut, lang } = useLang();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const isSuper = user?.role === "superadmin";
  const canDepartments = can("departments.manage");
  const back = kind === "admin" ? "/admins" : "/staff";

  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [sex, setSex] = useState<Sex | "">("");
  const [birthDate, setBirthDate] = useState("");
  const [locality, setLocality] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [position, setPosition] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [unit, setUnit] = useState("");
  const [room, setRoom] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [temporary, setTemporary] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const roles = useResource(() => api.permissionRoles(), []);
  const catalogue = useResource(() => api.permissionCatalogue(), []);
  const departments = useResource(() => (canDepartments ? api.departments().then((r) => r.items) : Promise.resolve([])), [canDepartments]);
  /* справочник — ради посад, которые уже есть, и колонки «кто в відділенні»; закрытый — не беда, форма работает и без него */
  const dir = useResource(() => loadDirectory({ id: user?.id ?? "", canManageUsers: can("users.manage") }).catch(() => null), [user?.id]);

  /*
   * Лікарю предлагаются все назначаемые роли, кроме встроенной (её сервер
   * даёт сам); администратору — только ступени выше специалиста и, если
   * заводит суперадмин, класс superadmin.
   */
  const options = useMemo(() => {
    const list = (roles.data ?? []).filter((r) => r.assignable && !r.isBuiltin);
    return kind === "admin" ? list.filter((r) => roleRank(r.code) > 1) : list;
  }, [roles.data, kind]);
  const builtin = (roles.data ?? []).find((r) => r.isBuiltin) ?? null;
  /*
   * Выбор по умолчанию — из загруженного справочника, и до его загрузки
   * выбора нет: «Створити» заперта. Иначе быстро заполненная форма заводила
   * бы не того, кого выбрали бы секундой позже. Класс superadmin — крайний
   * случай, а не умолчание.
   */
  const ready = !!roles.data;
  const fallback =
    kind === "doctor" ? (options.find((r) => r.code === "specialist")?.id ?? NONE) : (options[0]?.id ?? (isSuper ? SUPER : ""));
  const chosen = ready ? (role ?? fallback) : "";
  const chosenRole = options.find((r) => r.id === chosen) ?? null;

  const problems = {
    lastName: !lastName.trim(),
    firstName: !firstName.trim(),
    email: !/^\S+@\S+\.\S+$/.test(email.trim()) || !!emailError,
    password: password.length < 8,
  };
  const bad = (Object.keys(problems) as (keyof typeof problems)[]).filter((k) => problems[k]);
  const canSubmit = !busy && ready && !!chosen && bad.length === 0;
  const fieldName: Record<keyof typeof problems, string> = {
    lastName: ut("person.lastName"),
    firstName: ut("person.firstName"),
    email: ut("adm2.emailLogin"),
    password: ut("adm2.password"),
  };

  const positions = useMemo(() => facetValues((dir.data?.rows ?? []).filter(isDoctor), "position"), [dir.data]);
  const department = (departments.data ?? []).find((d) => d.id === departmentId) ?? null;

  async function submit() {
    setTried(true);
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createUser({
        email: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        middleName: middleName.trim() || null,
        role: chosen === SUPER ? "superadmin" : "admin",
        mustChangePassword: temporary,
        sex: sex || null,
        birthDate: birthDate || null,
        unit: unit.trim() || null,
        position: position.trim() || null,
        specialty: specialty.trim() || null,
        locality: locality.trim() || null,
      });
      if (chosen && chosen !== SUPER && chosen !== NONE) {
        const card = await api.userPermissions(created.id);
        const have = card.roles.map((r) => r.roleId);
        if (!have.includes(chosen)) await api.setUserRoles(created.id, [...have, chosen]);
      }
      if (departmentId && canDepartments) {
        /* профиль приёма — отдельным шагом: запись уже есть, и отказ здесь не должен её прятать */
        await api
          .saveSpecialistProfile(created.id, { departmentId, position: position.trim() || null, room: room.trim() || null })
          .catch((e: unknown) => toast(e instanceof Error ? e.message : ut("adm.createFailed"), "err"));
      }
      toast(ut("ppl.created"), "ok");
      navigate(`/staff/${created.id}`);
    } catch (e) {
      /* 409 у этого маршрута — только занятая почта: отказ встаёт под полем, а не общей строкой */
      if (e instanceof ApiError && (e.status === 409 || /email/i.test(e.message))) setEmailError(e.message);
      else setError(e instanceof Error ? e.message : ut("adm.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  const title = kind === "admin" ? ut("adm.addAdmin") : ut("ppl.addDoctor");

  return (
    <Page title={title} back={{ to: back, label: ut("adm2.backToList") }} meta={[ut("adm2.newAccountMeta"), ut("adm2.newAccountWhy")]}>
      <div className="grid items-start gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title={ut("adm2.newAccount")}
          icon={<AIc.userPlus />}
          sub={ut("adm2.newAccountSub")}
          footer={
            <div className="flex w-full flex-wrap items-center gap-3">
              {tried && bad.length ? (
                <ErrorText className="m-0">{fill(ut("adm2.fieldsToFix"), { n: bad.length, fields: bad.map((k) => fieldName[k]).join(", ") })}</ErrorText>
              ) : error ? (
                <ErrorText className="m-0">{error}</ErrorText>
              ) : null}
              <span className="ml-auto flex items-center gap-2">
                <Button variant="ghost" onClick={() => navigate(back)}>
                  {ut("common.cancel")}
                </Button>
                <Button variant="primary" icon={<AIc.userPlus size={15} />} disabled={busy || !ready} onClick={() => void submit()}>
                  {ut("adm.create")}
                </Button>
              </span>
            </div>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          >
            <FormSection title={ut("adm2.whoIs")} sub={ut("adm2.whoIsSub")}>
              <div className="grid gap-x-3 min-[760px]:grid-cols-3">
                <Field label={ut("person.lastName")} error={tried && problems.lastName ? ut("adm2.required") : null}>
                  <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} autoComplete="off" data-autofocus />
                </Field>
                <Field label={ut("person.firstName")} error={tried && problems.firstName ? ut("adm2.required") : null}>
                  <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} autoComplete="off" />
                </Field>
                <Field label={ut("adm2.middleName")} optional>
                  <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} maxLength={80} autoComplete="off" />
                </Field>
                <Field label={ut("person.sex")}>
                  <Select value={sex} onChange={(e) => setSex(e.target.value as Sex | "")}>
                    <option value="">{ut("ppl.unset")}</option>
                    <option value="female">{ut("person.sex.female")}</option>
                    <option value="male">{ut("person.sex.male")}</option>
                  </Select>
                </Field>
                <Field label={ut("person.birthDate")} optional>
                  <Input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
                </Field>
                <Field label={ut("adm2.locality")} optional>
                  <Input value={locality} onChange={(e) => setLocality(e.target.value)} maxLength={160} autoComplete="off" />
                </Field>
              </div>
            </FormSection>

            <FormSection title={ut("adm2.whereWorks")} sub={canDepartments ? ut("adm2.whereWorksSub") : ut("adm2.whereWorksSubNoDept")}>
              <div className="grid gap-x-3 min-[760px]:grid-cols-2">
                {canDepartments ? (
                  <Field label={ut("ppl.department")} optional hint={ut("adm2.departmentHint")}>
                    <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={!departments.data}>
                      <option value="">{ut("adm2.noDepartmentYet")}</option>
                      {(departments.data ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label={ut("mp.position")} optional hint={positions.length ? ut("adm2.positionHint") : undefined}>
                  <Input value={position} onChange={(e) => setPosition(e.target.value)} maxLength={160} list="staff-positions" autoComplete="off" />
                </Field>
                <datalist id="staff-positions">
                  {positions.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
                <Field label={ut("ppl.specialty")} optional hint={ut("adm2.specialtyHint")}>
                  <Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} maxLength={160} autoComplete="off" />
                </Field>
                <Field label={ut("ppl.organization")} optional>
                  <Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={160} autoComplete="off" />
                </Field>
                {canDepartments && departmentId ? (
                  <Field label={ut("adm2.defaultRoom")} optional>
                    <Input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={50} icon={<AIc.door size={15} />} autoComplete="off" />
                  </Field>
                ) : null}
              </div>
            </FormSection>

            <FormSection title={ut("adm2.signIn")} sub={ut("adm2.signInSub")}>
              <Field label={ut("adm2.emailLogin")} error={emailError ?? (tried && problems.email ? ut("adm2.emailInvalid") : null)}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailError(null);
                  }}
                  icon={<AIc.at size={15} />}
                  autoComplete="off"
                />
              </Field>
              <Field
                label={ut("adm2.password")}
                hint={ut("adm2.passwordHint")}
                error={tried && problems.password ? ut("adm2.passwordShort") : null}
              >
                <div className="flex gap-2">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    className={cx("flex-1", showPassword && "font-mono")}
                    suffix={
                      <button
                        type="button"
                        aria-label={showPassword ? ut("adm2.hidePassword") : ut("adm2.showPassword")}
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword((v) => !v)}
                        className="inline-grid size-7 min-h-0 cursor-pointer place-items-center rounded-[8px] border-0 bg-transparent p-0 text-muted hover:bg-sunk hover:text-text"
                      >
                        {showPassword ? <AIc.eyeOff size={15} /> : <Ic.eye size={15} />}
                      </button>
                    }
                  />
                  <Button
                    type="button"
                    icon={<AIc.rotate size={15} />}
                    onClick={() => {
                      setPassword(generatePassword());
                      setShowPassword(true);
                    }}
                  >
                    {ut("adm2.generate")}
                  </Button>
                </div>
              </Field>
              <Switch checked={temporary} onChange={setTemporary} label={ut("adm2.temporary")} sub={ut("adm2.temporarySub")} />
            </FormSection>

            <FormSection title={ut("adm.role")} sub={ut("adm2.roleSub")} last>
              {roles.error ? (
                <Loading error={roles.error} onRetry={roles.reload} bare />
              ) : !ready ? (
                <Loading rows={3} bare />
              ) : (
                <div role="radiogroup" aria-label={ut("adm.role")} className="flex flex-col gap-2">
                  {kind === "admin" && isSuper ? (
                    <ChoiceCard
                      name="role"
                      value={SUPER}
                      checked={chosen === SUPER}
                      onChange={setRole}
                      title={<RoleTitle title={ut("perm.superadminTitle")} meta={ut("adm2.allRights")} />}
                      sub={ut("adm2.superSub")}
                    />
                  ) : null}
                  {options.map((r) => (
                    <ChoiceCard
                      key={r.id}
                      name="role"
                      value={r.id}
                      checked={chosen === r.id}
                      onChange={setRole}
                      title={
                        <RoleTitle
                          title={t(r.title, lang)}
                          meta={`${roleRank(r.code) > 0 ? fill(ut("adm2.stepN"), { n: roleRank(r.code) }) : ut("adm2.outsideChainShort")}, ${plural(ut("adm2.nRights"), r.permissions.length, lang)}`}
                        />
                      }
                      sub={roleSummary(r.permissions, catalogue.data, lang)}
                    />
                  ))}
                  {kind === "doctor" ? (
                    <ChoiceCard
                      name="role"
                      value={NONE}
                      checked={chosen === NONE}
                      onChange={setRole}
                      title={<RoleTitle title={ut("ppl.roleNone")} meta={builtin ? plural(ut("adm2.nRights"), builtin.permissions.length, lang) : ""} />}
                      sub={ut("adm2.builtinOnlySub")}
                    />
                  ) : null}
                </div>
              )}
              <p className="m-0 mt-3 flex items-start gap-1.5 text-small text-muted">
                <Ic.info size={14} className="mt-0.5" />
                {ut("adm2.builtinNote")}
              </p>
            </FormSection>
          </form>
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <RoleEffect
            chosen={chosen === SUPER ? "super" : chosenRole}
            builtin={builtin}
            catalogue={catalogue.data ?? null}
          />
          {department ? <DepartmentPanel title={department.title} rows={(dir.data?.rows ?? []).filter((r) => isDoctor(r) && workplaceOf(r) === department.title)} /> : null}
          <Panel title={ut("adm2.afterCreate")} icon={<Ic.list />}>
            <ul className="m-0 flex list-none flex-col p-0">
              <Step icon={<AIc.key size={15} />} title={temporary ? ut("adm2.stepTempTitle") : ut("adm2.stepPassTitle")} sub={ut("adm2.stepPassSub")} />
              {temporary ? <Step icon={<AIc.rotate size={15} />} title={ut("adm2.stepChangeTitle")} sub={ut("adm2.stepChangeSub")} /> : null}
              <Step icon={<AIc.smartphone size={15} />} title={ut("adm2.stepMfaTitle")} sub={ut("adm2.stepMfaSub")} />
              <Step icon={<AIc.key size={15} />} title={ut("adm2.stepRoleTitle")} sub={ut("adm2.stepRoleSub")} />
            </ul>
            <p className="m-0 mt-3 text-small text-muted">{ut("adm2.afterCreateNote")}</p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}

/** Случайный пароль из 14 знаков без похожих букв: его диктуют и переписывают с экрана */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function FormSection({ title, sub, children, last }: { title: string; sub?: string; children: ReactNode; last?: boolean }) {
  return (
    <section className={cx("pb-4", last ? "" : "mb-4 border-b border-divider")}>
      <h3 className="m-0 mb-3 flex flex-wrap items-baseline gap-x-2 text-h3 font-extrabold text-text">
        {title}
        {sub ? <span className="text-small font-medium text-muted">{sub}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function RoleTitle({ title, meta }: { title: string; meta: string }) {
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span>{title}</span>
      <span className="text-caption font-medium text-muted">{meta}</span>
    </span>
  );
}

type Catalogue = Awaited<ReturnType<typeof api.permissionCatalogue>>;
type Role = Awaited<ReturnType<typeof api.permissionRoles>>[number];

/** Чем роль занята — названия первых прав её набора, без кодов */
function roleSummary(permissions: string[], catalogue: Catalogue | null, lang: Lang): string {
  if (!catalogue) return "";
  const titles: string[] = [];
  for (const g of catalogue.groups) for (const p of g.permissions) if (permissions.includes(p.code)) titles.push(t(p.title, lang));
  return titles.slice(0, 4).join(", ") + (titles.length > 4 ? "…" : "");
}

/**
 * Что откроет роль — последствиями, а не кодами: разделы меню, действия,
 * аналитика (effect.opens справочника прав). Встроенная роль добавляется
 * сервером каждому — то, что она даёт сверх выбранной, показано отдельно.
 */
function RoleEffect({ chosen, builtin, catalogue }: { chosen: Role | "super" | null; builtin: Role | null; catalogue: Catalogue | null }) {
  const { ut, lang } = useLang();
  if (!catalogue) return null;
  const all = catalogue.groups.flatMap((g) => g.permissions);
  if (chosen === "super") {
    return (
      <Panel title={ut("adm2.roleOpens")} icon={<AIc.key />} sub={ut("perm.superadminTitle")}>
        <p className="m-0 text-small text-text-2">{ut("perm.superadminNote")}</p>
      </Panel>
    );
  }
  const mine = new Set(chosen?.permissions ?? []);
  const fromBuiltin = (builtin?.permissions ?? []).filter((c) => !mine.has(c));
  const union = new Set([...mine, ...fromBuiltin]);
  const missing = all.filter((p) => !union.has(p.code));
  const kindTitle: Record<PermissionEffectKind, string> = {
    screen: ut("perm.kind.screen"),
    action: ut("perm.kind.action"),
    analysis: ut("perm.kind.analysis"),
  };
  const kindIcon: Record<PermissionEffectKind, ReactNode> = {
    screen: <Ic.layers size={15} />,
    action: <Ic.mousePointer size={15} />,
    analysis: <Ic.chart size={15} />,
  };
  return (
    <Panel
      title={ut("adm2.roleOpens")}
      icon={<AIc.key />}
      sub={chosen ? `«${t(chosen.title, lang)}», ${plural(ut("adm2.nRights"), chosen.permissions.length, lang)}` : ut("ppl.roleNone")}
    >
      <div className="flex flex-col">
        {KINDS.map((k) => {
          const here = all.filter((p) => mine.has(p.code) && p.effect.kind === k);
          if (!here.length) return null;
          return (
            <div key={k} className="border-b border-divider py-2.5 first:pt-0">
              <p className="m-0 mb-1 flex items-center gap-2 text-small font-bold text-text">
                <span className="text-muted">{kindIcon[k]}</span>
                {kindTitle[k]}
              </p>
              <ul className="m-0 list-disc pl-5 text-small leading-[19px] text-text-2">
                {here.map((p) => (
                  <li key={p.code}>{t(p.effect.opens, lang)}</li>
                ))}
              </ul>
            </div>
          );
        })}
        {builtin && fromBuiltin.length ? (
          <div className="py-2.5">
            <p className="m-0 mb-1 flex items-center gap-2 text-small font-bold text-text">
              <span className="text-muted">
                <Ic.checkCheck size={15} />
              </span>
              {fill(ut("adm2.fromBuiltin"), { role: t(builtin.title, lang) })}
            </p>
            <ul className="m-0 list-disc pl-5 text-small leading-[19px] text-text-2">
              {fromBuiltin.map((code) => {
                const p = all.find((x) => x.code === code);
                return <li key={code}>{p ? t(p.title, lang) : code}</li>;
              })}
            </ul>
          </div>
        ) : null}
      </div>
      <p className="m-0 mt-2 text-small text-muted">
        {fill(ut("adm2.totalRights"), { n: union.size, total: all.length })}
        {missing.length ? ` ${fill(ut("adm2.wontOpen"), { list: missing.map((p) => t(p.title, lang).toLowerCase()).join(", ") })}` : ""}
      </p>
    </Panel>
  );
}

/** Кто уже работает в выбранном відділенні — и сколько пациентов ведёт каждый */
function DepartmentPanel({ title, rows }: { title: string; rows: { id: string; fullName: string; position: string | null; account?: { patients: number } }[] }) {
  const { ut, lang } = useLang();
  const total = rows.reduce((n, r) => n + (r.account?.patients ?? 0), 0);
  const max = Math.max(1, ...rows.map((r) => r.account?.patients ?? 0));
  return (
    <Panel title={title} icon={<AIc.building />} sub={plural(ut("adm2.nDoctors"), rows.length, lang)}>
      {rows.length ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 border-b border-divider py-2 last:border-0">
              <span className="min-w-0">
                <b className="block truncate text-small font-bold text-text">{shortName(r.fullName)}</b>
                <small className="block truncate text-caption text-muted">{r.position ?? ""}</small>
              </span>
              <span className="flex flex-col gap-1">
                <span className="text-caption text-muted">
                  <b className="text-small font-extrabold tabular-nums text-text">{r.account?.patients ?? 0}</b> {ut("adm2.patientsShort")}
                </span>
                <span className="h-1.5 overflow-hidden rounded-[3px] bg-track">
                  <b className="block h-full rounded-[3px] bg-violet" style={{ width: `${((r.account?.patients ?? 0) / max) * 100}%` }} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Callout kind="line">{ut("adm2.departmentEmpty")}</Callout>
      )}
      {rows.length ? <p className="m-0 mt-3 text-small text-muted">{fill(ut("adm2.departmentLoad"), { n: plural(ut("adm2.nPatients"), total, lang), doctors: plural(ut("adm2.nDoctorsDat"), rows.length, lang) })}</p> : null}
    </Panel>
  );
}

function Step({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <li className="flex items-start gap-2.5 border-b border-divider py-2 last:border-0">
      <span className="inline-grid size-7 shrink-0 place-items-center rounded-[9px] bg-sunk text-muted">{icon}</span>
      <span className="min-w-0 text-small leading-[18px]">
        <b className="block font-bold text-text">{title}</b>
        <span className="text-text-2">{sub}</span>
      </span>
    </li>
  );
}
