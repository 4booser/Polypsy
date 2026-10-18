import { useState, type ReactNode } from "react";
import { api } from "../api";
import { NotLoaded, loadView, useAction } from "../ui";
import { MenuButton, MenuSeparator, menuItemClass } from "../ui/menu";
import { Button, buttonClass, type ButtonProps } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource, type Resource } from "../useResource";

type Kind = "conclusion" | "note";
type Library = Awaited<ReturnType<typeof api.templates>>;

/**
 * Библиотека шаблонов и формулировок отделения.
 *
 * Шаблон — заготовка целого текста (заключение, запись приёма): он заменяет
 * набранное. Формулировка — оборот, который вставляется в место курсора и
 * ничего не стирает. Пополнять библиотеку удобнее всего оттуда, где
 * формулировка родилась: специалист замечает нужный оборот в момент, когда
 * его пишет, а не когда заполняет справочники.
 */

/** Вставка в место курсора поля; без поля — в конец через пробел */
export function insertAtCursor(
  body: string,
  value: string,
  onChange: (next: string) => void,
  el: HTMLTextAreaElement | null,
): void {
  if (!el) {
    onChange(value ? `${value} ${body}` : body);
    return;
  }
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  onChange(`${value.slice(0, start)}${body}${value.slice(end)}`);
  queueMicrotask(() => {
    el.focus();
    el.setSelectionRange(start + body.length, start + body.length);
  });
}

/** «Зберегти як формулювання»: выделенное в поле — в библиотеку под названием */
function useSavePhrase(value: string, textareaRef: React.RefObject<HTMLTextAreaElement | null>, reload: () => void) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const save = () =>
    run(async () => {
      const el = textareaRef.current;
      const picked = el && el.selectionStart !== el.selectionEnd ? value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0) : "";
      if (!picked.trim()) {
        window.alert(ut("tpl.selectFirst"));
        return false;
      }
      const title = window.prompt(ut("tpl.addTitle"), picked.slice(0, 60));
      if (!title) return false;
      await api.createTemplate({ kind: "phrase", title, body: picked });
      reload();
    }, ut("tpl.added"));
  return { save, busy };
}

/**
 * Раскрывающаяся библиотека под полем (запись приёма): шаблоны и
 * формулировки плашками, «Зберегти як формулювання», «Скасувати».
 */
