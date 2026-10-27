import { useLang } from "../../lang";
import { cx } from "../../ui/cx";

/**
 * «Джерело» — откуда текст и пороги методики, для персонала (surveys.source_note).
 *
 * Раньше это стояло в описании, и описание читал обследуемый на первом экране
 * методики. Теперь описание — две строки «что и за какой срок», а
 * происхождение — здесь: в паспорте («Про методику», «Коротко про методику»).
 * Свёрнуто: абзац о выборке и переводе нужен, когда сомневаются в пороге, а
 * не при каждом взгляде на паспорт. Нативный details — открывается и с
 * клавиатуры, и диктор его называет.
 */
export function SourceNote({ text, className }: { text: string | null | undefined; className?: string }) {
  const { ut } = useLang();
  if (!text?.trim()) return null;
  return (
    <details className={cx("min-w-0", className)}>
      <summary className="cursor-pointer text-small font-bold text-violet-ink">{ut("mc.ovSource")}</summary>
      <p className="m-0 mt-1.5 whitespace-pre-line break-words text-small text-text-2">{text}</p>
    </details>
  );
}
