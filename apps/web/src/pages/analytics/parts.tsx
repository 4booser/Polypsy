import type { ReactNode } from "react";
import type { RuleAction, RuleCondition, UiKey } from "@quizzy/shared";
import { useLang } from "../../lang";
import { Ic } from "../../ui/icons";
import { Popover } from "../../ui/Popover";
import { Tag } from "../../ui/primitives";
import { AIc } from "./icons";
import { type Op, thresholdText } from "./model";

/*
 * Общие куски перечня и формы моделей: как модель называет свои условия и
 * действия. Перечень печатает их пилюлями (читается без открытия модели),
 * форма — значками тех же видов в шапках блоков и в «Як читається модель».
 */

/** Знак сравнения: в пилюле перечня место узкое, слово «не менше» — в форме и подсказке */
export const OP_SIGN: Record<Op, string> = { ">=": "≥", "<=": "≤", ">": ">", "<": "<" };

/** Значок вида действия — один и тот же в перечне, в форме и в подсказке модели */
export const ACT_ICON: Record<RuleAction["kind"], ReactNode> = {
  notify_duty: <AIc.bellRing size={13} />,
  advise: <AIc.lightbulb size={13} />,
  suggest_survey: <AIc.clipboardPlus size={13} />,
  suggest_pathway: <AIc.route size={13} />,
};

export const ACT_KEY: Record<RuleAction["kind"], UiKey> = {
  advise: "am.actAdvise",
  notify_duty: "am.actNotify",
  suggest_survey: "am.actSuggest",
  suggest_pathway: "am.actPathway",
};

/** Плашка условия (.cn набора): тихий фон, ключевое — жирным */
function Chip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex h-[26px] max-w-full min-w-0 items-center gap-[5px] whitespace-nowrap rounded-[8px] bg-sunk px-[9px] text-small font-semibold text-text-2 [&_b]:font-extrabold [&_b]:text-text">
      {icon ? <span className="inline-flex text-muted">{icon}</span> : null}
      {children}
    </span>
  );
}

/**
 * Условие пилюлей: «PHQ-9 TOT ≥ 20», «Будь-який тест, шкала SUI ≥ 2»,
 * «Прапор ризику: виражений», «Проходжень цього тесту ≥ 2».
 *
 * У условия по шкале на сервере — только код шкалы, без её названия; ради
 * названий пришлось бы читать каждую методику перечня целиком. Код в
 * условии — то, что человек и вписывал.
 */
export function CondChip({ c, testTitle }: { c: RuleCondition; testTitle: (id: string) => string }) {
  const { ut } = useLang();
  if (c.kind === "risk") {
    return (
      <Chip icon={<AIc.flag size={13} />}>
        {ut("am.chipRisk")} <b>{ut(c.severity === "severe" ? "am.riskSevere" : "am.riskModerate").toLowerCase()}</b>
      </Chip>
    );
  }
  if (c.kind === "history") {
    return (
      <Chip icon={<Ic.history size={13} />}>
        {ut("am.chipHistory")}{" "}
        <b>
          {OP_SIGN[">="]} {c.completedAtLeast}
        </b>
      </Chip>
    );
  }
  const normed = c.metric === "normed" ? <span className="font-semibold text-muted">{ut("am.chipNormed")}</span> : null;
  return (
    <Chip>
      {c.surveyId === null ? (
        <span>{ut("am.chipAnyTest")}</span>
      ) : (
        <b className="min-w-0 max-w-[180px] truncate">{testTitle(c.surveyId)}</b>
      )}
      <span>{c.scaleCode}</span>
      <b>
        {OP_SIGN[c.op]} {thresholdText(c.value)}
      </b>
      {normed}
    </Chip>
  );
}

/**
 * Действие пилюлей. Порада — с текстом по наведению: строка перечня не
 * растягивается на абзац совета, а прочитать его можно не открывая модель.
 */
export function ActTag({ a, testTitle }: { a: RuleAction; testTitle: (id: string) => string }) {
  const { ut } = useLang();
  if (a.kind === "suggest_survey") {
    return (
      <Tag icon={ACT_ICON.suggest_survey} className="max-w-full">
        <span className="min-w-0 max-w-[230px] truncate">
          {ut("am.actSuggest")}: {testTitle(a.surveyId)}
        </span>
      </Tag>
    );
  }
  if (a.kind === "advise") {
    return (
      <Popover title={ut("am.actAdvise")} note={ut("am.adviseWhere")} content={<p className="m-0">«{a.text}»</p>} width={320}>
        <span tabIndex={0} className="inline-flex rounded-pill outline-none focus-visible:outline-2 focus-visible:outline-focus">
          <Tag icon={ACT_ICON.advise}>{ut("am.actAdvise")}</Tag>
        </span>
      </Popover>
    );
  }
  if (a.kind === "suggest_pathway") {
    return (
      <Tag icon={ACT_ICON.suggest_pathway} className="max-w-full">
        <span className="min-w-0 max-w-[230px] truncate">
          {ut("am.actPathway")}: {a.pathwayId}
        </span>
      </Tag>
    );
  }
  return <Tag icon={ACT_ICON.notify_duty}>{ut("am.actNotify")}</Tag>;
}
