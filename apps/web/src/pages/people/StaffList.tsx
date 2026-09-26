import { Fragment, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth";
import { IconSearchGlass, Loading, useUrlState } from "../../ui";
import { Page } from "../../ui/layout";
import { IconCaret, IconPlusThick } from "../../ui/glyphs";
import { Button, Input, Tabs } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { loadDirectory, withLadder } from "./data";
import {
  type StaffGroupBy,
  type StaffRow,
  facetChoice,
  facetValues,
  filterStaff,
  groupStaff,
  isAdministrator,
  isDoctor,
  parseSort,
  peopleLists,
  sortByName,
  staffMeta,
} from "./model";

/*
 * Списки «Лікарі» (кадр f42) и «Адміністратори» (кадр f49) — один экран в
 * двух прочтениях.
 *
 * Что на кадрах и как легло на код:
 *
 *   заголовок · поле поиска с лупой · «+»   → строка над списком (Page),
 *                                              поиск в адресе (?q), «+» — ссылка
 *                                              на «Додати лікаря/адміністратора»
 *   сетка 3 колонки, строка 58px:            → grid; имя фиолетовым,
 *   имя + мета-строка                           мета серым
 *
 * Кадр f49 нарисован без лупы в поле поиска, f42 — с лупой; взят f42: та же
 * лупа стоит в строке над списком групп (f34/f35) и в секции «Лікарі»
 * карточки администратора (f50), то есть три кадра против одного, и поле
 * без неё на соседнем экране читалось бы как другое поле.
 *
 * Чего на кадре нет, а на экране было: числа найденных у заголовка (между
 * чернилами заголовка и рамкой поля на f42/f49 чернил ноль) и абзаца о том,
 * что справочник показан не весь. Ни то ни другое не пропало — оба ушли в
 * строку для диктора под полем поиска: число списку нужно не глазу (список
 * виден целиком), а тому, кто его не видит.
 *
 * ОТСТУПЛЕНИЯ ОТ КАДРОВ — решение заказчика 2026-09-26: «тут должна быть
 * сортировка по отделениям, должностям, фильтр по имени, номеру телефону и
 * логину», и тогда же — «полоса наверху теперь всегда полная, а переключение
 * „Лікарі | Адміністратори“ переезжает во вкладки на самой странице».
 * Отсюда то, чего на f42/f49 нет:
 *
 *   вкладки «Лікарі | Адміністратори»   → под строкой заголовка, ссылками;
 *                                          только тому, кому открыты оба
 *                                          списка (peopleLists)
 *   «Відділення», «Посада», «Сортування» → строка залитых выборов над
 *                                          сеткой, по колонке сетки каждый;
 *                                          всё — в адресе (?unit, ?position,
 *                                          ?sort), как поиск
 *   группы по відділенню / посаді        → заголовок раздела 20/700 над
 *                                          линией 2px, как у карточки
 *                                          пациента, и число людей в группе
 *   строка человека                      → имя 17/700, под ним «логін ·
 *                                          телефон · відділення · посада» —
 *                                          и стать с роком в конце, как было
 *                                          (почему — staffMeta в model.ts)
 *
 * Поиск ищет по ФИО (в любом порядке слов), логину и телефону — на клиенте:
 * сотрудников десятки, справочник приходит целиком, и значения выпадающих
 * фильтров всё равно берутся из него же. Телефон в ответе есть; чтение
 * справочника с номерами сервер пишет в журнал (см. data.ts).
 *
 * Кто «лікар», а кто «адміністратор» — в model.ts: класс учётной записи и
 * ступень лестницы должностей, а не два разных списка на сервере.
 */

export type StaffKind = "doctors" | "admins";

/*
 * Строка списка: 58px шага с кадра = две строки по 19 плюс по 10 сверху и
 * снизу.
 *
 * Подсветка наведения — ровно по колонке и ровно #f7f5fa. Прежде она
 * красилась --surface-2 (#f0ecff, заливка плашек) и свешивалась на 8px в
 * каждую сторону. Ступень под неё заведена давно — --primary-tint, и в её
 * собственном пояснении названо это самое #f7f5fa.
 *
 * Тон один на все кадры: замер преобладающего цвета подсвеченной строки даёт
 * (247,245,250) и на f04, и на f30, и на f35, и на f06, и на f11. Записанное
 * здесь прежде «f35 даёт другой тон (#eeecf1)» было неверно: #eeecf1 — это
 * растушёвка букв поверх подсветки, а не её заливка.
 *
 * Ширина — по колонке, и кадры расходятся не в правиле, а в аккуратности
 * рисунка: f30 даёт 1048…1419 (372 при колонке 370), f06 — 569 при колонке
 * 570, f11 — ровно 1200 во всю колонку, а f04 (636…1038 = 403) и f35
 * (215…814 = 600) не совпадают ни с одной вертикалью сетки — их
 * прямоугольники нарисованы от руки. Свеса нет ни на одном.
 *
 * Имя и мета ниже (nameClass, metaClass) — кадровые 13/700 и 13/400: ими
 * пользуется карточка человека (f04, f30, f50). Сам список раздела печатает
 * строку крупнее — см. listNameClass.
 */
export const rowClass = cx(
  "block py-[10px] no-underline",
  "transition-colors duration-[var(--dur-fast)] hover:bg-[var(--primary-tint)] hover:no-underline",
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
);
export const nameClass = "block truncate text-[13px] font-bold leading-[19px] text-primary";
export const metaClass = "flex flex-wrap gap-x-[10px] text-[13px] leading-[19px] text-muted";

/** Три колонки, как на кадре; на узком окне — одна: три колонки по 300px нечитаемы */
export const gridClass = "grid grid-cols-3 gap-x-[45px] max-[900px]:grid-cols-1";

/*
 * Строка списка раздела — решение заказчика 2026-09-26, а не кадр f42.
 *
 * Имя 17/700 — ступень «имя строки» консоли (как у строк карточки пациента):
 * на кадровых 13 имя терялось рядом с мета-строкой, которая выросла вдвое.
 * Имя переносится, а не режется многоточием: в колонке 370 полное ФИО
 * помещается почти всегда, а обрезанное «Ковальчук Ярослав Бог…» — ровно
 * та часть, по которой человека различают.
 *
 * Мета 15 muted: четыре-шесть частей в колонку 370 на кадровых 13 уходили в
 * серую кашу. Части разделены точкой, нарисованной разметкой между
 * значениями, — пустое поле не оставляет ни места, ни лишней точки; диктору
 * точка не читается. Длинная почта ломается где угодно
 * (`overflow-wrap:anywhere`), а не вылезает из колонки.
 */
const listNameClass = "block text-[17px] font-bold leading-[22px] text-primary [overflow-wrap:anywhere]";
const listMetaClass = "mt-[2px] block text-[15px] leading-[20px] text-muted [overflow-wrap:anywhere]";

/**
 * Выбор-фильтр в залитом силуэте поля (look="fill": заливка #f0ecff, без
 * рамки, высота 36, радиус 5) — как фильтры «Статистики» (f23/f29).
 *
 * Своим элементом, а не общим Select: у того два вида — штатный с рамкой
 * #cccccc и «bare» в силуэте контурного поля, — и залитого нет, а
 * переопределять рамку и заливку снаружи классом нельзя: в Tailwind две
 * утилиты одного свойства в строке классов спорят, и побеждает не
 * последняя, а та, что ниже в собранном CSS (см. пояснение к полям в
 * primitives.tsx). Каретка — знаком (IconCaret), а не фоном: фон
 * стилем — это инлайновый style, которого в новой разметке нет.
 *
 * Пустой выбор («Усі відділення») набран подписью поля — 17/700
 * фиолетовым, выбранный — начертанием данных: заполненный фильтр обязан
 * отличаться от незаполненного с первого взгляда. Какие пункты стоят в
 * списке, когда значение из адреса в данных не встречается, — facetChoice
 * в model.ts.
 */
function FillSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const empty = !value || value === options[0]?.value;
  return (
    <span className="relative block min-w-0">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-9 w-full min-w-0 appearance-none truncate rounded-[5px] border-0 bg-primary-soft pl-[10px] pr-[30px] text-[17px]",
          empty ? "font-bold text-primary" : "font-normal text-text",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-45",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-[11px] top-1/2 flex -translate-y-1/2 text-primary">
        <IconCaret />
      </span>
    </span>
  );
}

