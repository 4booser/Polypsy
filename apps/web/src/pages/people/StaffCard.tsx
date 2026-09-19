import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import type { PatientGroupWithCounts, Respondent, Sex } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { day } from "../../format";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Page, Panel } from "../../ui/layout";
import { IconGear, IconPlusThick } from "../../ui/glyphs";
import { ActionMenu } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { Button, Field, Input, Readout, Select, Tabs } from "../../ui/primitives";
import { usePagedResource, useResource } from "../../useResource";
import { DEFAULT_PER, pageCount, pageFrom, perFrom } from "../constructor/catalogue";
import { loadMember } from "./data";
import { type StaffRow, metaSegments, ownGroups, pageSlice } from "./model";
import { gridClass, metaClass, nameClass, rowClass } from "./StaffList";

/*
 * Карточка сотрудника — кадры f04, f32, f33, f44 (профиль), f35/f36 (вкладка
 * «Групи»), f41, f48, f51 (та же карточка для администратора и суперадмина).
 *
 * Девять кадров — одна карточка в разных редакциях, и вот что из них взято:
 *
 *   заголовок      — имя человека (f33, f35, f36), а не слово «Лікар» /
 *                    «Адміністратор» (f04, f44, f41, f48). Кадры с именем —
 *                    поздние и самые полные (с вкладками), и имя в заголовке
 *                    отличает карточку в истории браузера и закладках; роль
 *                    при этом на экране остаётся — полем «Роль».
 *   поля           — сетка 3×4 в порядке f04/f33: имя · прізвище · по батькові /
 *                    стать · спеціалізація · організація / дата народження ·
 *                    email · телефон / населений пункт · роль. Двухколоночная
 *                    сетка f44/f41/f48 — та же карточка, ужатая под экран без
 *                    списка; здесь под карточкой всегда вкладка, и ширина есть.
 *   шестерёнка     — «Редагувати · Змінити пароль · Вийти», меню ActionMenu.
 *   вкладки        — «Профіль · Пацієнти · Групи» из f36; «Тести · Аналітика ·
 *                    Статистика · Повідомлення» из того же кадра не взяты: у
 *                    сотрудника в системе нет своих тестов и своей аналитики —
 *                    это разделы верхнего меню, и вкладка вела бы туда же.
 *                    Плитки быстрых переходов 3×2 с f33 — те же разделы, что и
 *                    в верхнем меню; вкладки f36 их заменяют.
 *   список «Лікарі» под карточкой администратора (f51) — не взят: связи
 *                    «администратор → его врачи» в модели нет (см. api_gaps).
 *   шапка          — имя слева, вкладки в той же строке (f33, f04), а не
 *                    имя по центру с линией на всю ширину и вкладками по
 *                    центру под ней (f35/f36). Кадры вкладок рисуют шапку
 *                    иначе, чем кадры профиля той же карточки; взят рисунок
 *                    профиля — он же у соседней карты пациента (PatientCard),
 *                    и две карточки людей с разными шапками читались бы как
 *                    два разных экрана. Строка над списком вкладки (Групи)
 *                    при этом с f35/f36 взята как есть.
 *
 * Поля показываются залитыми (Readout look="fill"), как на кадрах: карточка —
 * просмотр, правка — режим по «Редагувати». Пустое поле показывает свою
 * подпись, заполненное — значение; это и есть рисунок кадров, где все поля
 * пустые. Диктору подпись читается всегда (<dt> скрыт с экрана, не из дерева).
 *
 * Чего сервер не даёт (см. api_gaps): чужую карточку править нельзя (PATCH
 * /api/auth/me пишет только в себя), сбросить чужой пароль нельзя, телефон
 * наружу не отдаётся, города в модели нет. Соответствующие пункты меню в
 * чужой карточке остаются, но погашены с подсказкой, а поля стоят пустыми.
 */

interface CardCtx {
  row: StaffRow;
  /** Своя карточка: правка и смена пароля доступны только в ней */
  me: boolean;
  isSuper: boolean;
  editing: boolean;
  setEditing: (v: boolean) => void;
  changingPassword: boolean;
  setChangingPassword: (v: boolean) => void;
  reload: () => void;
}

