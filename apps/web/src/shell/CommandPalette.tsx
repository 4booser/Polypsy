import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { api } from "../api";
import { useLang } from "../lang";
import { IconSearchGlass } from "../ui";
import type { UiKey } from "@quizzy/shared";

/**
 * Палитра команд.
 *
 * Раньше, чтобы назначить методику конкретному человеку, нужно было
 * вспомнить, на каком экране это делается. Здесь путь один и всегда
 * одинаковый: нажать ⌘K и набрать фамилию или название действия.
 *
 * Поиск пациентов идёт на сервер с задержкой: ФИО зашифровано, и фильтровать
 * на клиенте можно было бы только то, что уже приехало.
 */

interface Item {
  key: UiKey;
  to: string;
  group: UiKey;
  hint?: string;
}

const ITEMS: Item[] = [
  { key: "nav.dashboard", to: "/", group: "cmd.navigate" },
  { key: "nav.worklist", to: "/worklist", group: "cmd.navigate" },
  { key: "nav.cases", to: "/alerts", group: "cmd.navigate" },
  { key: "nav.patients", to: "/patients", group: "cmd.navigate" },
  { key: "nav.referrals", to: "/referrals", group: "cmd.navigate" },
  { key: "nav.surveys", to: "/surveys", group: "cmd.navigate" },
  { key: "nav.batteries", to: "/batteries", group: "cmd.navigate" },
  { key: "nav.schedules", to: "/schedules", group: "cmd.navigate" },
  { key: "nav.invites", to: "/invites", group: "cmd.navigate" },
  { key: "nav.kiosk", to: "/kiosk-sessions", group: "cmd.navigate" },
  { key: "nav.groups", to: "/groups", group: "cmd.navigate" },
  { key: "nav.compare", to: "/compare", group: "cmd.navigate" },
  { key: "nav.surveillance", to: "/surveillance", group: "cmd.navigate" },
  { key: "nav.unitReport", to: "/unit-report", group: "cmd.navigate" },
  { key: "cmd.newSurvey", to: "/constructor", group: "cmd.actions" },
  { key: "cmd.newInvite", to: "/invites", group: "cmd.actions" },
  { key: "cmd.newKiosk", to: "/kiosk-sessions", group: "cmd.actions" },
];

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
  const [people, setPeople] = useState<{ id: string; fullName: string; email: string }[]>([]);

  // поиск людей — на сервере и с задержкой: набор текста не должен
  // дёргать API на каждую букву
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setPeople([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .respondents({ search: query.trim(), limit: "6" })
        .then((page) => setPeople(page.items.map((r) => ({ id: r.userId, fullName: r.fullName, email: r.email }))))
        .catch(() => setPeople([]));
    }, 220);
    return () => clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const groups = useMemo(() => {
    const by = new Map<UiKey, Item[]>();
    for (const i of ITEMS) by.set(i.group, [...(by.get(i.group) ?? []), i]);
    return [...by.entries()];
  }, []);

  if (!open) return null;

  const go = (to: string) => {
    navigate(to);
    onClose();
  };

  return (
    <div className="palette-backdrop" onClick={onClose} role="presentation">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <Command label={ut("cmd.title")} shouldFilter>
          {/*
            Строка поиска со значком и подсказкой выхода.
            Голое поле не говорило, чем оно является: над списком разделов и
            людей оно читалось как ещё один фильтр. Лупа акцентом называет
            место, «esc» — единственный выход, который иначе надо угадать.
          */}
          <div className="palette-search">
            <span aria-hidden className="palette-search-icon">
              <IconSearchGlass />
            </span>
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={ut("cmd.placeholder")}
            />
            <kbd>esc</kbd>
          </div>
          <Command.List>
            <Command.Empty>{ut("cmd.nothing")}</Command.Empty>

            {people.length ? (
              <Command.Group heading={ut("cmd.people")}>
                {people.map((p) => (
                  <Command.Item
                    key={p.id}
                    value={`${p.fullName} ${p.email}`}
                    onSelect={() => go(`/patients/${p.id}`)}
                  >
                    <span className="grow">{p.fullName}</span>
                    <span className="muted">{p.email}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}

            {groups.map(([group, items]) => (
              <Command.Group key={group} heading={ut(group)}>
                {items.map((i) => (
                  <Command.Item key={i.key + i.to} value={ut(i.key)} onSelect={() => go(i.to)}>
                    {ut(i.key)}
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
              >
                {ut("cmd.theme")}
              </Command.Item>
              <Command.Item
                value={ut("cmd.density")}
                onSelect={() => {
                  onToggleDensity();
                  onClose();
                }}
              >
                {ut("cmd.density")}
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
        <div className="palette-foot">
          <span><kbd>↑↓</kbd> {ut("cmd.move")}</span>
          <span><kbd>↵</kbd> {ut("cmd.open")}</span>
          <span><kbd>esc</kbd> {ut("cmd.close")}</span>
        </div>
      </div>
    </div>
  );
}