export function TemplatePicker({
  kind,
  value,
  onChange,
  textareaRef,
  variant = "ghost",
}: {
  kind: Kind;
  value: string;
  onChange: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  variant?: ButtonProps["variant"];
}) {
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const res = useResource(() => (open ? api.templates() : Promise.resolve(null)), [open]);
  const phrase = useSavePhrase(value, textareaRef, res.reload);

  if (!open) {
    return (
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {ut("tpl.insert")}
      </Button>
    );
  }

  const all = res.data?.items ?? [];
  const templates = all.filter((t) => t.kind === kind);
  const phrases = all.filter((t) => t.kind === "phrase");

  return (
    <div className="flex w-full flex-col gap-3 rounded-panel border border-border bg-panel p-3 shadow-tile">
      <LibraryState res={res} />
      {templates.length ? (
        <Group title={ut("tpl.templates")}>
          {templates.map((t) => (
            <Button
              key={t.id}
              size="xs"
              onClick={() => {
                if (value.trim() && !window.confirm(ut("tpl.replaces"))) return;
                onChange(t.body);
                setOpen(false);
              }}
            >
              {t.title}
            </Button>
          ))}
        </Group>
      ) : null}
      {phrases.length ? (
        <Group title={ut("tpl.phrases")}>
          {phrases.map((t) => (
            <Button key={t.id} size="xs" variant="ghost" onClick={() => insertAtCursor(t.body, value, onChange, textareaRef.current)}>
              {t.title}
            </Button>
          ))}
        </Group>
      ) : null}
      <div className="flex flex-wrap gap-2 border-t border-divider pt-3">
        <Button disabled={phrase.busy} size="xs" variant="ghost" onClick={() => void phrase.save()}>
          {ut("tpl.add")}
        </Button>
        <Button size="xs" variant="quiet" onClick={() => setOpen(false)}>
          {ut("visit.cancel")}
        </Button>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="m-0 mb-1.5 text-caption font-bold text-muted">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/**
 * Шаблоны и формулировки меню на полосе инструментов редактора (заключение):
 * «Шаблони» заменяет текст целиком, «Формулювання» вставляет в место
 * курсора, последним пунктом — сохранить выделенное как формулировку.
 * Библиотека грузится, когда меню открыли, — и одна на оба меню.
 */
export function TemplateMenus({
  kind,
  value,
  onChange,
  textareaRef,
  templateIcon,
  phraseIcon,
  disabled,
}: {
  kind: Kind;
  value: string;
  onChange: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  templateIcon?: ReactNode;
  phraseIcon?: ReactNode;
  disabled?: boolean;
}) {
  const { ut } = useLang();
  const trigger = (label: string, icon: ReactNode) =>
    function Trigger(props: { "aria-haspopup": "menu"; "aria-expanded": boolean; "aria-controls": string | undefined; onClick: () => void }) {
      return (
        <button type="button" disabled={disabled} className={buttonClass("ghost", "xs")} {...props}>
          {icon}
          {label}
        </button>
      );
    };
  return (
    <>
      <MenuButton label={ut("tpl.templates")} trigger={trigger(ut("tpl.templates"), templateIcon)} align="right-out">
        {(close) => <LibraryItems kind={kind} what="templates" value={value} onChange={onChange} textareaRef={textareaRef} close={close} />}
      </MenuButton>
      <MenuButton label={ut("tpl.phrases")} trigger={trigger(ut("tpl.phrases"), phraseIcon)} align="right-out">
        {(close) => <LibraryItems kind={kind} what="phrases" value={value} onChange={onChange} textareaRef={textareaRef} close={close} />}
      </MenuButton>
    </>
  );
}

/** Пункты открытого меню библиотеки: грузит её при открытии, общий кэш на оба меню */
function LibraryItems({
  kind,
  what,
  value,
  onChange,
  textareaRef,
  close,
}: {
  kind: Kind;
  what: "templates" | "phrases";
  value: string;
  onChange: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  close: () => void;
}) {
  const { ut } = useLang();
  const res = useResource(() => api.templates(), [], { key: "templates.library", staleMs: 60_000 });
  const phrase = useSavePhrase(value, textareaRef, res.reload);
  const all = res.data?.items ?? [];
  const items = all.filter((t) => (what === "templates" ? t.kind === kind : t.kind === "phrase"));
  const empty = (
    <p className="m-0 px-2.5 py-2 text-small text-muted">{res.error ? ut("common.error") : res.data ? ut("tpl.none") : ut("common.loading")}</p>
  );
  return (
    <>
      {items.length
        ? items.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className={menuItemClass()}
              onClick={() => {
                close();
                if (what === "phrases") {
                  insertAtCursor(t.body, value, onChange, textareaRef.current);
                  return;
                }
                if (value.trim() && !window.confirm(ut("tpl.replaces"))) return;
                onChange(t.body);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
            </button>
          ))
        : empty}
      {what === "phrases" ? (
        <>
          <MenuSeparator />
          <button
            type="button"
            role="menuitem"
            className={menuItemClass()}
            onClick={() => {
              close();
              void phrase.save();
            }}
          >
            <span className="min-w-0 flex-1 truncate">{ut("tpl.add")}</span>
          </button>
        </>
      ) : null}
    </>
  );
}

export function LibraryState({
  res,
}: {
  res: Pick<Resource<Library | null>, "data" | "error" | "loading" | "reload" | "updatedAt">;
}) {
  const { ut } = useLang();
  const view = loadView(res, (d) => !d || d.items.length === 0);
  if (view === "wait" || view === "failed") return <NotLoaded res={res} rows={1} />;
  return view === "empty" ? <p className="m-0 text-small text-muted">{ut("tpl.none")}</p> : null;
}