export default function StaffCard() {
  const { id } = useParams<{ id: string }>();
  const { user, logout, refreshUser, can } = useAuth();
  const { ut } = useLang();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const me = !!user && user.id === id;
  const isSuper = user?.role === "superadmin";
  const canManage = can("users.manage");
  /*
   * Есть ли у смотрящего раздел «Лікарі» — то же правило, что у маршрута
   * /staff в App.tsx: суперадмин либо ступень выше специалиста. Свою карточку
   * открывает каждый сотрудник, а крошка на несуществующий раздел увела бы
   * рядового специалиста через общий перехват на сводку.
   */
  const hasSection = isSuper || (user?.ladderRank ?? 0) > 1;
  const crumbs = hasSection ? <Link to="/staff">{ut("ppl.staff")}</Link> : undefined;

  const viewerId = user?.id ?? "";
  const res = useResource(() => loadMember(id!, { id: viewerId, canManageUsers: canManage }), [id, viewerId, canManage], {
    enabled: !!id && !!user,
  });
  const [editing, setEditing] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  /* уход с карточки на другую сбрасывает режимы: правка одного человека не переезжает к другому */
  useEffect(() => {
    setEditing(false);
    setChangingPassword(false);
  }, [id]);

  const reload = useCallback(() => {
    res.reload();
    /* своя запись живёт ещё и в оболочке: имя в бургере обязано смениться вместе с карточкой */
    if (me) refreshUser();
  }, [res.reload, me, refreshUser]);

  const base = `/staff/${id}`;
  /*
   * «Редагувати» и «Змінити пароль» относятся к профилю; выбранные с другой
   * вкладки, они сперва открывают профиль — иначе человек нажал пункт, и на
   * экране ничего не изменилось.
   */
  const toProfile = () => {
    if (pathname !== base) navigate(base);
  };

  if (res.error) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const row = res.data.row;
  if (!row) {
    return (
      <Page title={ut("ppl.notFound")} crumbs={crumbs}>
        <p className="m-0 text-[13px] text-muted">{ut("ppl.notFound")}</p>
      </Page>
    );
  }

  const ctx: CardCtx = { row, me, isSuper, editing, setEditing, changingPassword, setChangingPassword, reload };

  return (
    <Page
      title={row.fullName || row.email}
      crumbs={crumbs}
      toolbar={
        <Tabs
          label={ut("ppl.tabsLabel")}
          items={[
            { to: base, label: ut("ppl.tabProfile"), end: true },
            { to: `${base}/patients`, label: ut("top.patients") },
            { to: `${base}/groups`, label: ut("top.groups") },
          ]}
        />
      }
      actions={
        <ActionMenu
          label={ut("ppl.actions")}
          glyph={<IconGear />}
          entries={[
            {
              label: ut("ppl.edit"),
              disabled: !me,
              hint: ut("ppl.onlySelf"),
              onSelect: () => {
                toProfile();
                setChangingPassword(false);
                setEditing(true);
              },
            },
            {
              label: ut("acct.changePassword"),
              disabled: !me,
              hint: ut("ppl.onlySelf"),
              onSelect: () => {
                toProfile();
                setEditing(false);
                setChangingPassword(true);
              },
            },
            /* выход — действие над сессией, а не над карточкой: доступен в любой */
            { label: ut("nav.logout"), onSelect: logout },
          ]}
        />
      }
    >
      <Outlet context={ctx} />
    </Page>
  );
}

/* ─────────── профиль ─────────── */

interface FieldSpec {
  key: string;
  label: string;
  value: string | null;
}

/**
 * Сетка полей 3×4 — замер кадра: колонки по 370 при зазоре 45, шаг строк 51
 * (поле 36 + 15). На узком окне — одна колонка.
 */
const fieldGrid = "grid grid-cols-3 gap-x-[45px] gap-y-[15px] max-[900px]:grid-cols-1";

