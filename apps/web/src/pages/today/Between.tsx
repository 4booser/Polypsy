import { Link } from "react-router-dom";
import type { WorkItem } from "@quizzy/shared";
import { day } from "../../format";
import { Ic } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { TextAction } from "../../ui/records";
import { useLang } from "../../lang";
import { withCount } from "../../ui/plural";
import { fill } from "../dashboard/model";
import { workWhy } from "../worklist/model";
import { chipLabel, WorkIcon } from "./ActNow";
import type { DrawerTarget } from "./drawers";
import { Di } from "./icons";

/**
 * «Між сесіями» — короткие дела из очереди, каждое с одним действием тут
 * же: письмо — ответить в ящике, неявка — написать человеку, остальное —
 * открыть там, где с ним работают. Вся очередь — на «Черга роботи».
 */
export function Between({
  items,
  total,
  onReply,
}: {
  items: WorkItem[];
  total: number;
  onReply: (t: DrawerTarget) => void;
}) {
  const { ut, lang } = useLang();
  if (!items.length) return null;
  return (
    <Panel
      title={ut("dayA.between")}
      icon={<Ic.inbox />}
      sub={withCount(ut("home.nTasks"), items.length, lang)}
      actions={<TextAction to="/worklist">{fill(ut("dayA.allQueue"), { n: total })}</TextAction>}
      flush
    >
      <ul className="m-0 list-none px-2 pb-2 pt-0">
        {items.map((w) => {
          const unread = w.kind === "message";
          const tone = w.kind === "noshow" || w.overdue ? "attention" : w.kind === "message" ? "info" : "plain";
          return (
            <li
              key={`${w.kind}-${w.id}`}
              className="relative grid grid-cols-[minmax(180px,262px)_minmax(0,1fr)_auto] items-center gap-x-4 rounded-[12px] py-3 pl-5 pr-3 transition-colors duration-[var(--dur-fast)] hover:bg-sunk max-[1100px]:grid-cols-[minmax(0,1fr)_auto] max-[1100px]:gap-y-2"
            >
              {unread ? <span aria-hidden className="absolute left-2 top-[19px] size-[7px] rounded-full bg-primary" /> : null}
              <div className="min-w-0">
                <Link
                  to={`/patients/${w.userId}`}
                  className="block truncate text-[14px] font-bold leading-5 text-text no-underline hover:underline"
                >
                  {w.userName}
                </Link>
                <Tag tone={tone} icon={<WorkIcon kind={w.kind} />} className="mt-[5px]">
                  {chipLabel(w, ut)}
                </Tag>
              </div>
              <div className="min-w-0 max-[1100px]:col-span-2 max-[1100px]:row-start-2">
                <p className="m-0 text-[13px] leading-[19px] text-text">{workWhy(w, ut)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-caption text-muted">
                  {w.unit ? <span>{w.unit}</span> : null}
                  <span>{fill(ut("dayA.since"), { d: day(w.since) })}</span>
                </div>
              </div>
              <div className="flex items-center justify-end gap-1.5 max-[1100px]:col-start-2 max-[1100px]:row-start-1">
                {w.kind === "message" ? (
                  <Button size="xs" icon={<Ic.reply />} onClick={() => onReply({ patientId: w.userId, patientName: w.userName, threadId: w.id })}>
                    {ut("dayA.replyBtn")}
                  </Button>
                ) : w.kind === "noshow" ? (
                  <Button size="xs" icon={<Ic.message />} onClick={() => onReply({ patientId: w.userId, patientName: w.userName })}>
                    {ut("dayA.write")}
                  </Button>
                ) : (
                  <ButtonLink to={w.href} size="xs">
                    <Di.outLink />
                    {ut("dayA.open")}
                  </ButtonLink>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
