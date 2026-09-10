import {
  createContext,
  useCallback,
  useRef,
  useEffect,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Resource } from "../useResource";
import {
  applyFacets,
  facetOptions,
  parseFacets,
  serializeFacets,
  toggleFacet,
  type Facet,
  type FacetSelection,
} from "./facets";
import { useLang } from "../lang";

/** Мелкие переиспользуемые части консоли: иконки, состояния, таблицы, сообщения */

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
export const IconAudit = icon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></>);
export const IconBattery = icon(<><rect x="2" y="7" width="16" height="10" rx="2" /><path d="M22 11v2" /><path d="M6 11v2M10 11v2" /></>);
export const IconClock = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconInvite = icon(<><path d="M4 4h16v12H5.2L4 17.2V4Z" /><path d="M8 20h12" /><path d="M9 9h6M9 12h4" /></>);
export const IconKiosk = icon(<><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M9 19h6" /></>);
export const IconPulse = icon(<><path d="M2 12h4l2-7 4 14 3-9 2 2h5" /></>);
export const IconRoute = icon(<><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="5" r="2.5" /><path d="M8.5 19h6a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7h6" /></>);
export const IconReferral = icon(<><path d="M4 12h11" /><path d="M12 6l6 6-6 6" /><path d="M20 4v16" /></>);
/* уголок раскрытия группы в рельсе: повёрнут вниз, когда группа открыта */
export const IconChevron = icon(<path d="M9 6l6 6-6 6" />);
/*
 * Значки действий и состояний.
 *
 * Заводятся здесь, а не в отдельном наборе и не картинками: обводка у всех
 * одна (24×24, штрих 1.8, скруглённые концы), и покупной растровый набор
 * выбивался бы из строя на первом же экране, где стоит рядом со своими.
 * Заодно значок наследует цвет текста и меняется вместе с темой — картинке
 * пришлось бы держать две версии.
 */
export const IconPlus = icon(<><path d="M12 5v14M5 12h14" /></>);
export const IconEdit = icon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>);
export const IconTrash = icon(<><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /><path d="M10 11v6M14 11v6" /></>);
export const IconSave = icon(<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></>);
export const IconSearchGlass = icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconFilter = icon(<><path d="M3 5h18l-7 8v6l-4 2v-8Z" /></>);
export const IconDownload = icon(<><path d="M12 3v12M7 11l5 5 5-5" /><path d="M4 20h16" /></>);
export const IconPrint = icon(<><path d="M7 8V3h10v5" /><rect x="4" y="8" width="16" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>);
export const IconLink = icon(<><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>);
export const IconWarn = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>);
export const IconInfo = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const IconOk = icon(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>);
export const IconLock = icon(<><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>);
export const IconEye = icon(<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>);
export const IconArchive = icon(<><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></>);
export const IconNote = icon(<><path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></>);
export const IconChart = icon(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>);
export const IconMessage = icon(<><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></>);

export const IconCompare = icon(<><path d="M3 20V10M9 20V4M15 20v-7M21 20V8" /></>);

/* ─────────── состояния ─────────── */

/**
 * Инициалы вместо портрета.
 *
 * Фотографий в системе нет и не будет — это лишние персональные данные ради
 * украшения. Инициалы в кружке решают ту же задачу: глаз цепляется за строку
 * в длинном списке однофамильцев. Цвет выводится из имени, поэтому у одного
 * человека он всегда один и тот же и запоминается.
 */
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "—";
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span
      aria-hidden
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        /*
         * Насыщенность и светлота подобраны перебором всех 360 тонов, а не
         * на глаз. Прежние 45 %/30 % давали в худшем случае (тон 60,
         * жёлтый) контраст 5,3:1 — достаточно, но кружки складывались в
         * радугу: в списке из пятидесяти строк пятьдесят насыщенных пятен
         * перетягивают внимание с данных, ради которых список и открыли.
         *
         * На 32 %/26 % кружок остаётся узнаваемым, но перестаёт спорить с
         * сигнальными цветами. Худший контраст инициалов — 6,13:1 (тон 60);
         * прежде здесь стояло 7,4:1 — число верное для прежнего цвета
         * текста и молча устаревшее вместе с ним.
         *
         * Обод в один пиксель добавлен, когда земля стала сине-фиолетовой:
         * холодные кружки (тон около 240) отличались от панели всего в
         * 1,18 раза и переставали читаться как кружки — оставались висеть
         * одни инициалы. Поднять светлоту нельзя, она уводит инициалы ниже
         * 4,5:1; край решает то же самое, ничего не отнимая.
         */
        background: `hsl(${hue} 32% 26%)`,
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent)",
      }}
    >
      {initials}
    </span>
  );
}

