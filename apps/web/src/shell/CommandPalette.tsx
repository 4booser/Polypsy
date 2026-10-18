import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { api } from "../api";
import { useDebounced, useResource } from "../useResource";
import { useLang } from "../lang";
import { backdropPress, useFocusTrap } from "../ui";
import type { UiKey } from "@quizzy/shared";
import { ModKey } from "./HelpDrawer";
import { ShellIcon, type IconName } from "./icons";
import { initials } from "./UserMenu";
import { Kbd } from "../ui/kbd";

/**
 * Палитра команд — ⌘K / Ctrl K с любого экрана или поле поиска на полосе.
 *
 * Раньше, чтобы назначить методику конкретному человеку, нужно было
 * вспомнить, на каком экране это делается. Здесь путь один и всегда
 * одинаковый: нажать ⌘K и набрать фамилию или название действия.
 *
 * Поиск пациентов идёт на сервер с задержкой: ФИО зашифровано, и фильтровать
 * на клиенте можно было бы только то, что уже приехало.
 *
 * Вид — по набору «Виразної» (comms-command-palette): окно 640 под полосой,
 * строка поиска 60 с «Esc» справа, группы подписями, строки 44 со значком,
 * люди — кружком с инициалами, внизу подсказка клавиш. Правой колонки набора
 * («карточка человека и действия с ним») здесь нет: у палитры есть только
 * имя и почта найденного, а выдумывать остальное — значит показывать
 * неправду о человеке.
 */

interface Item {
  key: UiKey;
  to: string;
  group: UiKey;
  icon: IconName;
}

/*
 * Шесть команд когда-то вели в никуда: они указывали на маршруты, которых в
 * приложении нет, и общий перехват молча уводил на сводку. Проверка
 * test/commandPalette.test.ts следит, чтобы каждая команда вела на
 * объявленный маршрут.
 */
const ITEMS: Item[] = [
  { key: "nav.dashboard", to: "/", group: "cmd.navigate", icon: "layout-dashboard" },
  { key: "day.title", to: "/today", group: "cmd.navigate", icon: "house" },
  { key: "nav.worklist", to: "/worklist", group: "cmd.navigate", icon: "list-checks" },
  { key: "nav.cases", to: "/alerts", group: "cmd.navigate", icon: "triangle-alert" },
  { key: "nav.patients", to: "/patients", group: "cmd.navigate", icon: "users" },
  { key: "nav.referrals", to: "/referrals", group: "cmd.navigate", icon: "arrow-right-left" },
  { key: "nav.surveys", to: "/surveys", group: "cmd.navigate", icon: "clipboard-list" },
  { key: "nav.batteries", to: "/batteries", group: "cmd.navigate", icon: "layers" },
  { key: "nav.reception", to: "/my-schedule", group: "cmd.navigate", icon: "calendar-days" },
  { key: "ms.title", to: "/messages", group: "cmd.navigate", icon: "messages-square" },
  { key: "sn.mailings", to: "/mailings", group: "cmd.navigate", icon: "megaphone" },
  { key: "nav.invites", to: "/invites", group: "cmd.navigate", icon: "user-plus" },
  { key: "sn.patientGroups", to: "/patient-groups", group: "cmd.navigate", icon: "component" },
  { key: "adm.groupsTitle", to: "/groups", group: "cmd.navigate", icon: "folder-tree" },
  { key: "perm.title", to: "/permissions", group: "cmd.navigate", icon: "key-round" },
  { key: "acct.title", to: "/account", group: "cmd.navigate", icon: "circle-user-round" },
  { key: "cmd.newSurvey", to: "/constructor", group: "cmd.actions", icon: "pencil-ruler" },
  { key: "cmd.newInvite", to: "/invites", group: "cmd.actions", icon: "user-plus" },
];

/* строка палитры: 44 высотой, выбранная — подложкой sunk; cmdk ставит data-selected сам */
const ROW =
  "flex h-11 cursor-pointer items-center gap-[10px] rounded-[9px] px-[10px] text-[13.5px] font-semibold " +
  "text-text data-[selected=true]:bg-sunk [&>svg]:text-muted";

/* подписи групп cmdk рисует сам — оформляются селектором от списка */
const LIST =
  "max-h-[min(440px,calc(100dvh-240px))] overflow-y-auto p-[6px] [scrollbar-width:thin] " +
  "[&_[cmdk-group-heading]]:px-[10px] [&_[cmdk-group-heading]]:pb-[4px] [&_[cmdk-group-heading]]:pt-[8px] " +
  "[&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:leading-4 " +
  "[&_[cmdk-group-heading]]:text-muted";

