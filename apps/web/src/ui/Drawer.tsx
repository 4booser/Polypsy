import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { cx } from "./cx";
import { isTopLayer, useFocusTrap } from "./focus";
import { Ic } from "./icons";
import { IconTile, type PanelTone } from "./layout";
import { useToast } from "./toast";
import { Tooltip } from "./Popover";
import { useLang } from "../lang";

/*
 * Ящик действий (.drawer набора): плавающая панель справа, 440 (широкая —
 * 520), левые углы 18, тень. Разбор, ответ, перенос, назначение, заключение,
 * правка строки открываются здесь — страница остаётся на месте.
 *
 * Черновик не теряется. Ящик не размонтируется при закрытии: он уезжает за
 * край и становится inert, а содержимое — и всё, что человек набрал, — живёт
 * дальше. Закрытие (Esc, подложка, крестик) с несохранённым вводом говорит
 * «Чернетку … збережено» и даёт «Повернутися». Сам ящик знает о вводе только
 * то, что ему сказали: `dirty` ставит экран, у которого состояние формы.
 *
 * Модальный по умолчанию: подложка, фокус заперт (useFocusTrap, общий со
 * всеми слоями), при закрытии фокус возвращается тому, кто открыл.
 * `modal={false}` — боковая панель без подложки и ловушки (просмотр рядом с
 * таблицей), Esc закрывает её так же.
 */

export interface DrawerPaneProps {
  /** Имя вида: по нему Drawer выбирает, какой показать */
  mode?: string;
  title: ReactNode;
  /** Подпись под заголовком: «Мельник Андрій, PHQ-9 від 08.10, 14:12» */
  sub?: ReactNode;
  /** Значок в квадрате 40 */
  icon?: ReactNode;
  tone?: PanelTone;
  /** Под заголовком: таймер разбора, полоса состояния */
  headerExtra?: ReactNode;
  /** Кнопки внизу; основная — первой */
  footer?: ReactNode;
  /** Строка над кнопками: что сделает сохранение («Відкриє підпис № 0451») */
  note?: ReactNode;
  noteIcon?: ReactNode;
  /** Своя строка состояния справа: «чернетку збережено, 16:58» */
  saved?: ReactNode;
  /** Есть несохранённый ввод: закрытие скажет, что черновик сохранён */
  dirty?: boolean;
  /** Родительный падеж для сообщения: «розбору сигналу № 214» */
  draftName?: string;
  /** Клавиша, которой вид открывается снова, — на «Повернутися» */
  kbd?: string;
  children?: ReactNode;
  /** Скрыт (неактивный вид) — ставит сам Drawer */
  hidden?: boolean;
  /** Закрыть — ставит сам Drawer */
  onRequestClose?: () => void;
}

/**
 * Один вид ящика: шапка, прокручиваемое тело, липкий подвал.
 * Внутри Drawer; отдельно не рисуется.
 */
