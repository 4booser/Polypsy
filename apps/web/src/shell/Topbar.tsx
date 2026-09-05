import { useLang } from "../lang";
import { LangSwitch } from "../lang";
import { EventCenter } from "./EventCenter";
import { cx } from "../ui/cx";

/** Квадратная кнопка-иконка панели: одна высота со всем остальным в строке. */
const iconBtn = cx(
  // рамку глобального правила для button приходится гасить явно:
  // иконка в панели — не кнопка с рамкой, а мишень для нажатия
  "inline-grid size-8 min-h-0 shrink-0 place-items-center rounded-sm border border-transparent bg-transparent p-0 text-muted",
  "transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 hover:text-text",
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
);

/**
 * Верхняя панель.
 *
 * Настройки вида (тема, язык, плотность) раньше жили внизу бокового меню —
 * там, где их никто не искал, и там, где они отнимали место у навигации.
 * Здесь же — единственная точка входа в поиск: одна и та же кнопка и одна и
 * та же клавиша, с какого бы экрана ни начали.
 */
export function Topbar({
  onSearch,
  onToggleRail,
  railOpen,
  theme,
  onToggleTheme,
  right,
}: {
  onSearch: () => void;
  onToggleRail: () => void;
  railOpen: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  right?: React.ReactNode;
}) {
  const { ut } = useLang();
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

  return (
    <header
      className={cx(
        "sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 px-3",
        "border-b border-hairline",
        // прозрачность с размытием: под панелью проходит содержимое, и
        // граница между «панель» и «страница» должна оставаться видимой
        "bg-[color-mix(in_srgb,var(--bg)_86%,transparent)] backdrop-blur-md",
      )}
    >
      <button
        type="button"
        className={iconBtn}
        onClick={onToggleRail}
        aria-label={railOpen ? ut("shell.collapse") : ut("shell.expand")}
        title={railOpen ? ut("shell.collapse") : ut("shell.expand")}
      >
        <IconRail />
      </button>

      {/*
        Поиск выглядит полем, а работает как кнопка: набор идёт уже в палитре.
        Поле, в которое нельзя печатать, обычно раздражает — здесь оно
        оправдано тем, что палитра открывается мгновенно и первый же
        набранный символ попадает в неё, а не теряется.
      */}
      <button
        type="button"
        className={cx(
          // на телефоне от поиска остаётся значок: подпись и клавиша там не нужны,
          // а место нужно
          "flex h-8 min-h-0 min-w-[240px] max-w-[420px] flex-1 items-center gap-2 rounded-sm px-2.5",
          "max-[900px]:min-w-0 max-[900px]:flex-none max-[900px]:justify-center max-[900px]:px-2",
          "border border-border bg-surface text-small text-muted",
          "transition-colors duration-[var(--dur-fast)]",
          "hover:border-border-strong hover:bg-surface-2 hover:text-text",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        )}
        onClick={onSearch}
      >
        <IconSearch />
        <span className="flex-1 text-left max-[900px]:hidden">{ut("shell.search")}</span>
        <kbd className="rounded-[4px] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-micro text-faint max-[900px]:hidden">
          {mac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>

      <span className="flex-1" />
      {right}
      <EventCenter />

      {/* вид отделён от работы: настройки экрана — отдельная группа справа */}
      <span aria-hidden className="mx-1 h-5 w-px bg-hairline" />

      {/*
        Переключателя плотности здесь больше нет. Он менял отступы в
        таблицах, но на экранах, которые открывают каждый день, разница не
        читалась вовсе — значок в панели выглядел кнопкой, которая ничего не
        делает, и обучал не нажимать на соседние.
      */}
      <button
        type="button"
        className={iconBtn}
        onClick={onToggleTheme}
        aria-label={theme === "dark" ? ut("nav.themeLight") : ut("nav.themeDark")}
        title={theme === "dark" ? ut("nav.themeLight") : ut("nav.themeDark")}
      >
        {theme === "dark" ? <IconSun /> : <IconMoon />}
      </button>
      <LangSwitch />
    </header>
  );
}

const s = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;

function IconRail() {
  return (
    <svg {...s}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
  );
}
function IconSearch() {
  return <svg {...s}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}
function IconSun() {
  return (
    <svg {...s}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>
  );
}
function IconMoon() {
  return <svg {...s}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" /></svg>;
}
