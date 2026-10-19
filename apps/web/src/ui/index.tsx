import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { backdropPress } from "./backdrop";
import { isTopLayer, useFocusTrap } from "./focus";
import { Ic } from "./icons";
import { IconTile, type PanelTone } from "./layout";
import { Button, ErrorText, Field, Input } from "./primitives";
import { Loading } from "./states";
import type { Resource } from "../useResource";
import { useLang } from "../lang";

/*
 * Набор «Виразна» — точка входа ui/.
 *
 * Экраны берут общие части отсюда (`import { … } from "../ui"`): состояния,
 * окно, сообщения, таблицу, ящик, поповеры, фильтры, числа. Описание каждой
 * части и когда её брать — в ui/README.md. Примитивы формы и раскладка
 * живут в ui/primitives и ui/layout и отсюда тоже доступны.
 */

export * from "./focus";
export * from "./keys";
export * from "./urlState";
export * from "./toast";
export * from "./states";
export * from "./kbd";
export * from "./icons";
export * from "./DataTable";
export * from "./Drawer";
export * from "./Popover";
export * from "./records";
export * from "./numbers";
export * from "./filters";
/* число со словом: одно правило Intl.PluralRules на всю консоль (ui/plural.ts) */
export * from "./plural";
/*
 * Части, которые нужны и начальному куску (рельса, оболочка, вход), — своими
 * модулями: оболочка берёт их оттуда напрямую, а не через эту точку входа,
 * которая потянула бы в начальный кусок таблицу, фильтры и окна (волна 27).
 */
export * from "./strokeIcons";
export * from "./backdrop";
export * from "./loadView";
export * from "./action";

/* ─────────── люди ─────────── */

/** Тон кружка: фиолетовый — пациент, мягкий — второстепенный, нейтральный — сотрудник */
export type AvatarTone = "violet" | "soft" | "neutral";

/** Инициалы из имени: «Мельник Андрій» → «МА» */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "—";
}

/**
 * Инициалы вместо портрета (.av набора).
 *
 * Фотографий в системе нет и не будет — это лишние персональные данные ради
 * украшения. Пациент — фиолетовый кружок с белыми инициалами, сотрудник —
 * нейтральный (`tone="neutral"`). Размер — число: 28 в строке таблицы, 34 в
 * списке, 44 и 56 в карточке (у крупных — кольцо цвета тонировки).
 */
export function Avatar({
  name,
  size = 22,
  tone = "violet",
  initials,
  className,
}: {
  name: string;
  size?: number;
  tone?: AvatarTone;
  /** Свои инициалы, если имя пишется не «Фамилия Имя» */
  initials?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-full font-extrabold leading-none tracking-[0.02em]",
        tone === "violet" ? "bg-violet text-onfill" : tone === "soft" ? "bg-violet-tint text-violet-ink" : "bg-sunk-2 text-text-2",
        size >= 44 && "shadow-[0_0_0_3px_var(--vtint)]",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * (size >= 44 ? 0.34 : 0.38))) }}
    >
      {initials ?? initialsOf(name)}
    </span>
  );
}

/**
 * Подтверждение необратимого действия перепечатыванием названия.
 *
 * Обычный confirm снимается не глядя — рука жмёт «ОК» раньше, чем глаз
 * читает. Требование напечатать название заставляет посмотреть, что именно
 * удаляется. Сама кнопка — обычная: красный в наборе отдан риску для
 * человека, а здесь защищает подтверждение, а не цвет.
 */