export function StaffProfile() {
  const { row, me, editing, setEditing, changingPassword, setChangingPassword, reload } = useOutletContext<CardCtx>();
  const { ut, lang } = useLang();

  /*
   * Роли-шаблоны — с карточки прав: класс учётной записи (admin) про
   * должность не говорит ничего, а «Роль» на кадре — именно должность.
   * Отказ (ступень выше моей) — не ошибка экрана: должность неизвестна, и
   * поле стоит пустым, как любое другое незаполненное. Карточка есть, а
   * ролей в ней нет — так и пишется: «без роли-шаблона», а не ярлык
   * раздела «Адміністратор групи», который в поле «должность» читался бы
   * как должность.
   */
  const perms = useResource(() => api.userPermissions(row.id).catch(() => null), [row.id]);

  const roleText = useMemo(() => {
    const parts: string[] = [];
    if (row.role === "superadmin") parts.push(ut("nav.roleSuper"));
    const titles = perms.data?.roles.map((r) => r.title[lang] ?? r.title.uk ?? r.code) ?? [];
    if (titles.length) parts.push(...titles);
    else if (perms.data && row.role === "admin") parts.push(ut("ppl.roleNone"));
    return parts.join(" · ");
  }, [row.role, perms.data, lang, ut]);

  const sexText = row.sex === "male" ? ut("person.sex.male") : row.sex === "female" ? ut("person.sex.female") : null;

  /* порядок — построчный, чтобы колонки сетки совпали с кадром (см. шапку файла) */
  const fields: FieldSpec[] = [
    { key: "firstName", label: ut("person.firstName"), value: row.firstName || null },
    { key: "lastName", label: ut("person.lastName"), value: row.lastName || null },
    { key: "middleName", label: ut("ppl.middleName"), value: row.middleName },
    { key: "sex", label: ut("person.sex"), value: sexText },
    { key: "specialty", label: ut("ppl.specialty"), value: row.specialty },
    /* «Організація» — подразделение из карточки: учреждение = экземпляр системы, и второго уровня нет */
    { key: "unit", label: ut("ppl.organization"), value: row.unit },
    { key: "birthDate", label: ut("person.birthDate"), value: row.birthDate ? day(row.birthDate) : null },
    { key: "email", label: ut("person.email"), value: row.email },
    /* телефон и населённый пункт сервер не отдаёт — поля стоят пустыми, как на кадре */
    { key: "phone", label: ut("ppl.phone"), value: null },
    { key: "city", label: ut("ppl.city"), value: null },
    { key: "role", label: ut("adm.role"), value: roleText || null },
  ];

  return (
    <>
      {editing && me ? (
        <ProfileForm
          row={row}
          onDone={() => {
            setEditing(false);
            reload();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <dl className={cx("m-0", fieldGrid)}>
          {fields.map((f) => (
            <div key={f.key} className="min-w-0">
              {/* sr-only, а не hidden: подпись нужна диктору, с экрана её убирает кадр */}
              <dt className="sr-only">{f.label}</dt>
              {/* обрезка — на строке внутри, а не на самом поле: у flex-контейнера многоточие не работает */}
              <Readout as="dd" look="fill" className="m-0 min-w-0">
                {f.value ? (
                  <span className="min-w-0 truncate text-text">{f.value}</span>
                ) : (
                  <span className="min-w-0 truncate font-bold text-primary">{f.label}</span>
                )}
              </Readout>
            </div>
          ))}
        </dl>
      )}

      {changingPassword && me ? <PasswordPanel onDone={() => setChangingPassword(false)} /> : null}
    </>
  );
}

/**
 * Правка своей анкеты — те же места, что и в просмотре, только полями:
 * так «Редагувати» не перестраивает экран, а раскрывает его. Что сервер
 * не принимает (email, телефон, населённый пункт, роль), стоит погашенным на
 * своём месте с подсказкой: убрать поле значило бы, что при правке карточка
 * меняет форму.
 */
function ProfileForm({ row, onDone, onCancel }: { row: StaffRow; onDone: () => void; onCancel: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [firstName, setFirstName] = useState(row.firstName);
  const [lastName, setLastName] = useState(row.lastName);
  const [middleName, setMiddleName] = useState(row.middleName ?? "");
  const [sex, setSex] = useState<Sex | "">(row.sex ?? "");
  const [specialty, setSpecialty] = useState(row.specialty ?? "");
  const [unit, setUnit] = useState(row.unit ?? "");
  const [birthDate, setBirthDate] = useState(row.birthDate ?? "");

  const locked = ut("ppl.notStoredYet");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api.updateMe({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            middleName: middleName.trim() || null,
            sex: sex || null,
            specialty: specialty.trim() || null,
            unit: unit.trim() || null,
            birthDate: birthDate || null,
          });
          onDone();
        }, ut("acct.saved"));
      }}
    >
      <div className={fieldGrid}>
        <Field inline label={ut("person.firstName")}>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={80} required />
        </Field>
        <Field inline label={ut("person.lastName")}>
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={80} required />
        </Field>
        <Field inline label={ut("ppl.middleName")}>
          <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} maxLength={80} />
        </Field>
        <Field inline label={ut("person.sex")}>
          <Select value={sex} onChange={(e) => setSex(e.target.value as Sex | "")}>
            <option value="">{ut("ppl.unset")}</option>
            <option value="male">{ut("person.sex.male")}</option>
            <option value="female">{ut("person.sex.female")}</option>
          </Select>
        </Field>
        <Field inline label={ut("ppl.specialty")}>
          <Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} maxLength={160} />
        </Field>
        <Field inline label={ut("ppl.organization")}>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={160} />
        </Field>
        <Field inline label={ut("person.birthDate")}>
          <Input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
        </Field>
        <Field inline label={ut("person.email")}>
          <Input value={row.email} disabled title={locked} />
        </Field>
        <Field inline label={ut("ppl.phone")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("ppl.city")}>
          <Input value="" disabled title={locked} />
        </Field>
        <Field inline label={ut("adm.role")}>
          <Input value="" disabled title={locked} />
        </Field>
      </div>
      <p className="m-0 mt-[15px] text-[13px] leading-[19px] text-muted">{ut("ppl.disabledFieldsHint")}</p>
      {/* кнопка формы — 45px, 22/700; вторая, «Скасувати», без заливки: две залитых спорят */}
      <div className="mt-[28px] flex flex-wrap gap-[15px]">
        <Button type="submit" size="md" className="min-w-[215px]" disabled={busy || !firstName.trim() || !lastName.trim()}>
          {ut("common.save")}
        </Button>
        <Button type="button" size="md" variant="ghost" onClick={onCancel} disabled={busy}>
          {ut("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Смена пароля — под карточкой, по пункту меню, а не постоянной панелью,
 * как на /account: на кадрах она за шестерёнкой. Порог 10 знаков — с
 * сервера (changePasswordSchema): просить меньше значило бы получать отказ
 * после нажатия.
 */
function PasswordPanel({ onDone }: { onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  return (
    <Panel className="mt-[28px] max-w-[370px]" title={ut("acct.changePassword")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.changePassword(current, next);
            onDone();
          }, ut("acct.passwordChanged"));
        }}
      >
        <Field label={ut("acct.currentPassword")}>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label={ut("acct.newPassword")}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} />
        </Field>
        <div className="mt-[15px] flex flex-wrap gap-[15px]">
          <Button type="submit" size="md" disabled={busy || !current || next.length < 10}>
            {ut("acct.changePassword")}
          </Button>
          <Button type="button" size="md" variant="ghost" onClick={onDone} disabled={busy}>
            {ut("common.cancel")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/* ─────────── строка над списком вкладки ─────────── */

/**
 * «Групи [поиск] + … страницы» — строка над списком внутри вкладки (кадр f36).
 * Та же ось, что у строки над списком экрана: заголовок 24/700 слева, поле
 * тянется, глиф и блок страниц справа. Заголовок здесь — <h2>: <h1> уже занят
 * именем человека.
 */
function SectionBar({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-[28px] flex items-center gap-[24px] max-[900px]:flex-wrap">
      <h2 className="m-0 shrink-0 text-[24px] font-bold leading-tight text-primary">{title}</h2>
      {children ? <div className="flex min-w-0 flex-1 items-center gap-[19px]">{children}</div> : <span className="flex-1" />}
      {actions ? <div className="flex shrink-0 items-center gap-[14px]">{actions}</div> : null}
    </div>
  );
}

function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Input look="outline" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="pr-[44px]" autoComplete="off" />
      <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
        <IconSearchGlass />
      </span>
    </div>
  );
}

