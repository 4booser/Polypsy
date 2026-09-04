import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { Page, Panel } from "../ui/layout";
import { useLang } from "../lang";

/**
 * Командная консоль.
 *
 * Выглядит как терминал, оболочкой не является: сервер выполняет только
 * команды из своего реестра, и добавить новую можно лишь выкатом. Здесь —
 * ровно ввод, вывод и история; вся власть решать, что можно, остаётся на
 * сервере, потому что клиент в этом вопросе не свидетель.
 *
 * Список команд подтягивается при открытии и служит двум вещам: дополнению
 * по Tab и подсказке. Недоступные команды в нём помечены, а не спрятаны:
 * список, скрывающий половину себя, заставляет гадать, чего не хватает,
 * вместо того чтобы это назвать.
 */

interface Line {
  kind: "input" | "output" | "error";
  text: string;
}

export default function Console() {
  const { ut } = useLang();
  /*
   * Приветствие собирается из словаря, а не лежит константой рядом:
   * константа считалась бы один раз при загрузке модуля, и переключение
   * языка её бы не задело — экран остался бы наполовину на прежнем.
   */
  const [lines, setLines] = useState<Line[]>(() => [
    { kind: "output", text: ut("con.hello") },
    { kind: "output", text: ut("con.hint") },
    { kind: "output", text: "" },
  ]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState<{ usage: string; name: string; allowed: boolean }[]>([]);
  /** История введённого; листается стрелками, индекс −1 = «сейчас печатаю» */
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api
      .consoleCommands()
      .then((r) => setCommands(r.items))
      .catch(() => setCommands([]));
  }, []);

  // прокрутка к последней строке: терминал, за которым надо тянуться мышью,
  // перестаёт быть терминалом
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  async function run(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed === "clear") {
      setLines([]);
      setValue("");
      return;
    }

    history.current = [trimmed, ...history.current.filter((h) => h !== trimmed)].slice(0, 100);
    cursor.current = -1;
    setLines((prev) => [...prev, { kind: "input", text: trimmed }]);
    setValue("");
    setBusy(true);
    try {
      const res = await api.consoleRun(trimmed);
      setLines((prev) => [
        ...prev,
        ...res.lines.map((text) => ({ kind: res.ok ? ("output" as const) : ("error" as const), text })),
        { kind: "output" as const, text: "" },
      ]);
    } catch (error) {
      /*
       * Отказ по праву приходит обычной ошибкой API — печатаем его как
       * строку вывода, а не всплывающим окном: в терминале отказ это тоже
       * вывод, и он должен остаться в ленте, а не исчезнуть по нажатию.
       */
      const text = error instanceof ApiError ? error.message : String(error);
      setLines((prev) => [...prev, { kind: "error", text }, { kind: "output", text: "" }]);
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
    if (e.key === "Tab") {
      e.preventDefault();
      // дополняем по началу строки; при нескольких совпадениях печатаем их
      const matches = commands.filter((c) => c.usage.startsWith(value) || c.name.startsWith(value));
      if (matches.length === 1) setValue(matches[0]!.name + " ");
      else if (matches.length > 1) {
        setLines((prev) => [
          ...prev,
          { kind: "input", text: value },
          ...matches.map((m) => ({ kind: "output" as const, text: `  ${m.usage}` })),
          { kind: "output" as const, text: "" },
        ]);
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

  return (
    <Page title={ut("nav.console")} sub={ut("con.sub")}>
      <Panel flush>
        <div
          className="font-mono text-sm leading-relaxed p-4 max-h-[62vh] overflow-y-auto"
          onClick={() => input.current?.focus()}
        >
          {lines.map((line, i) => (
            <div
              key={i}
              className={
                line.kind === "input"
                  ? "text-accent whitespace-pre-wrap"
                  : line.kind === "error"
                    ? "text-danger whitespace-pre-wrap"
                    : "text-muted whitespace-pre-wrap"
              }
            >
              {line.kind === "input" ? `$ ${line.text}` : line.text}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="text-accent">$</span>
            <input
              ref={input}
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              // автозаполнение браузера в терминале предлагает адреса почты
              // из прошлых форм — здесь это шум поверх ввода
              autoComplete="off"
              spellCheck={false}
              aria-label={ut("con.input")}
              className="flex-1 bg-transparent outline-none font-mono text-sm"
            />
          </div>
          <div ref={bottom} />
        </div>
      </Panel>
    </Page>
  );
}
