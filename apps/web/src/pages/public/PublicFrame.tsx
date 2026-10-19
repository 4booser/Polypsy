import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useLang } from "../../lang";
import { useServiceStatus } from "../../service/status";
import { ShellIcon } from "../../shell/icons";
import { LangMenu } from "../../shell/LangMenu";
import { LogoTile } from "../../shell/Logo";
import { setThemeChoice } from "../../shell/theme";
import { ThemeToggle } from "../../shell/ThemeToggle";
import { cx } from "../../ui/cx";
import { buttonClass } from "../../ui/primitives";
import { IconFacebook, IconTelegram, IconYouTube } from "./social";

/*
 * Рамка гостевых страниц Polypsy 2.0 — лендинг, вход, статус (public() в
 * kit/shell.py).
 *
 * Шапка 80 на колонке 1200: знак и имя слева; справа состояние системы
 * ссылкой на страницу статуса, тема, язык и «Увійти». Подвал — одна строка
 * под чертой: «© 2026 Polypsy» (год — текущий), телефон и почта учреждения
 * и соцсети. Пунктов, которых в системе нет (политика конфиденциальности,
 * условия, «Дані зберігаються в Україні»), здесь нет, хотя набор их рисует:
 * ссылка в никуда хуже отсутствующей, а обещание о данных — дело
 * учреждения, а не макета. «Про кампанію» прежнего кадра f00 ушло вместе с
 * кампанией: лендинг Polypsy 2.0 рассказывает о системе.
 *
 * Тема у гостя своя и хранится только в браузере: у гостя нет профиля на
 * сервере. Набор рисует гостевые страницы в обеих темах, и переключатель
 * стоит в шапке, как у кабинета.
 *
 * Содержимое страницы — во всю колонку: каждая страница сама решает, где у
 * неё карточка входа или блок лендинга.
 */

/** Колонка 1200 по центру, с полями по 16 на узком окне */
const COLUMN = "mx-auto w-full max-w-[1232px] px-4";

export function PublicFrame({
  children,
  signIn,
  bleed,
  extra,
}: {
  children: ReactNode;
  /**
   * «Увійти» в шапке. По умолчанию — везде, кроме самого входа. Ворота после
   * входа (временный пароль, второй фактор) прячут её: человек уже вошёл.
   */
  signIn?: boolean;
  /** Содержимое само раскладывает колонку: лендинг с полосами во всю ширину */
  bleed?: boolean;
  /** Своё перед состоянием системы: «Допомога» у приглашения пациента */
  extra?: ReactNode;
}) {
  const { ut } = useLang();
  const { pathname } = useLocation();
  const showSignIn = signIn ?? pathname !== "/login";
  return (
    <div className="flex min-h-dvh flex-col bg-ground text-text">
      <header className={cx(COLUMN, "flex h-20 shrink-0 items-center gap-6 max-[600px]:gap-3")}>
        <Link
          to="/"
          aria-label={ut("pub.home")}
          className="flex shrink-0 items-center gap-[10px] rounded-[12px] text-text no-underline hover:no-underline"
        >
          <LogoTile size={40} ring />
          <span className="text-[18px] font-extrabold leading-none tracking-[-0.015em] max-[420px]:hidden">
            {ut("shell.brand")}
          </span>
        </Link>
        <div className="ml-auto flex items-center gap-[10px] max-[600px]:gap-[6px]">
          {extra}
          <StatusLink />
          <ThemeToggle tone="band" onChoose={(c) => setThemeChoice(c)} className="max-[600px]:hidden" />
          <LangMenu tone="band" />
          {/*
            «Увійти» — везде, кроме самого входа: на нём кнопка вела бы туда,
            где человек уже стоит. Тонированная, как в наборе (.pub-h .btn):
            основная кнопка страницы — её собственная («Увійти» формы,
            «Підключити відділення» лендинга), а шапке вторая залитая не нужна.
          */}
          {!showSignIn ? null : (
            <Link to="/login" className={buttonClass("secondary", "sm")}>
              <ShellIcon name="log-in" size={15} />
              {ut("lg.signIn")}
            </Link>
          )}
        </div>
      </header>
      <main className={bleed ? "min-w-0 flex-1" : cx(COLUMN, "flex-1 pb-[56px]")}>{children}</main>
      <Footer />
    </div>
  );
}

