import type { ComponentProps, ReactNode } from "react";
import { useLang } from "../../../lang";
import { Ic } from "../../../ui/icons";
import { Page } from "../../../ui/layout";
import { Tooltip } from "../../../ui/Popover";

/*
 * Рамка разделов «Люди й безпека» и «Дані й продукт» (Polypsy 2.0, участок
 * v2-ops-people).
 *
 * В «Виразній» у каждого раздела своя шапка: заголовок, мета-строка за
 * волосяной линией («271 обліковий запис / 23 персонал, 248 пацієнтів»),
 * право, которым открыт раздел, действия и строка пояснения. Всё это знает
 * только сам раздел, поэтому он ставит Page набора сам, а общая рамка
 * техпанели (index.tsx) для этих адресов отдаёт ему место целиком.
 */
export const OWN_FRAME: readonly string[] = [
  "/ops/users",
  "/ops/sessions",
  "/ops/audit",
  "/ops/suspicious",
  "/ops/grants",
  "/ops/who-viewed",
  "/ops/mfa",
  "/ops/quality",
  "/ops/usage",
  "/ops/mobile",
  "/ops/push",
];

/** Рисует ли раздел по этому адресу свою рамку */
export function ownFrame(pathname: string): boolean {
  return OWN_FRAME.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Право, которым открыт раздел: тихая пилюля с кодом права и подсказкой
 * «Хто бачить розділ». Код — моноширинным: это идентификатор, его ищут в
 * настройках ролей буква в букву.
 */
export function AccessPill({ perm }: { perm: string }) {
  const { ut } = useLang();
  return (
    <Tooltip label={ut("opp.access")}>
      <span
        tabIndex={0}
        className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-pill bg-sunk pl-[7px] pr-[9px] text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-violet-ring"
      >
        <Ic.lock size={12} />
        <span className="font-mono text-[11.5px] font-medium leading-none">{perm}</span>
      </span>
    </Tooltip>
  );
}

/**
 * Page набора с пилюлей права перед действиями. Всё остальное — свойства
 * самого Page: meta, lead, toolbar, context.
 */
export function SectionPage({
  perm,
  actions,
  ...page
}: ComponentProps<typeof Page> & { perm?: string | null; actions?: ReactNode }) {
  const right =
    perm || actions ? (
      <>
        {perm ? <AccessPill perm={perm} /> : null}
        {actions}
      </>
    ) : undefined;
  return <Page {...page} actions={right} />;
}
