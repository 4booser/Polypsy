import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { CohortMembers, CohortPreview, CohortRow, CohortSpec, Scale } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { useLang } from "../lang";
import { Loading, Modal, useAction, useToast } from "../ui";
import { cx } from "../ui/cx";
import { IconDots, IconPlusThick } from "../ui/glyphs";
import { Page } from "../ui/layout";
import { ActionMenu } from "../ui/menu";
import { Button, Field, Input, Num, Stat } from "../ui/primitives";
import { useResource } from "../useResource";
import {
  BREAKDOWNS,
  BREAKDOWN_TITLE,
  MIN_SEVERITY,
  OPERATORS,
  OPERATOR_LABEL,
  SEVERITY_LABEL,
  type BreakdownKind,
  type ScaleCond,
  activeFilters,
  barRows,
  breakdownCells,
  breakdownCsv,
  breakdownLabel,
  describeSpec,
  paramsFromSpec,
  sameSpec,
  specErrors,
  specFromParams,
  toSampleFilters,
} from "./cohorts/model";
import { Check, FillSelect, FilterTag, Group, MemberList, MultiPick, Section, Segmented, ShareBars } from "./cohorts/parts";
import { AssignSurveyDialog, PickGroupDialog } from "./patientGroups/dialogs";
import { SelectionBar } from "./patientGroups/PersonGrid";
import { presetHref } from "./statistics/model";
import { GlyphButton, IconMinusThick } from "./statistics/parts";

/**
 * «Добір людей» — конструктор когорт.
 *
 * «Мужчины 20–30 из рот 1–3, прошедшие МЛО за квартал, с ЛАП ниже четырёх, у
 * которых есть повторный замер» — вопрос, который задают постоянно, а отвечают
 * на него выгрузкой в SPSS и обратно.
 *
 * Счётчик пересчитывается на каждое изменение условия: смысл конструктора в
 * том, чтобы видеть, во что превращается сужение, до того как нажать. Сужать
 * вслепую и проверять результатом — это тот же SPSS, только медленнее. Запрос
 * ждёт паузу в наборе: каждый предпросмотр — строка журнала, и цифра возраста,
 * набранная по буквам, не должна оставлять трёх записей вместо одной.
 *
 * Имена показываются отдельным действием. Посмотреть распределение и увидеть,
 * кто это, — разные вещи с разными последствиями, и в журнале они различаются.
 *
 * ── Решение заказчика 2026-09-26 ──
 *
 * «Экран выглядит не тронутым, нужно переделать под стиль дизайна проекта,
 * добавить адекватные фильтры, сделать понятнее юай и добавить больше
 * нужного функционала». Отсюда раскладка по порядку чтения — слева направо и
 * сверху вниз:
 *
 *   «Кого шукаємо»        — фильтры колонкой слева, сгруппированы и подписаны:
 *                           о человеке (стать, вік, підрозділ, населений
 *                           пункт) и об обследованиях (методика, період,
 *                           вираженість, повторний замір, тривога, шкали);
 *   «Що вийшло»           — справа: метки активных условий с «×», число
 *                           крупно, разбивки полосками с долями;
 *   «Що з ними зробити»   — поимённо, CSV разбивок, пресет статистики,
 *                           сохранить;
 *   «Поіменно»            — появляется по действию: строки как в списке
 *                           пациентов, выбор и «Призначити тест» / «Додати
 *                           до групи» — те же окна, что у списка пациентов;
 *   «Збережені»           — правило словами, открыть ссылкой, переименовать,
 *                           удалить.
 *
 * Состояние отбора — в адресе (model.ts, paramsFromSpec): ссылку можно
 * переслать, и она откроет ту же выборку. Открытая сохранённая помечается
 * параметром `saved` — так экран знает, что её можно «оновити».
 */