export function ConfirmByName({
  title,
  name,
  warning,
  actionLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  name: string;
  warning: ReactNode;
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { ut } = useLang();
  const [typed, setTyped] = useState("");
  return (
    <section className="rounded-panel border border-border bg-panel p-4 shadow-panel">
      <div className="mb-2 flex items-center gap-2.5">
        <IconTile icon={<Ic.alert />} tone="warn" />
        <h2 className="m-0 min-w-0 flex-1 text-section font-extrabold text-text">{title}</h2>
        <Button variant="quiet" size="xs" onClick={onCancel}>
          {ut("ui.cancel")}
        </Button>
      </div>
      <div className="text-body text-text-2">{warning}</div>
      <div className="mt-3">
        <Field label={`${ut("ui.typeToConfirm")} «${name}»`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      </div>
      <Button variant="danger" className="mt-3" disabled={typed.trim() !== name} onClick={onConfirm}>
        {actionLabel}
      </Button>
    </section>
  );
}

/* ─────────── окно ─────────── */

/**
 * Модальное окно (.modal набора) — только когда шаг обязан прервать работу:
 * подтвердить разрушительное или необратимое, короткая форма, без которой
 * дальше нельзя. Всё остальное — ящик (Drawer).
 *
 * Esc закрывает, фокус заперт внутри и при закрытии возвращается открывшему,
 * фон не прокручивается. Подложка закрывает окно только нажатием, начатым и
 * законченным на ней (backdropPress).
 *
 * `secret` — окно показывает то, что второй раз не показать (временный
 * пароль): подложка его не закрывает, Esc и крестик — да.
 * `esc={false}` — шаг надо закончить (коды восстановления не подтверждены):
 * ни Esc, ни подложка не закрывают — окно вздрагивает; закрывают только его
 * собственные кнопки.
 */
export function Modal({
  title,
  onClose: closeProp,
  children,
  wide,
  width,
  secret,
  esc = true,
  sub,
  icon,
  tone = "violet",
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 940 вместо 560 */
  wide?: boolean;
  /** Своя ширина в пикселях */
  width?: number;
  /** Показывает то, что второй раз не показать: подложка его не закрывает */
  secret?: boolean;
  /** false — ни Esc, ни подложка не закрывают: окно вздрагивает */
  esc?: boolean;
  /** Подпись под заголовком: «PSQI, 0 призначень за 30 днів» */
  sub?: ReactNode;
  /** Значок в квадрате 40 перед заголовком */
  icon?: ReactNode;
  tone?: PanelTone;
  /** Кнопки внизу через волосяную линию: основная первой */
  footer?: ReactNode;
}) {
  const { ut } = useLang();
  // фокус внутрь, круг по Tab и возврат при закрытии — общий для всех слоёв
  const ref = useFocusTrap<HTMLDivElement>();
  const [press] = useState(backdropPress);
  /* толчок: класс снимается и ставится заново в следующем кадре — анимация перезапускается без пересоздания окна */
  const [nudging, setNudging] = useState(false);
  const nudge = useCallback(() => {
    setNudging(false);
    requestAnimationFrame(() => setNudging(true));
  }, []);
  /* закрытие Esc и подложкой: у окна, которое надо закончить, — толчок вместо закрытия */
  const onClose = esc ? closeProp : nudge;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* закрывается верхний слой; см. isTopLayer */
      if (e.key === "Escape" && isTopLayer(ref)) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop fixed inset-0 z-60 grid place-items-center bg-scrim p-10 animate-[kit-fade_var(--dur)_var(--ease)] max-[640px]:p-4"
      onPointerDown={press.down}
      onPointerUp={press.up}
      onClick={(e) => {
        if (press.click(e) && !secret) onClose();
      }}
    >
      <div
        className={cx(
          "modal flex max-h-[calc(100vh-80px)] max-w-full flex-col overflow-hidden rounded-drawer border border-border bg-panel shadow-pop outline-none",
          nudging ? "animate-[kit-nudge_0.32s_var(--ease)]" : "animate-[kit-rise_var(--dur-slow)_var(--ease)]",
        )}
        onAnimationEnd={() => setNudging(false)}
        style={{ width: width ?? (wide ? 940 : 560) }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-esc={esc ? undefined : "block"}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <DialogFrame title={title} sub={sub} icon={icon} tone={tone} footer={footer} onClose={closeProp} closeLabel={ut("bp.close")}>
          {children}
        </DialogFrame>
      </div>
    </div>
  );
}

/**
 * Внутренность окна (.modal набора): шапка с квадратом значка 40, заголовком
 * 18/800 и крестиком, тело с прокруткой, подвал с кнопками. Modal рисует её
 * внутри слоя; страница дизайн-системы — открытой на месте (тогда без
 * role=dialog: настоящий диалог на странице один).
 */
export function DialogFrame({
  title,
  sub,
  icon,
  tone = "violet",
  footer,
  onClose,
  closeLabel,
  children,
}: {
  title: string;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: PanelTone;
  footer?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-divider py-4 pl-5 pr-3.5">
        {icon ? <IconTile icon={icon} tone={tone} size={40} /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[18px] font-extrabold leading-6 tracking-[-0.02em] text-text">{title}</h2>
          {sub ? <span className="block text-small text-muted">{sub}</span> : null}
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="inline-grid size-9 min-h-0 shrink-0 cursor-pointer place-items-center rounded-control border-0 bg-sunk p-0 text-text-2 hover:bg-sunk-2 hover:text-text"
          >
            <Ic.x size={17} />
          </button>
        ) : null}
      </header>
      <div className="kit-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-4 text-body">{children}</div>
      {footer ? (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-divider px-5 pb-4 pt-3">{footer}</footer>
      ) : null}
    </>
  );
}

/* ─────────── данные ─────────── */

/**
 * Три состояния загрузки в одном месте: пока данных нет — скелет; отказ без
 * данных — отказ с «повторить»; данные есть, но обновить не вышло — данные и
 * строка отказа над ними: устаревшие цифры полезнее пустого экрана, если про
 * их устарелость сказано. Об обрыве связи говорит оболочка
 * (ui/ConnectionLine.tsx), а не экран.
 */
export function Screen<T>({
  res,
  rows = 4,
  children,
}: {
  res: Resource<T>;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (res.data === null) {
    return <Loading rows={rows} error={res.error} onRetry={res.reload} busy={res.loading} />;
  }
  return (
    <>
      {res.error ? <ErrorText className="mb-3">{res.error}</ErrorText> : null}
      {children(res.data)}
    </>
  );
}

/** Место данных, пока их нет: скелет или отказ с «повторить» — но никогда не «пусто» */
export function NotLoaded({
  res,
  rows = 2,
}: {
  res: Pick<Resource<unknown>, "error" | "loading" | "reload">;
  rows?: number;
}) {
  return <Loading rows={rows} error={res.error} onRetry={res.reload} busy={res.loading} />;
}