export function DrawerPane({
  title,
  sub,
  icon,
  tone = "violet",
  headerExtra,
  footer,
  note,
  noteIcon,
  saved,
  dirty,
  children,
  hidden,
  onRequestClose,
  mode,
}: DrawerPaneProps) {
  const { ut } = useLang();
  const status = saved ?? (dirty ? ut("kit.draftNote") : null);
  return (
    <section data-pane={mode} hidden={hidden} className={cx("flex h-full min-h-0 flex-col", hidden && "hidden")}>
      <header className="shrink-0 border-b border-divider py-3.5 pl-[18px] pr-3">
        <div className="flex items-center gap-3">
          {icon ? <IconTile icon={icon} tone={tone} size={40} /> : null}
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-[18px] font-extrabold leading-6 tracking-[-0.02em] text-text">{title}</h2>
            {sub ? <span className="block truncate text-small text-muted">{sub}</span> : null}
          </div>
          <Tooltip label={ut("kit.closeKeep")} kbd="Esc" side="bottom" align="end">
            <button
              type="button"
              data-drawer-close
              onClick={onRequestClose}
              aria-label={ut("ui.closePanel")}
              className="inline-grid size-9 min-h-0 shrink-0 cursor-pointer place-items-center rounded-control border-0 bg-sunk p-0 text-text-2 hover:bg-sunk-2 hover:text-text"
            >
              <Ic.x size={17} />
            </button>
          </Tooltip>
        </div>
        {headerExtra ? <div className="mt-3">{headerExtra}</div> : null}
      </header>
      <div className="kit-scroll min-h-0 flex-1 overflow-y-auto pb-2.5 pl-[18px] pr-4">{children}</div>
      {footer || note || status ? (
        <footer className="shrink-0 border-t border-divider bg-panel pb-4 pl-[18px] pr-4 pt-2.5">
          {note || status ? (
            <div className="mb-2.5 flex min-h-[18px] items-center gap-2.5">
              {note ? (
                <span className="flex min-w-0 items-center gap-1.5 text-small font-semibold text-text-2">
                  <span className="inline-flex shrink-0 text-violet-ink [&>svg]:size-[14px]">{noteIcon ?? <Ic.lockOpen />}</span>
                  <span className="truncate">{note}</span>
                </span>
              ) : null}
              {status ? (
                <span data-saved className="ml-auto inline-flex items-center gap-[5px] whitespace-nowrap text-caption text-muted">
                  <Ic.cloudCheck size={13} className="text-good" />
                  {status}
                </span>
              ) : null}
            </div>
          ) : null}
          {footer ? <div className="flex flex-wrap gap-2">{footer}</div> : null}
        </footer>
      ) : null}
    </section>
  );
}

