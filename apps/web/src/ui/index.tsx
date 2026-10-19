import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { isTopLayer, useFocusTrap } from "./focus";
import { Ic } from "./icons";
import { IconTile, type PanelTone } from "./layout";
import { Button, ErrorText, Field, Input } from "./primitives";
import { Loading } from "./states";
import { useToast } from "./toast";
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

/* ─────────── иконки ─────────── */

const icon = (path: ReactNode) =>
  function Icon() {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    );
  };

export const IconDashboard = icon(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>);
export const IconSurvey = icon(<><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 12h6M9 16h4" /></>);
export const IconGroup = icon(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>);
export const IconPatients = icon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></>);
export const IconAlert = icon(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>);
export const IconUsers = icon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>);
/* стопка листов: пакет заключений — это подшивка, а не отдельный документ */
export const IconStack = icon(<><rect x="4" y="3" width="12" height="15" rx="1" /><path d="M8 21h10a2 2 0 0 0 2-2V8" /><path d="M8 8h4M8 12h4" /></>);
/* Администрирование: человек с шестерёнкой — настройка того, кто что может */
export const IconUserGear = icon(<><circle cx="9" cy="7" r="4" /><path d="M2 21v-2a4 4 0 0 1 4-4h5" /><circle cx="18" cy="17" r="2.5" /><path d="M18 13v1.2M18 19.8V21M21.5 15l-1 .6M15.5 18.4l-1 .6M21.5 19l-1-.6M15.5 15.6l-1-.6" /></>);
export const IconBattery = icon(<><rect x="2" y="7" width="16" height="10" rx="2" /><path d="M22 11v2" /><path d="M6 11v2M10 11v2" /></>);
export const IconClock = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconPulse = icon(<><path d="M2 12h4l2-7 4 14 3-9 2 2h5" /></>);
export const IconReferral = icon(<><path d="M4 12h11" /><path d="M12 6l6 6-6 6" /><path d="M20 4v16" /></>);
/*
 * Значки действий и состояний.
 *
 * Заводятся здесь, а не в отдельном наборе и не картинками: обводка у всех
 * одна (24×24, штрих 1.8, скруглённые концы), и покупной растровый набор
 * выбивался бы из строя на первом же экране, где стоит рядом со своими.
 * Заодно значок наследует цвет текста и меняется вместе с темой — картинке
 * пришлось бы держать две версии.
 */
export const IconSearchGlass = icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconPrint = icon(<><path d="M7 8V3h10v5" /><rect x="4" y="8" width="16" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>);
export const IconWarn = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>);
export const IconOk = icon(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>);
export const IconLock = icon(<><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>);
export const IconMessage = icon(<><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></>);

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

/** Где событие нажатия: на самой подложке или внутри окна */
interface PressEvent {
  target: unknown;
  currentTarget: unknown;
}

/**
 * Нажатие на подложке окна (#179) — закрывает, только если и началось, и
 * кончилось на ней.
 *
 * Подложка закрывала окно по click, не глядя, где началось нажатие. А click
 * приходит общему предку нажатия и отпускания: выделил протяжкой текст в
 * «Причина вимкнення» или «Опис групи», отпустил мышь за краем окна — click
 * на подложке, окно закрыто, набранное потеряно. Обратное тоже: нажал на
 * подложке, отпустил в окне — click опять достаётся подложке.
 *
 * Состояние — на одно окно (Modal держит свой экземпляр), без React:
 * проверяется вызовами (test/modalBackdrop.test.ts).
 */
export function backdropPress(): {
  down: (e: PressEvent) => void;
  up: (e: PressEvent) => void;
  /** Закрывать ли окно этим click */
  click: (e: PressEvent) => boolean;
} {
  let downOnBackdrop = false;
  let upOnBackdrop = false;
  return {
    down: (e) => {
      downOnBackdrop = e.target === e.currentTarget;
      upOnBackdrop = false;
    },
    up: (e) => {
      upOnBackdrop = e.target === e.currentTarget;
    },
    click: (e) => {
      const closes = downOnBackdrop && upOnBackdrop && e.target === e.currentTarget;
      downOnBackdrop = false;
      upOnBackdrop = false;
      return closes;
    },
  };
}

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

/**
 * Что стоит на месте данных: четыре состояния, которые нельзя путать.
 *
 *  - wait   — ответа ещё не было: первая загрузка или ждём связи (о связи
 *             говорит строка оболочки, ConnectionLine). Место — скелет.
 *  - failed — сервер отказал, данных нет. Место — отказ с «повторить».
 *  - empty  — сервер ответил, и ответ пуст: пустой список или «ничего»
 *             (null, 204 — например, текст согласия ещё не задан). Только
 *             здесь уместно «нічого немає».
 *  - ready  — данные есть (может быть, устаревающие: обрыв и неудачный
 *             повтор их не стирают).
 *
 * Внешний разбор (w13:uitests): экраны, которые брали `data ?? []`, на
 * отказе и на обрыве говорили «звернень немає», «прийомів немає»,
 * «пропущеного немає» — то есть сообщали о человеке неправду, выглядящую
 * как правда. «Нет данных» — это ответ сервера, а не отсутствие ответа.
 *
 * `updatedAt` отличает «ответ был, и он пуст» от «ответа не было»: у обоих
 * data — null.
 */
export type LoadView = "wait" | "failed" | "empty" | "ready";

export function loadView<T>(
  res: Pick<Resource<T>, "data" | "error" | "updatedAt">,
  isEmpty?: (data: T) => boolean,
): LoadView {
  if (res.data !== null) return isEmpty?.(res.data) ? "empty" : "ready";
  if (res.error) return "failed";
  return res.updatedAt !== null ? "empty" : "wait";
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

/** Оборачивает действие: показывает результат и не даёт ошибке уйти в пустоту */
export function useAction() {
  const toast = useToast();
  const { ut } = useLang();
  const [busy, setBusy] = useState(false);
  /*
   * Пока действие в полёте, второе не начинается.
   *
   * Иначе «Сохранить черновиком» и сразу «Подписать» уходили на сервер
   * одновременно с одной и той же базовой версией: второй запрос падал на
   * проверке параллельных правок, и подпись молча не ставилась. Флаг живёт
   * в ref, а не только в состоянии, потому что решение принимается в момент
   * клика, до перерисовки.
   */
  const inFlight = useRef(false);

  /*
   * Действие, вернувшее ложь, считается несделанным.
   *
   * Раньше любой штатный возврат означал успех — и подтверждение
   * показывалось даже тогда, когда действие не состоялось. Так и выходило:
   * человек нажимал «удалить», отказывался в системном окне, и ему
   * сообщали «группа удалена». Группа при этом оставалась на месте.
   *
   * Вопрос лучше задавать ДО run — тогда обманывать нечему. Но там, где он
   * должен быть внутри, у действия теперь есть способ сказать «я ничего не
   * сделал»: вернуть false.
   */
  const run = useCallback(
    async (fn: () => Promise<unknown>, okText?: string) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      try {
        const outcome = await fn();
        if (outcome === false) return false;
        if (okText) toast(okText, "ok");
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : ut("ui.actionFailed"), "err");
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [toast, ut],
  );

  return { run, busy };
}
