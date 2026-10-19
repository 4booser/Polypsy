import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { cx } from "../ui/cx";

/**
 * Номера помощи строками-звонками (m-calls): линия доверия и 103. Красным —
 * только 103: это единственная строка про угрозу жизни. Настоящие ссылки
 * tel: без подтверждения: в кризис лишний шаг между человеком и звонком
 * стоит дороже всего остального на экране. Строк, номеров которых у
 * кабинета нет (семья, дежурный отделения), здесь нет: выдумывать их нельзя.
 *
 * `autoFocus` — в ящике «Допомога»: фокус при открытии встаёт на первый
 * звонок, а не на крестик (Drawer, data-autofocus). На крестике набор
 * сразу показывает подсказку «Закрити…», и на телефоне она ложилась поверх
 * строки 103 (ревью волны 26); а звонок — то, ради чего ящик открыли.
 */
export function CallRows({ framed = true, autoFocus }: { framed?: boolean; autoFocus?: boolean }) {
  const { ut } = useLang();
  const rows = [
    { key: "hotline", name: ut("home.hotline"), sub: ut("pt.helpHotlineSub"), num: ut("home.hotlineNumber"), risk: false },
    { key: "emergency", name: ut("pt.emergency"), sub: ut("pt.emergencySub"), num: ut("pt.emergencyNumber"), risk: true },
  ];
  return (
    <div className={cx(framed ? "overflow-hidden rounded-[16px] border border-border" : "border-t border-divider")}>
      {rows.map((r, i) => (
        <a
          key={r.key}
          href={`tel:${r.num}`}
          data-autofocus={autoFocus && i === 0 ? true : undefined}
          aria-label={`${ut("pt.helpCall")}: ${r.name}, ${r.num}`}
          className="group grid min-h-[66px] grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-3 border-t border-divider py-[9px] pl-4 pr-[14px] text-text no-underline first:border-t-0 hover:bg-panel-2 hover:no-underline"
        >
          <span className="min-w-0">
            <b className={cx("block text-[16px] font-extrabold leading-[22px]", r.risk && "text-risk-ink")}>{r.name}</b>
            <small className="block truncate text-[14px] font-semibold leading-[19px] text-muted">{r.sub}</small>
          </span>
          <span className={cx("text-[20px] font-extrabold leading-none tabular-nums", r.risk ? "text-risk-ink" : "text-violet-ink")}>
            {r.num}
          </span>
          <span
            aria-hidden
            className={cx(
              "grid size-11 place-items-center rounded-[14px]",
              r.risk ? "bg-risk text-onfill group-hover:bg-risk-hover" : "bg-violet-tint text-violet-ink group-hover:bg-violet-tint-2",
            )}
          >
            <ShellIcon name="phone" size={19} />
          </span>
        </a>
      ))}
    </div>
  );
}
