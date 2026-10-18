import type { UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { ShellIcon, type IconName } from "./icons";
import { THEME_CHOICES, useThemeChoice, type ThemeChoice } from "./theme";
import { Tooltip } from "../ui/Popover";

const LOOK: Record<ThemeChoice, { icon: IconName; label: UiKey }> = {
  light: { icon: "sun", label: "nav.themeLight" },
  dark: { icon: "moon", label: "nav.themeDark" },
  system: { icon: "monitor", label: "nav.themeSystem" },
};

/**
 * Переключатель темы — три кнопки в одной плашке (.tt набора): светлая,
 * тёмная, «як у системі».
 *
 * Три, а не кнопка «наоборот»: при выборе «як у системі» «наоборот» не
 * говорит, во что переключит, а человек на общем компьютере должен видеть,
 * какой выбор сейчас действует. Выбранная — `aria-pressed` и залитая
 * кнопка, а не только цвет значка.
 *
 * `onChoose` — куда сохранить выбор: консоль пишет его в профиль на
 * сервере, гостевая страница — только в браузер. Само переключение — общее
 * (shell/theme.ts).
 *
 * `tone` — поверхность: тёмная полоса приложения консоли или светлая шапка
 * кабинета, гостевых страниц и всплывающей карточки.
 */
export function ThemeToggle({
  onChoose,
  tone = "appbar",
  className,
}: {
  onChoose: (c: ThemeChoice) => void;
  tone?: "appbar" | "band";
  className?: string;
}) {
  const { ut } = useLang();
  const choice = useThemeChoice();
  return (
    <div
      role="group"
      aria-label={ut("pt.theme")}
      className={cx(
        "inline-flex shrink-0 gap-[2px] rounded-[12px] p-[3px]",
        tone === "appbar" ? "bg-appbar-field" : "bg-band-card shadow-[inset_0_0_0_1px_var(--bcardline)]",
        className,
      )}
    >
      {THEME_CHOICES.map((c) => {
        const on = c === choice;
        const label = ut(LOOK[c].label);
        return (
          <Tooltip key={c} label={label} side="bottom">
              <button
                type="button"
                aria-pressed={on}
                aria-label={label}
                onClick={() => onChoose(c)}
                className={cx(
                  "grid min-h-0 place-items-center rounded-[9px] border-0 p-0",
                  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
                  tone === "appbar" ? "h-8 w-[34px]" : "h-[34px] w-9",
                  tone === "appbar"
                    ? on
                      ? "bg-appbar-ink text-appbar"
                      : "bg-transparent text-appbar-muted hover:text-appbar-ink"
                    : on
                      ? "bg-violet-tint-2 text-violet-ink"
                      : "bg-transparent text-muted hover:text-text",
                )}
              >
                <ShellIcon name={LOOK[c].icon} size={14} />
              </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
