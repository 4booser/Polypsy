import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Ic, KbdHints, Loading, useToast } from "../ui";
import { cx } from "../ui/cx";
import { Page, Panel } from "../ui/layout";
import { Button } from "../ui/primitives";
import { AIc, fill, hm, whenShort } from "./people/parts";

/**
 * Командная консоль — Polypsy 2.0, макет admin-console.
 *
 * Выглядит как терминал, оболочкой не является: сервер выполняет только
 * команды из своего реестра, и добавить новую можно лишь выкатом. Здесь —
 * ввод, вывод блоками (команда, состояние, время и длительность) и
 * история; вся власть решать, что можно, остаётся на сервере, потому что
 * клиент в этом вопросе не свидетель.
 *
 * Список команд справа служит трём вещам: дополнению по Tab, подсказке под
 * строкой ввода и ответу «чего мне не хватает». Недоступные команды в нём
 * перечёркнуты и подписаны правом, а не спрятаны: список, скрывающий
 * половину себя, заставляет гадать.
 *
 * Отказ по праву — тоже вывод, а не всплывающее окно: в терминале он
 * остаётся в ленте, и его можно перечитать. Янтарём, а не красным: красный
 * в наборе — только риск для человека.
 */

interface Block {
  id: number;
  command: string;
  at: string;
  ms: number | null;
  /** ok — выполнено; fail — команда ответила отказом; denied — нет права (403) */
  state: "running" | "ok" | "fail" | "denied";
  lines: string[];
}

/*
 * Недавние команды — удобство вкладки, не данные: в хранилище вкладки
 * (sessionStorage), а не браузера, и под ключом учётной записи.
 *
 * Строка команды несёт аргументы, а среди них бывает почта пациента:
 * `user find` ищет по всем учётным записям. В localStorage она пережила бы
 * выход и досталась бы следующему за общим ноутбуком отделения — так же
 * решён список запросов поиска по записям (search/model.ts). Ключ с id: вышел
 * один, вошёл другой в той же вкладке — чужих команд он не видит. Хранилище
 * закрыто (приватное окно) — недавние живут до перезагрузки.
 */
const RECENT_PREFIX = "quizzy.console.recent:";
const RECENT_MAX = 8;

type RecentStore = Pick<Storage, "getItem" | "setItem">;

export const recentKey = (userId: string) => `${RECENT_PREFIX}${userId}`;

/** Хранилище вкладки, если браузер его даёт */
function tabStore(): RecentStore | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

