import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { UiKey } from "@quizzy/shared";
import { Link, useNavigate } from "react-router-dom";
import { Sparkline } from "../../charts/clinical";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { DataTable, Kbd, Tooltip, useToast, type Column } from "../../ui";
import { cx } from "../../ui/cx";
import { Page } from "../../ui/layout";
import { Button, Input } from "../../ui/primitives";
import { type Resource, useResource } from "../../useResource";
import { fill } from "../dashboard/model";
import { OpsIcon, type OpsIconName } from "./icons";
import { clock, hhmm, shortId } from "./model";
import { parseRequestId } from "./obs2a/model";

/**
 * Общие части техпанели в «Виразній» (Polypsy 2.0): рамка экрана со
 * слотами шапки, опрос с отметкой времени, «наживо», поле «номер → траса»,
 * ссылка на вид, статус значком и словом, метод и код HTTP, маршрут
 * шаблоном, таблица «Показники» и таблица-сетка.
 *
 * Разделы «Система» и «Експлуатація» (участок v2-ops-system) и «Люди й
 * безпека» (v2-ops-people) берут отсюда одно и то же: экспорт не меняется,
 * добавляется.
 */

/* ─────────── рамка экрана: слоты шапки ─────────── */

/*
 * Шапку экрана техпанели рисует её рамка (index.tsx): заголовок — имя
 * раздела из реестра. Но у каждого раздела своя мета-строка («1 842 запити
 * за годину»), свои действия (номер → траса, ссылка на вид) и своя полоса
 * инструментов (период, фильтры, «наживо»). Раздел отдаёт их через
 * <OpsHead>, а рамка ставит на место порталом: Page остаётся одна, и
 * разделы, которые шапку не трогают, выглядят как прежде.
 *
 * Порталом, а не состоянием рамки: в состояние пришлось бы класть
 * разметку, а она новая на каждой отрисовке раздела — рамка перерисовывала
 * бы раздел, раздел снова отдавал бы шапку, и так по кругу. Рамка знает
 * только «слот занят» (число), разметка живёт у раздела.
 */
type Slot = "meta" | "actions" | "toolbar";

/** Заголовок и «назад» раздела без пункта в колонке (трасса запроса): строки, а не разметка */
interface HeadTitle {
  title: string;
  back?: { to: string; label: string };
}

interface HeadSlots {
  el: Record<Slot, HTMLElement | null>;
  claim: (slot: Slot, on: boolean) => void;
  setTitle: (t: HeadTitle | null) => void;
}

const HeadCtx = createContext<HeadSlots | null>(null);

/** Рамка раздела техпанели: Page с заголовком и слотами для <OpsHead> */
export function OpsFrame({ title, back, children }: { title: ReactNode; back?: { to: string; label: string }; children: ReactNode }) {
  const [busy, setBusy] = useState<Record<Slot, number>>({ meta: 0, actions: 0, toolbar: 0 });
  const [el, setEl] = useState<Record<Slot, HTMLElement | null>>({ meta: null, actions: null, toolbar: null });
  const [own, setOwn] = useState<HeadTitle | null>(null);
  const setTitle = useCallback((t: HeadTitle | null) => {
    setOwn((cur) => (cur?.title === t?.title && cur?.back?.to === t?.back?.to && cur?.back?.label === t?.back?.label ? cur : t));
  }, []);
  const claim = useCallback((slot: Slot, on: boolean) => {
    setBusy((b) => ({ ...b, [slot]: Math.max(0, b[slot] + (on ? 1 : -1)) }));
  }, []);
  const refs = useMemo(() => {
    const make = (slot: Slot) => (node: HTMLElement | null) => setEl((cur) => (cur[slot] === node ? cur : { ...cur, [slot]: node }));
    return { meta: make("meta"), actions: make("actions"), toolbar: make("toolbar") };
  }, []);
  const value = useMemo(() => ({ el, claim, setTitle }), [el, claim, setTitle]);
  return (
    <HeadCtx.Provider value={value}>
      <Page
        title={own?.title ?? title}
        back={own?.back ?? back}
        meta={busy.meta ? <span ref={refs.meta} className="contents" /> : undefined}
        actions={busy.actions ? <span ref={refs.actions} className="contents" /> : undefined}
        toolbar={busy.toolbar ? <div ref={refs.toolbar} className="min-w-0" /> : undefined}
      >
        {children}
      </Page>
    </HeadCtx.Provider>
  );
}