/** Раздел тела ящика (.ds): линия сверху, заголовок 15/800, подпись и правая часть */
export function DrawerSection({
  title,
  sub,
  right,
  tag,
  children,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  /** Пилюля сразу за заголовком */
  tag?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="border-t border-divider py-[18px] first:border-t-0">
      {title ? (
        <div className="mb-2.5 flex items-center gap-2">
          <h3 className="m-0 whitespace-nowrap text-h3 font-extrabold text-text">{title}</h3>
          {tag}
          {sub ? <span className="min-w-0 truncate text-small text-muted">{sub}</span> : null}
          {right ? <span className="ml-auto">{right}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

type PaneElement = ReactElement<DrawerPaneProps>;

function panesOf(children: ReactNode): PaneElement[] {
  return Children.toArray(children).filter(
    (c): c is PaneElement => isValidElement(c) && (c.type as unknown) === DrawerPane,
  );
}

/** Какой вид показать: названный `mode`, иначе первый */
export function activePane(modes: (string | undefined)[], mode?: string): number {
  if (mode !== undefined) {
    const at = modes.indexOf(mode);
    if (at >= 0) return at;
  }
  return 0;
}

/** Текст сообщения о сохранённом черновике */
export function draftToastText(template: { of: string; plain: string }, name?: string): string {
  return name ? template.of.replace("{name}", name) : template.plain;
}

/**
 * Ящик.
 *
 * Один вид — свойствами прямо на Drawer (title, footer, dirty…) и телом в
 * children. Несколько видов — детьми DrawerPane с `mode`; показывается
 * названный `mode`, остальные остаются смонтированными (у каждого свой
 * черновик).
 *
 * ```tsx
 * <Drawer open={open} onClose={() => setOpen(false)} onReturn={() => setOpen(true)}
 *   title="Розбір сигналу № 214" icon={<Ic.alert />} tone="risk"
 *   dirty={note !== ""} draftName="розбору сигналу № 214" kbd="R"
 *   footer={<Button variant="primary">Зберегти розбір</Button>}>
 *   <DrawerSection title="Рішення">…</DrawerSection>
 * </Drawer>
 * ```
 */
export function Drawer({
  open,
  onClose,
  onReturn,
  mode,
  wide,
  modal = true,
  label,
  children,
  ...single
}: {
  open: boolean;
  /** Закрыть: Esc, подложка, крестик. Черновик экран не трогает — он остаётся */
  onClose: () => void;
  /** «Повернутися» в сообщении о черновике: открыть ящик снова на том же виде */
  onReturn?: (mode?: string) => void;
  /** Какой вид показать, если видов несколько */
  mode?: string;
  /** 520 вместо 440 */
  wide?: boolean;
  /** false — без подложки и ловушки фокуса (просмотр рядом со списком) */
  modal?: boolean;
  /** Имя слоя для диктора; по умолчанию — заголовок вида */
  label?: string;
  children?: ReactNode;
} & Partial<Omit<DrawerPaneProps, "hidden" | "onRequestClose" | "children" | "mode">>) {
  const { ut } = useLang();
  const toast = useToast();
  const trapped = useFocusTrap<HTMLElement>(open && modal);
  const box = trapped;
  const opener = useRef<HTMLElement | null>(null);

  const panes: PaneElement[] = single.title !== undefined ? [] : panesOf(children);
  const at = activePane(
    panes.map((p) => p.props.mode),
    mode,
  );
  const current: DrawerPaneProps | undefined =
    single.title !== undefined ? (single as DrawerPaneProps) : panes[at]?.props;
  const currentMode = single.title !== undefined ? mode : panes[at]?.props.mode;

  /* кто открыл немодальный ящик — ему вернуть фокус (модальному возвращает ловушка) */
  if (open && !modal && !opener.current) opener.current = document.activeElement as HTMLElement | null;

  const requestClose = useCallback(() => {
    if (current?.dirty) {
      toast(draftToastText({ of: ut("kit.draftSavedOf"), plain: ut("kit.draftSaved") }, current.draftName), "info", {
        icon: <Ic.cloudCheck />,
        action: onReturn ? { label: ut("kit.return"), kbd: current.kbd, onClick: () => onReturn(currentMode) } : undefined,
      });
    }
    /* фокус уходит из ящика до того, как тот станет inert: иначе он повиснет на невидимом поле */
    if (box.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    onClose();
    if (!modal) {
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    }
  }, [current?.dirty, current?.draftName, current?.kbd, currentMode, onClose, onReturn, toast, ut, modal, box]);

  /* Esc — верхнему слою: ящик под окном или палитрой не закрывается вместе с ними */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (modal ? !isTopLayer(box) : !isTopLayer({ current: null })) return;
      requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, modal, requestClose, box]);

  /* при открытии — фокус на [data-autofocus] вида или на крестик, как в наборе */
  useLayoutEffect(() => {
    if (!open) return;
    const root = box.current;
    if (!root || root.contains(document.activeElement)) return;
    const pane = root.querySelector<HTMLElement>("section[data-pane]:not([hidden])") ?? root;
    const target = pane.querySelector<HTMLElement>("[data-autofocus]") ?? pane.querySelector<HTMLElement>("[data-drawer-close]");
    target?.focus({ preventScroll: true });
  }, [open, at, box]);

  const name = label ?? (typeof current?.title === "string" ? current.title : undefined);

  return (
    <>
      {open && modal ? (
        <div aria-hidden onClick={requestClose} className="fixed inset-0 z-[34] bg-scrim/60 animate-[kit-fade_var(--dur)_var(--ease)]" />
      ) : null}
      <aside
        ref={box}
        role={modal ? "dialog" : "complementary"}
        aria-modal={modal && open ? true : undefined}
        aria-label={name}
        aria-hidden={open ? undefined : true}
        inert={!open}
        tabIndex={-1}
        data-drawer
        data-open={open ? "true" : "false"}
        className={cx(
          "fixed bottom-2.5 right-0 top-[calc(var(--ah,56px)+10px)] z-[35] flex max-w-[calc(100vw-16px)] flex-col overflow-hidden outline-none",
          "rounded-l-drawer border border-r-0 border-border bg-panel shadow-drawer",
          "transition-[transform,visibility] duration-[var(--dur-slow)] ease-[var(--ease)]",
          wide ? "w-[520px]" : "w-[440px]",
          open ? "visible translate-x-0" : "invisible translate-x-[104%]",
        )}
      >
        {single.title !== undefined ? (
          <DrawerPane {...(single as DrawerPaneProps)} mode={mode} onRequestClose={requestClose}>
            {children}
          </DrawerPane>
        ) : (
          panes.map((p, i) => (
            <DrawerPane key={p.key ?? p.props.mode ?? i} {...p.props} hidden={i !== at} onRequestClose={requestClose} />
          ))
        )}
      </aside>
    </>
  );
}
