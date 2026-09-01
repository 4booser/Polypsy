import { useState } from "react";
import { api } from "../api";
import { useAction } from "../ui";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

type Kind = "conclusion" | "note";

/**
 * Вставка из библиотеки отделения.
 *
 * Шаблон подставляется вместо набранного, формулировка — в место курсора.
 * Это разное поведение, а не разное оформление: заготовка документа поверх
 * написанного абзаца затрёт работу, а оборот в середине фразы — ровно то,
 * зачем он и нужен.
 */
export function TemplatePicker({
  kind,
  value,
  onChange,
  textareaRef,
}: {
  kind: Kind;
  value: string;
  onChange: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { ut } = useLang();
  const { run } = useAction();
  const [open, setOpen] = useState(false);
  const res = useResource(() => (open ? api.templates() : Promise.resolve(null)), [open]);

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {ut("tpl.insert")}
      </Button>
    );
  }

  const all = res.data?.items ?? [];
  const templates = all.filter((t) => t.kind === kind);
  const phrases = all.filter((t) => t.kind === "phrase");

  /*
   * Вставка в место курсора, а не в конец.
   *
   * Формулировку дописывают в середину предложения — «жалоб не предъявляет»
   * идёт после «на момент осмотра». Приклеенная в конец, она превращает
   * текст в набор обрывков, и специалист перестаёт ею пользоваться.
   */
  const insertAtCursor = (body: string) => {
    const el = textareaRef.current;
    if (!el) {
      onChange(value ? `${value} ${body}` : body);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${body}${value.slice(end)}`);
    // курсор остаётся после вставленного: следующее слово печатают дальше
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(start + body.length, start + body.length);
    });
  };

  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-hairline p-2">
      {all.length === 0 && !res.loading ? (
        <p className="text-caption text-muted">{ut("tpl.none")}</p>
      ) : null}

      {templates.length ? (
        <div>
          <p className="mb-1 text-micro uppercase tracking-[var(--tracking-label)] text-faint">
            {ut("tpl.templates")}
          </p>
          <div className="flex flex-wrap gap-1">
            {templates.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (value.trim() && !window.confirm(ut("tpl.replaces"))) return;
                  onChange(t.body);
                  setOpen(false);
                }}
              >
                {t.title}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {phrases.length ? (
        <div>
          <p className="mb-1 text-micro uppercase tracking-[var(--tracking-label)] text-faint">
            {ut("tpl.phrases")}
          </p>
          <div className="flex flex-wrap gap-1">
            {phrases.map((t) => (
              <Button key={t.id} size="sm" variant="ghost" onClick={() => insertAtCursor(t.body)}>
                {t.title}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex gap-2">
        {/*
          Пополнять библиотеку удобнее всего оттуда, где формулировка
          родилась: специалист замечает нужный оборот в момент, когда его
          пишет, а не когда заполняет справочники.
        */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            run(async () => {
              const el = textareaRef.current;
              const picked =
                el && el.selectionStart !== el.selectionEnd
                  ? value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
                  : "";
              if (!picked.trim()) {
                window.alert(ut("tpl.selectFirst"));
                return;
              }
              const title = window.prompt(ut("tpl.addTitle"), picked.slice(0, 60));
              if (!title) return;
              await api.createTemplate({ kind: "phrase", title, body: picked });
              await res.reload();
            }, ut("tpl.added"))
          }
        >
          {ut("tpl.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {ut("visit.cancel")}
        </Button>
      </div>
    </div>
  );
}