/**
 * Подтверждение необратимого действия перепечатыванием названия.
 *
 * Обычный confirm снимается не глядя — рука жмёт «ОК» раньше, чем глаз читает.
 * Требование напечатать название заставляет посмотреть, что именно удаляется;
 * это единственная защита, которую нельзя пройти на автомате.
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
    <div className="card danger-card">
      <div className="card-head">
        <h2>{title}</h2>
        <button className="ghost" onClick={onCancel}>{ut("ui.cancel")}</button>
      </div>
      <div>{warning}</div>
      <label className="field" style={{ marginTop: 10 }}>
        <span>
          {ut("ui.typeToConfirm")} «{name}»
        </span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </label>
      <button className="danger" disabled={typed.trim() !== name} onClick={onConfirm}>
        {actionLabel}
      </button>
    </div>
  );
}

/**
 * Скелет вместо строки «Загрузка…».
 *
 * Строка не говорит, чего ждать, и экран прыгает, когда данные приезжают.
 * Скелет держит место и показывает форму будущего содержимого — переход
 * получается без скачка.
 */
export function Skeleton({
  lines = 3,
  height = 14,
  width = "100%",
}: {
  lines?: number;
  height?: number;
  width?: string;
}) {
  return (
    <div className="skeleton-group" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          // последняя строка короче: так блок читается как текст, а не как таблица
          style={{ height, width: i === lines - 1 ? "62%" : width }}
        />
      ))}
    </div>
  );
}

/** Метка состояния: цвет несёт смысл, но не единственный — рядом всегда слово */
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  children: ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/**
 * Модальное окно.
 *
 * Esc закрывает, фокус уходит внутрь, фон не прокручивается. Без этого
 * диалог остаётся ловушкой для клавиатуры.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { ut } = useLang();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label={ut("bp.close")}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Кнопка «показать ещё» с честным состоянием и концом списка */
export function LoadMore({
  cursor,
  busy,
  onLoad,
  emptyText,
}: {
  cursor: string | null;
  busy?: boolean;
  onLoad: () => void;
  emptyText?: string;
}) {
  const { ut } = useLang();
  if (!cursor) return <p className="hint end-of-list">{emptyText ?? ut("ui.noMoreRecords")}</p>;
  return (
    <button className="load-more" disabled={busy} onClick={onLoad}>
      {busy ? ut("ui.loadingMore") : ut("ui.loadMore")}
    </button>
  );
}

/**
 * Состояние загрузки экрана: заголовок и карточка-скелет.
 *
 * Раньше на месте экрана стояла строка «Загрузка…»: она не говорит, чего
 * ждать, и содержимое приезжает рывком, сдвигая всё вниз. Скелет держит
 * место и показывает форму будущего экрана.
 *
 * Ошибка передаётся сюда же: «загружается» и «не загрузилось» — соседние
 * состояния одного места, и разводить их по разным веткам значит писать
 * обработку ошибки заново на каждом экране.
 */
/**
 * Полоса «нет связи».
 *
 * Отсутствие сети — не поломка экрана, и говорить о нём надо иначе: экран
 * держит последние данные, а сверху появляется полоса с повтором. Раньше
 * консоль показывала техническое «Failed to fetch» и обнуляла содержимое —
 * специалист в кабинете со слабым Wi-Fi видел то же, что при упавшем
 * сервере.
 */
export function OfflineBar({ onRetry, busy }: { onRetry: () => void; busy?: boolean }) {
  const { ut } = useLang();
  return (
    <div className="offline-bar" role="status">
      <i className="dot" />
      <span className="grow">{ut("ui.offline")}</span>
      <button className="ghost" onClick={onRetry} disabled={busy}>
        {busy ? ut("ui.retrying") : ut("common.retry")}
      </button>
    </div>
  );
}

