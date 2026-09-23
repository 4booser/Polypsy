import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import type { PatientGroupWithCounts, Respondent, Sex, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { day } from "../../format";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Page } from "../../ui/layout";
import { IconGear, IconPlusThick } from "../../ui/glyphs";
import { ActionMenu } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { Button, Field, Input, Readout, Select } from "../../ui/primitives";
import { barKind, type BarKind } from "../../shell/Topbar";
import { usePagedResource, useResource } from "../../useResource";
import { DEFAULT_PER, pageCount, pageFrom, perFrom } from "../constructor/catalogue";
import { loadDirectory, loadMember } from "./data";
import { type StaffRow, isDoctor, matchesQuery, metaSegments, ownGroups, pageSlice } from "./model";
import { gridClass, metaClass, nameClass, rowClass } from "./StaffList";

/*
 * Карточка сотрудника — кадры f04, f30, f31 (общая консоль), f34/f35
 * (разделы карточки), f40, f43, f47, f50 (консоль людей). Восемь кадров одной
 * карточки, и различия между ними не редакции, а два разных места экрана.
 *
 * ДВЕ ШАПКИ, И ЭТО НЕ ПРОТИВОРЕЧИЕ КАДРОВ.
 *
 *   профиль (/staff/:id) — заголовок слева, шестерня справа: так на f04, f30,
 *   f31, f40, f43, f47, f50 — на всех семи кадрах профиля без исключения;
 *
 *   раздел карточки (/staff/:id/*) — имя ПО ЦЕНТРУ колонки (f35: чернила
 *   613…996 при центре колонки 805), под ним линия #b299cc во всю ширину
 *   (y 213…214), под ней подменю из семи пунктов по центру (229…250), и
 *   только потом строка раздела. Так на f34 и f35, и другой шапки у разделов
 *   карточки нет ни на одном кадре.
 *
 * Шестерни на f34/f35 нет вовсе — её и не рисуем: «Редагувати» и «Змінити
 * пароль» относятся к профилю, выход есть в бургере, а на профиль ведёт
 * первый пункт подменю.
 *
 * ЗАГОЛОВОК ПРОФИЛЯ.
 *
 *   своя карточка — СЛОВО РОЛИ: «Лікар» (f04 у специалиста и f30 у
 *   заведующего), «Адміністратор» (f40), «Супер Адміністратор» (f47). Имя
 *   человек и так знает, а роль на своей карточке — единственное, чего нет в
 *   полях (поле «Роль» несёт роль-шаблон, то есть должность, а не класс
 *   записи);
 *
 *   чужая карточка — ПІБ (f31, f34, f35). Кадры f43 и f50 печатают над чужой
 *   карточкой слово роли — их два против трёх, и решает не счёт: только имя
 *   отличает карточку одного человека от карточки другого в истории браузера,
 *   в закладке и в заголовке окна. На f43/f50 нарисован тот же шаблон, что на
 *   f40/f47, где заголовком роль стоит правомерно, — потому что карточка там
 *   своя.
 *
 * ЧТО ЛЕЖИТ ПОД КАРТОЧКОЙ — тоже свойство места, а не роли (см. underCard).
 *
 * РАСКЛАДКА ПОЛЕЙ идёт следом за этим: там, где под карточкой что-то есть,
 * поля стоят сеткой 3×4 во всю ширину колонки (f04, f30, f31, f50); там, где
 * под ней пусто, — двумя колонками по 372 с зазором 76, по центру (f40, f43,
 * f47). Порядок полей в двух раскладках РАЗНЫЙ, и это замер, а не описка: в
 * 3×4 построчно (ряд 3 — «Дата народження | email | телефон»), в двух
 * колонках по столбцам, и телефон там стоит ПЕРЕД email (правый столбец:
 * спеціалізація, організація, телефон, email, роль).
 *
 * Поля показываются залитыми (Readout look="fill"), как на кадрах: карточка —
 * просмотр, правка — режим по «Редагувати». Пустое поле показывает свою
 * подпись, заполненное — значение; это и есть рисунок кадров, где все поля
 * пустые. Диктору подпись читается всегда (<dt> скрыт с экрана, не из дерева).
 *
 * Крошки над заголовком нет ни на одном из четырнадцати кадров раздела (f41:
 * между низом полосы 116 и чернилами заголовка 163 — 47px чистого белого).
 * Убрана; возврат в список не потерян — он в верхней полосе и в бургере.
 *
 * Чего сервер не даёт (см. api_gaps): чужую карточку править нельзя (PATCH
 * /api/auth/me пишет только в себя), сбросить чужой пароль нельзя, телефон
 * наружу не отдаётся, города в модели нет, связи «этот администратор → его
 * лікарі» не существует. На кадрах f31/f43/f50 все три пункта меню нарисованы
 * одинаково нажимаемыми — здесь два из них в чужой карточке погашены с
 * подсказкой: пункт, ведущий к отказу после заполнения формы, хуже
 * погашенного.
 */