/**
 * Состояние системы ссылкой на страницу статуса: зелёная галочка, когда всё
 * работает, янтарный знак — при работах и сбоях. Красного здесь нет: это не
 * риск для человека.
 */
function StatusLink() {
  const { ut } = useLang();
  const { status, unreachable } = useServiceStatus();
  const state = unreachable ? "degraded" : (status?.status ?? null);
  const label =
    state === "maintenance"
      ? ut("svc.status.maintenance")
      : state === "degraded"
        ? ut("svc.status.degraded")
        : state === "ok"
          ? ut("svc.status.ok")
          : ut("svc.title");
  const good = state === "ok";
  return (
    <Link
      to="/status"
      className={cx(
        "inline-flex h-10 shrink-0 items-center gap-[7px] rounded-control px-[12px] text-[13.5px] font-bold",
        "text-violet-ink no-underline hover:bg-violet-tint hover:no-underline max-[600px]:px-[8px]",
      )}
    >
      <ShellIcon
        name={good || state === null ? "circle-check" : "circle-alert"}
        size={15}
        className={good ? "text-good" : state === null ? "text-violet-ink" : "text-warn"}
      />
      <span className="max-[600px]:sr-only">{label}</span>
    </Link>
  );
}

/*
 * Подвал — одна строка под чертой: «© 2026 Polypsy», телефон и почта
 * учреждения, соцсети справа.
 *
 * Телефон и почта — настоящие ссылки (tel:, mailto:): на телефоне по
 * контакту нажимают, а не переписывают. Адрес ссылки — из той же строки
 * словаря, что и подпись: второй записи номера в коде нет.
 */
function Footer() {
  const { ut } = useLang();
  const tel = `tel:${ut("pub.phone").replace(/\s+/g, "")}`;
  const mail = `mailto:${ut("pub.email")}`;
  const link =
    "inline-flex min-h-6 items-center rounded-[6px] text-text-2 no-underline hover:text-text hover:underline";
  return (
    <footer className="border-t border-border bg-panel">
      <div
        className={cx(
          COLUMN,
          "flex min-h-16 flex-wrap items-center gap-x-6 gap-y-2 py-3 text-[13.5px] leading-5 text-muted",
        )}
      >
        <span>{ut("pub.copyright").replace("{year}", String(new Date().getFullYear())).replace("{brand}", ut("shell.brand"))}</span>
        <address className="flex flex-wrap items-center gap-x-6 gap-y-1 not-italic">
          <span>
            <a href={tel} className={link}>
              {ut("pub.phone")}
            </a>
            {", "}
            {ut("pub.city")}
          </span>
          <a href={mail} className={link}>
            {ut("pub.email")}
          </a>
        </address>
        <div className="ml-auto flex items-center gap-[4px]">
          <span className="sr-only">{ut("pub.social")}</span>
          <SocialLink href="https://www.facebook.com/" label={ut("pub.facebook")}>
            <IconFacebook />
          </SocialLink>
          <SocialLink href="https://www.youtube.com/" label={ut("pub.youtube")}>
            <IconYouTube />
          </SocialLink>
          <SocialLink href="https://t.me/" label={ut("pub.telegram")}>
            <IconTelegram />
          </SocialLink>
        </div>
      </div>
    </footer>
  );
}

function SocialLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      href={href}
      aria-label={label}
      target="_blank"
      rel="noreferrer"
      className="grid size-10 place-items-center rounded-full text-violet-ink [&>svg]:size-6 hover:bg-violet-tint"
    >
      {children}
    </a>
  );
}