export function CommandPalette({
  open,
  onClose,
  onToggleTheme,
  onToggleDensity,
}: {
  open: boolean;
  onClose: () => void;
  onToggleTheme: () => void;
  onToggleDensity: () => void;
}) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  /*
   * Поиск людей — на сервере и с задержкой: набор текста не должен дёргать
   * API на каждую букву. Через слой загрузки: ответ ложится под ту строку,
   * которую спрашивали, а не под последнюю пришедшую.
   */
  const search = useDebounced(query.trim(), 220);
  const searching = open && search.length >= 2 && query.trim().length >= 2;
  const found = useResource(
    () =>
      api
        .respondents({ search, limit: "6" })
        .then((page) => page.items.map((r) => ({ id: r.userId, fullName: r.fullName, email: r.email })))
        // палитра — удобство: отказ поиска людей оставляет в ней команды, а не ошибку
        .catch(() => []),
    [search],
    { enabled: searching },
  );
  const people = searching ? (found.data ?? []) : [];

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const groups = useMemo(() => {
    const by = new Map<UiKey, Item[]>();
    for (const i of ITEMS) by.set(i.group, [...(by.get(i.group) ?? []), i]);
    return [...by.entries()];
  }, []);

  /*
   * Та же ловушка фокуса, что у модального окна, а не своя копия. Хук
   * вызывается до раннего возврата: порядок хуков не может зависеть от того,
   * открыта палитра или нет.
   */
  const ref = useFocusTrap<HTMLDivElement>(open);
  /*
   * Подложка закрывает палитру тем же правилом, что Modal (#200, #179):
   * нажатие начато и закончено на ней. Протяжка выделения из поля поиска,
   * отпущенная за краем палитры, её больше не гасит.
   */
  const [press] = useState(backdropPress);

  if (!open) return null;

  const go = (to: string) => {
    navigate(to);
    onClose();
  };

  return (
    <div
      className="palette-backdrop fixed inset-0 z-[90] grid place-items-start justify-items-center bg-scrim px-4 pt-[88px] animate-[fade_var(--dur-fast)_var(--ease)] max-[600px]:pt-4"
      onPointerDown={press.down}
      onPointerUp={press.up}
      onClick={(e) => {
        if (press.click(e)) onClose();
      }}
      role="presentation"
    >
      {/*
        Палитра объявляет себя диалогом: для диктора иначе страница под ней
        оставалась бы доступной для чтения, хотя работать с ней нельзя.
        tabIndex нужен ловушке: пока фокус не занят полем ввода, ей есть
        куда его увести.
      */}
      <div
        className="palette flex w-[min(640px,100%)] flex-col overflow-hidden rounded-drawer border border-border bg-panel text-text shadow-pop animate-[rise_var(--dur)_var(--ease)]"
        role="dialog"
        aria-modal="true"
        aria-label={ut("cmd.title")}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <Command label={ut("cmd.title")} shouldFilter>
          <div className="flex h-[60px] items-center gap-3 border-b border-divider pl-[18px] pr-[14px] text-muted">
            <ShellIcon name="search" size={18} />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={ut("cmd.placeholder")}
              className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[16px] font-semibold text-text outline-none placeholder:text-muted focus-visible:outline-none"
            />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className={LIST}>
            <Command.Empty className="px-[22px] py-[22px] text-center text-[13px] text-muted">
              {ut("cmd.nothing")}
            </Command.Empty>

            {people.length ? (
              <Command.Group heading={ut("cmd.people")}>
                {people.map((p) => (
                  <Command.Item
                    key={p.id}
                    value={`${p.fullName} ${p.email}`}
                    onSelect={() => go(`/patients/${p.id}`)}
                    className={ROW}
                  >
                    <span
                      aria-hidden
                      className="grid size-7 shrink-0 place-items-center rounded-full bg-violet text-[11px] font-extrabold text-onfill"
                    >
                      {initials(p.fullName)}
                    </span>
                    <span className="flex min-w-0 flex-col gap-[2px]">
                      <span className="truncate">{p.fullName}</span>
                      <small className="truncate text-[12px] font-semibold text-muted">{p.email}</small>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}

            {groups.map(([group, items]) => (
              <Command.Group key={group} heading={ut(group)}>
                {items.map((i) => (
                  <Command.Item key={i.key + i.to} value={ut(i.key)} onSelect={() => go(i.to)} className={ROW}>
                    <ShellIcon name={i.icon} size={16} />
                    <span className="truncate">{ut(i.key)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}

            <Command.Group heading={ut("cmd.view")}>
              <Command.Item
                value={ut("cmd.theme")}
                onSelect={() => {
                  onToggleTheme();
                  onClose();
                }}
                className={ROW}
              >
                <ShellIcon name="moon" size={16} />
                <span className="truncate">{ut("cmd.theme")}</span>
              </Command.Item>
              <Command.Item
                value={ut("cmd.density")}
                onSelect={() => {
                  onToggleDensity();
                  onClose();
                }}
                className={ROW}
              >
                <ShellIcon name="layers" size={16} />
                <span className="truncate">{ut("cmd.density")}</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
        <div className="palette-foot flex flex-wrap items-center gap-4 border-t border-divider px-[18px] py-[10px] text-[12px] text-muted">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {ut("cmd.move")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd>
            {ut("cmd.open")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {ut("cmd.close")}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 max-[600px]:hidden">
            <Kbd>
              <ModKey />
            </Kbd>
            <Kbd>K</Kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
