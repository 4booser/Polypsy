import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth";
import { IconSearchGlass, Loading, useUrlState } from "../../ui";
import { Page } from "../../ui/layout";
import { IconPlusThick } from "../../ui/glyphs";
import { Button, Input } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { loadDirectory, withLadder } from "./data";
import { isAdministrator, isDoctor, matchesQuery, metaSegments } from "./model";

/*
 * Списки «Лікарі» (кадр f43) и «Адміністратори» (кадр f50) — один экран в
 * двух прочтениях.
 *
 * Что на кадрах и как легло на код:
 *
 *   заголовок · поле поиска с лупой · «+»   → строка над списком (Page),
 *                                              поиск в адресе (?q), «+» — ссылка
 *                                              на «Додати лікаря/адміністратора»
 *   сетка 3 колонки, строка 58px:            → grid; имя 13/700 фиолетовым,
 *   имя + мета-строка                           мета 13/400 серым
 *
 * Кадр f50 нарисован без лупы в поле поиска, f43 — с лупой; взят f43 как
 * более полный: лупа — та же, что в каталоге тестов, и поле без неё на
 * соседнем экране читалось бы как другое поле.
 *
 * Чего в строке нет, хотя на кадре есть: телефона и города. Телефон сервер
 * наружу не отдаёт вовсе — он зашифрован и у пациентов открывается отдельным
 * действием с записью в журнал; города в модели нет. Пустое место не
 * заполняется прочерками (см. metaSegments).
 *
 * Кто «лікар», а кто «адміністратор» — в model.ts: класс учётной записи и
 * ступень лестницы должностей, а не два разных списка на сервере.
 */

export type StaffKind = "doctors" | "admins";

/*
 * Строка списка: 58px шага с кадра = две строки по 19 плюс по 10 сверху и
 * снизу. Подсветка наведения выходит за текст на 8px — на кадре f04 так
 * подсвечена одна из строк. Цвет подсветки — ступень поверхности, а не
 * сиреневый: на кадре она серая.
 */
export const rowClass = cx(
  "-mx-[8px] block rounded-[4px] px-[8px] py-[10px] no-underline",
  "transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 hover:no-underline",
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
);
export const nameClass = "block truncate text-[13px] font-bold leading-[19px] text-primary";
export const metaClass = "flex flex-wrap gap-x-[10px] text-[13px] leading-[19px] text-muted";

/** Три колонки, как на кадре; на узком окне — одна: три колонки по 300px нечитаемы */
export const gridClass = "grid grid-cols-3 gap-x-[45px] max-[900px]:grid-cols-1";

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
  /* поиск в адресе: «вот эти люди» пересылаются ссылкой, как и в списке пациентов */
  const [q, setQ] = useUrlState("q");

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

  const shown = useMemo(() => {
    const rows = res.data?.rows ?? [];
    const pick = kind === "admins" ? isAdministrator : isDoctor;
    return rows.filter((r) => pick(r) && matchesQuery(r, q));
  }, [res.data, kind, q]);

  const isAdmins = kind === "admins";
  const meta = { male: ut("adm.male"), female: ut("adm.female"), year: ut("ppl.yearShort") };

  return (
    <Page
      title={isAdmins ? ut("adm.admins") : ut("ppl.staff")}
      count={res.data ? shown.length : null}
      toolbar={
        <div className="relative min-w-0 flex-1">
          {/*
            Имя полю даёт aria-label, а не Field: на кадре поле пустое, без
            подписи-плейсхолдера. Лупа — украшение, поиск идёт по мере набора.
          */}
          <Input
            look="outline"
            aria-label={ut("adm.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pr-[44px]"
            autoComplete="off"
          />
          <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
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
      {res.data?.partial ? <p className="m-0 mb-[14px] text-[13px] leading-[19px] text-muted">{ut("ppl.directoryPartial")}</p> : null}

      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={6} />
      ) : shown.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("pt.nobodyFound")}</p>
      ) : (
        <ul className={cx("m-0 list-none p-0", gridClass)}>
          {shown.map((r) => (
            <li key={r.id} className="min-w-0">
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
    </Page>
  );
}