/** Что стоит под карточкой: список, плитки или ничего */
type Under = "patients" | "staff" | "tiles" | "none";

/**
 * Под карточкой — то, чего на этом рабочем месте иначе не увидеть.
 *
 * Разбор кадров, все восемь:
 *
 *   общая консоль (шесть или семь пунктов в полосе)
 *     своя карточка лікаря          → «Пацієнти» списком прямо здесь  (f04)
 *     своя карточка адміністратора  → «Лікарі» списком прямо здесь    (f30)
 *     чужая карточка                → шесть плиток переходов 3×2      (f31)
 *
 *   консоль людей (один пункт в полосе)
 *     своя карточка                 → ничего                     (f40, f47)
 *     чужая карточка лікаря         → ничего                          (f43)
 *     чужая карточка у суперадміна  → «Лікарі» этого адміністратора    (f50)
 *
 * Список под СВОЕЙ карточкой стоит на том же экране, а не за вкладкой: на
 * f04/f30 он нарисован под разделителем, и нажимать ради него «Пацієнти» не
 * нужно. Вкладки «Профіль · Пацієнти · Групи», которые тут были, заменены
 * подменю карточки с f35 — оно из семи пунктов и живёт на разделах.
 */
function underCard(kind: BarKind, me: boolean): Under {
  if (kind === "peopleStaff" || kind === "peopleAdmins") {
    /* «Лікарі цього адміністратора» — только у суперадміна и только в чужой карточке (f50) */
    return kind === "peopleAdmins" && !me ? "staff" : "none";
  }
  if (!me) return "tiles";
  return kind === "specialist" ? "patients" : "staff";
}

interface CardCtx {
  row: StaffRow;
  /** Своя карточка: правка и смена пароля доступны только в ней */
  me: boolean;
  isSuper: boolean;
  /** Рабочее место смотрящего — от него зависит, что лежит под карточкой */
  kind: BarKind;
  under: Under;
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
  const { pathname } = useLocation();
  const me = !!user && user.id === id;
  const isSuper = user?.role === "superadmin";
  const canManage = can("users.manage");
  const kind = barKind(user ?? {});

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
  /* профиль или раздел карточки — от этого зависит вся шапка (см. пояснение выше) */
  const onProfile = pathname === base;

  if (res.error) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const row = res.data.row;
  if (!row) {
    return (
      <Page title={ut("ppl.notFound")}>
        <p className="m-0 text-[13px] text-muted">{ut("ppl.notFound")}</p>
      </Page>
    );
  }

  const under = underCard(kind, me);
  const ctx: CardCtx = { row, me, isSuper, kind, under, editing, setEditing, changingPassword, setChangingPassword, reload };
  const name = row.fullName || row.email;

