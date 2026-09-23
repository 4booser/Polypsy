import { useCallback, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading } from "../../ui";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Pager } from "../../ui/pager";
import { GlyphLink, Input } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { DEFAULT_PER, pageCount, pageFrom, perFrom } from "../constructor/catalogue";
import { filterModels, modelHref, pageSlice } from "./model";

/*
 * Перечень аналитики — кадр f10 макета.
 *
 * Что на кадре и как это легло на код:
 *
 *   «Перелік аналітики» · поле с лупой · «+»    → Page: заголовок, toolbar
 *   «елементів на сторінці · сторінка 1 з 10»  → ?per и ?page, Pager (общий
 *                                                 с каталогом тестов)
 *   две колонки «Назва + Опис»                  → один список в две колонки
 *                                                 (CSS columns), строка =
 *                                                 имя 13/700 фиолетовым +
 *                                                 описание 13/400 серым
 *   подсвеченная шестая строка                  → наведение
 *
 * Просветы строки над списком — свойство `snug` рамки Page: 40 от полосы
 * шапки, 13 до поля поиска, 78 от «+» до блока страниц, 6 до первой строки
 * списка. Все четыре — замеры f10, см. пояснение к свойству в layout.tsx.
 *
 * Откуда данные. Модель — правило поддержки решений (см. model.ts):
 * GET /api/decisions/rules, название → title, описание → note. Маршрут не
 * знает ни поиска, ни страниц, поэтому и то и другое считается здесь — на
 * десятках строк это дешевле нового параметра на сервере (см. api_gaps в
 * отчёте волны). Состояние экрана — в адресе, как у каталога: ссылку на
 * «страницу 2 по запросу „ризик“» пересылают коллеге.
 *
 * Чего на кадре нет — нет и здесь. Метка «вимкнена» у выключенной модели и
 * подстановка «без опису» вместо пустого описания с экрана убраны: на f10 у
 * всех шестнадцати строк только имя и описание, никаких плашек и заглушек.
 * Состояние модели не потеряно — его показывает и переключает окно «Про
 * модель» в меню шестерёнки самой модели (Editor.tsx); пустое описание
 * печатается пустой ячейкой, как на кадре.
 */

export default function AnalyticsList() {
  const { ut } = useLang();
  const [params, setParams] = useSearchParams();

  const q = params.get("q") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

  /* `replace`, а не push: каждая буква поиска — не шаг в истории браузера */
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

  const list = useResource(() => api.decisionRules(), []);

  const found = useMemo(() => (list.data ? filterModels(list.data, q) : null), [list.data, q]);
  const pages = pageCount(found?.length ?? 0, per);
  const shown = useMemo(() => (found ? pageSlice(found, page, per) : null), [found, page, per]);

  /* страница за концом списка (сузили поиск) — возвращаемся на ближайшую */
  useEffect(() => {
    if (found && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [found, page, pages, update]);

  return (
    <Page
      title={ut("am.title")}
      snug
      toolbar={
        /* поле поиска тянется на всю строку, «+» за ним — как на кадре */
        <div className="flex min-w-0 flex-1 items-center gap-[15px]">
          <div className="relative min-w-0 flex-1">
            {/*
              Имя полю даёт aria-label, а не Field: на кадре поле поиска пустое,
              без подписи-плейсхолдера, а Field печатал бы подпись внутри поля.
              Лупа — украшение, не кнопка: отбор идёт по мере набора.
            */}
            <Input
              look="outline"
              aria-label={ut("am.search")}
              value={q}
              onChange={(e) => update({ q: e.target.value, page: null })}
              className="pr-[44px]"
              autoComplete="off"
              maxLength={200}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]"
            >
              <IconSearchGlass />
            </span>
          </div>
          {/*
            «+» — ссылка на форму новой модели, а не меню, как в каталоге: там за
            плюсом три действия (тест, папка, импорт), здесь одно.
          */}
          <GlyphLink to={modelHref("new")} aria-label={ut("am.add")}>
            <IconPlusThick />
          </GlyphLink>
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
      {list.error ? (
        <Loading error={list.error} onRetry={list.reload} />
      ) : !shown ? (
        <Loading rows={5} />
      ) : shown.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{q.trim() ? ut("am.emptySearch") : ut("am.empty")}</p>
      ) : (
        /*
          Две колонки — CSS columns, а не два списка: для диктора это один
          перечень из N моделей, а не два по половине. Заполняется сверху вниз
          в первую колонку, потом во вторую — так читается кадр.

          Колонка ровно 600 и зазор 30 — замеры f10: подложка наведения
          шестой строки 200…799, вторая колонка начинается в 830 (имя
          830…971, описание 1000…1383), шаг колонок 630. Отсюда ширина
          блока 1230, то есть на 30 больше колонки содержимого: вторая
          колонка кончается там, где у кадра кончается её пустое поле, а
          текст обеих колонок остаётся внутри 1200. `max-w-full` и одна
          колонка ниже 900 держат узкое окно.
        */
        <ul className="m-0 w-[1230px] max-w-full list-none columns-2 gap-x-[30px] p-0 max-[900px]:columns-1">
          {shown.map((m) => (
            <li
              key={m.id}
              /*
                Строка — имя 172 (с зазором 24 до описания) и описание по
                остатку: та же сетка, что у каталога тестов.

                Отступ по вертикали 12: на кадре подложка наведения — 79
                пикселей высотой (594…672) при четырёх строках описания по
                14, то есть 13 над текстом и 11 под ним; шаг строк 82.
                Подложка — --primary-tint, ровно #f7f5fa кадра (замер
                заливки шестой строки), а не --primary-soft: тот вдвое
                плотнее и даёт тон полосы шапки, а не строки списка.
              */
              className="flex break-inside-avoid gap-0 py-[12px] hover:bg-primary-tint"
            >
              <div className="w-[172px] shrink-0 pr-[24px]">
                {/* межстрочник имени 20 — замер f10: верхушки двух строк 194 и 214 */}
                <Link
                  to={modelHref(m.id)}
                  className="text-[13px] font-bold leading-[20px] text-primary no-underline hover:underline"
                >
                  {m.title}
                </Link>
              </div>
              {/*
                Межстрочник описания 14 — замер f10 (верхушки строк 194, 208,
                222, 236). Пустое описание — пустая ячейка: заглушки на кадре
                нет, а ширину колонки держит сама сетка.
              */}
              <p className="m-0 min-w-0 flex-1 text-[13px] leading-[14px] text-muted">{m.note}</p>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
