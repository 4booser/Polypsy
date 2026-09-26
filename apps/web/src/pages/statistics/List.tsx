import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading } from "../../ui";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Pager } from "../../ui/pager";
import { DEFAULT_PER, pageCount, pageFrom, perFrom } from "../../ui/paging";
import { GlyphLink, Input } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { STATS_CHART, STATS_LIST, STATS_NEW, statHref } from "./model";
import { IconViewChart, IconViewList } from "./parts";

/*
 * «Статистика — перелік статистики», кадр f08.
 *
 * Строка списка и сетка в две колонки — те же, что у перечня аналитики f10
 * (pages/analytics/List.tsx): опись кадров прямо называет их двойниками, и
 * замеры сходятся до пикселя — колонка 600, шаг колонок 630, строка 82,5,
 * подложка наведения #f7f5fa. Все числа сетки взяты оттуда с их доводами.
 *
 * Чем f08 отличается от f10 — и как это легло на код (замеры f08, начало
 * колонки содержимого на 200 кадра 1600, низ полосы шапки = 100):
 *
 *   «Статистика» 24/700 + две иконки справа     → первая строка шапки: 30 от
 *   (капитель 137, иконки 139…165, 27×27,           полосы до строки 36, иконки
 *   зазор 14)                                        прижаты к её низу
 *   «Перелік статистики» + поиск + «+» + страницы → вторая строка, 29 ниже
 *   (поле 195…230, ширина 651)                       первой; всё остальное — как
 *                                                    у f10
 *   блок страниц отодвинут от «+» на 64, а не 78   → 51 справа от «+» (+13 зазора)
 *   первая строка списка на 16 ниже поля, а не 6   → 10 под второй строкой
 *
 * Две строки шапки не укладываются в рамку Page с одной строкой, поэтому
 * заголовок рамке отдан скрытым (`titleHidden`), а обе строки печатаются в
 * полосе инструментов. Первая поднята на 10 (`-mt-[10px]`): рамка даёт 40
 * (`snug`), кадр — 30, а заводить в общей рамке третье число ради одного
 * экрана значило бы править модуль, который правят параллельно.
 *
 * Иконки вида: «діаграма» ведёт на экран f24 (диаграмма по выбранной
 * модели), «перелік» — сюда же и помечена aria-current. Цвет у обеих
 * одинаковый, как на кадре: текущий вид называется диктору, а не цветом.
 *
 * Данные — GET /api/stat-models: поиск и страницы на сервере (?q, ?limit,
 * ?offset → {items, total}), состояние экрана — в адресе, как у каталога.
 */
export default function StatList() {
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

  /* поиск ждёт паузу в наборе: запрос на каждую букву — лишняя нагрузка без пользы */
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDq(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const list = useResource(() => api.statModels({ q: dq, limit: per, offset: (page - 1) * per }), [dq, page, per]);
  const pages = pageCount(list.data?.total ?? 0, per);

  /* страница за концом списка (сузили поиск) — возвращаемся на ближайшую */
  useEffect(() => {
    if (list.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [list.data, page, pages, update]);

  return (
    <Page
      title={ut("top.statistics")}
      titleHidden
      snug
      toolbar={
        <div className="-mt-[10px] mb-[10px] flex w-full min-w-0 flex-col">
          <div className="flex h-9 items-center justify-between">
            {/*
              Видимое имя раздела — не второй <h1>: он уже объявлен рамке
              скрытым ровно этими словами, и диктор прочитал бы его дважды.
            */}
            <p aria-hidden className="m-0 text-[24px] font-bold leading-tight text-primary">
              {ut("top.statistics")}
            </p>
            <nav aria-label={ut("st.views")} className="flex items-center gap-[14px] self-end">
              <GlyphLink to={STATS_CHART} aria-label={ut("st.viewChart")}>
                <IconViewChart />
              </GlyphLink>
              <GlyphLink to={STATS_LIST} aria-label={ut("st.viewList")} aria-current="page">
                <IconViewList />
              </GlyphLink>
            </nav>
          </div>
          <div className="mt-[29px] flex min-w-0 items-center gap-[13px] max-[900px]:flex-wrap">
            <h2 className="m-0 shrink-0 text-[24px] font-bold leading-tight text-primary">{ut("st.listTitle")}</h2>
            <div className="relative min-w-0 flex-1">
              {/* имя полю — aria-label: на кадре поле поиска пустое, без подписи внутри */}
              <Input
                look="outline"
                aria-label={ut("st.search")}
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
            <GlyphLink to={STATS_NEW} aria-label={ut("st.add")}>
              <IconPlusThick />
            </GlyphLink>
            {/* 51 + 13 зазора = 64 от «+» до блока страниц — замер f08 (1121 → 1185) */}
            <div className="ml-[51px] shrink-0 max-[900px]:ml-0">
              <Pager
                page={page}
                pages={pages}
                per={per}
                onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
                onPage={(n) => update({ page: n > 1 ? String(n) : null })}
              />
            </div>
          </div>
        </div>
      }
    >
      {list.error ? (
        <Loading error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading rows={5} />
      ) : list.data.items.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{dq.trim() ? ut("am.emptySearch") : ut("st.empty")}</p>
      ) : (
        /*
          Сетка — копия перечня аналитики f10 вместе с её доводами (600 +
          30, строка 82,5, одна колонка ниже 1260): кадры f08 и f10 — один
          макет с разными подписями.
        */
        <ul className="m-0 w-[1230px] list-none columns-2 gap-x-[30px] p-0 max-[1259px]:w-full max-[1259px]:columns-1">
          {list.data.items.map((m) => (
            <li
              key={m.id}
              className="flex break-inside-avoid gap-0 pb-[10px] pt-[13px] mb-[3.5px] hover:bg-primary-tint"
            >
              <div className="w-[172px] shrink-0 pr-[24px]">
                <Link
                  to={statHref(m.id)}
                  className="text-[17px] font-bold leading-[20px] text-primary no-underline hover:underline"
                >
                  {m.title}
                </Link>
              </div>
              {/* пустое описание — пустая ячейка: заглушки на кадре нет */}
              <p className="m-0 min-w-0 flex-1 text-[13px] leading-[14px] text-muted">{m.description}</p>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
