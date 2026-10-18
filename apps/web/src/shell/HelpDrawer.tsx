import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { IconCommand } from "../ui/glyphs";
import { ShellIcon } from "./icons";
import { Drawer, Kbd } from "../ui";

/** Мак или нет: на маке палитру открывают Command+K, у остальных — Ctrl K */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/**
 * Клавиша-модификатор палитры: на маке — значок Command (его печатает и сама
 * клавиатура, а в подмножестве шрифта этого знака нет), у остальных — «Ctrl».
 */
export function ModKey() {
  return isMac() ? <IconCommand /> : <>Ctrl</>;
}

/**
 * «Довідка» внизу рельсы — клавиши консоли и двери, которые нужны редко.
 *
 * Только то, что в консоли действительно работает: ⌘K и Esc — на любом
 * экране (App.tsx, ui/index.tsx), остальное — на разборе случаев риска
 * (pages/Alerts.tsx). Клавиша, которая работает на одном экране, названа
 * вместе с ним: обещанная «везде» и не сработавшая клавиша учит не верить
 * подсказкам вообще.
 */
export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ut } = useLang();
  return (
    <Drawer open={open} onClose={onClose} title={ut("rail.helpFull")} icon={<ShellIcon name="keyboard" size={18} />}>
      <div className="pb-[10px]">
        <Section title={ut("help.keys")}>
          <KeyRow keys={["mod", "K"]} label="help.palette" />
          <KeyRow keys={["Esc"]} label="help.escape" />
        </Section>
        <Section title={ut("help.casesKeys")}>
          <KeyRow keys={["J", "K"]} label="help.rows" />
          <KeyRow keys={["/"]} label="help.search" />
          <KeyRow keys={["1", "2", "3"]} label="help.outcome" />
          <KeyRow keys={["T"]} label="help.take" />
        </Section>
        <Section title={ut("help.more")}>
          <DoorRow to="/status" icon="circle-check" label="svc.title" onGo={onClose} />
          <DoorRow to="/account" icon="circle-user-round" label="acct.title" onGo={onClose} />
        </Section>
      </div>
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-[16px]">
      <h3 className="m-0 pb-[6px] text-[12px] font-bold leading-4 text-muted">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function KeyRow({ keys, label }: { keys: string[]; label: UiKey }) {
  const { ut } = useLang();
  return (
    <div className="flex min-h-9 items-center gap-3 border-b border-divider py-[6px] last:border-b-0">
      <span className="flex w-[92px] shrink-0 items-center gap-[4px]">
        {keys.map((k) => (
          <Kbd key={k}>{k === "mod" ? <ModKey /> : k}</Kbd>
        ))}
      </span>
      <span className="text-[13px] leading-[18px] text-text-2">{ut(label)}</span>
    </div>
  );
}

function DoorRow({ to, icon, label, onGo }: { to: string; icon: "circle-check" | "circle-user-round"; label: UiKey; onGo: () => void }) {
  const { ut } = useLang();
  return (
    <Link
      to={to}
      onClick={onGo}
      className={cx(
        "flex h-9 items-center gap-[10px] rounded-[9px] px-[10px] text-[13px] font-semibold text-text no-underline",
        "hover:bg-sunk hover:no-underline",
      )}
    >
      <ShellIcon name={icon} size={16} className="text-muted" />
      {ut(label)}
    </Link>
  );
}
