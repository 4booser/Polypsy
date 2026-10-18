import type { OpsAlertChannel, OpsAlertEventKind, VitalRating } from "@quizzy/shared";
import { useLang } from "../../../lang";
import { Tooltip } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Tag, type TagTone } from "../../../ui/primitives";
import { OpsIcon, type OpsIconName } from "../icons";
import { EVENT_TAG_KEY, RATING_KEY } from "./model";

/*
 * Общие куски разделов obs2b в «Виразній»: метка оценки замера, метка
 * события оповещения, значок канала и кнопка раскрытия строки. Без
 * инлайновых стилей (apps/web/test/opsObs2b.test.ts): всё — классами.
 */

/* ─────────── оценка замера ─────────── */

/*
 * Оценка — формой и цветом сразу: «добре» — круг зелёным, «потребує уваги» —
 * треугольник янтарём серии, «погано» — квадрат тёмным янтарём. Форма
 * читается и без цвета — в печати и при любом виде дальтонизма; слово
 * стоит рядом в легенде таблицы и в подсказке.
 */
const MARK: Record<VitalRating, string> = {
  good: "rounded-full bg-good",
  needs: "bg-[var(--c2)] [clip-path:polygon(50%_0,100%_100%,0_100%)]",
  poor: "rounded-[2px] bg-warn",
};

export function RatingMark({ rating, className }: { rating: VitalRating; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-2 shrink-0", MARK[rating], className)} />;
}

/** Легенда оценок словами: «● добре ▲ потребує уваги ■ погано» */
export function RatingLegend() {
  const { ut } = useLang();
  const order: VitalRating[] = ["good", "needs", "poor"];
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-small font-semibold">
      {order.map((r) => (
        <li key={r} className={cx("inline-flex items-center gap-1.5", r === "good" ? "text-good" : "text-warn", r === "poor" && "font-extrabold")}>
          <RatingMark rating={r} />
          {ut(RATING_KEY[r])}
        </li>
      ))}
    </ul>
  );
}

/* ─────────── события оповещений ─────────── */

const EVENT_TAG: Record<OpsAlertEventKind, { tone: TagTone; icon: OpsIconName }> = {
  fired: { tone: "attention", icon: "circle-x" },
  repeat: { tone: "attention", icon: "repeat" },
  resolved: { tone: "good", icon: "circle-check" },
  test: { tone: "info", icon: "flask-conical" },
};

/** Событие истории пилюлей: «збій», «досі триває» — янтарём; «відновлено» — зелёным; «тестове» — синим */
export function EventTag({ kind }: { kind: OpsAlertEventKind }) {
  const { ut } = useLang();
  const t = EVENT_TAG[kind];
  return (
    <Tag tone={t.tone} icon={<OpsIcon name={t.icon} />}>
      {ut(EVENT_TAG_KEY[kind])}
    </Tag>
  );
}

/** Значок события в списке «Як спрацьовувало»: та же форма, что у пилюли, плиткой */
export function EventGlyph({ kind }: { kind: OpsAlertEventKind }) {
  const t = EVENT_TAG[kind];
  return (
    <span
      aria-hidden
      className={cx(
        "grid size-7 shrink-0 place-items-center rounded-[9px]",
        t.tone === "attention" ? "bg-warn-tint text-warn" : t.tone === "good" ? "bg-good-tint text-good" : "bg-info-tint text-info",
      )}
    >
      <OpsIcon name={t.icon} size={15} />
    </span>
  );
}

export const CHANNEL_ICON: Record<OpsAlertChannel, OpsIconName> = { telegram: "send", email: "mail" };

/* ─────────── раскрытие строки ─────────── */

/** Шеврон раскрытия строки списка: повёрнут, пока строка открыта */
export function ExpandButton({
  open,
  controls,
  onToggle,
  labels,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  labels: { open: string; close: string };
}) {
  const label = open ? labels.close : labels.open;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        aria-label={label}
        onClick={onToggle}
        className={cx(
          "inline-grid size-7 min-h-0 cursor-pointer place-items-center rounded-[8px] border-0 p-0 transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
          open ? "bg-violet-tint text-violet-ink" : "bg-transparent text-muted hover:bg-sunk hover:text-text",
        )}
      >
        <OpsIcon name="chevron-right" size={16} className={cx("transition-transform duration-[180ms]", open && "rotate-90")} />
      </button>
    </Tooltip>
  );
}
