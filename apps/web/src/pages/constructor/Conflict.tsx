import { ApiError } from "../../api";
import { useLang } from "../../lang";
import { Button } from "../../ui/primitives";

/*
 * Одновременная правка методики (волна 12).
 *
 * Конструктор шлёт baseVersionId — версию, от которой начата правка. Если
 * между открытием и сохранением методику сохранил кто-то другой (или та же
 * методика в соседней вкладке), сервер отвечает 409, а не пишет поверх:
 * прежде вторая правка молча выбрасывала первую. Здесь этот отказ из
 * красной строки ошибки превращается в объяснение и выбор: перечитать
 * методику с сервера или сперва забрать свои правки текстом (JSON), чтобы
 * повторить их на свежей версии.
 */

export type SaveFailure = { conflict: true; message: string } | { conflict: false; message: string };

/** Что за отказ пришёл на сохранение: конфликт версий или прочее */
export function saveFailure(error: unknown, fallback: string): SaveFailure {
  if (error instanceof ApiError && error.status === 409) return { conflict: true, message: error.message };
  return { conflict: false, message: error instanceof Error ? error.message : fallback };
}

export function VersionConflict({
  message,
  onReload,
  onShowMine,
}: {
  /** Текст сервера — err.surveyVersionConflict на языке консоли */
  message: string;
  onReload: () => void;
  onShowMine: () => void;
}) {
  const { ut } = useLang();
  return (
    /* янтарь — «требует внимания»: сохранение не прошло, и решать человеку */
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[5px] border border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-accent-soft px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 text-small font-bold text-text">{ut("co.conflictTitle")}</p>
        <p className="m-0 mt-[4px] text-small text-text">{message}</p>
        <p className="m-0 mt-[4px] text-[13px] text-muted">{ut("co.conflictHint")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" size="sm" onClick={onShowMine}>
          {ut("co.conflictShowMine")}
        </Button>
        <Button size="sm" onClick={onReload}>
          {ut("co.conflictReload")}
        </Button>
      </div>
    </div>
  );
}