function useSlot(ctx: HeadSlots | null, slot: Slot, on: boolean) {
  useLayoutEffect(() => {
    if (!ctx || !on) return;
    ctx.claim(slot, true);
    return () => ctx.claim(slot, false);
  }, [ctx?.claim, slot, on]);
}

/**
 * Шапка раздела: мета-строка (жирная строка и обычная), действия справа,
 * полоса инструментов под заголовком. Вне рамки (тест рисует раздел сам по
 * себе) — те же части прямо в потоке.
 */
export function OpsHead({
  title,
  back,
  meta,
  actions,
  toolbar,
}: {
  /** Своё имя экрана — у страницы без пункта в колонке (трасса); иначе имя раздела */
  title?: string;
  back?: { to: string; label: string };
  meta?: [ReactNode, ReactNode] | null;
  actions?: ReactNode;
  toolbar?: ReactNode;
}) {
  const ctx = useContext(HeadCtx);
  const setTitle = ctx?.setTitle;
  const backTo = back?.to;
  const backLabel = back?.label;
  useLayoutEffect(() => {
    if (!setTitle || !title) return;
    setTitle({ title, back: backTo && backLabel ? { to: backTo, label: backLabel } : undefined });
    return () => setTitle(null);
  }, [setTitle, title, backTo, backLabel]);
  const hasMeta = !!meta;
  const hasActions = actions !== undefined && actions !== null && actions !== false;
  const hasToolbar = toolbar !== undefined && toolbar !== null && toolbar !== false;
  useSlot(ctx, "meta", hasMeta);
  useSlot(ctx, "actions", hasActions);
  useSlot(ctx, "toolbar", hasToolbar);
  const metaNode = meta ? (
    <>
      <b className="font-extrabold text-text">{meta[0]}</b>
      <span>{meta[1]}</span>
    </>
  ) : null;
  if (!ctx) {
    return (
      <div className="mb-3 flex flex-col gap-2">
        {metaNode ? <div className="flex flex-col text-[13px] leading-[18px] text-text-2">{metaNode}</div> : null}
        {hasActions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        {hasToolbar ? toolbar : null}
      </div>
    );
  }
  return (
    <>
      {metaNode && ctx.el.meta ? createPortal(metaNode, ctx.el.meta) : null}
      {hasActions && ctx.el.actions ? createPortal(actions, ctx.el.actions) : null}
      {hasToolbar && ctx.el.toolbar ? createPortal(toolbar, ctx.el.toolbar) : null}
    </>
  );
}

/**
 * Полоса инструментов под шапкой (.fbar набора): слева — период, поиск,
 * фильтры; справа — «наживо» или строка о периоде истории.
 */
export function OpsToolbar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {children}
      {right ? <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{right}</div> : null}
    </div>
  );
}

/* ─────────── опрос ─────────── */

/**
 * Опрос раз в `pollMs` и момент последнего пришедшего ответа.
 *
 * Сам опрос — в useResource: он же не опрашивает скрытую вкладку браузера и
 * гасит таймер, когда вкладку панели закрыли (компонент размонтирован), —
 * то есть «ушёл со вкладки — опрос встал» выполняется устройством, а не
 * памятью автора экрана.
 */
export function useOpsResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  pollMs: number,
): Resource<T> {
  const res = useResource(load, deps, { pollMs });
  /*
   * Момент ответа — от слоя загрузки (волна 13), а не по смене data: ответ,
   * совпавший с прежним, данные не меняет, и «оновлено о …» стояло бы на
   * месте, хотя опрос шёл. Пока грузится новый период, остаётся прежний
   * момент — как и было.
   */
  const last = useRef<number | null>(null);
  if (res.updatedAt !== null) last.current = res.updatedAt;
  return { ...res, updatedAt: last.current };
}

/**
 * «Наживо, кожні 20 с | оновлено о 16:59:48» (.live набора): зелёная точка —
 * опрос идёт. `paused` — лента остановлена человеком: точка янтарём и
 * «Стрічку зупинено о …».
 */
