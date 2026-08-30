import { useMemo, useState } from "react";
import { newUid, type DraftQuestion } from "./model";
import { useLang } from "../../lang";
import { Grid, Panel } from "../../ui/layout";
import { Button, Field, Select, Textarea } from "../../ui/primitives";

/**
 * Массовая вставка пунктов из текста пособия.
 *
 * Главный сценарий переноса методики: скопировать колонку пунктов из PDF и
 * получить сразу 45–200 вопросов. Разбор терпим к мусору распознавания:
 * номера «1.», «1)», «1 —» срезаются, переносы внутри пункта склеиваются
 * (строка без номера продолжает предыдущий пункт), пустые строки игнорируются.
 */

interface ParsedItem {
  n: number | null;
  text: string;
}

export function parseBulk(raw: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const numbered =
      trimmed.match(/^(\d{1,3})\s*[.)\]:—–-]\s*(.+)$/) ?? trimmed.match(/^(\d{1,3})\s+(.+)$/);
    if (numbered) {
      items.push({ n: Number(numbered[1]), text: numbered[2]!.trim() });
    } else if (items.length) {
      // строка без номера — хвост предыдущего пункта, разорванного переносом
      items[items.length - 1]!.text += ` ${trimmed}`;
    } else {
      items.push({ n: null, text: trimmed });
    }
  }
  return items;
}

/** Дыры и дубли в нумерации — почти наверняка ошибка распознавания PDF */
export function numberingProblems(items: ParsedItem[]): string[] {
  const problems: string[] = [];
  const numbers = items.map((i) => i.n).filter((n): n is number => n !== null);
  if (!numbers.length) return problems;
  const seen = new Set<number>();
  for (const n of numbers) {
    if (seen.has(n)) problems.push(`Номер ${n} встречается дважды`);
    seen.add(n);
  }
  const max = Math.max(...numbers);
  for (let i = 1; i <= max; i++) {
    if (!seen.has(i)) problems.push(`Пропущен номер ${i}`);
  }
  return problems.slice(0, 8);
}

export function BulkPaste({
  onAppend,
  onClose,
}: {
  onAppend: (questions: DraftQuestion[]) => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const [raw, setRaw] = useState("");
  const [lang, setLang] = useState<"uk" | "ru">("uk");
  const [type, setType] = useState<"yesno" | "single">("yesno");

  const items = useMemo(() => parseBulk(raw), [raw]);
  const problems = useMemo(() => numberingProblems(items), [items]);

  function apply() {
    const questions: DraftQuestion[] = items.map((item) => ({
      uid: newUid(),
      type,
      // текст кладётся в выбранный язык; второй остаётся пустым и виден
      // в форме как незаполненный — честнее, чем дублировать не тот язык
      title: lang === "uk" ? { uk: item.text, ru: "" } : { uk: "", ru: item.text },
      required: true,
      options:
        type === "yesno"
          ? [
              { text: { uk: ut("bp.yes"), ru: "Да" }, keyCode: "yes" },
              { text: { uk: "Ні", ru: ut("bp.no") }, keyCode: "no" },
            ]
          : [],
    }));
    onAppend(questions);
    onClose();
  }

  return (
    <Panel
      title={ut("bp.title")}
      actions={<Button variant="quiet" onClick={onClose}>{ut("bp.close")}</Button>}
      hint="Скопируйте пункты из пособия — по одному на строку, с номерами или без. Номера «1.», «1)»
        срезаются; строка без номера приклеивается к предыдущему пункту (переносы из PDF)."
    >
      <Textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={12}
        placeholder={"1. Чи може життя втратити цінність?\n2. Життя іноді гірше за смерть.\n…"}
        spellCheck={false}
      />
      <Grid min={200} className="mt-3">
        <Field label={ut("bp.lang")}>
          <Select value={lang} onChange={(e) => setLang(e.target.value as never)}>
            <option value="uk">украинский</option>
            <option value="ru">русский</option>
          </Select>
        </Field>
        <Field label={ut("bp.type")}>
          <Select value={type} onChange={(e) => setType(e.target.value as never)}>
            <option value="yesno">{ut("bp.yesNo")}</option>
            <option value="single">{ut("bp.single")}</option>
          </Select>
        </Field>
      </Grid>

      {items.length ? (
        <p className="mt-3 text-caption text-muted">
          Распознано пунктов: <strong className="font-medium text-text">{items.length}</strong>
          {items[0] ? <> · первый: «{items[0].text.slice(0, 60)}»</> : null}
          {items.length > 1 ? <> · последний: «{items[items.length - 1]!.text.slice(0, 60)}»</> : null}
        </p>
      ) : null}
      {problems.length ? (
        /*
         * Нумерация подозрительна — почти наверняка ошибка распознавания PDF.
         * Это ровно случай «требует внимания» до сохранения, поэтому янтарь
         * здесь уместен.
         */
        <div className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-accent-soft p-3 text-caption text-accent">
          Нумерация подозрительна — проверьте исходный текст:
          {problems.map((p) => (
            <div key={p}>• {p}</div>
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        <Button variant="primary" disabled={!items.length} onClick={apply}>
          Добавить {items.length} пунктов
        </Button>
      </div>
    </Panel>
  );
}
