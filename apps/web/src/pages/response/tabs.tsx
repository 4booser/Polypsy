import { Link, useNavigate } from "react-router-dom";
import { day } from "../../format";
import { useDecimal } from "../../charts/kit";
import { useLang } from "../../lang";
import { Tooltip, useHotkeys } from "../../ui";
import { cx } from "../../ui/cx";
import { Tabs } from "../../ui/primitives";
import type { AttemptNav } from "./context";
import { attemptHref } from "./frame";

/**
 * Вкладки прохождения: «Відповіді» (протокол) и «Графіки», справа —
 * переключатель попыток той же методики: «19 24 серп. · 16 11 вер. · 14 8 жовт.».
 *
 * Два адреса, а не состояние одного экрана: /surveys/:id/responses/:rid и
 * тот же адрес с /charts. Ссылку на графики пересылают коллеге так же, как
 * ссылку на протокол, и карточка пациента ведёт прямо на графики. «Відповіді»
 * с `end`: иначе NavLink считал бы её активной и на /charts — адрес графиков
 * начинается с адреса ответов.
 *
 * Попытка в переключателе ведёт на ту же вкладку другой попытки: смотревший
 * графики хочет графики соседнего замера, а не его протокол. «[» и «]» —
 * предыдущая и следующая попытка.
 */
export function ResponseTabs({
  surveyId,
  responseId,
  nav,
  charts,
}: {
  surveyId: string;
  responseId: string;
  /** null — попыток не знаем (прохождение без человека, обстановка не пришла) */
  nav: AttemptNav | null;
  charts: boolean;
}) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const fmt = useDecimal();
  useHotkeys(
    {
      "[": () => {
        if (nav?.prev) navigate(attemptHref(surveyId, nav.prev, charts));
      },
      "]": () => {
        if (nav?.next) navigate(attemptHref(surveyId, nav.next, charts));
      },
    },
    !!nav,
  );
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Tabs
        label={ut("rch.tabsLabel")}
        items={[
          { to: `/surveys/${surveyId}/responses/${responseId}`, label: ut("rch.tabAnswers"), end: true },
          { to: `/surveys/${surveyId}/responses/${responseId}/charts`, label: ut("rch.tabCharts") },
        ]}
      />
      {nav && nav.total > 1 ? (
        <nav aria-label={ut("rp.attempts")} className="ml-auto flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap text-small text-muted">
            {nav.total > nav.chips.length ? ut("rp.attemptsOf").replace("{n}", String(nav.total)) : ut("rp.attempts")}
          </span>
          <span className="inline-flex items-center gap-0.5 rounded-[12px] bg-sunk p-[3px]">
            {nav.chips.map((c) => {
              const body = (
                <>
                  {c.value !== null ? <b className="font-extrabold tabular-nums">{fmt(c.value)}</b> : null}
                  <small className="text-[11.5px] font-semibold text-muted">{day(c.at)}</small>
                </>
              );
              const cls = cx(
                "inline-flex h-[30px] items-baseline gap-[5px] whitespace-nowrap rounded-[9px] px-2.5 pt-[7px] text-[13px] leading-none no-underline",
                c.current ? "bg-panel text-violet-ink shadow-tile" : "text-text-2 hover:bg-sunk-2 hover:text-text hover:no-underline",
              );
              if (c.current) {
                return (
                  <span key={c.id} aria-current="page" className={cls}>
                    {body}
                  </span>
                );
              }
              const link = (
                <Link key={c.id} to={attemptHref(surveyId, c.id, charts)} className={cls}>
                  {body}
                </Link>
              );
              return c.id === nav.prev ? (
                <Tooltip key={c.id} label={ut("rp.prevAttempt")} kbd="[">
                  {link}
                </Tooltip>
              ) : c.id === nav.next ? (
                <Tooltip key={c.id} label={ut("rp.nextAttempt")} kbd="]">
                  {link}
                </Tooltip>
              ) : (
                link
              );
            })}
          </span>
        </nav>
      ) : null}
    </div>
  );
}