/**
 * Три состояния загрузки в одном месте.
 *
 * Раньше каждый экран писал их сам — и писал по-разному: где-то обрыв связи
 * показывался как ошибка приложения, где-то экран навсегда оставался пустым,
 * где-то при обновлении данные исчезали и появлялись заново. Здесь порядок
 * один: пока данных нет — скелет; если связи нет, но данные уже были —
 * показываем их с полосой предупреждения, потому что устаревшие цифры
 * полезнее пустого экрана, если про их устарелость сказано.
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
    if (res.offline) {
      return (
        <>
          <OfflineBar onRetry={res.reload} busy={res.loading} />
          <Loading rows={rows} />
        </>
      );
    }
    return <Loading rows={rows} error={res.error} />;
  }
  return (
    <>
      {res.offline ? <OfflineBar onRetry={res.reload} busy={res.refreshing} /> : null}
      {res.error ? <p className="error">{res.error}</p> : null}
      {children(res.data)}
    </>
  );
}

export function Loading({ rows = 4, error }: { rows?: number; error?: string | null }) {
  if (error) {
    return (
      <div className="card">
        <p className="error" style={{ margin: 0 }}>{error}</p>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="skeleton" style={{ height: 20, width: "38%", marginBottom: 14 }} />
      <Skeleton lines={rows} />
    </div>
  );
}

/**
 * Пустое состояние.
 *
 * `compact` — для случая, когда пусто не на экране, а в одной его панели:
 * тогда это подробность, а не ответ на вопрос, с которым пришли.
 */
export function Empty({
  title,
  hint,
  action,
  compact,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "empty is-compact" : "empty"}>
      <strong>{title}</strong>
      {hint ? <div style={{ fontSize: 13, marginBottom: action ? 14 : 0 }}>{hint}</div> : null}
      {action}
    </div>
  );
}


/* ─────────── всплывающие сообщения ─────────── */

type Toast = { id: number; text: string; kind: "ok" | "err" | "info" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((v) => [...v, { id, text, kind }]);
    // сообщения исчезают сами: держать их до клика — навязчиво
    setTimeout(() => setItems((v) => v.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "ok" ? "ok" : t.kind === "err" ? "err" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

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

  const run = useCallback(
    async (fn: () => Promise<unknown>, okText?: string) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      try {
        await fn();
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

/* ─────────── сортируемая таблица ─────────── */

/**
 * Горячие клавиши экрана.
 *
 * Разбор трёхсот случаев мышью — это лишний час работы каждый день.
 * Клавиши не срабатывают, пока курсор в поле ввода: иначе набор комментария
 * «н» превращался бы в «не подтверждён».
 *
 * Сочетания с модификаторами тоже пропускаем: Cmd+K и Ctrl+F принадлежат
 * браузеру, и перехватывать их без крайней нужды — способ разозлить человека.
 */
export function useHotkeys(map: Record<string, () => void>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        // Esc работает и в поле: он про «уйти отсюда», а не про действие
        if (e.key !== "Escape") return;
      }
      const handler = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/**
 * Подсказка по горячим клавишам: маленькая полоса внизу экрана.
 *
 * Клавиша, о которой никто не знает, экономит ноль времени. Подсказка
 * скрывается на узких экранах — там клавиатуры обычно нет.
 */
export function HotkeyHint({ keys }: { keys: [string, string][] }) {
  return (
    <div className="hotkeys" aria-hidden>
      {keys.map(([k, what]) => (
        <span key={k}>
          <kbd>{k}</kbd> {what}
        </span>
      ))}
    </div>
  );
}

/**
 * Значение, живущее в адресной строке.
 *
 * Смысл не в красоте адреса, а в том, что вид экрана можно передать: «открой
 * тревоги за март, отсортированные по дате» становится ссылкой, а не устной
 * инструкцией. Плюс перезагрузка страницы не сбрасывает разбор наполовину.
 *
 * Пишем через replace: каждый щелчок по заголовку столбца не должен добавлять
 * запись в историю браузера — «назад» обязано уводить со страницы, а не
 * отменять сортировку по одному шагу.
 */
export function useUrlState(
  name: string,
  fallback = "",
): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) ?? fallback;
  const set = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          if (!next || next === fallback) copy.delete(name);
          else copy.set(name, next);
          return copy;
        },
        { replace: true },
      );
    },
    [name, fallback, setParams],
  );
  return [value, set];
}