export function Live({ pollSec, updatedAt, paused }: { pollSec: number; updatedAt: number | null; paused?: boolean }) {
  const { ut } = useLang();
  const loc = locale();
  const at = updatedAt === null ? null : clock(updatedAt, loc);
  return (
    <span role="status" className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap text-small leading-4 text-muted">
      <i
        aria-hidden
        className={cx(
          "size-2 shrink-0 rounded-full",
          paused ? "bg-warn shadow-[0_0_0_3px_var(--warntint)]" : "bg-good shadow-[0_0_0_3px_var(--goodtint)]",
        )}
      />
      {paused ? (
        <>
          <b className="font-bold text-warn">{ut("opx.live.paused")}</b>
          {at ? fill(ut("opx.live.at"), { time: at }) : null}
        </>
      ) : (
        <>
          {fill(ut("opx.live.every"), { n: pollSec })}
          {at ? (
            <>
              <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
              {fill(ut("ops.updated"), { time: at })}
            </>
          ) : null}
        </>
      )}
    </span>
  );
}

/**
 * «Дані з моменту запуску процесу…» и «оновлено о …».
 *
 * Первая половина обязательна на каждой вкладке с памятью процесса: пустые
 * ошибки и тихий график после перезапуска выглядят как «всё хорошо», хотя
 * значат «ничего не помню». `since` не передан — у вкладки нет памяти
 * процесса (база отвечает о своём состоянии сейчас), и сказано это другими
 * словами.
 */
export function Stamp({ since, updatedAt, note }: { since?: string; updatedAt: number | null; note?: ReactNode }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-small text-muted">
      <span className="min-w-0">{since ? fill(ut("ops.since"), { time: sinceText(since, loc) }) : note}</span>
      {updatedAt !== null ? (
        <span role="status" className="shrink-0 tabular-nums">
          {fill(ut("ops.updated"), { time: clock(updatedAt, loc) })}
        </span>
      ) : null}
    </div>
  );
}

/** Момент запуска процесса коротко: «06.10, 21:41» */
export function sinceText(since: string, loc: string): string {
  const d = new Date(since);
  return `${d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit" })}, ${hhmm(since, loc)}`;
}

/**
 * Строка под панелью (.pf набора): значок и приглушённое пояснение —
 * «Дані з моменту запуску процесу…», «Про ключі й токени — лише «задано /
 * не задано»». Для `Panel footer`.
 */
export function PanelNote({ icon = "info", children }: { icon?: OpsIconName; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-caption leading-4 text-muted">
      <OpsIcon name={icon} size={13} className="mt-px" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** Пояснение процесса для подвала панели: «Дані з моменту запуску процесу — 06.10, 21:41; …» */
export function SinceNote({ since }: { since: string }) {
  const { ut } = useLang();
  return <PanelNote>{fill(ut("opx.sinceNote"), { time: sinceText(since, locale()) })}</PanelNote>;
}

/**
 * Фильтр-переключатель полосы инструментов («Лише нові», «Лише з 5xx»):
 * нажат — фильтр стоит (тонированный, с галочкой), повторное нажатие
 * снимает. Кнопка с aria-pressed, а не чип с меню: значений у него два.
 */
export function FilterToggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cx(
        "inline-flex h-9 min-h-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[18px] border-0 px-3 text-small font-semibold leading-none",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        on ? "bg-violet-tint text-violet-ink hover:bg-violet-tint-2" : "bg-sunk text-text-2 hover:bg-sunk-2",
      )}
    >
      {on ? <OpsIcon name="check" size={14} /> : null}
      {label}
    </button>
  );
}

/* ─────────── число со словом ─────────── */

/** Три формы слова при числе — ключи `.one` / `.few` / `.many`, как print.age.* */
export type CountKeys = readonly [UiKey, UiKey, UiKey];

/**
 * «1 842 запити», «64 маршрути»: форма — по правилу числа языка
 * (Intl.PluralRules). У английского форм две: «one» и «other» — вторая
 * берётся из `.many`.
 */
export function useCount() {
  const { ut, lang } = useLang();
  const loc = locale();
  return useCallback(
    (keys: CountKeys, n: number, vars?: Record<string, string | number>) => {
      const cat = new Intl.PluralRules(lang).select(n);
      const key = cat === "one" ? keys[0] : cat === "few" ? keys[1] : keys[2];
      return fill(ut(key), { n: new Intl.NumberFormat(loc).format(n), ...vars });
    },
    [ut, lang, loc],
  );
}

/**
 * Шаблон словаря с разметкой на месте подстановок: «востаннє {time}» с
 * жирным временем. Подстановки без разметки — как у fill.
 */
export function fillNode(template: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/(\{[a-zA-Z0-9_]+\})/);
  return parts.map((part, i) => {
    const m = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
    if (!m) return part;
    const v = vars[m[1]!];
    return v === undefined ? part : <span key={i}>{v}</span>;
  });
}

