import { useCallback, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading } from "../../ui";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Pager } from "../../ui/pager";
import { GlyphLink, Input, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { DEFAULT_PER, pageCount, pageFrom, perFrom } from "../constructor/catalogue";
import { filterModels, modelHref, pageSlice } from "./model";

/*
 * Перечень аналитики — кадр f08 макета.
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
 * Откуда данные. Модель — правило поддержки решений (см. model.ts):
 * GET /api/decisions/rules, название → title, описание → note. Маршрут не
 * знает ни поиска, ни страниц, поэтому и то и другое считается здесь — на
 * десятках строк это дешевле нового параметра на сервере (см. api_gaps в
 * отчёте волны). Состояние экрана — в адресе, как у каталога: ссылку на
 * «страницу 2 по запросу „ризик“» пересылают коллеге.
 *
 * Чего на кадре нет, а здесь есть: метка «вимкнена» у выключенной модели.
 * Выключенное правило на проходження не срабатывает, и перечень, где такая
 * модель неотличима от действующей, вводил бы в заблуждение ровно там, где
 * решают, чем пользоваться.
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
          в первую колонку, потом во вторую — так читается кадр. Колонка 600 и
          зазор 30 — замеры f08 (205→805, 835→1435); ниже 900 колонка одна.
        */
        <ul className="m-0 list-none columns-2 gap-x-[30px] p-0 max-[900px]:columns-1">
          {shown.map((m) => (
            <li
              key={m.id}
              /*
                Строка — имя 172 (с зазором 24 до описания) и описание по
                остатку: та же сетка, что у каталога тестов. Подложка
                наведения — мягкий фиолетовый, вплотную к тексту, как
                подсвеченная строка на кадре; отступ по вертикали 10 даёт
                шаг 58 у однострочной записи.
              */
              className="flex break-inside-avoid gap-0 py-[10px] hover:bg-primary-soft"
            >
              <div className="w-[172px] shrink-0 pr-[24px]">
                <Link
                  to={modelHref(m.id)}
                  className="text-[13px] font-bold leading-[17px] text-primary no-underline hover:underline"
                >
                  {m.title}
                </Link>
                {m.enabled ? null : (
                  <div className="mt-[4px]">
                    <Tag>{ut("am.disabledTag")}</Tag>
                  </div>
                )}
              </div>
              <p className="m-0 min-w-0 flex-1 text-[13px] leading-[17px] text-muted">
                {m.note ? m.note : <span className="text-faint">{ut("am.noDescription")}</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