  /*
   * Своя карточка подписана ролью, чужая — именем (см. шапку файла). Слово
   * роли — по рабочему месту, и все четыре кадра своей карточки сходятся
   * без единого исключения:
   *
   *   специалист и заведующий → «Лікар»              (f04 и f30)
   *   администратор           → «Адміністратор»      (f40)
   *   суперадмин              → «Супер Адміністратор» (f47)
   *
   * Заведующий подписан лікарем, хотя раздел людей у него есть: он лечит, и
   * f30 — как раз его карточка со списком лікарів под разделителем. «Супер
   * Адміністратор» — два слова с заглавной в обоих, именно так на кадре, в
   * отличие от слитного nav.roleSuper, которым названа роль в поле «Роль».
   */
  const roleWord =
    kind === "peopleAdmins" ? ut("ppl.roleSuperTitle") : kind === "peopleStaff" ? ut("ppl.roleAdmin") : ut("ppl.roleDoctor");

  if (!onProfile) {
    return (
      <Page
        /*
         * 30/700 — замер имени на f34/f35: та же строка занимает там 384px
         * против 312 на f31, где она набрана заголовочными 24. Междустрочие
         * сжато до кегля (leading-none), иначе линия под именем уезжает вниз:
         * на кадре она стоит в 100px от низа полосы, а 40 отступа + 30 строки
         * + 28 подвала шапки дают ровно 98.
         */
        title={<span className="text-[30px] leading-none">{name}</span>}
        titleAlign="center"
      >
        {/* линия #b299cc во всю ширину колонки, под ней подменю в 15px (f35: линия 213…214, чернила подменю 229) */}
        <hr className="m-0 mb-[10px] h-[2px] border-0 bg-[var(--primary-rule)]" />
        <CardSubmenu base={base} />
        <Outlet context={ctx} />
      </Page>
    );
  }