export default function Cohorts() {
  const { ut } = useLang();
  const toast = useToast();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();

  const spec = useMemo(() => specFromParams(params), [params]);
  const key = useMemo(() => paramsFromSpec(spec).toString(), [spec]);
  const savedId = params.get("saved");

  /* правка — от актуального адреса, а не от замыкания: два быстрых нажатия не должны терять первое */
  const patch = useCallback(
    (p: Partial<CohortSpec>) =>
      setParams((prev) => paramsFromSpec({ ...specFromParams(prev), ...p }, prev), { replace: true }),
    [setParams],
  );
  const setSpec = useCallback(
    (next: CohortSpec) => setParams((prev) => paramsFromSpec(next, prev), { replace: true }),
    [setParams],
  );

  const options = useResource(() => api.cohortOptions(), []);
  const surveys = useResource(() => api.surveys(), []);
  const saved = useResource(() => api.cohorts(), []);
  const survey = useResource(() => api.survey(spec.surveyId!), [spec.surveyId], { enabled: !!spec.surveyId });

  const surveyTitle = useCallback(
    (id: string) => surveys.data?.find((s) => s.id === id)?.title ?? (survey.data?.id === id ? survey.data.title : undefined),
    [surveys.data, survey.data],
  );
  const scaleTitle = useCallback(
    (code: string) => {
      const sc = survey.data?.scales.find((s) => s.code === code);
      return sc ? sc.title : undefined;
    },
    [survey.data],
  );

  /* ─── предпросмотр ─── */

  const errors = specErrors(spec);
  const invalid = !!(errors.age || errors.period);
  const [preview, setPreview] = useState<CohortPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (invalid) {
      setCounting(false);
      return;
    }
    let alive = true;
    setCounting(true);
    const timer = setTimeout(() => {
      void api
        .cohortPreview(specFromParams(new URLSearchParams(key)))
        .then((p) => {
          if (!alive) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (alive) setPreviewError(e instanceof Error ? e.message : "");
        })
        .finally(() => {
          if (alive) setCounting(false);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, invalid, attempt]);

  /* ─── поимённо ─── */

  const [names, setNames] = useState<CohortMembers | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const namesRef = useRef<HTMLDivElement>(null);
  /* условия на момент ответа: имена, пришедшие после правки условий, относятся к прежней когорте */
  const keyNow = useRef(key);
  keyNow.current = key;
  /* имена сбрасываются при смене условий: список от прошлого запроса относится к другой когорте */
  useEffect(() => {
    setNames(null);
    setSelected(new Set());
  }, [key]);
  useEffect(() => {
    if (!names) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    namesRef.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  }, [names]);

  const showNames = () =>
    void run(async () => {
      const asked = key;
      const got = await api.cohortMembers(spec);
      if (keyNow.current !== asked) return false;
      setNames(got);
      setSelected(new Set());
    });

  /* ─── сохранённые ─── */

  const opened = saved.data?.find((c) => c.id === savedId) ?? null;
  const [title, setTitle] = useState("");
  const saveNew = () =>
    void run(async () => {
      const created = await api.saveCohort(title.trim(), spec);
      setTitle("");
      saved.reload();
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("saved", created.id);
          return next;
        },
        { replace: true },
      );
    }, ut("coh.savedDone"));
  const updateOpened = () =>
    void run(async () => {
      if (!opened) return false;
      await api.updateCohort(opened.id, { spec });
      saved.reload();
    }, ut("coh.updatedDone"));
  const removeSaved = (c: CohortRow) =>
    void run(async () => {
      if (!window.confirm(ut("coh.deleteConfirm"))) return false;
      await api.deleteCohort(c.id);
      saved.reload();
      if (c.id === savedId) {
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.delete("saved");
            return next;
          },
          { replace: true },
        );
      }
    }, ut("coh.deleted"));

  /* ─── выгрузка ─── */

  const exportCsv = () => {
    if (!preview) return;
    const text = breakdownCsv(preview, ut, (kind, k) => breakdownLabel(kind, k, ut));
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `cohort-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /* ─── окна ─── */

  const [dialog, setDialog] = useState<"assign" | "group" | "stats" | null>(null);
  const [renaming, setRenaming] = useState<CohortRow | null>(null);
  const groups = useResource(() => api.patientGroups(), [dialog === "group"], { enabled: dialog === "group" });

  const assign = async (surveyId: string, expiresAt: string | null) => {
    let done = 0;
    for (const userId of selected) {
      await api.grant(surveyId, userId, undefined, expiresAt);
      done += 1;
    }
    return `${ut("pg.assigned")} — ${done}`;
  };

  const tags = activeFilters(spec, ut, { survey: surveyTitle, scale: scaleTitle });
  const usableSurveys = (surveys.data ?? [])
    .filter((s) => s.responseCount > 0 || s.id === spec.surveyId)
    .sort((a, b) => a.title.localeCompare(b.title));
  const people = names?.items ?? [];
  const allChosen = people.length > 0 && people.every((p) => selected.has(p.userId));

  return (
    <Page title={ut("coh.title")} sub={ut("coh.lede")}>
      <div className="grid grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-x-[48px] max-[1000px]:grid-cols-1">
        {/* ─── кого шукаємо ─── */}
        <Section title={ut("coh.who")} labelId="coh-who">
          <div className="flex flex-col gap-[18px]">
            <Group legend={ut("person.sex")}>
              <Segmented
                name="coh-sex"
                value={spec.sex ?? "any"}
                options={[
                  { value: "any", label: ut("coh.anySex") },
                  { value: "male", label: ut("nm.menCap") },
                  { value: "female", label: ut("nm.womenCap") },
                ]}
                onChange={(v) => patch({ sex: v === "any" ? null : v })}
              />
            </Group>

            <Group legend={ut("coh.age")} hint={ut("coh.ageHint")} error={errors.age ? ut(errors.age) : null}>
              <AgeRange
                min={spec.ageMin ?? null}
                max={spec.ageMax ?? null}
                invalid={!!errors.age}
                onCommit={(ageMin, ageMax) => patch({ ageMin, ageMax })}
              />
            </Group>

            <Group legend={ut("person.unit")}>
              <MultiPick
                label={ut("person.unit")}
                allLabel={ut("coh.anyUnit")}
                options={options.data?.units ?? []}
                value={spec.units ?? []}
                onChange={(units) => patch({ units })}
                emptyText={ut("coh.noOptions")}
              />
            </Group>

            <Group legend={ut("st.locality")}>
              <MultiPick
                label={ut("st.locality")}
                allLabel={ut("coh.anyLocality")}
                options={options.data?.localities ?? []}
                value={spec.localities ?? []}
                onChange={(localities) => patch({ localities })}
                emptyText={ut("coh.noOptions")}
              />
            </Group>

            {/* вторая половина — про обследования; тонкая черта делит «кто» и «что проходил» */}
            <hr aria-hidden className="m-0 border-0 border-t border-hairline" />

            <Group legend={ut("coh.survey")}>
              <FillSelect
                label={ut("coh.survey")}
                value={spec.surveyId ?? ""}
                /* смена методики снимает условия по шкалам: коды шкал принадлежат ей */
                onChange={(v) => patch({ surveyId: v || null, scales: [] })}
                disabled={!surveys.data}
              >
                <option value="">{ut("coh.anySurvey")}</option>
                {usableSurveys.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </FillSelect>
            </Group>

            <Group legend={ut("coh.period")} error={errors.period ? ut(errors.period) : null}>
              <div className="flex items-center gap-[8px]">
                <div className="min-w-0 flex-1">
                  <Input
                    look="fill"
                    type="date"
                    aria-label={`${ut("coh.period")}: ${ut("st.dateFrom")}`}
                    aria-invalid={!!errors.period || undefined}
                    value={spec.from ?? ""}
                    max={spec.to ?? undefined}
                    onChange={(e) => patch({ from: e.target.value || null })}
                  />
                </div>
                <span aria-hidden className="h-[2px] w-[12px] shrink-0 bg-field-border" />
                <div className="min-w-0 flex-1">
                  <Input
                    look="fill"
                    type="date"
                    aria-label={`${ut("coh.period")}: ${ut("st.dateTo")}`}
                    aria-invalid={!!errors.period || undefined}
                    value={spec.to ?? ""}
                    min={spec.from ?? undefined}
                    onChange={(e) => patch({ to: e.target.value || null })}
                  />
                </div>
              </div>
            </Group>

            <Group legend={ut("coh.severityAtLeast")} hint={ut("coh.severityHint")}>
              <Segmented
                name="coh-severity"
                value={spec.minSeverity ?? "any"}
                options={[
                  { value: "any", label: ut("coh.anySeverity") },
                  ...MIN_SEVERITY.map((s) => ({ value: s, label: ut(SEVERITY_LABEL[s]), dot: s })),
                ]}
                onChange={(v) => patch({ minSeverity: v === "any" ? null : v })}
              />
            </Group>

            <Group legend={ut("coh.extra")}>
              <Check checked={!!spec.repeatedOnly} onChange={(v) => patch({ repeatedOnly: v })}>
                {ut("coh.repeated")}
              </Check>
              <Check checked={!!spec.riskOnly} onChange={(v) => patch({ riskOnly: v })}>
                {ut("coh.risk")}
              </Check>
            </Group>

            <Group legend={ut("coh.scaleConds")}>
              {spec.surveyId ? (
                survey.data ? (
                  <ScaleConditions
                    scales={survey.data.scales}
                    value={spec.scales ?? []}
                    onChange={(scales) => patch({ scales })}
                  />
                ) : (
                  <Loading rows={1} error={survey.error} onRetry={survey.reload} />
                )
              ) : (
                <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("coh.scaleNeedSurvey")}</p>
              )}
            </Group>
          </div>
        </Section>

        <div className="min-w-0">
          {/* ─── що вийшло ─── */}
          <Section
            title={ut("coh.result")}
            labelId="coh-result"
            aside={
              <span role="status" className="text-[13px] text-muted">
                {counting ? ut("coh.counting") : ""}
              </span>
            }
          >
            <div className="mb-[20px] flex flex-wrap items-center gap-[8px]">
              {tags.length ? (
                <>
                  <ul aria-label={ut("coh.activeConditions")} className="m-0 flex list-none flex-wrap gap-[6px] p-0">
                    {tags.map((t) => (
                      <FilterTag key={t.id} label={t.label} onRemove={() => setSpec(t.without(spec))} />
                    ))}
                  </ul>
                  <Button variant="quiet" onClick={() => setSpec({})}>
                    {ut("tbl.resetFacets")}
                  </Button>
                </>
              ) : (
                <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("coh.noConditions")}</p>
              )}
            </div>

            {previewError !== null ? (
              <Loading error={previewError || ut("common.error")} onRetry={() => setAttempt((n) => n + 1)} />
            ) : !preview ? (
              <Loading rows={3} />
            ) : (
              <Result preview={preview} busy={counting || invalid} />
            )}
          </Section>

          {/* ─── що з ними зробити ─── */}
          <Section title={ut("coh.actions")} labelId="coh-actions">
            <div className="flex flex-wrap gap-[12px]">
              <Button
                disabled={busy || invalid || !preview || !preview.size}
                onClick={showNames}
              >
                {ut("coh.showNames")}
              </Button>
              <Button variant="ghost" disabled={!preview?.breakdownAllowed} onClick={exportCsv}>
                {ut("coh.csv")}
              </Button>
              <Button variant="ghost" disabled={invalid} onClick={() => setDialog("stats")}>
                {ut("coh.toStats")}
              </Button>
            </div>
            <p className="m-0 mt-[6px] text-[11px] leading-[15px] text-muted">{ut("coh.namesWarn")}</p>

            <form
              className="mt-[20px] flex flex-wrap items-center gap-[12px]"
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim() && !invalid) saveNew();
              }}
            >
              <div className="min-w-[220px] flex-1">
                <Input
                  look="outline"
                  ph="plain"
                  aria-label={ut("coh.name")}
                  placeholder={ut("coh.name")}
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={busy || invalid || !title.trim()}>
                {ut("coh.save")}
              </Button>
              {opened && !sameSpec(opened.spec, spec) ? (
                <Button variant="ghost" disabled={busy || invalid} onClick={updateOpened}>
                  {`${ut("coh.updateSaved")} «${opened.title}»`}
                </Button>
              ) : null}
            </form>
            <p className="m-0 mt-[6px] text-[11px] leading-[15px] text-muted">{ut("coh.savedHint")}</p>
          </Section>
        </div>
      </div>

      {/* ─── поіменно ─── */}
      {names ? (
        <div ref={namesRef} className="scroll-mt-[16px]">
          <Section
            title={ut("coh.namesTitle")}
            labelId="coh-names"
            aside={
              <Button variant="quiet" onClick={() => setNames(null)}>
                {ut("coh.hideNames")}
              </Button>
            }
          >
            {names.suppressed ? (
              <p className="m-0 text-[15px] leading-[20px] text-text">
                {ut("coh.namesSuppressed")} <Num>{names.smallCellFloor}</Num>
              </p>
            ) : people.length === 0 ? (
              <p className="m-0 text-[13px] text-muted">{ut("srch.nothing")}</p>
            ) : (
              <>
                <div className="mb-[8px]">
                  <Check
                    checked={allChosen}
                    onChange={(on) => setSelected(on ? new Set(people.map((p) => p.userId)) : new Set())}
                  >
                    {ut("coh.selectAll")} <Num className="text-muted">{people.length}</Num>
                  </Check>
                </div>
                <MemberList
                  people={people}
                  selected={selected}
                  onToggle={(id) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  surveyTitle={surveyTitle}
                  dayOf={day}
                />
                {names.truncated ? (
                  <p className="m-0 mt-[12px] text-[13px] text-muted">{ut("coh.namesTruncated")}</p>
                ) : null}
                <SelectionBar
                  count={selected.size}
                  entries={[
                    { label: ut("pg.assignTest"), onSelect: () => setDialog("assign") },
                    { label: ut("pg.addToGroup"), onSelect: () => setDialog("group") },
                    { label: ut("pg.clearSelection"), onSelect: () => setSelected(new Set()) },
                  ]}
                />
              </>
            )}
          </Section>
        </div>
      ) : null}

      {/* ─── збережені ─── */}
      <Section title={ut("coh.saved")} labelId="coh-saved">
        {saved.error ? (
          <Loading error={saved.error} onRetry={saved.reload} />
        ) : !saved.data ? (
          <Loading rows={2} />
        ) : saved.data.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{ut("coh.noneSaved")}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {saved.data.map((c) => {
              const current = c.id === savedId;
              const href = `/cohorts?${paramsFromSpec(c.spec, new URLSearchParams({ saved: c.id })).toString()}`;
              return (
                <li
                  key={c.id}
                  className={cx(
                    "-mx-[4px] flex items-center gap-[16px] border-b border-hairline px-[4px] py-[12px] last:border-b-0",
                    "has-[a:hover]:bg-primary-tint",
                    current && "bg-primary-tint",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-[10px]">
                      <Link
                        to={href}
                        aria-current={current ? "true" : undefined}
                        className="text-[17px] font-bold leading-[22px] text-primary no-underline hover:underline"
                      >
                        {c.title}
                      </Link>
                      {current ? (
                        <span className="text-[11px] text-muted">
                          {sameSpec(c.spec, spec) ? ut("coh.opened") : ut("coh.changed")}
                        </span>
                      ) : null}
                    </div>
                    <p className="m-0 mt-[2px] text-[13px] leading-[18px] text-muted">
                      {describeSpec(c.spec, ut, { survey: surveyTitle })}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">{day(c.createdAt)}</span>
                  <ActionMenu
                    label={`${ut("coh.savedActions")}: ${c.title}`}
                    glyph={<IconDots />}
                    entries={[
                      { label: ut("coh.open"), onSelect: () => navigate(href) },
                      { label: ut("coh.rename"), onSelect: () => setRenaming(c) },
                      { label: ut("adm.delete"), onSelect: () => removeSaved(c), danger: true },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {dialog === "assign" ? (
        <AssignSurveyDialog title={ut("pg.assignTest")} onAssign={assign} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "group" ? (
        groups.data ? (
          <PickGroupDialog
            groups={groups.data}
            count={selected.size}
            onPick={async (groupId) => {
              /* по одному запросу на человека; повтор сервер читает как «уже там» */
              for (const userId of selected) await api.addPatientGroupMember(groupId, userId);
              setDialog(null);
              toast(ut("pg.added"), "ok");
            }}
            onClose={() => setDialog(null)}
          />
        ) : (
          <Modal title={ut("pg.addToGroup")} onClose={() => setDialog(null)}>
            <Loading rows={2} error={groups.error} onRetry={groups.reload} />
          </Modal>
        )
      ) : null}
      {dialog === "stats" ? (
        <ToStatistics
          spec={spec}
          suggested={opened?.title ?? ""}
          onClose={() => setDialog(null)}
          onCreated={(id) => navigate(presetHref(id))}
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          row={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            saved.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

/* ─────────── результат ─────────── */

/**
 * Число и разбивки.
 *
 * Число — крупно и моноширинно (Stat). Скрытое порогом — словами, а не
 * прочерком: «замало, щоб назвати число» и сам порог рядом, иначе прочерк
 * на месте главного числа экрана читался бы как поломка.
 *
 * Пока идёт пересчёт, прежний результат остаётся на месте приглушённым
 * (aria-busy): пустой экран на каждое нажатие мигал бы, а старое число без
 * пометки выдавало бы себя за новое.
 */
function Result({ preview, busy }: { preview: CohortPreview; busy: boolean }) {
  const { ut } = useLang();
  return (
    <div aria-busy={busy || undefined} className={cx("transition-opacity duration-[var(--dur-fast)]", busy && "opacity-60")}>
      {preview.size === null ? (
        <div>
          <p className="m-0 text-[20px] font-bold leading-[26px] text-text">{ut("coh.tooSmall")}</p>
          <p className="m-0 mt-[4px] max-w-[60ch] text-[13px] leading-[18px] text-muted">
            {ut("coh.floorHint")} <Num>{preview.smallCellFloor}</Num>
          </p>
        </div>
      ) : (
        <Stat value={preview.size} label={ut("coh.size")} />
      )}
      {preview.size === 0 ? <p className="m-0 mt-[8px] text-[13px] text-muted">{ut("coh.nobody")}</p> : null}

      {preview.breakdownAllowed ? (
        <>
          <div className="mt-[24px] grid grid-cols-2 gap-x-[40px] gap-y-[28px] max-[700px]:grid-cols-1">
            {BREAKDOWNS.map((kind: BreakdownKind) => (
              <ShareBars
                key={kind}
                title={ut(BREAKDOWN_TITLE[kind])}
                rows={barRows(breakdownCells(preview, kind), preview.size)}
                label={(k) => breakdownLabel(kind, k, ut)}
                severity={kind === "severity"}
              />
            ))}
          </div>
          <p className="m-0 mt-[16px] max-w-[70ch] text-[11px] leading-[15px] text-muted">{ut("coh.sharesNote")}</p>
        </>
      ) : preview.size !== 0 ? (
        <p className="m-0 mt-[12px] max-w-[60ch] text-[13px] leading-[18px] text-muted">{ut("coh.noBreakdown")}</p>
      ) : null}
    </div>
  );
}

/* ─────────── вік ─────────── */

function ageOf(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(120, n)) : null;
}

/**
 * «Вік від — до» одним полем-диапазоном.
 *
 * Набранное живёт в поле, а в правило уходит после паузы: иначе «35»
 * по буквам сначала стало бы «3», и под «від 25» поле покраснело бы
 * ошибкой диапазона посреди набора. Снятая меткой «×» граница приходит
 * сверху и переписывает поле.
 */
function AgeRange({
  min,
  max,
  invalid,
  onCommit,
}: {
  min: number | null;
  max: number | null;
  invalid: boolean;
  onCommit: (ageMin: number | null, ageMax: number | null) => void;
}) {
  const { ut } = useLang();
  const [lo, setLo] = useState(min === null ? "" : String(min));
  const [hi, setHi] = useState(max === null ? "" : String(max));
  useEffect(() => setLo((v) => (ageOf(v) === min ? v : min === null ? "" : String(min))), [min]);
  useEffect(() => setHi((v) => (ageOf(v) === max ? v : max === null ? "" : String(max))), [max]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const a = ageOf(lo);
      const b = ageOf(hi);
      if (a !== min || b !== max) onCommit(a, b);
    }, 400);
    return () => clearTimeout(timer);
    /* только на набор: пришедшие сверху значения уже совпадают с полем */
  }, [lo, hi]);
  const field = (label: string, ph: string, value: string, set: (v: string) => void) => (
    <div className="w-[96px] shrink-0">
      <Input
        look="fill"
        ph="plain"
        type="number"
        inputMode="numeric"
        min={0}
        max={120}
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={ph}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );
  return (
    <div className="flex items-center gap-[8px]">
      {field(ut("st.ageFrom"), ut("coh.fromWord"), lo, setLo)}
      <span aria-hidden className="h-[2px] w-[12px] shrink-0 bg-field-border" />
      {field(ut("st.ageTo"), ut("coh.ageTo"), hi, setHi)}
    </div>
  );
}

/* ─────────── умови за шкалами ─────────── */

interface CondRow {
  key: string;
  code: string;
  op: ScaleCond["op"];
  value: string;
}

let rowSeq = 0;
const toRows = (conds: readonly ScaleCond[]): CondRow[] =>
  conds.map((c) => ({ key: `c${++rowSeq}`, code: c.code, op: c.op, value: String(c.value) }));
const committed = (rows: readonly CondRow[]): ScaleCond[] =>
  rows
    .filter((r) => r.code && r.value.trim() !== "" && Number.isFinite(Number(r.value)))
    .map((r) => ({ code: r.code, op: r.op, value: Number(r.value) }));

/**
 * Строки «шкала · умова · бал» — «+» и «−», как в формах статистики.
 *
 * Строка без балла — черновик: она видна и правится, но в правило не
 * уходит. Прежде пустое поле балла превращалось в ноль, и «D ≥ 0» молча
 * отбирало всех, у кого шкала вообще посчитана.
 *
 * Под баллом — границы шкалы по её полосам («межі шкали: 0–27»): значение
 * здесь итоговое (T-бал, стен или сырой — как у полос), и без границ «10»
 * не с чем сравнить.
 */
function ScaleConditions({
  scales,
  value,
  onChange,
}: {
  scales: Scale[];
  value: ScaleCond[];
  onChange: (next: ScaleCond[]) => void;
}) {
  const { ut } = useLang();
  const idBase = useId();
  const [rows, setRows] = useState<CondRow[]>(() => toRows(value));
  const outside = JSON.stringify(value);
  useEffect(() => {
    setRows((now) => (JSON.stringify(committed(now)) === outside ? now : toRows(value)));
    /* value — тот же outside, но объектом; сравнение идёт по строке */
  }, [outside]);

  const update = (next: CondRow[]) => {
    setRows(next);
    const c = committed(next);
    if (JSON.stringify(c) !== outside) onChange(c);
  };
  const set = (key: string, p: Partial<CondRow>) => update(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const range = (code: string): string | null => {
    const bands = scales.find((s) => s.code === code)?.bands ?? [];
    if (!bands.length) return null;
    const lo = Math.min(...bands.map((b) => b.minScore));
    const hi = Math.max(...bands.map((b) => b.maxScore));
    return `${ut("coh.scaleRange")}: ${lo}–${hi}`;
  };

  if (!scales.length) return <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("coh.noScales")}</p>;

  return (
    <div className="flex flex-col gap-[12px]">
      {rows.map((r, i) => {
        const hint = range(r.code);
        return (
          <div key={r.key} className="flex flex-col gap-[6px] rounded-[5px]">
            <div className="flex items-center gap-[8px]">
              <FillSelect
                label={`${ut("coh.scale")} ${i + 1}`}
                value={r.code}
                onChange={(code) => set(r.key, { code })}
                className="min-w-0 flex-1"
              >
                {scales.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.title}
                  </option>
                ))}
              </FillSelect>
              <GlyphButton label={`${ut("st.removeCriterion")} ${i + 1}`} onClick={() => update(rows.filter((x) => x.key !== r.key))}>
                <IconMinusThick />
              </GlyphButton>
            </div>
            <div className="flex items-center gap-[8px] pr-[35px]">
              <FillSelect
                label={`${ut("coh.operator")} ${i + 1}`}
                value={r.op}
                onChange={(op) => set(r.key, { op: op as ScaleCond["op"] })}
                className="min-w-0 flex-1"
              >
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {ut(OPERATOR_LABEL[op])}
                  </option>
                ))}
              </FillSelect>
              <div className="w-[88px] shrink-0">
                <Input
                  look="fill"
                  ph="plain"
                  type="number"
                  inputMode="decimal"
                  aria-label={`${ut("coh.value")} ${i + 1}`}
                  aria-describedby={hint ? `${idBase}-${r.key}` : undefined}
                  placeholder={ut("coh.value")}
                  value={r.value}
                  onChange={(e) => set(r.key, { value: e.target.value })}
                />
              </div>
            </div>
            {hint ? (
              <p id={`${idBase}-${r.key}`} className="m-0 text-[11px] leading-[15px] text-muted">
                {hint}
              </p>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center gap-[8px]">
        <GlyphButton
          label={ut("coh.addCond")}
          disabled={rows.length >= 10}
          onClick={() => update([...rows, { key: `c${++rowSeq}`, code: scales[0]!.code, op: ">=", value: "" }])}
        >
          <IconPlusThick />
        </GlyphButton>
        <span aria-hidden className="text-[13px] text-muted">
          {ut("coh.addCond")}
        </span>
      </div>
    </div>
  );
}

/* ─────────── в статистику ─────────── */

/**
 * «Відкрити у статистиці»: пресет фильтров из условий подбора.
 *
 * Окно называет, что перейдёт и что нет, ДО создания: у пресета статистики
 * своих условий меньше (model.ts, toSampleFilters), и молча созданный
 * пресет с половиной условий читался бы как та же выборка. Готовый пресет
 * открывается в своей форме («Створення фільтра»), где его можно поправить
 * и откуда его подхватит любая модель.
 */
function ToStatistics({
  spec,
  suggested,
  onClose,
  onCreated,
}: {
  spec: CohortSpec;
  suggested: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { ut } = useLang();
  const { filters, dropped } = toSampleFilters(spec);
  const carried = activeFilters(
    {
      sex: filters.sex ?? null,
      ageMin: filters.ageMin ?? null,
      ageMax: filters.ageMax ?? null,
      localities: filters.locality ? [filters.locality] : [],
      from: filters.from ?? null,
      to: filters.to ?? null,
    },
    ut,
  );
  const [title, setTitle] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const preset = await api.createFilterPreset({ title: title.trim(), criteria: filters });
      onCreated(preset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ui.actionFailed"));
      setBusy(false);
    }
  }

  return (
    <Modal title={ut("coh.toStatsTitle")} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void create();
        }}
      >
        <p className="m-0 text-[15px] leading-[20px] text-text">{ut("coh.toStatsLede")}</p>
        {carried.length ? (
          <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-[6px] p-0">
            {carried.map((c) => (
              <li key={c.id} className="rounded-[4px] bg-primary-soft px-[8px] py-[3px] text-[13px] font-bold text-primary">
                {c.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 mt-[8px] text-[13px] text-muted">{ut("coh.toStatsNothing")}</p>
        )}
        {dropped.length ? (
          <>
            <p className="m-0 mt-[14px] text-[15px] leading-[20px] text-text">{ut("coh.toStatsDropped")}</p>
            <p className="m-0 mt-[4px] text-[13px] leading-[18px] text-muted">{dropped.map((k) => ut(k)).join(" · ")}</p>
          </>
        ) : null}
        <div className="mt-[18px]">
          <Field label={ut("coh.presetName")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus required />
          </Field>
        </div>
        {error ? <p className="m-0 mt-[10px] text-[13px] text-danger">{error}</p> : null}
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? ut("co.saving") : ut("coh.createPreset")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────── перейменування ─────────── */

function RenameDialog({ row, onClose, onSaved }: { row: CohortRow; onClose: () => void; onSaved: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [title, setTitle] = useState(row.title);
  return (
    <Modal title={ut("coh.rename")} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void run(async () => {
            await api.updateCohort(row.id, { title: title.trim() });
            onSaved();
          }, ut("coh.renamed"));
        }}
      >
        <Field label={ut("coh.name")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus required />
        </Field>
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !title.trim() || title.trim() === row.title}>
            {ut("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
