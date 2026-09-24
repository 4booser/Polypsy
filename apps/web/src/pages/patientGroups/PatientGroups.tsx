import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { PatientGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading } from "../../ui";
import { cx } from "../../ui/cx";
import { IconHeart, IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Pager } from "../../ui/pager";
import { DEFAULT_PER, pageCount, pageFrom, perFrom, slicePage } from "../../ui/paging";
import { Button, Input, Tabs } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { GroupForm } from "./dialogs";
import { FAVORITES_KEY, matchesQuery, parseFavorites, serializeFavorites, toggleIn } from "./model";

/*
 * «Групи» — кадр f10 макета: каталог групп ПАЦИЕНТОВ.
 *
 * Не путать с /groups: там группы МЕТОДИК, единица разграничения доступа.
 * Здесь — рабочие списки специалиста: «Моя група», «Група ризику», «Вечірня
 * група». Пункт «Групи» верхней полосы ведёт сюда; группы методик остались в
 * бургере под своим именем («Групи методик»), чтобы два одинаковых слова не
 * вели на два разных экрана.
 *
 * Что на кадре и как это легло на код:
 *
 *   «Групи» · поле поиска с лупой · «+»          → заголовок, ?q, окно новой группы
 *   «елементів на сторінці · сторінка 1 з 10 ‹ ›» → ?per и ?page, Pager
 *   список в две колонки: назва | опис | ♥         → сетка ниже
 *
 * Ряд вкладок с именами групп над списком — с кадра f06: те же подписи, тот
 * же зазор 52 и та же полоса прокрутки под ними, что на f05. Прежняя
 * редакция его не рисовала вовсе, считая «одним входом, нарисованным
 * дважды»: вкладка «Група ризику» стояла бы над строкой «Група ризику».
 * Кадр — истина, ряд вернулся; спор решён так, что вкладка ведёт НЕ на
 * строку под собой, а туда же, куда ведёт та же вкладка на f05, — к людям
 * этой группы (/patients?group=…). Тогда ряд не повторяет список, а
 * дополняет его: строка открывает группу, вкладка — её состав.
 *
 * Активной вкладки здесь нет: ни одна из них не указывает на этот экран.
 * Цвет активной (бледный) виден на f05, где вкладка и есть состояние
 * списка; здесь все шесть — полным фиолетовым, как непройденные двери.
 *
 * Сердце нарисовано и работает, но живёт в браузере, не на сервере — почему,
 * см. FAVORITES_KEY в model.ts.
 *
 * Числа рядом с «Групи» нет: на кадре его нет, каталог тестов (f11) его
 * тоже не печатает, а сколько групп нашлось, справа уже говорит
 * «сторінка 1 з 10». Микроподписи «N учасників · M тестів» под описанием
 * тоже нет — на кадре строка это имя в две строки и описание в четыре, и
 * лишний абзац уводил шаг строк с кадровых 82 на 104. Числа не пропали:
 * они стоят в карточке группы, куда ведёт имя.
 *
 * Страницы считаются на клиенте: GET /api/patient-groups отдаёт весь список
 * разом, и десять страниц по десять — это сто групп у одного специалиста;
 * второй механизм страниц на сервере ради этого не стоит.
 */