/* ─────────── действия шапки ─────────── */

/**
 * Поле «номер запиту → траса» (.tbox набора). Отдельной формой, а не
 * фильтром ленты: номер из экрана ошибки у человека — это вопрос «что
 * случилось с этим обращением», и ответ на него — трасса целиком.
 */
export function TraceBox({ wide, initial = "", className }: { wide?: boolean; initial?: string; className?: string }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  const [bad, setBad] = useState(false);
  return (
    <form
      role="search"
      aria-label={ut("ops.trace.search")}
      className={cx("relative max-[700px]:w-full", className)}
      onSubmit={(e) => {
        e.preventDefault();
        const id = parseRequestId(value);
        setBad(!id);
        if (id) navigate(`/ops/trace/${encodeURIComponent(id)}`);
      }}
    >
      <Input
        aria-label={ut("ops.trace.search")}
        aria-invalid={bad || undefined}
        placeholder={ut("ops.trace.search")}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setBad(false);
        }}
        icon={<OpsIcon name="route" size={15} />}
        suffix={<Kbd>↵</Kbd>}
        className={cx(
          wide ? "w-[370px]" : "w-[260px]",
          "max-[700px]:w-full [&_input]:font-mono [&_input]:text-[12.5px] [&_input::placeholder]:font-sans [&_input::placeholder]:text-[13px]",
        )}
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
      />
      {bad ? (
        <span role="alert" className="absolute left-0 top-full z-[2] mt-1 whitespace-nowrap text-caption font-semibold text-risk-ink">
          {ut("ops.trace.badId")}
        </span>
      ) : null}
    </form>
  );
}

/** Скопировать адрес текущего вида: период, фильтры, порядок — в адресе */
export function CopyLinkButton() {
  const { ut } = useLang();
  const toast = useToast();
  const label = ut("opx.copyLink");
  return (
    <Tooltip label={label}>
      <Button
        size="icon"
        aria-label={label}
        icon={<OpsIcon name="link" />}
        onClick={() => {
          void navigator.clipboard?.writeText(window.location.href).then(
            () => toast(ut("opx.linkCopied"), "ok"),
            () => toast(ut("ops.copyFailed"), "err"),
          );
        }}
      />
    </Tooltip>
  );
}

/** «Оновити зараз»: перечитать без ожидания такта опроса */
export function RefreshButton({ onRefresh, busy }: { onRefresh: () => void; busy?: boolean }) {
  const { ut } = useLang();
  const label = ut("opx.refresh");
  return (
    <Tooltip label={label}>
      <Button size="icon" aria-label={label} icon={<OpsIcon name="refresh-cw" />} onClick={onRefresh} disabled={busy} />
    </Tooltip>
  );
}

/** Обычные действия шапки раздела: номер → траса и ссылка на вид */
export function HeadActions({ children }: { children?: ReactNode }) {
  return (
    <>
      <TraceBox />
      <CopyLinkButton />
      {children}
    </>
  );
}

/* ─────────── номер запроса ─────────── */

/**
 * Номер запроса: укороченный на экране, целиком — в подсказке и в буфере обмена.
 *
 * Ведёт в трассу запроса (/ops/trace/:id), а не в ленту с фильтром: трасса
 * — это те же строки лога плюс итог, ошибка, журнал и SQL, то есть всё,
 * ради чего номер нажимают.
 */
export function RequestId({ id, linked = true }: { id: string | null; linked?: boolean }) {
  const { ut } = useLang();
  const toast = useToast();
  if (!id) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {linked ? (
        <Link
          to={`/ops/trace/${encodeURIComponent(id)}`}
          title={`${id} — ${ut("ops.trace.open")}`}
          className="truncate font-mono text-[12px] font-semibold text-violet-ink no-underline hover:underline"
        >
          {shortId(id)}…
        </Link>
      ) : (
        <span title={id} className="truncate font-mono text-[12px] text-text-2">
          {shortId(id)}…
        </span>
      )}
      <button
        type="button"
        aria-label={ut("ops.copyId")}
        title={ut("ops.copyId")}
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(
            () => toast(ut("ops.idCopied"), "ok"),
            () => toast(ut("ops.copyFailed"), "err"),
          );
        }}
        className={cx(
          "relative inline-grid size-7 min-h-0 shrink-0 cursor-pointer place-items-center rounded-[8px] border-0 bg-transparent p-0 text-muted",
          "hover:bg-sunk hover:text-text",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
        )}
      >
        <OpsIcon name="copy" size={14} />
      </button>
    </span>
  );
}