/* ─────────── пациенты ─────────── */

/**
 * Вкладка «Пацієнти» (кадр f04): под карточкой — люди в зоне ответственности
 * этого лікаря, той же строкой, что и в списке лікарів: имя, почта, пол, год.
 *
 * Только для своей карточки. «Пациенты другого врача» сервер не отдаёт:
 * список строится по зоне ответственности того, кто спрашивает, а не по
 * закреплению за человеком (см. api_gaps). Показать в чужой карточке свой
 * список значило бы подписать чужим именем своих людей.
 */
export function StaffPatients() {
  const { me } = useOutletContext<CardCtx>();
  const { ut } = useLang();
  return (
    <>
      <SectionBar title={ut("top.patients")} />
      {me ? <OwnPatients /> : <p className="m-0 text-[13px] text-muted">{ut("ppl.patientsOthersHint")}</p>}
    </>
  );
}

/* отдельным компонентом, чтобы запрос за списком не уходил из чужой карточки, где он не нужен */
function OwnPatients() {
  const { ut } = useLang();
  const page = usePagedResource<Respondent>((cursor) => api.respondents({ cursor: cursor ?? undefined }), []);
  const meta = { male: ut("adm.male"), female: ut("adm.female"), year: ut("ppl.yearShort") };

  return (
    <>
      {page.error ? (
        <Loading error={page.error} onRetry={page.reload} />
      ) : !page.items ? (
        <Loading rows={6} />
      ) : page.items.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("ppl.noPatients")}</p>
      ) : (
        <>
          <ul className={cx("m-0 list-none p-0", gridClass)}>
            {page.items.map((p) => (
              <li key={p.userId} className="min-w-0">
                <Link to={`/patients/${p.userId}`} className={rowClass}>
                  <span className={nameClass}>{p.fullName}</span>
                  <span className={metaClass}>
                    {metaSegments(p, meta).map((s) => (
                      <span key={s}>{s}</span>
                    ))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {page.hasMore ? (
            <div className="mt-[14px]">
              <Button variant="ghost" disabled={page.loadingMore} onClick={page.loadMore}>
                {page.loadingMore ? ut("ui.loadingMore") : ut("ui.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

/* ─────────── группы ─────────── */

/**
 * Вкладка «Групи» (кадры f35/f36): группы пациентов этого лікаря в две
 * колонки — название и описание, поиск, «+», страницы.
 *
 * Данные — GET /api/patient-groups с отбором по владельцу: сервер отдаёт
 * суперадмину все группы, остальным только свои (см. ownGroups). Список
 * считается на клиенте целиком, страницы — тоже: групп у человека единицы,
 * а не тысячи, и серверной постраничности у маршрута нет.
 *
 * «+» ведёт в раздел «Групи» верхнего меню: экраны групп делает другая
 * волна, и заводить группу здесь второй формой значило бы две формы одной
 * группы. Показывается только в своей карточке — завести группу другому
 * человеку нельзя: владельцем становится тот, кто заводит.
 */
export function StaffGroups() {
  const { row, me, isSuper } = useOutletContext<CardCtx>();
  const { ut } = useLang();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const pageNo = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const res = useResource(() => api.patientGroups(), []);
  const all = useMemo(() => (res.data ? ownGroups(res.data, row.id, q) : null), [res.data, row.id, q]);
  const pages = pageCount(all?.length ?? 0, per);
  const shown = useMemo(() => (all ? pageSlice(all, pageNo, per) : null), [all, pageNo, per]);

  /* страница за концом списка (сменили «на сторінці») — возвращаемся на ближайшую */
  useEffect(() => {
    if (all && pageNo > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [all, pageNo, pages, update]);

  return (
    <>
      <SectionBar
        title={ut("top.groups")}
        actions={<Pager page={pageNo} pages={pages} per={per} onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })} onPage={(n) => update({ page: n > 1 ? String(n) : null })} />}
      >
        <SearchBox label={ut("ppl.searchGroups")} value={q} onChange={(v) => update({ q: v, page: null })} />
        {me ? (
          <Button size="glyph" variant="ghost" aria-label={ut("adm.newGroup")} onClick={() => navigate("/groups")}>
            <IconPlusThick />
          </Button>
        ) : null}
      </SectionBar>

      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !shown ? (
        <Loading rows={4} />
      ) : shown.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">
          {!me && !isSuper ? ut("ppl.groupsOthersHint") : ut("ppl.noGroups")}
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-2 gap-x-[60px] gap-y-[24px] p-0 max-[900px]:grid-cols-1">
          {shown.map((g) => (
            <GroupRow key={g.id} group={g} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Строка группы: название 15/700 фиолетовым в колонке 172 (может занять две
 * строки — так и на кадре), описание 13/400 серым, не длиннее четырёх строк.
 * Название — не ссылка: карточка группы делается другой волной, и адрес её
 * здесь неизвестен; ссылка в никуда хуже текста.
 */
function GroupRow({ group }: { group: PatientGroupWithCounts }) {
  return (
    <li className="grid min-w-0 grid-cols-[172px_1fr] gap-x-[36px] max-[600px]:grid-cols-1">
      <span className="text-[15px] font-bold leading-[20px] text-primary">{group.title}</span>
      <span className="line-clamp-4 text-[13px] leading-[17px] text-muted">{group.description ?? ""}</span>
    </li>
  );
}
