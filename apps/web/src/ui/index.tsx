import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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
export const IconCompare = icon(<><path d="M3 20V10M9 20V4M15 20v-7M21 20V8" /></>);

/* ─────────── состояния ─────────── */

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
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: ReactNode;
  initialSort?: { key: string; desc?: boolean };
  /** Имя файла включает выгрузку CSV текущего вида таблицы */
  csvName?: string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);

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
                  setSort((s) => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key }))
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
