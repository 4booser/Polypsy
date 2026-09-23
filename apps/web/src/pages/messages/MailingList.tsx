import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { MailingListItem } from "@quizzy/shared";
import { api } from "../../api";
import { day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading } from "../../ui";
import { cx } from "../../ui/cx";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Pager } from "../../ui/pager";
import { DEFAULT_PER, pageCount, pageFrom, perFrom } from "../../ui/paging";
import { GlyphLink, Input } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { mailingHref } from "./model";

/*
 * «Повідомлення» — кадр f09 макета: перечень розсилок автора.
 *
 * Это не переписка. Переписка пациент ↔ специалист (/messages, Messages.tsx)
 * осталась как была и открывается из бургера («Листування»); пункт полосы
 * «Повідомлення» ведёт сюда, как нарисовано: тема, начало текста, дата.
 *
 * Что на кадре и как это легло на код:
 *
 *   «Повідомлення» · поле поиска с лупой · «+»    → заголовок, ?q, ссылка на форму
 *   «елементів на сторінці · сторінка 1 з 10 ‹ ›» → ?per и ?page, Pager
 *   строки: тема | три строки текста | дата       → список ниже
 *   шестая строка подсвечена                      → наведение
 *
 * Чего на кадре нет и здесь нет: колонок-подписей, счётчика у заголовка,
 * вкладок «чернетки / надіслані», статусов и числа получателей в строке.
 * Черновик от отправленной в списке не отличается ничем, кроме даты: у
 * отправленной это дата отправки, у черновика — последней правки (так
 * отдаёт сервер, поле `at`). Скрытые автором розсилки сервер показывает
 * только по ?hidden=1 — параметр адреса поддержан, органа управления на
 * кадре нет, и он не нарисован.
 *
 * Страницы и поиск — на сервере (limit/offset, q): тема и текст лежат
 * зашифрованными и расшифровываются там; тянуть список целиком, как у
 * групп, значило бы расшифровывать всё на каждую букву.
 */

export default function MailingList() {
  const { ut } = useLang();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const hidden = params.get("hidden") === "1";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

  /* состояние — в адресе, как у каталога и групп: ссылку на «страницу 3» пересылают */
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

  /* поиск ждёт паузу в наборе: сервер расшифровывает список на каждый запрос */
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDq(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const list = useResource(
    () => api.mailings({ q: dq, hidden, limit: per, offset: (page - 1) * per }),
    [dq, hidden, page, per],
  );
  const pages = pageCount(list.data?.total ?? 0, per);

  /* последняя страница может опустеть после удаления или поиска — возвращаемся на ближайшую */
  useEffect(() => {
    if (list.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [list.data, page, pages, update]);

  return (
    <Page
      title={ut("top.messages")}
      toolbar={
        /*
         * Поле тянется от заголовка до «+», лупа — украшение: поиск идёт по
         * мере набора. Имя полю даёт aria-label, а не Field: на кадре поле
         * пустое, без подписи-плейсхолдера. Зазор 13 — замер f09: рамка поля
         * кончается на 1033, штрих плюса начинается на 1048.
         */
        <div className="flex min-w-0 flex-1 items-center gap-[13px]">
          <div className="relative min-w-0 flex-1">
            <Input
              look="outline"
              aria-label={ut("mail.search")}
              value={q}
              onChange={(e) => update({ q: e.target.value, page: null })}
              className="pr-[44px]"
              autoComplete="off"
              /* предел сервера (mailingListQuery, q ≤ 120): длиннее — не «нет результатов», а 400 */
              maxLength={120}
            />
            <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
              <IconSearchGlass />
            </span>
          </div>
          {/* «+» — ссылка на форму, а не кнопка с окном: новое повідомлення — отдельный экран (f16) */}
          <GlyphLink to="/mailings/new" aria-label={ut("mail.add")}>
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
      ) : !list.data ? (
        <Loading rows={5} />
      ) : list.data.items.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{dq.trim() ? ut("mail.emptySearch") : ut("mail.empty")}</p>
      ) : (
        /*
         * Список, а не таблица: у строки нет шапки колонок ни на кадре, ни
         * по смыслу — тема, начало текста и дата читаются диктором как один
         * элемент списка, а не как три безымянные ячейки.
         */
        <ul className="m-0 list-none p-0">
          {list.data.items.map((m) => (
            <Row key={m.id} m={m} />
          ))}
        </ul>
      )}
    </Page>
  );
}

/**
 * Строка списка — замеры f09 (кадр 1600, колонка 1200 один к одному):
 *
 *   тема       17/700 фиолетовым, интерлиньяж 23, колонка 156 + зазор 24
 *   текст      13/400 серым, интерлиньяж 14, три строки и обрез
 *   дата       14/700 серым, правый край колонки, 96 + зазор 24
 *   шаг строк  68 = три строки текста (42) + по 13 сверху и снизу
 *
 * Тема набрана крупнее «имени в списке» других экранов (13/700) — так на
 * кадре: «Тема повідомлення» стоит 153px шириной при 17 знаках, а 13-м
 * кеглем те же знаки заняли бы 119. Замер сильнее общего правила.
 *
 * Линий между строками нет: на кадре между строками белое (проверено
 * пипеткой на трёх колонках), расшифровка макета в этом месте ошиблась.
 *
 * Подсветка наведения — #f7f5fa с кадра, то есть ровно 5 % фиолетового на
 * белом (247 = 0,95·255 + 0,05·102). Записана вычислением из токена, а не
 * числом: поедет за палитрой. Полоса замерена от 205 до 1404 — это ровно
 * колонка 1200, не шире и не у́же.
 *
 * Колонки выровнены по центру, а не по верху, и это замер, а не вкус: дата
 * первой строки стоит на 222…231, а при выравнивании по верху её глиф лёг бы
 * на 213…223 — девять пикселей мимо. Центр даёт 222…232.
 */
function Row({ m }: { m: MailingListItem }) {
  return (
    <li
      className={cx(
        "flex items-center gap-[24px] py-[13px]",
        "transition-colors duration-[var(--dur-fast)]",
        "hover:bg-[color-mix(in_srgb,var(--primary)_5%,transparent)]",
      )}
    >
      <Link
        to={mailingHref(m.id)}
        className="w-[156px] shrink-0 text-[17px] font-bold leading-[23px] text-primary no-underline hover:underline"
      >
        {m.title}
      </Link>
      <p className="m-0 min-w-0 flex-1 text-[13px] leading-[14px] text-muted line-clamp-3">{m.preview}</p>
      {/*
        «14 may 20:15» на кадре — день, месяц словом, время. Месяц по языку
        консоли (day → «14 трав.»), время — timeOfDay; английское «may» на
        кадре — заглушка рисунка, не формат. Одна дата на строку, как на
        кадре: у отправленной — отправки, у черновика — правки.
      */}
      <span className="w-[96px] shrink-0 whitespace-nowrap text-right text-[14px] font-bold leading-[23px] text-muted">
        {day(m.at)} {timeOfDay(m.at)}
      </span>
    </li>
  );
}