  return (
    <Page
      title={me ? roleWord : name}
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
                setChangingPassword(false);
                setEditing(true);
              },
            },
            {
              label: ut("acct.changePassword"),
              disabled: !me,
              hint: ut("ppl.onlySelf"),
              onSelect: () => {
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

/* ─────────── подменю карточки ─────────── */

/**
 * Семь пунктов по центру, сразу под линией (кадр f35: чернила 374…1256 при
 * центре колонки 805, зазоры между словами 44, 32, 34, 33, 29, 24 — в среднем
 * 33; кегль 20/700, тот же, что в верхней полосе, а не 18/700 вкладок).
 *
 * Текущий пункт НЕ выделен ничем: на кадре все семь набраны одним #663399,
 * включая «Групи», хотя открыт именно этот раздел. «Вы здесь» несёт
 * aria-current, который NavLink проставляет сам, — без него признак остался бы
 * только в адресной строке. Общие вкладки (Tabs) при этом не трогаются:
 * бледнение неактивной взято у них со своих кадров, и полоса прокрутки под
 * ними — тоже с кадра каталога; здесь ни того ни другого на f35 нет.
 *
 * Четырёх последних разделов у карточки своего экрана не имеют: ни «тестів
 * цього лікаря», ни «його аналітики» сервер отдельно не отдаёт. Пункты ведут
 * в одноимённые разделы верхнего меню — туда же, куда ведут плитки чужой
 * карточки (f31). Заводить четыре пустых адреса под /staff/:id значило бы
 * четыре двери в пустую комнату.
 */
const CARD_SECTIONS: { key: UiKey; to: (base: string) => string; end?: boolean }[] = [
  { key: "ppl.tabProfile", to: (b) => b, end: true },
  { key: "top.patients", to: (b) => `${b}/patients` },
  { key: "top.groups", to: (b) => `${b}/groups` },
  { key: "top.tests", to: () => "/surveys" },
  { key: "top.analytics", to: () => "/analytics" },
  { key: "top.statistics", to: () => "/cohorts" },
  { key: "top.messages", to: () => "/mailings" },
];

function CardSubmenu({ base }: { base: string }) {
  const { ut } = useLang();
  return (
    <nav aria-label={ut("ppl.tabsLabel")} className="mb-[30px] flex flex-wrap items-center justify-center gap-[33px]">
      {CARD_SECTIONS.map((s) => (
        <NavLink
          key={s.key}
          to={s.to(base)}
          end={s.end}
          className="whitespace-nowrap text-[20px] font-bold leading-none text-primary no-underline outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          {ut(s.key)}
        </NavLink>
      ))}
    </nav>
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

/**
 * Две колонки по 372 с зазором 76, блок по центру колонки (f40 392…765 и
 * 840…1213, f43 403…774 и 851…1222, f47 394…765 и 842…1213). Зазор от
 * заголовка до первой плашки здесь 37, а не 27 трёхколоночной раскладки
 * (f40/f43/f47: чернила заголовка кончаются на 183-185, плашка начинается на
 * 220-222), отсюда mt-[9px] поверх штатных 28 от Page.
 */
const fieldPair = "mx-auto mt-[9px] grid max-w-[820px] grid-cols-2 gap-x-[76px] gap-y-[15px] max-[900px]:grid-cols-1";

export function StaffProfile() {
  const { row, me, kind, under, editing, setEditing, changingPassword, setChangingPassword, reload } = useOutletContext<CardCtx>();
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

  const f = {
    firstName: { key: "firstName", label: ut("person.firstName"), value: row.firstName || null },
    lastName: { key: "lastName", label: ut("person.lastName"), value: row.lastName || null },
    middleName: { key: "middleName", label: ut("ppl.middleName"), value: row.middleName },
    sex: { key: "sex", label: ut("person.sex"), value: sexText },
    specialty: { key: "specialty", label: ut("ppl.specialty"), value: row.specialty },
    /* «Організація» — подразделение из карточки: учреждение = экземпляр системы, и второго уровня нет */
    unit: { key: "unit", label: ut("ppl.organization"), value: row.unit },
    birthDate: { key: "birthDate", label: ut("person.birthDate"), value: row.birthDate ? day(row.birthDate) : null },
    email: { key: "email", label: ut("ppl.email"), value: row.email },
    /* телефон и населённый пункт сервер не отдаёт — поля стоят пустыми, как на кадре */
    phone: { key: "phone", label: ut("ppl.phone"), value: null },
    city: { key: "city", label: ut("ppl.city"), value: null },
    role: { key: "role", label: ut("adm.role"), value: roleText || null },
  } satisfies Record<string, FieldSpec>;

  const wide = under !== "none";
  /* порядок построчный (3×4) либо по столбцам (2 колонки) — см. шапку файла */
  const fields: FieldSpec[] = wide
    ? [f.firstName, f.lastName, f.middleName, f.sex, f.specialty, f.unit, f.birthDate, f.email, f.phone, f.city, f.role]
    : [f.firstName, f.specialty, f.lastName, f.unit, f.middleName, f.phone, f.sex, f.email, f.birthDate, f.role, f.city];

  return (
    <>
      {editing && me ? (
        <ProfileForm
          row={row}
          wide={wide}
          onDone={() => {
            setEditing(false);
            reload();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <dl className={cx("m-0", wide ? fieldGrid : fieldPair)}>
          {fields.map((s) => (
            <div key={s.key} className="min-w-0">
              {/* sr-only, а не hidden: подпись нужна диктору, с экрана её убирает кадр */}
              <dt className="sr-only">{s.label}</dt>
              {/* обрезка — на строке внутри, а не на самом поле: у flex-контейнера многоточие не работает */}
              <Readout as="dd" look="fill" className="m-0 min-w-0">
                {s.value ? (
                  <span className="min-w-0 truncate text-text">{s.value}</span>
                ) : (
                  <span className="min-w-0 truncate font-bold text-primary">{s.label}</span>
                )}
              </Readout>
            </div>
          ))}
        </dl>
      )}

      {changingPassword && me ? <PasswordForm onDone={() => setChangingPassword(false)} /> : null}

      {under === "none" ? null : (
        <>
          {/*
            Разделитель под блоком полей: линия 2px цветом #b299cc во всю
            ширину колонки (f04 y 429…430, f31 432…433, f50 428…429, все —
            (178,153,204)). Отступы замерены от плашек: 30 от низа последнего
            поля до линии, 29 от линии до заголовка секции.
          */}
          <hr className="mt-[30px] mb-[29px] h-[2px] border-0 bg-[var(--primary-rule)]" />
          {under === "tiles" ? <StaffTiles /> : under === "patients" ? <OwnPatients heading /> : <StaffSection me={me} kind={kind} />}
        </>
      )}
    </>
  );
}

/* ─────────── плитки чужой карточки ─────────── */

/**
 * Шесть плиток 3×2 под чужой карточкой (кадр f31: x 206…595, 611…1000,
 * 1016…1405 — по 390 при зазоре 15-16; ряды 469…558 и 574…663 — по 90 при
 * зазоре 15; заливка ровно #f0ecff, подпись по центру 20/700 фиолетовым).
 *
 * «Пацієнти» и «Групи» ведут в разделы ЭТОГО человека, остальные четыре — в
 * одноимённые разделы верхнего меню: своих экранов у них нет (см. подменю).
 */
function StaffTiles() {
  const { row } = useOutletContext<CardCtx>();
  const { ut } = useLang();
  const base = `/staff/${row.id}`;
  return (
    <nav aria-label={ut("ppl.tilesLabel")} className="grid grid-cols-3 gap-x-[16px] gap-y-[15px] max-[900px]:grid-cols-1">
      {CARD_SECTIONS.filter((s) => s.key !== "ppl.tabProfile").map((s) => (
        <Link
          key={s.key}
          to={s.to(base)}
          className="flex h-[90px] items-center justify-center rounded-[5px] bg-primary-soft text-[20px] font-bold text-primary no-underline outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          {ut(s.key)}
        </Link>
      ))}
    </nav>
  );
}

/* ─────────── правка своей анкеты ─────────── */

/**
 * Правка своей анкеты — те же места, что и в просмотре, только полями:
 * так «Редагувати» не перестраивает экран, а раскрывает его. Что сервер
 * не принимает (email, телефон, населённый пункт, роль), стоит погашенным на
 * своём месте с подсказкой: убрать поле значило бы, что при правке карточка
 * меняет форму.
 *
 * Абзаца-пояснения под сеткой на кадрах нет (f02 — чернил ноль ниже последней
 * плашки), и он ушёл в строку для диктора: погашенное поле объясняет себя
 * подсказкой, а диктор подсказку у отключённого поля не читает.
 */
function ProfileForm({ row, wide, onDone, onCancel }: { row: StaffRow; wide: boolean; onDone: () => void; onCancel: () => void }) {
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
      <div className={wide ? fieldGrid : fieldPair}>
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
          {/* look="bare": на кадре «Стать» — обычное поле, без каретки и без второй рамки */}
          <Select look="bare" value={sex} onChange={(e) => setSex(e.target.value as Sex | "")}>
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
        <Field inline label={ut("ppl.email")}>
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
      <p className="sr-only">{ut("ppl.disabledFieldsHint")}</p>
      {/* кнопка формы — 36px в шаг формы 51, как «Створити» на f41; вторая, «Скасувати», без заливки: две залитых спорят */}
      <div className="mt-[15px] flex flex-wrap gap-[15px]">
        <Button type="submit" size="form" className="min-w-[215px]" disabled={busy || !firstName.trim() || !lastName.trim()}>
          {ut("common.save")}
        </Button>
        <Button type="button" size="form" variant="ghost" onClick={onCancel} disabled={busy}>
          {ut("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Смена пароля — под карточкой, по пункту меню, а не постоянной панелью, как
 * на /account: на кадрах она за шестерёнкой. Порог 10 знаков — с сервера
 * (changePasswordSchema): просить меньше значило бы получать отказ после
 * нажатия.
 *
 * Панели вокруг полей больше нет. Кадра для этого состояния нет ни одного, но
 * ни на одном из четырнадцати кадров раздела нет и рамки вокруг группы полей:
 * все поля лежат прямо на белом. Панель приносила на экран цвет и рамку,
 * которых в макете не существует, — поля стоят сами, шириной в 370 и с шагом
 * 51, как на форме заведения.
 */
function PasswordForm({ onDone }: { onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  return (
    <form
      className="mt-[28px] grid max-w-[370px] gap-y-[15px]"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api.changePassword(current, next);
          onDone();
        }, ut("acct.passwordChanged"));
      }}
    >
      <h2 className="m-0 text-[24px] font-bold leading-tight text-primary">{ut("acct.changePassword")}</h2>
      <Field inline label={ut("acct.currentPassword")}>
        <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Field>
      <Field inline label={ut("acct.newPassword")}>
        <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} />
      </Field>
      <div className="flex flex-wrap gap-[15px]">
        <Button type="submit" size="form" disabled={busy || !current || next.length < 10}>
          {ut("acct.changePassword")}
        </Button>
        <Button type="button" size="form" variant="ghost" onClick={onDone} disabled={busy}>
          {ut("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/* ─────────── строка над списком раздела ─────────── */

/**
 * «Групи [поиск] + … страницы» — строка над списком (кадры f34/f35, и она же
 * над секцией «Лікарі» карточки администратора на f50). Та же ось, что у
 * строки над списком экрана: заголовок 24/700 слева, поле тянется, глиф и
 * блок страниц справа. Заголовок здесь — <h2>: <h1> уже занят именем или
 * словом роли.
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
      <Input look="outline" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="pr-[34px]" autoComplete="off" />
      <span aria-hidden className="pointer-events-none absolute right-[6px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
        <IconSearchGlass />
      </span>
    </div>
  );
}

/* ─────────── пациенты ─────────── */

/**
 * Раздел «Пацієнти» (кадр f04): люди в зоне ответственности этого лікаря,
 * той же строкой, что и в списке лікарів: имя, почта, пол, год.
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
function OwnPatients({ heading }: { heading?: boolean } = {}) {
  const { ut } = useLang();
  const page = usePagedResource<Respondent>((cursor) => api.respondents({ cursor: cursor ?? undefined }), []);
  const meta = { male: ut("adm.male"), female: ut("adm.female"), year: ut("ppl.yearShort") };
  /*
   * Кнопки «Завантажити ще» на кадре нет: на f04 под последней строкой списка
   * чернил нет вовсе. Насовсем убрать догрузку нельзя — у лікаря пациентов
   * тысячи, и одним ответом сервер их не отдаёт. Поэтому страница дотягивается
   * сама, когда до конца списка долистали: невидимая метка внизу сообщает, что
   * её видно, и это ровно то, что нарисовано, — список без органов управления.
   * Тому, кто листает клавиатурой или без наблюдателя, остаётся кнопка в
   * строке для диктора: у прокрутки, которой не видно, должен быть и обычный
   * способ.
   */
  const tail = useRef<HTMLDivElement | null>(null);
  /* ссылка на догрузку держится в ref: сама она у usePagedResource новая на каждый
     проход, и наблюдатель пересоздавался бы столько же раз */
  const more = useRef(page.loadMore);
  more.current = page.loadMore;
  useEffect(() => {
    const el = tail.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [page.hasMore]);

  return (
    <>
      {heading ? <SectionBar title={ut("top.patients")} /> : null}
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
            <div ref={tail} className="sr-only">
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

/* ─────────── лікарі под карточкой ─────────── */

/**
 * Секция «Лікарі» (кадры f30 и f50): заголовок, широкое поле поиска с лупой
 * во всю оставшуюся ширину и БЕЗ «+», под ним сетка в три колонки.
 *
 * На f50 (чужая карточка администратора у суперадміна) под каждой строкой
 * лежит линия #cccccc — своя сетка, а не общая: на f04/f30/f42/f49 линий нет,
 * и общий gridClass их не получает.
 *
 * Чего сервер не даёт: связи «этот администратор → его лікарі» в модели нет
 * вовсе. В своей карточке показывается тот справочник, который смотрящему и
 * так открыт (тот же, что на /staff); в чужой — честное пустое состояние, и
 * дыра записана в api_gaps. Подставлять туда общий реестр значило бы
 * подписать чужим именем всех лікарів учреждения.
 */
function StaffSection({ me, kind }: { me: boolean; kind: BarKind }) {
  const { ut } = useLang();
  const { user, can } = useAuth();
  const [q, setQ] = useState("");
  const canManage = can("users.manage");
  const viewerId = user?.id ?? "";
  /* линии между строками — только там, где они нарисованы (f50) */
  const ruled = kind === "peopleAdmins";

  const res = useResource(() => loadDirectory({ id: viewerId, canManageUsers: canManage }), [viewerId, canManage], {
    enabled: me && !!user,
  });
  const shown = useMemo(() => (res.data ? res.data.rows.filter((r) => isDoctor(r) && matchesQuery(r, q)) : null), [res.data, q]);
  const meta = { male: ut("adm.male"), female: ut("adm.female"), year: ut("ppl.yearShort") };

  return (
    <>
      <SectionBar title={ut("ppl.staff")}>
        <SearchBox label={ut("adm.searchPlaceholder")} value={q} onChange={setQ} />
      </SectionBar>

      {!me ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("ppl.staffOfAdminUnknown")}</p>
      ) : res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !shown ? (
        <Loading rows={6} />
      ) : shown.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("pt.nobodyFound")}</p>
      ) : (
        <ul className={cx("m-0 list-none p-0", gridClass)}>
          {shown.map((r) => (
            <li key={r.id} className={cx("min-w-0", ruled && "border-b-2 border-hairline")}>
              <Link to={`/staff/${r.id}`} className={rowClass}>
                <span className={nameClass}>{r.fullName}</span>
                <span className={metaClass}>
                  {metaSegments(r, meta).map((s) => (
                    <span key={s}>{s}</span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ─────────── группы ─────────── */

/**
 * Раздел «Групи» (кадры f34/f35): группы пациентов этого лікаря в две
 * колонки — название и описание, поиск, «+», страницы.
 *
 * Данные — GET /api/patient-groups с отбором по владельцу: сервер отдаёт
 * суперадмину все группы, остальным только свои (см. ownGroups). Список
 * считается на клиенте целиком, страницы — тоже: групп у человека единицы,
 * а не тысячи, и серверной постраничности у маршрута нет.
 *
 * «+» ведёт в раздел «Групи» верхнего меню и показывается только в своей
 * карточке. На кадре он стоит в строке раздела карточки, то есть заводит
 * группу этому человеку, — но владельцем группы становится тот, кто её
 * заводит, и завести её другому нельзя, пока сервер не даст указать
 * владельца. Второй формы создания группы в разделе при этом быть не должно:
 * одна группа — одна форма. Когда владельца можно будет указать, «+»
 * появится и в чужой карточке.
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
        <ul className="m-0 grid list-none grid-cols-2 gap-x-[60px] gap-y-[26px] p-0 max-[900px]:grid-cols-1">
          {shown.map((g) => (
            <GroupRow key={g.id} group={g} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Строка группы: название 15/700 фиолетовым в колонке 134 (может занять две
 * строки — так и на кадре), описание 13/400 серым, не длиннее четырёх строк.
 *
 * Замер f34: ячейка 210…776, название 210…341, описание 380…776 — то есть
 * колонка названия с зазором вместе дают 170, а не 208, как было. Строки
 * описания идут через 14 (329, 343, 357, 371), и весь ряд списка — через 82
 * (названия на 329 и 411): 4×14 + 26.
 *
 * Название — не ссылка: карточка группы делается другой волной, и адрес её
 * здесь неизвестен; ссылка в никуда хуже текста.
 */
function GroupRow({ group }: { group: PatientGroupWithCounts }) {
  return (
    <li className="grid min-w-0 grid-cols-[134px_1fr] gap-x-[36px] max-[600px]:grid-cols-1">
      <span className="text-[15px] font-bold leading-[20px] text-primary">{group.title}</span>
      <span className="line-clamp-4 text-[13px] leading-[14px] text-muted">{group.description ?? ""}</span>
    </li>
  );
}
