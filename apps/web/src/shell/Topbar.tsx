import { useLang } from "../lang";
import { LangSwitch } from "../lang";
import { EventCenter } from "./EventCenter";

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
  density,
  onToggleDensity,
  right,
}: {
  onSearch: () => void;
  onToggleRail: () => void;
  railOpen: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  density: "cozy" | "compact";
  onToggleDensity: () => void;
  right?: React.ReactNode;
}) {
  const { ut } = useLang();
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

  return (
    <header className="topbar">
      <button
        className="ghost icon-btn"
        onClick={onToggleRail}
        aria-label={railOpen ? ut("shell.collapse") : ut("shell.expand")}
        title={railOpen ? ut("shell.collapse") : ut("shell.expand")}
      >
        <IconRail />
      </button>

      {/* поиск выглядит полем, работает как кнопка: набор идёт уже в палитре */}
      <button className="topsearch" onClick={onSearch}>
        <IconSearch />
        <span className="grow">{ut("shell.search")}</span>
        <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>

      <div className="spacer" />
      {right}
      <EventCenter />

      <button
        className="ghost icon-btn"
        onClick={onToggleDensity}
        aria-label={ut("shell.density")}
        title={`${ut("shell.density")}: ${density === "compact" ? "compact" : "cozy"}`}
      >
        {density === "compact" ? <IconRows /> : <IconRowsWide />}
      </button>
      <button
        className="ghost icon-btn"
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
function IconRows() {
  return <svg {...s}><path d="M3 6h18M3 10h18M3 14h18M3 18h18" /></svg>;
}
function IconRowsWide() {
  return <svg {...s}><path d="M3 7h18M3 12h18M3 17h18" /></svg>;
}
