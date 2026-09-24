import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { roleRank } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { Loading, useToast } from "../../ui";
import { Page } from "../../ui/layout";
import { IconGear } from "../../ui/glyphs";
import { ActionMenu } from "../../ui/menu";
import { Button, Field, Input, Select } from "../../ui/primitives";
import { useResource } from "../../useResource";

/*
 * «Додати лікаря» (кадр f41) и «Додати адміністратора» (кадр f48) — одна
 * форма в двух прочтениях: две колонки по 372 с зазором 76 по центру, слева
 * анкета, справа служебное и кнопка «Створити» на 36px — ровно в шаг формы
 * 51, то есть вровень с полями (f41: поле «Роль» 426…461, кнопка 477…512).
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
 * Абзац об этом ушёл с глаз в строку для диктора: на кадре под кнопкой
 * чернил нет до самого низа.
 *
 * Шестерёнка с «Редагувати · Змінити пароль · Вийти» на этих кадрах ЕСТЬ —
 * f41 рисует её у правого края колонки (чернила 1385…1409) с раскрытой
 * плашкой 1262…1407, f48 то же. Прежняя запись «шестерёнки здесь нет» была
 * неверна. «Вийти» работает; «Редагувати» и «Змінити пароль» у ещё не
 * заведённой записи смысла не имеют и стоят погашенными с подсказкой — так
 * же, как в чужой карточке.
 *
 * Крошки над заголовком нет: ни на одном из четырнадцати кадров раздела её
 * не рисуют (f41 — 47px чистого белого между полосой и чернилами заголовка).
 * Возврат в список остаётся в верхней полосе и в бургере.
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
  const { user, logout } = useAuth();
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
  /*
   * Выбор по умолчанию — из загруженного справочника, и до его загрузки
   * выбора нет: поле погашено, «Створити» заперта. Иначе у администратора
   * поле на первом кадре показывало бы «Суперадміністратор», а секундой
   * позже молча переключалось на заведующего — и быстро заполненная форма
   * заводила бы суперадмина там, где та же форма чуть позже завела бы
   * заведующего. Класс superadmin — крайний случай, а не умолчание.
   */
  const ready = !!roles.data;
  const fallback = kind === "doctor" ? (options.find((r) => r.code === "specialist")?.id ?? "") : (options[0]?.id ?? (isSuper ? SUPER : ""));
  const chosen = ready ? (role ?? fallback) : "";

  const canSubmit = !busy && ready && firstName.trim() && lastName.trim() && email.trim() && password.length >= 8;
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

  /*
   * Две колонки кадра — два столбца разметки, а не одна сетка с построчным
   * порядком: на узком окне столбцы встают друг под друга целиком (анкета,
   * затем служебное), а построчная сетка перемежала бы их — Ім’я,
   * Спеціалізація, Прізвище, Організація… Строки выравниваются и так: поля
   * одной высоты (36) с одним зазором (15), кнопка — последняя в столбце.
   */
  const column = "grid content-start gap-y-[15px]";

  return (
    <Page
      title={title}
      /* 40 от низа полосы: чернила заголовка на f41 (полоса 17…116, чернила 165) и f48 (15…114 и 162) */
      topGap={40}
      actions={
        <ActionMenu
          label={ut("ppl.actions")}
          glyph={<IconGear />}
          entries={[
            /* править и менять пароль нечему: записи ещё нет */
            { label: ut("ppl.edit"), disabled: true, hint: ut("ppl.notCreatedYet") },
            { label: ut("acct.changePassword"), disabled: true, hint: ut("ppl.notCreatedYet") },
            { label: ut("nav.logout"), onSelect: logout },
          ]}
        />
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
        /*
         * 820 — ширина двух колонок кадра (372 + 76 + 372), по центру
         * колонки содержимого; шаг строк 51 = поле 36 + зазор 15. Зазор от
         * заголовка до первой плашки здесь 37 (f41: чернила заголовка
         * кончаются на 185, плашка начинается на 222), то есть на 9 больше
         * штатных 28 от Page.
         */
        className="mx-auto mt-[9px] grid max-w-[820px] grid-cols-2 gap-x-[76px] gap-y-[15px] max-[900px]:grid-cols-1"
      >
        <div className={column}>
          <Field inline label={ut("person.firstName")}>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} required autoComplete="off" />
          </Field>
          <Field inline label={ut("person.lastName")}>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} required autoComplete="off" />
          </Field>
          <Field inline label={ut("ppl.middleName")}>
            <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} maxLength={80} autoComplete="off" />
          </Field>
          <Field inline label={ut("person.sex")}>
            <Input value="" disabled title={locked} />
          </Field>
          <Field inline label={ut("person.birthDate")}>
            <Input value="" disabled title={locked} />
          </Field>
          <Field inline label={ut("ppl.city")}>
            <Input value="" disabled title={locked} />
          </Field>
        </div>
        <div className={column}>
          <Field inline label={ut("ppl.specialty")}>
            <Input value="" disabled title={locked} />
          </Field>
          <Field inline label={ut("ppl.organization")}>
            <Input value="" disabled title={locked} />
          </Field>
          <Field inline label={ut("ppl.phone")}>
            <Input value="" disabled title={locked} />
          </Field>
          <Field inline label={ut("ppl.email")}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
          </Field>
          <Field inline label={ut("adm.role")}>
            {/* до загрузки справочника — одна погашенная строка «завантажую», а не пустой список: поле обязано объяснять, почему заперто */}
            {/* look="bare": на кадре «Роль» — обычное поле, без каретки и без второй рамки */}
            <Select look="bare" value={chosen} disabled={!ready} onChange={(e) => setRole(e.target.value)}>
              {!ready ? <option value="">{ut("ui.loading")}</option> : null}
              {ready && kind === "admin" && isSuper ? <option value={SUPER}>{ut("nav.roleSuper")}</option> : null}
              {ready
                ? options.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title[lang] ?? r.title.uk ?? r.code}
                    </option>
                  ))
                : null}
              {ready && kind === "doctor" ? <option value="">{ut("ppl.roleNone")}</option> : null}
            </Select>
          </Field>
          <Field inline label={ut("adm.password8")}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required autoComplete="new-password" />
          </Field>
          <Button type="submit" size="form" className="w-full" disabled={!canSubmit}>
            {ut("adm.create")}
          </Button>
        </div>
        {/* справочник ролей не загрузился — форма заперта, и у отказа есть выход: повторить */}
        {roles.error ? (
          <div className="col-span-full">
            <Loading error={roles.error} onRetry={roles.reload} />
          </div>
        ) : null}
        {/* на кадре под кнопкой чернил нет — пояснение остаётся только диктору */}
        <p className="sr-only">{ut("ppl.disabledFieldsHint")}</p>
        {error ? (
          <p role="alert" className="col-span-full m-0 text-[13px] text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Page>
  );
}
