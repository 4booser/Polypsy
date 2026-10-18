import type { ReactNode } from "react";
import { renderNote, serverText, type Issue, type Lang } from "@quizzy/shared";
import { api } from "../../api";
import { dateTime } from "../../format";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { ShellIcon } from "../../shell/icons";
import { Callout, Drawer, DrawerSection, Ic, Loading } from "../../ui";
import { IconTile } from "../../ui/layout";
import { Button, Tag } from "../../ui/primitives";
import { CnIc } from "./icons";

/** Куда ведёт замечание проверки: пункт, шкала или методика целиком */
export type IssueTarget = { kind: "item"; n: number } | { kind: "scale"; code: string } | null;

const LANGS: Lang[] = ["uk", "ru", "en"];

/**
 * Место замечания — по строке `where` проверки («Пункт 7», «Шкала PHQ9»).
 *
 * Сервер пишет её на языке спросившего; номер пункта и код шкалы в
 * подстановках не лежат, поэтому место узнаётся сравнением с той же фразой
 * словаря сервера на каждом языке — а не разбором слов, которых в трёх
 * языках три разных.
 */
export function issueTarget(issue: Issue, items: number, scaleCodes: string[]): IssueTarget {
  for (const lang of LANGS) {
    for (let n = 1; n <= items; n++) {
      if (issue.where === serverText("val.where.item", lang, { n })) return { kind: "item", n };
    }
    for (const code of scaleCodes) {
      if (issue.where === serverText("val.where.scale", lang, { code })) return { kind: "scale", code };
    }
  }
  return null;
}

/**
 * «Перевірка структури» — ящик (макет methods-constructor): ошибки,
 * предупреждения и «Перейти» к месту. Проверка формальная — тот же
 * validateSurvey, что держит публикацию на сервере (POST /api/surveys/validate).
 */
export function CheckDrawer({
  open,
  onClose,
  issues,
  checking,
  error,
  sub,
  items,
  scaleCodes,
  onGoto,
  onRecheck,
  footer,
  note,
}: {
  open: boolean;
  onClose: () => void;
  issues: Issue[] | null;
  checking: boolean;
  error: string | null;
  sub: ReactNode;
  items: number;
  scaleCodes: string[];
  onGoto: (target: Exclude<IssueTarget, null>) => void;
  onRecheck: () => void;
  footer: ReactNode;
  note?: ReactNode;
}) {
  const { ut } = useLang();
  const errors = (issues ?? []).filter((i) => i.level === "error");
  const warnings = (issues ?? []).filter((i) => i.level === "warning");
  const row = (it: Issue, k: number) => {
    const target = issueTarget(it, items, scaleCodes);
    return (
      <li key={k} className="flex items-start gap-3 border-t border-divider py-2.5 first:border-t-0 first:pt-0">
        <IconTile icon={<Ic.circleAlert size={15} />} tone="warn" size={28} />
        <span className="min-w-0 flex-1 text-small text-text-2">
          <b className="block font-extrabold text-text">{it.where}</b>
          {it.message}
        </span>
        {target ? (
          <Button variant="ghost" size="xs" onClick={() => onGoto(target)}>
            {ut("ce.goTo")}
          </Button>
        ) : null}
      </li>
    );
  };
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={ut("co.checkStructure")}
      sub={sub}
      icon={<ShellIcon name="list-checks" size={18} />}
      note={note}
      noteIcon={<CnIc.gitBranch size={14} />}
      footer={footer}
    >
      {error ? (
        <DrawerSection>
          <Loading bare error={error} onRetry={onRecheck} />
        </DrawerSection>
      ) : issues === null ? (
        <DrawerSection>
          <Loading bare rows={3} />
        </DrawerSection>
      ) : (
        <>
          {/* заголовок — признак для смоука: «Структурних зауважень немає» или «Зауважень: …» */}
          <DrawerSection>
            <h3 className="m-0 text-h3 font-extrabold text-text" aria-live="polite">
              {issues.length === 0
                ? ut("co.noIssues")
                : `${ut("co.issuesSummary")}: ${errors.length} ${ut("co.errorsCount")}, ${warnings.length} ${ut("co.warningsCount")}`}
            </h3>
            {checking ? <p className="m-0 mt-1 text-small text-muted">{ut("ce.checking")}</p> : null}
          </DrawerSection>
          {errors.length ? (
            <DrawerSection title={ut("ce.errors")} sub={ut("ce.errorsSub")}>
              <ul className="m-0 list-none p-0">{errors.map(row)}</ul>
            </DrawerSection>
          ) : null}
          {warnings.length ? (
            <DrawerSection title={ut("ce.warnings")} sub={ut("ce.warningsSub")}>
              <ul className="m-0 list-none p-0">{warnings.map(row)}</ul>
            </DrawerSection>
          ) : null}
          {errors.length === 0 ? (
            <DrawerSection>
              <div className="flex items-center gap-3 text-small text-text-2">
                <IconTile icon={<Ic.check size={15} />} tone="good" size={28} />
                {ut("ce.noErrors")}
              </div>
            </DrawerSection>
          ) : null}
          <DrawerSection>
            <Callout kind="line">{ut("co.checkHint")}</Callout>
          </DrawerSection>
        </>
      )}
    </Drawer>
  );
}

/**
 * «Історія змін» — версии методики (GET /api/surveys/:id/versions): номер,
 * когда, заметка и сколько прохождений на ней собрано. Каждое сохранение
 * содержимого — новая версия; прохождения старой ссылаются на неё и не
 * перечитываются по новой.
 */
export function HistoryDrawer({
  open,
  onClose,
  surveyId,
  currentVersionId,
  sub,
}: {
  open: boolean;
  onClose: () => void;
  surveyId: string;
  currentVersionId: string | null;
  sub: ReactNode;
}) {
  const { ut, lang } = useLang();
  const versions = useResource(() => api.versions(surveyId), [surveyId, open], { enabled: open });
  const list = [...(versions.data ?? [])].sort((a, b) => b.version - a.version);
  return (
    <Drawer open={open} onClose={onClose} title={ut("ce.history")} sub={sub} icon={<Ic.history size={18} />}>
      <DrawerSection>
        {versions.error ? (
          <Loading bare error={versions.error} onRetry={versions.reload} />
        ) : !versions.data ? (
          <Loading bare rows={3} />
        ) : (
          <ol className="m-0 list-none p-0">
            {list.map((v) => (
              <li key={v.id} className="flex items-start gap-3 border-t border-divider py-2.5 first:border-t-0 first:pt-0">
                <IconTile icon={<CnIc.gitBranch size={15} />} tone={v.id === currentVersionId ? "violet" : "neutral"} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <b className="text-body font-extrabold text-text">
                      {ut("ce.version")} {v.version}
                    </b>
                    {v.id === currentVersionId ? <Tag tone="primary">{ut("ce.current")}</Tag> : null}
                  </span>
                  <span className="block text-small text-muted">
                    {dateTime(v.createdAt)}, {ut("ce.responses")}: {v.responseCount}
                  </span>
                  {v.note ? <span className="block text-small text-text-2">{renderNote(v.note, lang)}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </DrawerSection>
    </Drawer>
  );
}
