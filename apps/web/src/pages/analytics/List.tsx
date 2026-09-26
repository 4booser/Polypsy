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
import { AnalyticsTabs } from "./tabs";

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
 *                                                 имя 17/700 фиолетовым +
 *                                                 описание 13/400 серым
 *   подсвеченная шестая строка                  → наведение
 *
 * Просветы строки над списком — свойство `snug` рамки Page: 40 от полосы
 * шапки, 13 до поля поиска, 6 до первой строки списка; 78 от «+» до блока
 * страниц просит отдельное `pagerGap` — его же просит и «Повідомлення», но
 * своим числом. Все четыре — замеры f10, см. пояснения к свойствам в
 * layout.tsx.
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
      /* вкладки «Моделі · Тести» — над строкой f10, почему именно там — см. tabs.tsx */
      crumbs={<AnalyticsTabs />}
      snug
      pagerGap={78}
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
          шестой строки 200…799 (ровно 600), имя второй колонки 831…971,
          её описание 1001…1383, то есть шаг колонок 630. Отсюда ширина
          блока 1230 — на 30 больше колонки содержимого (1200): текст обеих
          колонок остаётся внутри 1200, а наружу выходит только пустое поле
          второй колонки.

          `max-w-full` отсюда убран, и это не недосмотр: он равен
          max-width:100% от колонки COLUMN (max-w-[1248px] px-6 = 1200) и
          резал блок до 1200 — колонки становились по 585 с шагом 615, то
          есть намерение было записано в комментарии и не выполнено
          разметкой.

          Узкое окно держит одна колонка ниже 1260. Порог считается, а не
          выбирается: при ширине окна w колонка стоит на
          max(0,(w−1248))/2 + 24, и 1230 помещаются, пока
          (w−1248)/2 + 24 + 1230 ≤ w, то есть при w ≥ 1260. Ниже — одна
          колонка во всю ширину, и лишних 30 не возникает.
        */
        <ul className="m-0 w-[1230px] list-none columns-2 gap-x-[30px] p-0 max-[1259px]:w-full max-[1259px]:columns-1">
          {shown.map((m) => (
            <li
              key={m.id}
              /*
                Строка — имя 172 (с зазором 24 до описания) и описание по
                остатку: та же сетка, что у каталога тестов.

                Поля 13 сверху и 10 снизу, шаг строк 82,5 — и это два разных
                замера, а не один. Подложка наведения шестой строки занимает
                ровно 594…672 (79 высотой, края без размытия) при содержимом
                607…662 (четыре строки описания по 14): 13 над текстом и 10
                под ним. Верхушки первых строк описания всех восьми строк
                колонки — 194, 276, 359, 441, 524, 607, 689, 772, то есть
                578/7 = 82,57 на строку. 79 + 3,5 = 82,5 — половина пикселя
                тут честнее целого: 82 набегает −4px к низу колонки, 83 —
                +3px, и обе видны на подложке восьмой строки.

                Подложка — --primary-tint, ровно #f7f5fa кадра (замер
                заливки шестой строки), а не --primary-soft: тот вдвое
                плотнее и даёт тон полосы шапки, а не строки списка.
              */
              className="flex break-inside-avoid gap-0 pb-[10px] pt-[13px] mb-[3.5px] hover:bg-primary-tint"
            >
              <div className="w-[172px] shrink-0 pr-[24px]">
                {/*
                  Имя 17/700, межстрочник 20 — замеры f10. Кегль берётся с
                  капители: «Н» в «Назва» занимает 194…205, то есть 12 при
                  откалиброванном на заголовке (24/700, капитель 17)
                  отношении 0,708 → 16,9. Для сравнения, описание той же
                  строки даёт капитель 9 → 13. Первая редакция взяла с кадра
                  межстрочник и не взяла кегль: при 13/700 та же строка имени
                  была бы ≈117 шириной вместо замеренных 141 (201…341).
                  Ровно то же имя в уже сведённом каталоге тестов набрано
                  17/700 (constructor/SurveyList.tsx).
                */}
                <Link
                  to={modelHref(m.id)}
                  className="text-[17px] font-bold leading-[20px] text-primary no-underline hover:underline"
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
