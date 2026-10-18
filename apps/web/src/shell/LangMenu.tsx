import { LANG_NAMES, LANG_SELF_LABEL, type Lang } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { MenuButton, menuItemClass } from "../ui/menu";
import { ShellIcon } from "./icons";

/**
 * Языки, из которых выбирают, — ключи LANG_NAMES, а не набранный список.
 *
 * Язык, добавленный в Lang без полного и короткого имени, не соберётся:
 * LANG_NAMES — запись `Record<Lang, …>`, и перечень не может отстать от типа
 * молча.
 */
export const LANG_CHOICES = Object.keys(LANG_NAMES) as Lang[];

/**
 * Язык одной подписью, по нажатию — плашка с языками. Одна на всю оболочку:
 * полоса приложения консоли, шапка кабинета пациента и гостевые страницы.
 *
 * На кнопке — значок языков и короткое слово текущего («Укр», «Рус»,
 * «Eng»): языков три, и «по кругу» человек попадал бы на нужный со второго
 * нажатия, не видя, что его ждёт дальше. В плашке — полные имена, каждое на
 * своём языке («Українська», «Русский», «English»): выбирает здесь и тот,
 * кто попал на незнакомый язык.
 *
 * Текущий язык отмечен не цветом: роль menuitemradio с aria-checked для
 * диктора и галочка для глаза. У каждого пункта свой `lang`: диктор читает
 * «Русский» русским голосом.
 *
 * `tone` — поверхность, на которой стоит кнопка: тёмная полоса приложения
 * консоли (`appbar`) или светлая шапка кабинета и гостевых страниц
 * (`band`). Цвета — токенами: полоса приложения тёмная в обеих темах и
 * несёт свои (appbar-*), шапка следует за темой.
 *
 * Ловушка фокуса, стрелки, Esc и подложка — общие (MenuButton).
 */
export function LangMenu({ tone = "appbar" }: { tone?: "appbar" | "band" }) {
  const { lang, setLang, ut } = useLang();
  /* короткое имя — из словаря, запасом — из LANG_NAMES */
  const word = ut("top.lang", LANG_NAMES[lang].short);
  return (
    <MenuButton
      label={LANG_SELF_LABEL}
      align="left"
      /*
       * Коробка меню растянута по высоте места, а не по кнопке: плашка тогда
       * начинается под полосой приложения, а не в её нижней трети.
       */
      className="items-center self-stretch"
      plateClassName="min-w-[200px]"
      trigger={(p) => (
        <button
          type="button"
          {...p}
          /*
           * Видимое слово входит в имя для диктора, и первым (WCAG 2.5.3):
           * тот, кто управляет голосом, говорит то, что видит («Укр»). Хвост
           * называет сам орган выбора и не переводится — LANG_SELF_LABEL.
           */
          aria-label={`${word} — ${LANG_SELF_LABEL}`}
          className={cx(
            "inline-flex min-h-0 shrink-0 items-center gap-[6px] whitespace-nowrap border-0 font-bold leading-none",
            "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
            tone === "appbar"
              ? "h-10 rounded-[12px] bg-transparent px-[10px] text-[13px] text-appbar-muted hover:bg-appbar-hover hover:text-appbar-ink aria-expanded:bg-appbar-hover aria-expanded:text-appbar-ink"
              : "h-11 rounded-[12px] bg-band-card px-[12px] text-[14px] text-text-2 shadow-[inset_0_0_0_1px_var(--bcardline)] hover:bg-violet-tint-2 hover:text-violet-ink",
          )}
        >
          <ShellIcon name="languages" size={tone === "appbar" ? 16 : 17} />
          {word}
        </button>
      )}
    >
      {(close) =>
        LANG_CHOICES.map((code) => {
          const current = code === lang;
          return (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              lang={code}
              className={cx(menuItemClass("left"), "gap-3")}
              onClick={() => {
                close();
                if (!current) setLang(code);
              }}
            >
              {/*
                Галочка у левого края, имя справа от неё. У невыбранных она
                невидима, но место держит: ширина плашки не прыгает.
              */}
              <span aria-hidden className={cx("shrink-0 text-violet-ink", !current && "invisible")}>
                <ShellIcon name="check" size={16} />
              </span>
              {LANG_NAMES[code].full}
            </button>
          );
        })
      }
    </MenuButton>
  );
}