export interface Column<T> {
  key: string;
  header: string;
  num?: boolean;
  /** Значение для сортировки; если не задано — колонка не сортируется */
  sort?: (row: T) => string | number;
  render: (row: T) => ReactNode;
  /** Текстовое значение для CSV; без него берётся sort, иначе колонка пропускается */
  csv?: (row: T) => string | number;
  width?: number;
  /**
   * Колонку нельзя скрыть. Ставится там, где без неё строка перестаёт быть
   * узнаваемой: имя пациента, название методики. Настройка колонок нужна,
   * чтобы убрать лишнее, а не чтобы получить таблицу из одних чисел.
   */
  required?: boolean;
  /** Скрыта, пока её не включат: редкие колонки не должны загромождать вид */
  hiddenByDefault?: boolean;
}

/**
 * CSV из текущего состояния таблицы (с сортировкой пользователя).
 * Разделитель — точка с запятой: русский Excel по умолчанию понимает её,
 * а запятую внутри чисел «1,5» — нет.
 */
/**
 * Сортировка строк таблицы. Вынесена из компонента, чтобы её можно было
 * проверить без React: это логика, а не разметка, и ошибка в ней тихо
 * переставляет данные местами.
 *
 * Числа сравниваются как числа, остальное — как текст с учётом языка:
 * «Ялинка» и «Яблуко» должны идти в порядке украинского алфавита, а не по
 * кодам символов.
 */
export function sortRows<T>(
  rows: T[],
  columns: Column<T>[],
  sort: { key: string; desc?: boolean } | null,
): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col?.sort) return rows;
  const get = col.sort;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const cmp =
      typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.desc ? -cmp : cmp;
  });
}