export default function PatientGroups() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

  /* состояние — в адресе, как у каталога: ссылку на «страницу 3» пересылают */
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

  const list = useResource(() => api.patientGroups(), []);
  const groups = list.data;

  const shown = useMemo(
    () => (groups ?? []).filter((g) => matchesQuery(q, g.title, g.description)),
    [groups, q],
  );
  const pages = pageCount(shown.length, per);
  const rows = slicePage(shown, page, per);

  /* последняя страница может опустеть после поиска — возвращаемся на ближайшую */
  useEffect(() => {
    if (groups && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [groups, page, pages, update]);

  /*
   * Пометки читаются один раз при открытии и пишутся при каждом нажатии.
   * Хранилище может быть недоступно (приватное окно, запрет сайтов на
   * данные) — тогда сердце работает до перезагрузки и молчит об этом: это
   * удобство, а не данные, и падать из-за него не за что.
   */
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      return parseFavorites(localStorage.getItem(FAVORITES_KEY));
    } catch {
      return new Set();
    }
  });
  const toggleFavorite = (id: string) => {
    const next = toggleIn(favorites, id);
    setFavorites(next);
    try {
      localStorage.setItem(FAVORITES_KEY, serializeFavorites(next));
    } catch {
      /* см. выше */
    }
  };

  const [creating, setCreating] = useState(false);

  return (
    <Page
      title={ut("pg.title")}
      /* блок страниц отодвинут от «+» на 74, как на кадре: см. wideActions */
      wideActions
      toolbar={
        /* поле тянется от заголовка до «+», лупа — украшение: поиск идёт по мере набора */
        /* зазор «поле → +» 14, как на f05/f06: поле кончается на 1022, «+» стоит 1036…1062 */
        <div className="flex min-w-0 flex-1 items-center gap-[14px]">
          <div className="relative min-w-0 flex-1">
            <Input
              look="outline"
              aria-label={ut("pg.search")}
              value={q}
              onChange={(e) => update({ q: e.target.value, page: null })}
              className="pr-[44px]"
              autoComplete="off"
              maxLength={200}
            />
            <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
              <IconSearchGlass />
            </span>
          </div>
          <Button size="glyph" variant="ghost" aria-label={ut("pg.add")} onClick={() => setCreating(true)}>
            <IconPlusThick />
          </Button>
        </div>
      }
      actions={
        <Pager
          page={page}
          pages={pages}
          per={per}
          onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
          onPage={(n) => update({ page: n > 1 ? String(n) : null })}
        />
      }
    >
      {/*
        Первый ребёнок — ряд вкладок: Page даёт ему 39px от строки заголовка,
        ровно как на кадре (низ строки заголовка 185, чернила вкладок 224).
        Вкладки-ссылки, а не состояние: они уводят на другой экран.
      */}
      <Tabs
        label={ut("pg.tabsLabel")}
        items={(groups ?? []).map((g) => ({ to: `/patients?group=${g.id}`, label: g.title }))}
      />
      {list.error ? (
        <Loading error={list.error} onRetry={list.reload} />
      ) : !groups ? (
        <Loading rows={5} />
      ) : rows.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{q.trim() ? ut("pg.emptySearch") : ut("pg.empty")}</p>
      ) : (
        /*
         * Две колонки, как на кадре; на узком окне — одна. Строка — <li>, а не
         * <tr>: у неё нет колонок с шапкой, есть название, описание и
         * сердце, и диктор читает «список из 14 элементов».
         */
        /* шаг колонок 630 при колонке 1200: зазор 30 (левые края имён на кадре — 200 и 831) */
        <ul className="m-0 mt-[22px] grid list-none grid-cols-2 gap-x-[30px] p-0 max-[900px]:grid-cols-1">
          {rows.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              favorite={favorites.has(g.id)}
              onFavorite={() => toggleFavorite(g.id)}
            />
          ))}
        </ul>
      )}

      {creating ? (
        <GroupForm
          group={null}
          onClose={() => setCreating(false)}
          /*
           * Новая группа открывается сразу карточкой: её заводят, чтобы
           * набрать людей, а набирают их там. Вернуться в список, найти
           * только что созданную строку и нажать её — три действия вместо нуля.
           */
          onSaved={(saved) => navigate(`/patient-groups/${saved.id}`)}
        />
      ) : null}
    </Page>
  );
}

/**
 * Строка списка: название 15/700 фиолетовым в две строки (макет прямо
 * говорит «Назва групи можливо велика»), описание 11/14 серым с выключкой по
 * ширине, сердце справа по середине строки — на кадре его центр стоит на
 * середине четырёхстрочного описания, а не у первой строки, как название.
 *
 * Замеры f06: имя 200…331, описание с 370 (зазор 38), шаг строк 82-83 при
 * четырёх строках описания с шагом 14. Наведение подсвечивает строку —
 * полоса пятой строки правой колонки, (247,245,250) = --primary-tint, а не
 * --surface-2 (#f0ecff): та втрое плотнее и совпадает с заливкой плашек
 * карточки.
 *
 * Микроподписи «N учасників · M тестів» под описанием больше нет: на кадре
 * её не нарисовано, а лишний абзац уводил шаг строк на 104. Числа стоят в
 * карточке группы, куда ведёт имя.
 */
function GroupRow({
  group,
  favorite,
  onFavorite,
}: {
  group: PatientGroupWithCounts;
  favorite: boolean;
  onFavorite: () => void;
}) {
  const { ut } = useLang();
  return (
    <li
      className={cx(
        "flex items-start gap-[38px] rounded-[4px] py-[14px] pl-[4px] -ml-[4px]",
        "transition-colors duration-[var(--dur-fast)] hover:bg-primary-tint",
      )}
    >
      <Link
        to={`/patient-groups/${group.id}`}
        className="w-[136px] shrink-0 text-[15px] font-bold leading-[20px] text-primary no-underline hover:underline"
      >
        {group.title}
      </Link>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-justify text-[11px] leading-[14px] text-muted">
          {group.description ? group.description : <span className="text-faint">{ut("pg.noDescription")}</span>}
        </p>
      </div>
      <Button
        size="glyph"
        variant="ghost"
        aria-label={ut("pg.favorite")}
        aria-pressed={favorite}
        onClick={onFavorite}
        className="shrink-0 self-center"
      >
        <IconHeart filled={favorite} />
      </Button>
    </li>
  );
}
