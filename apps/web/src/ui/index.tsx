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
export const IconAudit = icon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></>);
export const IconBattery = icon(<><rect x="2" y="7" width="16" height="10" rx="2" /><path d="M22 11v2" /><path d="M6 11v2M10 11v2" /></>);
export const IconClock = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconInvite = icon(<><path d="M4 4h16v12H5.2L4 17.2V4Z" /><path d="M8 20h12" /><path d="M9 9h6M9 12h4" /></>);
export const IconKiosk = icon(<><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M9 19h6" /></>);
export const IconPulse = icon(<><path d="M2 12h4l2-7 4 14 3-9 2 2h5" /></>);
export const IconReferral = icon(<><path d="M4 12h11" /><path d="M12 6l6 6-6 6" /><path d="M20 4v16" /></>);
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
export function Avatar({ name, size = 26 }: { name: string; size?: number }) {
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
         * Светлота 30 %, а не «на глаз»: при 42 % белые инициалы на жёлто-
         * зелёных оттенках давали контраст 2,9:1. Проверено перебором всех
         * 360 тонов — на 30 % худший случай даёт 5,3:1.
         */
        background: `hsl(${hue} 45% 30%)`,
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
  const [typed, setTyped] = useState("");
  return (
    <div className="card danger-card">
      <div className="card-head">
        <h2>{title}</h2>
        <button className="ghost" onClick={onCancel}>Отмена</button>
      </div>
      <div>{warning}</div>
      <label className="field" style={{ marginTop: 10 }}>
        <span>Напечатайте «{name}», чтобы подтвердить</span>
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
          <button className="ghost" onClick={onClose} aria-label="Закрыть">✕</button>
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
  emptyText = "Больше записей нет",
}: {
  cursor: string | null;
  busy?: boolean;
  onLoad: () => void;
  emptyText?: string;
}) {
  if (!cursor) return <p className="hint end-of-list">{emptyText}</p>;
  return (
    <button className="load-more" disabled={busy} onClick={onLoad}>
      {busy ? "Загружаю…" : "Показать ещё"}
    </button>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card">
      <div style={{ display: "grid", gap: 10 }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton" style={{ width: `${100 - i * 12}%` }} />
        ))}
      </div>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint ? <div style={{ fontSize: 13, marginBottom: action ? 14 : 0 }}>{hint}</div> : null}
      {action}
    </div>
  );
}

export function PageHead({
  title,
  sub,
  crumbs,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  crumbs?: ReactNode;
  actions?: ReactNode;
}) {
  // заголовок вкладки следует за страницей: десяток вкладок «Quizzy» неразличимы
  useEffect(() => {
    document.title = `${title} — Quizzy`;
    return () => {
      document.title = "Quizzy";
    };
  }, [title]);

  return (
    <div className="page-head">
      <div>
        {crumbs ? <div className="crumbs">{crumbs}</div> : null}
        <h1>{title}</h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
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
  return useCallback(
    async (fn: () => Promise<unknown>, okText?: string) => {
      try {
        await fn();
        if (okText) toast(okText, "ok");
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Не удалось выполнить", "err");
        return false;
      }
    },
    [toast],
  );
}

/* ─────────── сортируемая таблица ─────────── */

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
}

/**
 * CSV из текущего состояния таблицы (с сортировкой пользователя).
 * Разделитель — точка с запятой: русский Excel по умолчанию понимает её,
 * а запятую внутри чисел «1,5» — нет.
 */
function tableToCsv<T>(rows: T[], columns: Column<T>[]): string {
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
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: ReactNode;
  initialSort?: { key: string; desc?: boolean };
  /** Имя файла включает выгрузку CSV текущего вида таблицы */
  csvName?: string;
  /**
   * Префикс параметров адреса. Задан — сортировка переживает перезагрузку и
   * передаётся ссылкой; не задан — живёт в памяти компонента, как раньше.
   * Префикс нужен потому, что на странице бывает несколько таблиц.
   */
  stateKey?: string;
}) {
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

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, sort, columns]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  const exportCsv = () => {
    const blob = new Blob([tableToCsv(sorted, columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${csvName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="scroll-x">
      {csvName && rows.length ? (
        <div className="table-tools">
          <button onClick={exportCsv}>CSV · {rows.length}</button>
        </div>
      ) : null}
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
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
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? "num" : ""}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "Поиск"}
      style={{ maxWidth: width }}
    />
  );
}