export function tableToCsv<T>(rows: T[], columns: Column<T>[]): string {
  const cols = columns.filter((c) => c.csv ?? c.sort);
  const cell = (v: string | number) => {
    const str = String(v);
    return /[";\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  const head = cols.map((c) => cell(c.header)).join(";");
  const body = rows.map((r) => cols.map((c) => cell((c.csv ?? c.sort)!(r))).join(";"));
  return "\ufeff" + [head, ...body].join("\r\n");
}

export function DataTable<T>({
  rows,
  columns,
  empty,
  initialSort,
  csvName,
  stateKey,
  rowKey,
  facets,
  facetNote,
  onRowClick,
  isRowActive,
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: ReactNode;
  initialSort?: { key: string; desc?: boolean };
  /** Имя файла включает выгрузку CSV текущего вида таблицы */
  csvName?: string;
  /**
   * Устойчивый ключ строки. По умолчанию берётся поле `id`, а если его нет —
   * порядковый номер. Номер плох тем, что таблица сортируется: React считает
   * строку «той же самой» по позиции, и при смене порядка переиспользует её
   * узлы — вместе с раскрытым содержимым и фокусом внутри ячейки.
   */
  rowKey?: (row: T) => string;
  /**
   * Префикс параметров адреса. Задан — сортировка переживает перезагрузку и
   * передаётся ссылкой; не задан — живёт в памяти компонента, как раньше.
   * Префикс нужен потому, что на странице бывает несколько таблиц.
   */
  stateKey?: string;
  /**
   * Фасетные фильтры над таблицей. Со счётчиком «сколько будет» до
   * применения: выбор вслепую заставляет пробовать варианты по одному.
   */
  facets?: Facet<T>[];
  /**
   * Приписка к фасетам о том, по чему они считают.
   *
   * Таблица с подгрузкой держит в памяти только загруженные строки, и счётчик
   * «Разведрота 13» означает «13 из загруженных», а не «13 в подразделении».
   * Без этой приписки счётчик врёт — а счётчик, которому нельзя верить, хуже
   * его отсутствия: по нему принимают решения.
   */
  facetNote?: string;
  /**
   * Выбор строки. Нажатие по строке показывает её в панели контекста справа,
   * не уводя с экрана: раньше «посмотреть, кто это» стоило перехода в карту и
   * возврата назад — с потерей места в списке и набранных фильтров.
   *
   * Ссылки внутри ячеек продолжают работать как ссылки: выбор — это не
   * переход, и подменять им переход нельзя.
   */
  onRowClick?: (row: T) => void;
  /** Какая строка сейчас показана в панели контекста. */
  isRowActive?: (row: T) => boolean;
}) {
  /*
   * Большинство таблиц показывают сущности с id — берём его, не заставляя
   * каждый вызов передавать rowKey. Номер строки остаётся только там, где
   * идентификатора действительно нет (сводные строки, агрегаты).
   */
  const keyOf = (row: T, i: number): string => {
    if (rowKey) return rowKey(row);
    const id = (row as { id?: unknown }).id;
    return typeof id === "string" ? id : String(i);
  };

  const [urlSort, setUrlSort] = useUrlState(stateKey ? `${stateKey}.sort` : "");
  const [localSort, setLocalSort] = useState(initialSort ?? null);

  // «ключ» или «ключ:desc» — читаемо в адресной строке и разбирается одним split
  const sort = stateKey
    ? urlSort
      ? { key: urlSort.split(":")[0]!, desc: urlSort.endsWith(":desc") }
      : (initialSort ?? null)
    : localSort;

  const setSort = (next: { key: string; desc?: boolean } | null) => {
    if (!stateKey) {
      setLocalSort(next);
      return;
    }
    setUrlSort(next ? `${next.key}${next.desc ? ":desc" : ""}` : "");
  };

  /*
   * Скрытые колонки живут в адресе рядом с сортировкой: тогда настроенный вид
   * пересылается ссылкой и попадает в сохранённые виды бесплатно — они уже
   * умеют сохранять параметры адреса.
   */
  const [hiddenRaw, setHiddenRaw] = useUrlState(stateKey ? `${stateKey}.cols` : "");
  const [localHidden, setLocalHidden] = useState("");
  const hiddenParam = stateKey ? hiddenRaw : localHidden;

  const hidden = useMemo(() => {
    if (hiddenParam) return new Set(hiddenParam.split(","));
    return new Set(columns.filter((c) => c.hiddenByDefault).map((c) => c.key));
  }, [hiddenParam, columns]);

  const setHidden = (next: Set<string>) => {
    const raw = [...next].join(",");
    if (stateKey) setHiddenRaw(raw);
    else setLocalHidden(raw);
  };

  const shown = useMemo(
    () => columns.filter((c) => c.required || !hidden.has(c.key)),
    [columns, hidden],
  );

  const [facetRaw, setFacetRaw] = useUrlState(stateKey && facets ? `${stateKey}.f` : "");
  const [localFacets, setLocalFacets] = useState("");
  const facetParam = stateKey ? facetRaw : localFacets;
  const selection = useMemo(() => parseFacets(facetParam), [facetParam]);
  const setSelection = (next: FacetSelection) => {
    const raw = serializeFacets(next);
    if (stateKey) setFacetRaw(raw);
    else setLocalFacets(raw);
  };

  const filtered = useMemo(
    () => (facets?.length ? applyFacets(rows, facets, selection) : rows),
    [rows, facets, selection],
  );

  const sorted = useMemo(() => sortRows(filtered, shown, sort), [filtered, sort, shown]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  // выгружается видимый срез: то, что человек настроил, — и есть его ответ
  const exportCsv = () => {
    const blob = new Blob([tableToCsv(sorted, shown)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${csvName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const head = (
    <thead>
      <tr>
        {shown.map((c) => (
          <th
            key={c.key}
            className={`${c.num ? "num" : ""} ${c.sort ? "sortable" : ""}`}
            style={c.width ? { width: c.width } : undefined}
            onClick={() =>
              c.sort &&
              setSort(sort?.key === c.key ? { key: c.key, desc: !sort.desc } : { key: c.key })
            }
          >
            {c.header}
            {sort?.key === c.key ? <span className="arrow">{sort.desc ? "↓" : "↑"}</span> : null}
          </th>
        ))}
      </tr>
    </thead>
  );

  const hideable = columns.filter((c) => !c.required);
  const tools =
    (csvName && rows.length) || hideable.length || facets?.length ? (
      <div className="table-tools">
        {facets?.length ? (
          <FacetBar
            rows={rows}
            facets={facets}
            selection={selection}
            onChange={setSelection}
            shownCount={sorted.length}
            totalCount={rows.length}
            note={facetNote}
          />
        ) : null}
        <div className="row tight">
          {hideable.length ? (
            <ColumnPicker
              columns={hideable}
              hidden={hidden}
              onToggle={(key) => {
                const next = new Set(hidden);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                setHidden(next);
              }}
            />
          ) : null}
          {csvName && sorted.length ? (
            <button onClick={exportCsv}>CSV · {sorted.length}</button>
          ) : null}
        </div>
      </div>
    ) : null;

  /*
   * Короткие таблицы рисуются целиком: виртуализация стоит собственной
   * сложности (фиксированная высота строки, отдельный контейнер прокрутки) и
   * на двух десятках строк только мешает.
   */
  if (sorted.length <= VIRTUAL_FROM) {
    return (
      <div className="scroll-x">
        {tools}
        <table>
          {head}
          <tbody>
            {sorted.map((row, i) => (
              <Row
                key={keyOf(row, i)}
                row={row}
                columns={shown}
                onRowClick={onRowClick}
                active={isRowActive?.(row) ?? false}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      {tools}
      <VirtualRows
        sorted={sorted}
        columns={shown}
        head={head}
        keyOf={keyOf}
        onRowClick={onRowClick}
        isRowActive={isRowActive}
      />
    </>
  );
}

/**
 * Строка таблицы.
 *
 * Когда выбор включён, строка становится доступной с клавиатуры: работа со
 * списком одинаково часто идёт мышью и стрелками, и «посмотреть, кто это»
 * не должно требовать мыши. Ссылки внутри ячеек остаются ссылками — нажатие
 * по ним не считается выбором, иначе переход в карту заодно менял бы панель
 * справа и человек видел бы, как она мигает на уходе со страницы.
 */
function Row<T>({
  row,
  columns,
  height,
  onRowClick,
  active,
}: {
  row: T;
  columns: Column<T>[];
  height?: number;
  onRowClick?: (row: T) => void;
  active: boolean;
}) {
  const clickable = !!onRowClick;
  return (
    <tr
      style={height ? { height } : undefined}
      className={active ? "row-active" : undefined}
      aria-selected={clickable ? active : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={
        clickable
          ? (e) => {
              // нажатие по ссылке — переход, а не выбор
              if ((e.target as HTMLElement).closest("a, button")) return;
              onRowClick(row);
            }
          : undefined
      }
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRowClick(row);
                return;
              }
              /*
               * Стрелки и j/k двигают по списку.
               *
               * Разбор очереди — это чтение строк подряд, и тянуться к мыши
               * на каждую следующую строку значит тратить секунду там, где
               * их сотни. Буквы продублированы к стрелкам, потому что на
               * экране разбора случаев j/k уже означают то же самое, и
               * держать два разных способа для одного действия — лишнее
               * знание.
               */
              const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
              if (!step) return;
              const rows = Array.from(
                e.currentTarget.closest("tbody")?.querySelectorAll<HTMLTableRowElement>("tr[tabindex]") ?? [],
              );
              const at = rows.indexOf(e.currentTarget);
              const next = rows[at + step];
              if (!next) return;
              e.preventDefault();
              next.focus();
              // строка может быть у самого края: доводим её до видимой части
              next.scrollIntoView({ block: "nearest" });
            }
          : undefined
      }
    >
      {columns.map((c) => (
        <td key={c.key} className={c.num ? "num" : ""}>
          {c.render(row)}
        </td>
      ))}
    </tr>
  );
}

/** С какого числа строк включается виртуализация */
const VIRTUAL_FROM = 60;

/**
 * Длинная таблица: в DOM живут только видимые строки.
 *
 * Список пациентов — девять тысяч человек, и раньше все девять тысяч строк
 * рисовались сразу: вкладка занимала полгигабайта и прокручивалась рывками.
 * Высота строки берётся из токена плотности, поэтому в плотном режиме
 * пересчёт происходит сам.
 */
function VirtualRows<T>({
  sorted,
  columns,
  head,
  keyOf,
  onRowClick,
  isRowActive,
}: {
  sorted: T[];
  columns: Column<T>[];
  head: ReactNode;
  keyOf: (row: T, i: number) => string;
  onRowClick?: (row: T) => void;
  isRowActive?: (row: T) => boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRowHeight(scrollRef);

  const virtual = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const items = virtual.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtual.getTotalSize() - (items[items.length - 1]?.end ?? 0);

  return (
    <div className="scroll-x virtual-wrap" ref={scrollRef}>
      <table>
        {head}
        <tbody>
          {/* распорки вместо абсолютного позиционирования: строки таблицы
              нельзя вынимать из потока, не потеряв выравнивание колонок */}
          {padTop > 0 ? <tr style={{ height: padTop }} aria-hidden /> : null}
          {items.map((v) => {
            const row = sorted[v.index]!;
            return (
              <Row
                key={keyOf(row, v.index)}
                row={row}
                columns={columns}
                height={rowHeight}
                onRowClick={onRowClick}
                active={isRowActive?.(row) ?? false}
              />
            );
          })}
          {padBottom > 0 ? <tr style={{ height: padBottom }} aria-hidden /> : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Высота строки из токена плотности.
 *
 * Захардкодить нельзя: в плотном режиме строка ниже на восемь пикселей, и
 * виртуализация с чужой высотой оставляет пустоты в конце списка.
 */
function useRowHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(38);
  useEffect(() => {
    const read = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--row-h");
      const px = Number.parseFloat(raw);
      if (Number.isFinite(px) && px > 0) setH(px);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    return () => observer.disconnect();
  }, [ref]);
  return h;
}

/** Поле поиска с иконкой */
export function Search({
  value,
  onChange,
  placeholder,
  width = 260,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number;
}) {
  const { ut } = useLang();
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? ut("ui.search")}
      style={{ maxWidth: width }}
    />
  );
}

/* ─────────── настройка колонок и фасеты ─────────── */

/**
 * Какие колонки показывать.
 *
 * Обязательные не предлагаются к скрытию вовсе, а не показываются серыми:
 * список выбора должен состоять только из того, что действительно можно
 * выбрать. Настройка живёт в адресе, поэтому переживает перезагрузку и
 * передаётся ссылкой вместе с сортировкой.
 */
function ColumnPicker<T>({
  columns,
  hidden,
  onToggle,
}: {
  columns: Column<T>[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const count = columns.filter((c) => !hidden.has(c.key)).length;

  return (
    <div className="col-picker">
      <button
        className="ghost"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        {ut("tbl.columns")} · {count}/{columns.length}
      </button>
      {open ? (
        <>
          {/* клик мимо закрывает: меню без этого остаётся висеть поверх работы */}
          <div className="col-picker-veil" onClick={() => setOpen(false)} />
          <div className="col-picker-menu" role="group" aria-label={ut("tbl.columns")}>
            {columns.map((c) => (
              <label key={c.key}>
                <input
                  type="checkbox"
                  checked={!hidden.has(c.key)}
                  onChange={() => onToggle(c.key)}
                />
                {c.header}
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Фасеты над таблицей.
 *
 * У каждого варианта — счётчик «сколько строк останется». Он считается по
 * строкам, прошедшим остальные фасеты, но не этот: иначе выбор варианта
 * обнулял бы счётчики его соседей, и человек не увидел бы, что даст
 * переключение.
 */
function FacetBar<T>({
  rows,
  facets,
  selection,
  onChange,
  shownCount,
  totalCount,
  note,
}: {
  rows: T[];
  facets: Facet<T>[];
  selection: FacetSelection;
  onChange: (next: FacetSelection) => void;
  shownCount: number;
  totalCount: number;
  note?: string;
}) {
  const { ut } = useLang();
  const active = Object.values(selection).some((v) => v.length);

  return (
    <div className="facets">
      {facets.map((facet) => {
        const options = facetOptions(rows, facets, selection, facet.key);
        if (!options.length) return null;
        return (
          <div key={facet.key} className="facet">
            <span className="facet-label">{facet.label}</span>
            {options.slice(0, 8).map((o) => (
              <button
                key={o.value}
                className={`chip${o.selected ? " active" : ""}`}
                aria-pressed={o.selected}
                onClick={() => onChange(toggleFacet(selection, facet.key, o.value))}
              >
                {o.value} <span className="facet-count">{o.count}</span>
              </button>
            ))}
          </div>
        );
      })}
      {active ? (
        <button className="ghost" onClick={() => onChange({})}>
          {ut("tbl.resetFacets")} · {shownCount}/{totalCount}
        </button>
      ) : null}
      {note ? <span className="facet-note">{note}</span> : null}
    </div>
  );
}