export function readRecent(store: RecentStore | null, userId: string): string[] {
  if (!store || !userId) return [];
  try {
    const raw = store.getItem(recentKey(userId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(store: RecentStore | null, userId: string, list: string[]): void {
  if (!store || !userId) return;
  try {
    store.setItem(recentKey(userId), JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* хранилище закрыто или полно — недавние живут до перезагрузки */
  }
}

/** Команды, подходящие к набранному: по имени и по образцу вызова */
export function completions<T extends { name: string; usage: string }>(commands: T[], typed: string): T[] {
  const v = typed.trimStart();
  if (!v) return [];
  return commands.filter((c) => c.name.startsWith(v) || c.usage.startsWith(v) || (v.startsWith(`${c.name} `) && c.usage.startsWith(v.split(" ")[0]!)));
}

export default function Console() {
  const { ut } = useLang();
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const toast = useToast();
  const [started] = useState(() => new Date().toISOString());
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [intro, setIntro] = useState(true);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent(tabStore(), userId));
  /* список команд — удобство: без него работает всё, кроме дополнения по Tab */
  const commandsRes = useResource(() => api.consoleCommands().then((r) => r.items), []);
  const commands = commandsRes.data ?? [];
  /** История введённого; листается стрелками, индекс −1 = «сейчас печатаю» */
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const seq = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // прокрутка к последнему блоку: терминал, за которым надо тянуться мышью, перестаёт быть терминалом
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [blocks]);

  const matches = useMemo(() => completions(commands, value), [commands, value]);
  /* подсказка в самой строке — продолжение единственного совпадения */
  const ghost = matches.length === 1 && matches[0]!.name.startsWith(value.trimStart()) ? matches[0]!.name.slice(value.trimStart().length) : "";

  async function run(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "clear") {
      setBlocks([]);
      setIntro(false);
      setValue("");
      return;
    }
    history.current = [trimmed, ...history.current.filter((h) => h !== trimmed)].slice(0, 100);
    cursor.current = -1;
    const nextRecent = [trimmed, ...recent.filter((r) => r !== trimmed)].slice(0, RECENT_MAX);
    setRecent(nextRecent);
    saveRecent(tabStore(), userId, nextRecent);
    const id = ++seq.current;
    const at = new Date().toISOString();
    const t0 = performance.now();
    setBlocks((prev) => [...prev, { id, command: trimmed, at, ms: null, state: "running", lines: [] }]);
    setValue("");
    setBusy(true);
    try {
      const res = await api.consoleRun(trimmed);
      const ms = Math.round(performance.now() - t0);
      setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ms, state: res.ok ? "ok" : "fail", lines: res.lines } : b)));
    } catch (error) {
      /*
       * Отказ по праву приходит обычной ошибкой API — печатаем его строкой
       * вывода, а не всплывающим окном: в терминале отказ это тоже вывод.
       */
      const ms = Math.round(performance.now() - t0);
      const denied = error instanceof ApiError && error.status === 403;
      const text = error instanceof ApiError ? error.message : String(error);
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === id ? { ...b, ms, state: denied ? "denied" : "fail", lines: denied ? [text, ut("adm2.deniedHint")] : [text] } : b,
        ),
      );
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void run(value);
      return;
    }
    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setBlocks([]);
      setIntro(false);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      // дополняем по началу строки; при нескольких совпадениях — до общего начала
      if (matches.length === 1) setValue(`${matches[0]!.name} `);
      else if (matches.length > 1) {
        const names = matches.map((m) => m.name);
        let common = names[0]!;
        for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1);
        if (common.length > value.trimStart().length) setValue(common);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(cursor.current + 1, history.current.length - 1);
      if (next >= 0) {
        cursor.current = next;
        setValue(history.current[next] ?? "");
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = cursor.current - 1;
      cursor.current = Math.max(next, -1);
      setValue(next < 0 ? "" : (history.current[next] ?? ""));
    }
  }

  const transcript = () =>
    blocks.map((b) => [`$ ${b.command}`, ...b.lines].join("\n")).join("\n\n");

  return (
    <Page
      title={ut("nav.console")}
      meta={[ut("adm2.consoleMeta"), ut("adm2.consoleMetaSub")]}
      actions={
        <Button icon={<AIc.book size={15} />} disabled={busy} onClick={() => void run("help")}>
          {ut("adm2.commandHelp")}
        </Button>
      }
    >
      <div className="grid items-start gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title={ut("adm2.session")}
          icon={<AIc.terminal />}
          sub={fill(ut("adm2.sessionSince"), { at: whenShort(started, ut) })}
          actions={
            <>
              <Button
                variant="ghost"
                size="xs"
                icon={<AIc.copy size={14} />}
                disabled={!blocks.length}
                onClick={() => void navigator.clipboard?.writeText(transcript()).then(() => toast(ut("adm2.copied"), "ok"))}
              >
                {ut("adm2.copyAll")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                icon={<AIc.eraser size={14} />}
                onClick={() => {
                  setBlocks([]);
                  setIntro(false);
                }}
              >
                {ut("adm2.clear")}
              </Button>
            </>
          }
          footer={
            <KbdHints
              keys={[
                ["Enter", ut("adm2.keyRun")],
                ["Tab", ut("adm2.keyComplete")],
                ["↑ ↓", ut("adm2.keyHistory")],
                ["Ctrl L", ut("adm2.keyClear")],
              ]}
            />
          }
        >
          <div
            className="flex max-h-[62vh] min-h-[420px] flex-col overflow-y-auto rounded-panel bg-sunk px-3 pb-3 pt-3 font-mono text-[13px] leading-[20px]"
            onClick={() => input.current?.focus()}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {intro ? (
              <div className="mb-2 whitespace-pre-wrap px-1 text-muted">
                <p className="m-0">{ut("con.hello")}</p>
                <p className="m-0">{ut("con.hint")}</p>
              </div>
            ) : null}
            {blocks.map((b) => (
              <section
                key={b.id}
                aria-label={b.command}
                className={cx("mt-2 rounded-[10px] px-2.5 py-2", b.state === "denied" ? "bg-warn-tint shadow-[inset_0_0_0_1px_var(--warnline,transparent)]" : "")}
              >
                <div className="flex items-center gap-2">
                  {b.state === "running" ? (
                    <Ic.timer size={14} className="text-muted" />
                  ) : b.state === "ok" ? (
                    <Ic.check size={14} className="text-good" />
                  ) : (
                    <Ic.x size={14} className={b.state === "denied" ? "text-warn" : "text-muted"} />
                  )}
                  <span className="text-muted">$</span>
                  <b className="min-w-0 flex-1 truncate font-bold text-text">{b.command}</b>
                  <span className="whitespace-nowrap font-sans text-caption tabular-nums text-muted">
                    {hm(b.at)}
                    {b.ms !== null ? `  ${fill(ut("adm2.ms"), { n: b.ms })}` : ""}
                  </span>
                </div>
                {b.lines.length ? (
                  <div className={cx("mt-1.5 whitespace-pre-wrap pl-[22px]", b.state === "denied" ? "text-warn" : b.state === "fail" ? "text-text-2" : "text-text")}>
                    {b.lines.map((l, i) => (
                      <div key={i} className={cx(b.state === "denied" && i === 0 && "font-bold")}>
                        {l || " "}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
            <div className="relative mt-auto pt-3">
              {matches.length > 1 && value.trim() ? (
                <div className="absolute bottom-[calc(100%-4px)] left-0 z-[3] w-[min(440px,100%)] rounded-[12px] border border-border bg-panel p-1.5 font-sans shadow-pop">
                  <p className="m-0 px-2 pb-1 pt-0.5 text-caption font-bold text-muted">{ut("adm2.matches")}</p>
                  {matches.slice(0, 6).map((m) => (
                    <button
                      key={m.name}
                      type="button"
                      onClick={() => {
                        setValue(`${m.name} `);
                        input.current?.focus();
                      }}
                      className="flex w-full min-h-0 cursor-pointer items-center gap-3 rounded-[8px] border-0 bg-transparent px-2 py-1.5 text-left hover:bg-sunk"
                    >
                      <code className={cx("font-mono text-[12.5px] font-bold", m.allowed ? "text-text" : "text-muted line-through")}>{m.usage}</code>
                      <span className="ml-auto truncate text-caption text-text-2">{m.summary}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="flex h-11 items-center gap-2 rounded-[12px] border border-violet-ring bg-panel px-3 shadow-[0_0_0_3px_var(--vtint)]">
                <span className="text-muted">$</span>
                <span className="relative min-w-0 flex-1">
                  <input
                    ref={input}
                    value={value}
                    disabled={busy}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={onKeyDown}
                    // автозаполнение браузера в терминале предлагает адреса почты из прошлых форм
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={ut("con.input")}
                    className="relative z-[1] h-full w-full border-0 bg-transparent p-0 font-mono text-[13px] text-text outline-none"
                  />
                  {ghost ? (
                    <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center whitespace-pre font-mono text-[13px]">
                      <span className="invisible">{value}</span>
                      <span className="text-muted">{ghost}</span>
                    </span>
                  ) : null}
                </span>
                <span className="whitespace-nowrap font-sans text-caption text-muted">{ut("adm2.tabToComplete")}</span>
              </label>
            </div>
            <div ref={bottom} />
          </div>
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("adm2.commands")} icon={<Ic.list />} sub={ut("adm2.commandsSub")} flush>
            {commandsRes.error ? (
              <div className="px-4 pb-4">
                <Loading error={commandsRes.error} onRetry={commandsRes.reload} bare />
              </div>
            ) : !commandsRes.data ? (
              <div className="px-4 pb-4">
                <Loading rows={5} bare />
              </div>
            ) : (
              <ul className="m-0 list-none p-0">
                {commands.map((c) => (
                  <li key={c.name} className="flex items-start gap-2.5 border-t border-divider px-4 py-2.5">
                    {c.allowed ? <Ic.check size={14} className="mt-0.5 shrink-0 text-good" /> : <Ic.x size={14} className="mt-0.5 shrink-0 text-muted" />}
                    <span className="min-w-0 flex-1">
                      <button
                        type="button"
                        disabled={!c.allowed}
                        onClick={() => {
                          setValue(`${c.name} `);
                          input.current?.focus();
                        }}
                        className={cx(
                          "min-h-0 border-0 bg-transparent p-0 text-left font-mono text-[12.5px] font-bold",
                          c.allowed ? "cursor-pointer text-text hover:text-violet-ink" : "cursor-default text-muted line-through",
                        )}
                      >
                        {c.usage}
                      </button>
                      <small className="block text-caption leading-[16px] text-text-2">{c.summary}</small>
                    </span>
                    {c.permission ? <code className="shrink-0 font-mono text-[11px] text-muted">{c.permission}</code> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={ut("adm2.recent")} icon={<Ic.history />}>
            {recent.length ? (
              <div className="flex flex-wrap gap-1.5">
                {recent.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setValue(r);
                      input.current?.focus();
                    }}
                    className="inline-flex h-8 min-h-0 cursor-pointer items-center rounded-2xl border-0 bg-sunk px-3 font-mono text-[12.5px] font-bold text-text-2 hover:bg-sunk-2 hover:text-text"
                  >
                    {r}
                  </button>
                ))}
              </div>
            ) : (
              <p className="m-0 text-small text-muted">{ut("adm2.noRecent")}</p>
            )}
            <p className="m-0 mt-3 text-small text-muted">{ut("adm2.everyCommandLogged")}</p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