/* ─────────── статус ─────────── */

/**
 * Тон статуса: `ok` — гаразд, `warn` — попередження, `fail` — збій (янтарём
 * и жирно: красный в консоли — только риск для человека), `quiet` — вимкнено
 * или нічого, `info` — справка, `run` — іде зараз, `unk` — невідомо.
 */
export type Tone = "ok" | "warn" | "fail" | "quiet" | "info" | "run" | "unk";

const STATUS_ICON: Record<Tone, OpsIconName> = {
  ok: "circle-check",
  warn: "triangle-alert",
  fail: "octagon-x",
  quiet: "circle-minus",
  info: "info",
  run: "loader-circle",
  unk: "circle-dashed",
};

const STATUS_INK: Record<Tone, string> = {
  ok: "text-good",
  warn: "text-warn",
  fail: "font-extrabold text-warn",
  quiet: "text-muted",
  info: "text-info",
  run: "text-violet-ink",
  unk: "text-muted",
};

/** Статус словом и формой значка (.sm набора): цвет никогда не единственный признак */
export function StatusMark({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold leading-[18px]", STATUS_INK[tone], className)}>
      <OpsIcon name={STATUS_ICON[tone]} size={15} />
      {children}
    </span>
  );
}

/* ─────────── код, маршрут, метод ─────────── */

/** Код и данные моноширинно (.mono набора): маршрут, коммит, имя таблицы */
export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("font-mono text-[12px] font-medium leading-[18px] tracking-normal", className)}>
      {children}
    </span>
  );
}

/** Маршрут шаблоном: параметры («:id») приглушены — видно, где адрес, а где подстановка */
export function RoutePath({ route, className }: { route: string; className?: string }) {
  const parts = route.split("/");
  return (
    <Mono className={cx("min-w-0 truncate", className)} title={route}>
      {parts.map((p, i) => (
        <span key={i}>
          {i ? "/" : ""}
          {p.startsWith(":") || p.startsWith("[") ? <span className="text-muted">{p}</span> : p}
        </span>
      ))}
    </Mono>
  );
}

const METHOD_TONE: Record<string, string> = {
  POST: "bg-info-tint text-info",
  PUT: "bg-violet-tint text-violet-ink",
  PATCH: "bg-violet-tint text-violet-ink",
  DELETE: "bg-warn-tint-2 text-warn",
};

/** Метод HTTP пилюлей (.mth набора) */
export function Method({ m }: { m: string }) {
  const up = m.toUpperCase();
  return (
    <span
      className={cx(
        "inline-grid h-5 w-[50px] shrink-0 place-items-center rounded-[6px] font-mono text-[10.5px] font-bold leading-none",
        METHOD_TONE[up] ?? "bg-sunk text-text-2",
      )}
    >
      {up}
    </span>
  );
}

/** Метод и маршрут строкой (.mr набора) */
export function MethodRoute({ method, route, className }: { method: string | null; route: string | null; className?: string }) {
  return (
    <span className={cx("flex min-w-0 items-center gap-2", className)}>
      {method ? <Method m={method} /> : null}
      {route ? <RoutePath route={route} /> : <span className="text-muted">—</span>}
    </span>
  );
}

/** Код ответа HTTP (.hcode набора): 2xx зелёным, 5xx янтарём, прочее нейтрально */
export function HttpCode({ code }: { code: number | null }) {
  if (code === null) return <span className="text-muted">—</span>;
  return (
    <span
      className={cx(
        "inline-grid h-5 min-w-[38px] shrink-0 place-items-center rounded-[6px] px-1.5 font-mono text-[11px] font-bold leading-none",
        code < 300 ? "bg-good-tint text-good" : code >= 500 ? "bg-warn-tint-2 text-warn" : "bg-sunk text-text-2",
      )}
    >
      {code}
    </span>
  );
}

/* ─────────── «Показники» ─────────── */

export interface MetricRow {
  key: string;
  /** Что за число: «Запитів за годину» */
  label: ReactNode;
  /** Число сейчас, уже в своей единице: «1 842», «312 мс» */
  now: ReactNode;
  /** Ход числа рядом с ним — только когда он объясняет число */
  spark?: readonly number[];
  /** Янтарный ход — величина, которая требует внимания */
  sparkTone?: "plain" | "attention";
  /** С чем сравнить: «за 5 хв — 164, за добу — 21 460» */
  compare: ReactNode;
  /** Что это значит: статус словом или прежнее значение */
  state: ReactNode;
}