/** Фильтр по значениям из данных: «усі» первым пунктом, выбранное — см. facetChoice */
function FacetSelect({
  label,
  all,
  values,
  current,
  onChange,
  disabled,
}: {
  label: string;
  all: string;
  values: string[];
  current: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const choice = facetChoice(values, current);
  return (
    <FillSelect
      label={label}
      value={choice.value}
      onChange={onChange}
      disabled={disabled}
      options={[{ value: "", label: all }, ...choice.options.map((v) => ({ value: v, label: v }))]}
    />
  );
}

/** Сетка людей — одна на плоский список и на каждую группу */
function StaffGrid({ rows, omit, meta }: { rows: StaffRow[]; omit?: StaffGroupBy; meta: { male: string; female: string; year: string } }) {
  return (
    <ul className={cx("m-0 list-none p-0", gridClass)}>
      {rows.map((r) => (
        <li key={r.id} className="min-w-0">
          <Link to={`/staff/${r.id}`} className={rowClass}>
            <span className={listNameClass}>{r.fullName}</span>
            <span className={listMetaClass}>
              {staffMeta(r, meta, omit).map((s, i) => (
                /* ключ — место в строке: части не переставляются, а значения могут совпасть (відділення и посада) */
                <Fragment key={i}>
                  {/*
                    Пробелы вокруг точки — настоящие, а не отступ: без них вся
                    мета-строка для браузера одно слово, и перенос ложился
                    посреди него («Психологіч|не відділення») по
                    overflow-wrap:anywhere. С пробелами строка ломается между
                    частями, а посреди слова — только у длинной почты.
                  */}
                  {i > 0 ? (
                    <>
                      {" "}
                      <span aria-hidden className="px-[2px]">
                        ·
                      </span>{" "}
                    </>
                  ) : null}
                  <span>{s}</span>
                </Fragment>
              ))}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function StaffList({ kind }: { kind: StaffKind }) {
  const { ut } = useLang();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  /*
   * Право вести учётные записи — не класс: заведующий с таким правом заводит
   * людей наравне с суперадмином, а суперадмину сервер отвечает «да» без
   * справочника. По нему же выбирается маршрут за справочником (см. data.ts).
   */
  const canManage = can("users.manage");
  const viewerId = user?.id ?? "";
  /*
   * Поиск, отбор и порядок — в адресе: «вот эти люди» пересылаются ссылкой,
   * как и в списке пациентов, каталоге тестов и перечне аналитики. Пишется
   * через replace (useUrlState): «назад» уводит со страницы, а не отматывает
   * набранное по букве.
   */
  const [q, setQ] = useUrlState("q");
  const [unit, setUnit] = useUrlState("unit");
  const [position, setPosition] = useUrlState("position");
  const [sortParam, setSort] = useUrlState("sort", "name");
  const sort = parseSort(sortParam);

  /*
   * Вкладки — тем, кому открыты оба списка: вкладка на адрес, которого у
   * человека нет, увела бы его на сводку. Правило одно с маршрутами App.tsx.
   */
  const lists = peopleLists(user);
  const bothLists = lists.doctors && lists.admins;

  /*
   * Реестру администраторов нужны ступени лестницы — они догружаются
   * поштучно (withLadder). Реестру лікарів — нет: класс учётной записи
   * приходит со списком, и лишние запросы там ни к чему.
   */
  const res = useResource(
    async () => {
      const dir = await loadDirectory({ id: viewerId, canManageUsers: canManage });
      return kind === "admins" ? { ...dir, rows: await withLadder(dir.rows) } : dir;
    },
    [kind, viewerId, canManage],
    { enabled: !!user },
  );

  /* люди этого списка — от них и значения фильтров, чтобы выбор одного не выкидывал пункты другого */
  const ofKind = useMemo(() => {
    const pick = kind === "admins" ? isAdministrator : isDoctor;
    return (res.data?.rows ?? []).filter(pick);
  }, [res.data, kind]);
  const departments = useMemo(() => facetValues(ofKind, "unit"), [ofKind]);
  const positions = useMemo(() => facetValues(ofKind, "position"), [ofKind]);

  const shown = useMemo(() => filterStaff(ofKind, { q, unit, position }), [ofKind, q, unit, position]);
  const groups = useMemo(() => (sort === "name" ? null : groupStaff(shown, sort)), [shown, sort]);
  const flat = useMemo(() => (sort === "name" ? sortByName(shown) : []), [shown, sort]);

  const isAdmins = kind === "admins";
  const meta = { male: ut("adm.male"), female: ut("adm.female"), year: ut("ppl.yearShort") };

  return (
    <Page
      title={isAdmins ? ut("adm.admins") : ut("ppl.staff")}
      /* 40 от низа полосы до строки заголовка — замер f42 (116 и 156) и f49 (114 и 155) */
      topGap={40}
      toolbar={
        /*
         * Поле не доходит до «+» на 63px: замер f42 (поле кончается на 1317
         * при чернилах «+» 1381…1407 у правого края колонки 1406). 49 здесь
         * плюс штатные 14 между полем и действиями Page и дают эти 63.
         */
        <div className="relative mr-[49px] min-w-0 flex-1">
          {/*
            Имя полю даёт aria-label, а не Field: на кадре поле пустое, без
            подписи-плейсхолдера. Лупа — украшение, поиск идёт по мере набора.
            Отступ лупы 6 от внутренней кромки поля — замер f42 (чернила
            1290…1311 при кромке 1316).

            Имя поля говорит, по чему ищут, — ФИО, логин, телефон: поиск по
            номеру глазом не угадывается, а диктор иначе не узнает о нём вовсе.
          */}
          <Input
            look="outline"
            aria-label={ut("ppl.searchStaff")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pr-[34px]"
            autoComplete="off"
          />
          <span aria-hidden className="pointer-events-none absolute right-[6px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
            <IconSearchGlass />
          </span>
        </div>
      }
      actions={
        /*
         * «+» — переход на отдельный экран заведения (кадры f42/f49), а не
         * раскрывающаяся форма: на кадрах форма занимает экран целиком.
         * Только тому, у кого есть право users.manage — им закрыт POST
         * /api/users, — а глиф, ведущий к отказу после заполнения формы,
         * хуже отсутствующего. Маршрут «/new» открывается тем же правилом
         * (App.tsx).
         */
        canManage ? (
          <Button size="glyph" variant="ghost" aria-label={isAdmins ? ut("adm.addAdmin") : ut("ppl.addDoctor")} onClick={() => navigate(isAdmins ? "/admins/new" : "/staff/new")}>
            <IconPlusThick />
          </Button>
        ) : null
      }
    >
      {/*
        Число найденных и оговорка о неполном справочнике — для диктора, а не
        для глаза: на кадре над списком чистое поле (f42 — 39px белого между
        нижней рамкой поля и первой строкой). Диктору же нужны оба: список он
        не окидывает взглядом, а неполноту справочника иначе узнать неоткуда.
      */}
      <p className="sr-only" aria-live="polite">
        {res.data ? `${ut("ppl.found")} ${shown.length}` : ""}
        {res.data?.partial ? ` · ${ut("ppl.directoryPartial")}` : ""}
      </p>

      {/*
        Вкладки — ссылками на адреса списков, а не переключателем: «Лікарі»
        и «Адміністратори» — два экрана со своими адресами, их пересылают и
        кладут в закладки. Отбор при переходе не переносится: відділення и
        посады у двух списков свои, и перенесённый фильтр показал бы пустоту.
        24 до строки фильтров — «вкладки → сетка» дизайн-системы.
      */}
      {bothLists ? (
        <div className="mb-[24px]">
          <Tabs
            label={ut("ppl.listsLabel")}
            items={[
              { to: "/staff", label: ut("ppl.staff"), end: true },
              { to: "/admins", label: ut("adm.admins"), end: true },
            ]}
          />
        </div>
      ) : null}

      {/*
        Фильтры и порядок — по колонкам сетки ниже (три по 370 с зазором 45):
        выбор стоит над своей колонкой, и строка фильтров читается как шапка
        списка, а не как отдельная панель. На узком окне — столбиком, как и
        сама сетка. До ответа сервера выборы погашены: пунктов в них ещё нет.
      */}
      <div className={cx(gridClass, "mb-[24px] gap-y-[12px]")}>
        <FacetSelect
          label={ut("ppl.department")}
          all={ut("ppl.allDepartments")}
          values={departments}
          current={unit}
          onChange={setUnit}
          disabled={!res.data}
        />
        <FacetSelect
          label={ut("mp.position")}
          all={ut("ppl.allPositions")}
          values={positions}
          current={position}
          onChange={setPosition}
          disabled={!res.data}
        />
        <FillSelect
          label={ut("ppl.sort")}
          value={sort}
          onChange={setSort}
          options={[
            { value: "name", label: ut("ppl.sortByName") },
            { value: "unit", label: ut("ppl.sortByDepartment") },
            { value: "position", label: ut("ppl.sortByPosition") },
          ]}
        />
      </div>

      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={6} />
      ) : shown.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("pt.nobodyFound")}</p>
      ) : groups ? (
        groups.map((g) => (
          /*
           * Раздел группы — как раздел карточки пациента (Section в
           * PatientCard.tsx): 20/700 фиолетовым над линией 2px #b299cc. Число
           * людей — рядом с заголовком, моноширинным серым, как число у
           * заголовка экрана (Page, count): название группы — имя, число —
           * сведения о её содержимом. «Без відділення» — последней.
           */
          <section key={g.title ?? ""} className="border-t-2 border-primary-rule pb-[16px] pt-[32px]">
            <div className="mb-[14px] flex items-baseline gap-[10px]">
              <h2 className="m-0 text-[20px] font-bold leading-[24px] text-primary">
                {g.title ?? (sort === "unit" ? ut("ppl.noDepartment") : ut("ppl.noPosition"))}
              </h2>
              <span className="font-mono text-[13px] tabular-nums text-muted">{g.rows.length}</span>
            </div>
            <StaffGrid rows={g.rows} omit={sort === "name" ? undefined : sort} meta={meta} />
          </section>
        ))
      ) : (
        <StaffGrid rows={flat} meta={meta} />
      )}
    </Page>
  );
}
