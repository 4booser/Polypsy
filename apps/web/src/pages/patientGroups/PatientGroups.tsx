import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { PatientGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading } from "../../ui";
import { cx } from "../../ui/cx";
import { IconHeart, IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Pager } from "../../ui/Pager";
import { DEFAULT_PER, pageCount, pageFrom, perFrom, slicePage } from "../../ui/paging";
import { Button, Input } from "../../ui/primitives";
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
 * Чего на кадре есть, а здесь нет, и почему.
 *
 * Ряд вкладок с именами групп над списком групп. На f05 (пациенты) те же
 * вкладки — фильтр по группе, и там они на месте. Здесь под ними лежит список
 * тех же самых групп: вкладка «Група ризику» над строкой «Група ризику» —
 * это один вход, нарисованный дважды. Кадр f10 — редакция шапки с f05, а не
 * отдельное решение; взято более полное прочтение (f05), вкладки оставлены
 * ему. Если заказчик имел в виду обратное, ряд ставится одной строкой — Tabs
 * уже умеет.
 *
 * Сердце нарисовано и работает, но живёт в браузере, не на сервере — почему,
 * см. FAVORITES_KEY в model.ts.
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
      count={groups ? shown.length : null}
      toolbar={
        /* поле тянется от заголовка до «+», лупа — украшение: поиск идёт по мере набора */
        <div className="flex min-w-0 flex-1 items-center gap-[19px]">
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
        <ul className="m-0 grid list-none grid-cols-2 gap-x-[48px] p-0 max-[900px]:grid-cols-1">
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
 * говорит «Назва групи можливо велика»), описание 11/15 серым с выключкой по
 * ширине, сердце справа. Наведение подсвечивает строку — на кадре пятая
 * строка правой колонки залита именно так.
 *
 * Микроподпись «N учасників · M тестів» на кадре не нарисована; она стоит
 * под описанием, потому что это первый вопрос к любой группе — сколько в
 * ней людей, — а узнать это иначе можно только открыв карточку. Набрана
 * 10/400, как микроподписи макета, и строку не утяжеляет.
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
        "flex items-start gap-[24px] rounded-[4px] py-[14px] pl-[4px] -ml-[4px]",
        "transition-colors duration-[var(--dur-fast)] hover:bg-surface-2",
      )}
    >
      <Link
        to={`/patient-groups/${group.id}`}
        className="w-[136px] shrink-0 text-[15px] font-bold leading-[20px] text-primary no-underline hover:underline"
      >
        {group.title}
      </Link>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-justify text-[11px] leading-[15px] text-muted">
          {group.description ? group.description : <span className="text-faint">{ut("pg.noDescription")}</span>}
        </p>
        <p className="m-0 mt-[4px] text-[10px] leading-[12px] text-muted">
          {group.memberCount} {ut("pg.members")} · {group.surveyCount} {ut("pg.tests")}
        </p>
      </div>
      <Button
        size="glyph"
        variant="ghost"
        aria-label={ut("pg.favorite")}
        aria-pressed={favorite}
        onClick={onFavorite}
        className="mt-[2px] shrink-0"
      >
        <IconHeart filled={favorite} />
      </Button>
    </li>
  );
}
