import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { roleRank } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { useToast } from "../../ui";
import { Page } from "../../ui/layout";
import { Button, Field, Input, Select } from "../../ui/primitives";
import { useResource } from "../../useResource";

/*
 * «Додати лікаря» (кадр f42) и «Додати адміністратора» (кадр f49) — одна
 * форма в двух прочтениях: две колонки по центру, слева анкета, справа
 * служебное и кнопка «Створити» на 45px.
 *
 * Чего на кадре нет, а здесь есть: поле «Пароль». Сервер заводит учётную
 * запись только с паролем (createUserSchema, от 8 знаков) — без него кнопка
 * «Створити» была бы обещанием без исполнения. Стоит последним в правой
 * колонке, перед кнопкой.
 *
 * Что на кадре есть, а сервер не принимает: стать, дата народження,
 * спеціалізація, організація, телефон, населений пункт. Поля стоят на своих
 * местах, но погашены с подсказкой (см. api_gaps): принять их и молча
 * потерять — хуже, чем не принять. Убрать их с формы значило бы нарисовать
 * не тот кадр; сохранить «потом» человек сможет сам в своей карточке
 * (PATCH /api/auth/me) — кроме телефона и города, которых у сервера нет.
 *
 * Шестерёнки с «Редагувати · Змінити пароль · Вийти» на этих кадрах нет:
 * у ещё не заведённой записи нечего редактировать, а «Вийти» есть в бургере.
 *
 * «Роль» — в два слоя, как устроена система: класс учётной записи (лікар —
 * всегда admin; администратор — superadmin либо admin с ролью ступенью выше
 * специалиста) и роль-шаблон из справочника, которую сервер назначает вторым
 * вызовом. Встроенная роль, которую сервер выдаёт каждому сотруднику при
 * заведении, при этом сохраняется: набор ролей дописывается, а не заменяется.
 */

export type NewKind = "doctor" | "admin";

/** Класс superadmin в списке ролей — отдельным значением, не id справочника */
const SUPER = "superadmin";

export default function StaffNew({ kind }: { kind: NewKind }) {
  const { ut, lang } = useLang();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const isSuper = user?.role === "superadmin";

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles = useResource(() => api.permissionRoles(), []);
  /*
   * Лікарю предлагаются все назначаемые роли, кроме встроенной (её сервер
   * даёт сам); администратору — только ступени выше специалиста и, если
   * заводит суперадмин, класс superadmin.
   */
  const options = useMemo(() => {
    const list = (roles.data ?? []).filter((r) => r.assignable && !r.isBuiltin);
    return kind === "admin" ? list.filter((r) => roleRank(r.code) > 1) : list;
  }, [roles.data, kind]);
  const chosen = role ?? (kind === "doctor" ? (options.find((r) => r.code === "specialist")?.id ?? "") : (options[0]?.id ?? (isSuper ? SUPER : "")));

  const canSubmit = !busy && firstName.trim() && lastName.trim() && email.trim() && password.length >= 8;
  const locked = ut("ppl.notStoredYet");
  const title = kind === "admin" ? ut("adm.addAdmin") : ut("ppl.addDoctor");

  async function submit() {
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
      });
      if (chosen && chosen !== SUPER) {
        const card = await api.userPermissions(created.id);
        const have = card.roles.map((r) => r.roleId);
        if (!have.includes(chosen)) await api.setUserRoles(created.id, [...have, chosen]);
      }
      toast(ut("ppl.created"), "ok");
      navigate(`/staff/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("adm.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={title} crumbs={<Link to={kind === "admin" ? "/admins" : "/staff"}>{kind === "admin" ? ut("adm.admins") : ut("ppl.staff")}</Link>}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
        /*
         * 820 — ширина двух колонок кадра (370 + 78 + 370), по центру
         * колонки содержимого; шаг строк 51 = поле 36 + зазор 15.
         */
        className="mx-auto grid max-w-[820px] grid-cols-2 gap-x-[78px] gap-y-[15px] max-[900px]:grid-cols-1"
      >
        <Field inline label={ut("person.firstName")}>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} required autoComplete="off" />
        </Field>
        <Field inline label={ut("ppl.specialty")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("person.lastName")}>
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} required autoComplete="off" />
        </Field>
        <Field inline label={ut("ppl.organization")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("ppl.middleName")}>
          <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <Field inline label={ut("ppl.phone")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("person.sex")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("person.email")}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </Field>
        <Field inline label={ut("person.birthDate")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("adm.role")}>
          <Select value={chosen} onChange={(e) => setRole(e.target.value)}>
            {kind === "admin" && isSuper ? <option value={SUPER}>{ut("nav.roleSuper")}</option> : null}
            {options.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title[lang] ?? r.title.uk ?? r.code}
              </option>
            ))}
            {kind === "doctor" ? <option value="">{ut("ppl.roleNone")}</option> : null}
          </Select>
        </Field>
        <Field inline label={ut("ppl.city")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("adm.password8")}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required autoComplete="new-password" />
        </Field>
        {/* пустая клетка слева держит кнопку в правой колонке, как на кадре */}
        <span aria-hidden className="max-[900px]:hidden" />
        <Button type="submit" size="md" className="w-full" disabled={!canSubmit}>
          {ut("adm.create")}
        </Button>
        <p className="col-span-full m-0 text-[13px] leading-[19px] text-muted">{ut("ppl.disabledFieldsHint")}</p>
        {error ? (
          <p role="alert" className="col-span-full m-0 text-[13px] text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Page>
  );
}
