import { useMemo, useState, type ReactNode } from "react";
import { UI, type ContentLang, type UiKey } from "@quizzy/shared";
import { newUid, type DraftQuestion } from "./model";
import { Labeled } from "./fields";
import { CnIc } from "./icons";
import { useLang } from "../../lang";
import { Drawer, DrawerSection } from "../../ui";
import { Button, ErrorText, Field, Segmented, Textarea } from "../../ui/primitives";

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

/**
 * Дыры и дубли в нумерации — почти наверняка ошибка распознавания PDF.
 *
 * `ut` необязателен и по умолчанию не задан: функция разбора не привязана к
 * интерфейсу и должна остаться проверяемой без React вокруг. Когда её вызывает
 * экран, он передаёт свой `ut` — и подписи приходят на выбранном языке; без
 * него текст остаётся русским, как было раньше.
 */
export function numberingProblems(items: ParsedItem[], ut?: (key: UiKey) => string): string[] {
  // без ut (например, в тестах) — русский по умолчанию, как раньше
  const t = (key: UiKey) => (ut ? ut(key) : UI[key].ru);
  const problems: string[] = [];
  const numbers = items.map((i) => i.n).filter((n): n is number => n !== null);
  if (!numbers.length) return problems;
  const seen = new Set<number>();
  for (const n of numbers) {
    if (seen.has(n)) problems.push(`${t("bp.numberWord")} ${n} ${t("bp.duplicateSuffix")}`);
    seen.add(n);
  }
  const max = Math.max(...numbers);
  for (let i = 1; i <= max; i++) {
    if (!seen.has(i)) problems.push(`${t("bp.missingNumber")} ${i}`);
  }
  return problems.slice(0, 8);
}

/** Как разобрать вставленное: язык текста и вид пунктов */
export interface PasteKind {
  lang: ContentLang;
  type: "yesno" | "single";
}

/** Пункты из разобранного текста — в выбранный язык; второй язык остаётся пустым и виден как незаполненный */
export function pastedQuestions(items: ParsedItem[], kind: PasteKind): DraftQuestion[] {
  return items.map((item) => ({
    uid: newUid(),
    type: kind.type,
    title: kind.lang === "uk" ? { uk: item.text, ru: "" } : { uk: "", ru: item.text },
    required: true,
    options:
      kind.type === "yesno"
        ? [
            { uid: newUid(), text: { uk: UI["bp.yes"].uk, ru: UI["bp.yes"].ru }, keyCode: "yes" },
            { uid: newUid(), text: { uk: UI["bp.no"].uk, ru: UI["bp.no"].ru }, keyCode: "no" },
          ]
        : [],
  }));
}

/**
 * Ящик «Вставка пунктів з тексту» (макет methods-bulk-paste-dialog).
 *
 * Ящик, а не панель посреди формы: вставка — действие над методикой, и
 * страница под ним остаётся на месте. Ящик не размонтируется при закрытии —
 * вставленный текст живёт, пока не применён; закрытие с текстом говорит
 * «чернетку збережено» и даёт вернуться.
 *
 * Два места зовут его по-разному: старт новой методики заводит из пунктов
 * черновик, конструктор — дописывает их в конец списка. Поэтому подпись
 * основной кнопки и строка над ней приходят снаружи.
 */
export function BulkPaste({
  open,
  onClose,
  onReturn,
  onApply,
  applyLabel,
  sub,
  note,
  defaultLang = "uk",
}: {
  open: boolean;
  onClose: () => void;
  onReturn?: () => void;
  onApply: (questions: DraftQuestion[], kind: PasteKind) => void;
  applyLabel: string;
  /** Подпись под заголовком: имя методики, в которую вставляют */
  sub?: ReactNode;
  /** Строка над кнопками: куда лягут пункты */
  note?: ReactNode;
  defaultLang?: ContentLang;
}) {
  const { ut } = useLang();
  const [raw, setRaw] = useState("");
  const [lang, setLang] = useState<ContentLang>(defaultLang);
  const [type, setType] = useState<"yesno" | "single">("yesno");

  const items = useMemo(() => parseBulk(raw), [raw]);
  const problems = useMemo(() => numberingProblems(items, ut), [items, ut]);

  function apply() {
    onApply(pastedQuestions(items, { lang, type }), { lang, type });
    setRaw("");
    onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      wide
      title={ut("bp.title")}
      sub={sub}
      icon={<CnIc.paste size={18} />}
      dirty={raw.trim() !== ""}
      draftName={ut("cst.pasteDraftName")}
      note={note}
      noteIcon={note ? <CnIc.folder size={14} /> : undefined}
      footer={
        <>
          <Button variant="primary" icon={<CnIc.listPlus />} disabled={!items.length} onClick={apply}>
            {applyLabel}
          </Button>
          <Button onClick={onClose}>{ut("bp.close")}</Button>
        </>
      }
    >
      <DrawerSection>
        <p className="m-0 mb-3 text-small text-text-2">{ut("bp.hint")}</p>
        <Field label={ut("cst.pasteText")}>
          <Textarea
            data-autofocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={12}
            placeholder={ut("bp.placeholderExample")}
            spellCheck={false}
            className="leading-[21px]"
          />
        </Field>
      </DrawerSection>
      <DrawerSection title={ut("cst.howToRead")}>
        <Labeled label={ut("bp.lang")}>
          <Segmented
            wide
            label={ut("bp.lang")}
            value={lang}
            onChange={setLang}
            items={[
              { key: "uk", label: ut("bp.langUk") },
              { key: "ru", label: ut("bp.langRu") },
            ]}
          />
        </Labeled>
        <Labeled label={ut("bp.type")} hint={type === "single" ? ut("cst.optionsLater") : undefined}>
          <Segmented
            wide
            label={ut("bp.type")}
            value={type}
            onChange={setType}
            items={[
              { key: "yesno", label: ut("bp.yesNo") },
              { key: "single", label: ut("cst.single") },
            ]}
          />
        </Labeled>
      </DrawerSection>
      <DrawerSection title={ut("cst.result")}>
        {items.length ? (
          <div className="flex items-start gap-3 rounded-panel bg-sunk px-3.5 py-3">
            <span className="text-[26px] font-extrabold leading-none tracking-[-0.02em] tabular-nums text-text">
              {items.length}
            </span>
            <div className="min-w-0 text-small text-text-2">
              <b className="block font-bold text-text">{ut("bp.recognizedCount")}</b>
              {ut("bp.firstItem")} «{items[0]!.text.slice(0, 80)}»
              {items.length > 1 ? (
                <>
                  , {ut("bp.lastItem")} «{items[items.length - 1]!.text.slice(0, 80)}»
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="m-0 text-small text-muted">{ut("cst.nothingYet")}</p>
        )}
        {problems.length ? (
          /* нумерация подозрительна — почти наверняка ошибка распознавания PDF: внимание, не риск */
          <ErrorText tone="warn" className="mt-3">
            {ut("bp.numberingWarn")} {problems.join("; ")}.
          </ErrorText>
        ) : null}
      </DrawerSection>
    </Drawer>
  );
}
