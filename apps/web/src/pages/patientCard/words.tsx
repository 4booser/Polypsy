import { pointValueTop, type DynamicsPoint, type UiKey } from "@quizzy/shared";
import { useLang } from "../../lang";
import { Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { shownNumber, shownValue, signedShown } from "../patients/model";
import type { PictureRow } from "./clinical";
import { dm } from "./format";

/*
 * Балл и сдвиг словами — одни и те же на «Огляді», в «Динаміці» рабочего
 * места и в «Хто це» реестра: «11 з 27», «значуще погіршення · +8 з 13.05».
 * Статистика (порог MDC95, |RCI| > 1,96) — в подсказке, а не в строке.
 */

/** Сдвиг словом: «значуще погіршення» — янтарём, «значуще покращення» — зелёным, остальное — спокойно */
const VERDICT: Record<PictureRow["verdict"], { key: UiKey; tone: string }> = {
  worse: { key: "ws.vWorse", tone: "font-bold text-warn" },
  better: { key: "ws.vBetter", tone: "font-bold text-good" },
  changed: { key: "ws.vChanged", tone: "font-bold text-text" },
  within: { key: "ws.vWithin", tone: "text-text-2" },
  unknown: { key: "ws.vUnknown", tone: "text-text-2" },
  single: { key: "ws.vSingle", tone: "text-muted" },
  incomparable: { key: "ws.vIncomparable", tone: "text-muted" },
};

const INCOMPARABLE = { version: "rch.versions", units: "rch.units", unreliable: "rch.unreliable" } as const;

/**
 * «11 з 27», «T-бал 64», «стен 7», «49%» — тем же правилом, что подпись
 * значения на экране прохождения и в мобилке (shared, pointValueText): «з
 * N» — только у сырого балла; у T-балла и стена «из скольких» нет, а доля —
 * процентом. Отличие одно — дробь запятой языка («64,2»).
 */
export function ScoreText({ p, big }: { p: DynamicsPoint; big?: boolean }) {
  const { ut } = useLang();
  const v = shownValue(p.rawScore, p.normalization);
  const units = p.normalized === false ? "raw" : (p.normalization ?? "raw");
  const top = units === "raw" ? pointValueTop(p) : null;
  return (
    <span className="whitespace-nowrap tabular-nums">
      {units === "tscore" ? <small className="mr-1 text-caption font-bold text-muted">{ut("norm.tscore")}</small> : null}
      {units === "sten" ? <small className="mr-1 text-caption font-bold text-muted">{ut("norm.sten")}</small> : null}
      <b className={cx("font-extrabold text-text", big ? "text-[17px]" : "text-[15px]")}>
        {v.text}
        {v.unit}
      </b>
      {top !== null ? <small className="ml-1 text-caption font-semibold text-muted">{ut("ws.ofMax").replace("{n}", shownNumber(top))}</small> : null}
    </span>
  );
}

/** Сдвиг строки словами: вердикт, число и с какого замера; основа — в подсказке */
export function ChangeWords({ r }: { r: PictureRow }) {
  const { ut } = useLang();
  const verdict = VERDICT[r.verdict];
  const ratio = r.last.normalization === "ratio";
  const pp = ratio ? ` ${ut("card.pp")}` : "";
  const since = ut("ws.since").replace("{d}", dm(r.first.submittedAt));
  const word =
    r.verdict === "incomparable" && r.incomparable ? ut(INCOMPARABLE[r.incomparable]) : r.verdict === "single" ? ut("ws.vSingle") : ut(verdict.key);
  const delta = r.delta !== null ? `${signedShown(r.delta)}${r.delta ? pp : ""}` : null;
  const tip =
    r.verdict === "within" && r.threshold !== null
      ? ut("ws.tipWithin").replace("{n}", `${shownNumber(r.threshold)}${pp}`)
      : r.verdict === "unknown"
        ? ut("ws.tipUnknown")
        : (r.verdict === "worse" || r.verdict === "better" || r.verdict === "changed") && r.threshold !== null
          ? ut("ws.tipReliable").replace("{n}", `${shownNumber(r.threshold)}${pp}`)
          : null;
  const body = (
    <span className="min-w-0 text-small leading-[17px]">
      <span className={verdict.tone}>{word}</span>
      {delta !== null ? (
        <span className="whitespace-nowrap text-text-2">
          {" · "}
          <b className="font-bold tabular-nums text-text">{delta}</b> {since}
        </span>
      ) : null}
    </span>
  );
  return tip ? (
    <Tooltip label={tip}>
      <span tabIndex={0} className="min-w-0 cursor-default rounded-[4px] outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]">
        {body}
      </span>
    </Tooltip>
  ) : (
    body
  );
}