/**
 * Таблица «Показники» (вместо плиток KPI): у каждого числа — сравнение и
 * состояние словом. Колонки «Показник — Зараз — Для порівняння — Стан».
 */
export function MetricsTable({ rows, label }: { rows: readonly MetricRow[]; label: string }) {
  const { ut } = useLang();
  const columns: Column<MetricRow>[] = [
    { key: "label", header: ut("opx.col.metric"), width: 210, required: true, render: (r) => <b className="font-bold">{r.label}</b> },
    {
      key: "now",
      header: ut("opx.col.now"),
      width: 210,
      required: true,
      render: (r) => (
        <span className="flex items-center gap-2.5">
          <b className="whitespace-nowrap text-[15px] font-extrabold leading-none tabular-nums">{r.now}</b>
          {r.spark && r.spark.length > 1 ? (
            <Sparkline values={r.spark} width={64} height={22} color={r.sparkTone === "attention" ? "var(--warn)" : undefined} />
          ) : null}
        </span>
      ),
    },
    { key: "compare", header: ut("opx.col.compare"), required: true, render: (r) => <span className="text-text-2">{r.compare}</span> },
    { key: "state", header: ut("opx.col.state"), width: 280, required: true, render: (r) => r.state },
  ];
  return <DataTable rows={[...rows]} columns={columns} rowKey={(r) => r.key} dense sticky={false} label={label} />;
}

/** Прежнее значение для колонки «Стан»: «6 год тому — 1 510» — приглушённо */
export function Was({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

/* ─────────── таблица-сетка ─────────── */

/*
 * Таблица — сетка строк с ролями table/row/cell, а не <table>: голый <table>
 * подхватывает правила наследия (legacy.css — капитель заголовков, липкая
 * шапка, высота строки из токена плотности). Вид — как у .dtbl набора:
 * шапка 38 на подложке, строки через волосяную линию. Для сортировки,
 * отметки и действий строки — DataTable набора.
 */
export function GridTable({
  label,
  cols,
  minW,
  head,
  children,
}: {
  label: string;
  /** Литерал `grid-cols-[…]`: Tailwind собирает классы, читая исходник */
  cols: string;
  /** Литерал `min-w-[…]` — ниже этой ширины таблица прокручивается, а страница нет */
  minW: string;
  head: readonly ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <div role="table" aria-label={label} className={minW}>
        <div
          role="row"
          className={cx("grid h-[38px] items-center gap-x-4 border-y border-divider bg-panel-2 px-4", cols)}
        >
          {heads(head)}
        </div>
        {children}
      </div>
    </div>
  );
}

function heads(head: readonly ReactNode[]) {
  return head.map((x, i) => (
    <span key={i} role="columnheader" className="min-w-0 whitespace-nowrap text-caption font-bold leading-none text-muted">
      {x}
    </span>
  ));
}

export function GridRow({ cols, children, className }: { cols: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="row"
      className={cx(
        "grid min-h-11 items-center gap-x-4 border-b border-divider px-4 py-1.5 text-body leading-[19px] last:border-b-0",
        cols,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Cell({ children, num, className }: { children?: ReactNode; num?: boolean; className?: string }) {
  return (
    <span role="cell" className={cx("min-w-0", num && "text-right tabular-nums", className)}>
      {children}
    </span>
  );
}

/** Шапка числовой колонки — по правому краю, как сами числа */
export const NumHead = ({ children }: { children: ReactNode }) => <span className="block text-right">{children}</span>;

/** Подпись и значение столбцом (.kv набора): сборка, сведения о базе */
export function Facts({ items, w = 170 }: { items: readonly (readonly [ReactNode, ReactNode])[]; w?: 130 | 150 | 170 | 200 }) {
  const cols = {
    130: "grid-cols-[130px_minmax(0,1fr)]",
    150: "grid-cols-[150px_minmax(0,1fr)]",
    170: "grid-cols-[170px_minmax(0,1fr)]",
    200: "grid-cols-[200px_minmax(0,1fr)]",
  }[w];
  return (
    <dl className={cx("m-0 grid gap-x-3 gap-y-1.5 text-small leading-[18px] max-[600px]:grid-cols-1", cols)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="font-bold text-muted">{k}</dt>
          <dd className="m-0 min-w-0 text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Пусто — строкой, как у списков макета, а не плашкой */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="m-0 py-3 text-small text-muted">{children}</p>;
}
