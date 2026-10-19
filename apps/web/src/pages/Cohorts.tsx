import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { CohortMember, CohortMembers, CohortPreview, CohortRow, CohortSpec, Scale } from "@quizzy/shared";
import { api } from "../api";
import { useLang } from "../lang";
import { Avatar, Callout, Loading, Modal, PersonCell, useAction, useToast } from "../ui";
import { choiceLabel, keepChosen } from "../ui/choices";
import { cx } from "../ui/cx";
import { DataTable, type Column } from "../ui/DataTable";
import { Ic } from "../ui/icons";
import { IconTile, Page, Panel } from "../ui/layout";
import { ActionMenu, MenuButton, menuItemClass, MenuSeparator } from "../ui/menu";
import { Popover } from "../ui/Popover";
import { Button, Field, Input, Select, SeverityTag, Tag } from "../ui/primitives";
import { useDebounced, useResource } from "../useResource";
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
  breakdownFileName,
  breakdownLabel,
  describeSpec,
  paramsFromSpec,
  resultView,
  sameSpec,
  specErrors,
  specFromParams,
  toSampleFilters,
  withSpec,
} from "./cohorts/model";
import { Breakdown, Check, FilterSection, FilterTag, Group, MultiPick, Segmented } from "./cohorts/parts";
import { PickGroupDialog } from "./patientGroups/dialogs";
import { AssignDrawer } from "../components/AssignDrawer";
import { Pi } from "./patientGroups/icons";
import { pluralForm } from "../ui/plural";
import { fill, grantEach, newProgress, partialFailure, shortDate } from "./patientGroups/model";
import { presetHref } from "./statistics/model";

/**
 * «Добір людей» — конструктор когорт (patients-cohorts «Виразної»).
 *
 * «Мужчины 20–30 из рот 1–3, прошедшие МЛО за квартал, с ЛАП ниже четырёх, у
 * которых есть повторный замер» — вопрос, который задают постоянно, а отвечают
 * на него выгрузкой в SPSS и обратно.
 *
 * Слева — «Кого шукаємо»: условия о человеке, об обследовании и по шкалам; под
 * ними — «Збережені» правила. Справа — «Що вийшло»: метки условий с «×»,
 * число крупно рядом с числом всех обследованных зоны, разбивки полосами с
 * долями и порогом малых ячеек; ниже — «Що з ними зробити».
 *
 * Счётчик пересчитывается на каждое изменение условия: смысл конструктора в
 * том, чтобы видеть, во что превращается сужение, до того как нажать. Запрос
 * ждёт паузу в наборе: каждый предпросмотр — строка журнала.
 *
 * Имена — отдельным действием и после вопроса: посмотреть распределение и
 * увидеть, кто это, — разные вещи с разными последствиями, и в журнале они
 * различаются. Поименно — таблица с выбором: «Призначити тест» (ящик) и
 * «Додати до групи».
 *
 * Состояние отбора — в адресе (model.ts, paramsFromSpec): ссылку можно
 * переслать. Открытая сохранённая помечается параметром `saved` — так экран
 * знает, что её можно «оновити».
 *
 * Чего на макете есть, а здесь нет: «Як звужувалась вибірка» (число после
 * каждого условия — это по предпросмотру на условие, и каждый ложился бы в
 * журнал) и «Створити розсилку» (рассылка не принимает когорту адресатом).
 */
export default function Cohorts() {
  const { ut, lang } = useLang();
  const toast = useToast();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();

  const spec = useMemo(() => specFromParams(params), [params]);
  const key = useMemo(() => paramsFromSpec(spec).toString(), [spec]);
  const savedId = params.get("saved");

  /* правка — от актуального адреса, а не от замыкания: два быстрых нажатия не должны терять первое */
  const patch = useCallback(
    (p: Partial<CohortSpec>) => setParams((prev) => withSpec(prev, p), { replace: true }),
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
  /*
   * Счёт — по условиям, которые перестали меняться на 350 мс. Загрузкой, а не
   * голым запросом: ответ ложится под условия, по которым его спрашивали;
   * обрыв связи — не отказ. «Рахую» стоит с первой правки: число на экране
   * уже не про эти условия.
   */
  const settledKey = useDebounced(key, 350);
  const count = useResource(
    () => api.cohortPreview(specFromParams(new URLSearchParams(settledKey))),
    [settledKey],
    { enabled: !invalid },
  );
  const preview = count.data;
  const previewError = count.error;
  /*
   * «з N у вашій зоні» — предпросмотр без условий. После основного счёта, а
   * не вместе с ним: предпросмотр тяжёлый (десяток запросов к базе), и два
   * сразу замедляли главное число экрана вдвое. Ответ свежий пять минут и
   * общий для всех открытий экрана: зона за это время не меняется.
   */
  const everyone = useResource(() => api.cohortPreview({}), [], {
    enabled: !!preview || !!previewError,
    key: "cohorts.zone",
    staleMs: 5 * 60_000,
  });
  const counting = !invalid && (settledKey !== key || count.loading || count.refreshing);
  const view = resultView({ invalid, hasPreview: !!preview, error: previewError });

  /* ─── поимённо ─── */

  const [names, setNames] = useState<CohortMembers | null>(null);
  const [asking, setAsking] = useState(false);
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
      setAsking(false);
      if (keyNow.current !== asked) return false;
      setNames(got);
      setSelected(new Set());
    });

  /* ─── сохранённые ─── */

  const opened = saved.data?.find((c) => c.id === savedId) ?? null;
  const changed = !!opened && !sameSpec(opened.spec, spec);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState("");
  const saveNew = () =>
    void run(async () => {
      const created = await api.saveCohort(title.trim(), spec);
      setTitle("");
      setNaming(false);
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
  const [deleting, setDeleting] = useState<CohortRow | null>(null);
  const removeSaved = (c: CohortRow) =>
    void run(async () => {
      await api.deleteCohort(c.id);
      setDeleting(null);
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
  const hrefOf = (c: CohortRow) => `/cohorts?${paramsFromSpec(c.spec, new URLSearchParams({ saved: c.id })).toString()}`;

  /* ─── выгрузка ─── */

  const exportCsv = () => {
    if (!preview) return;
    const text = breakdownCsv(preview, ut, (kind, k) => breakdownLabel(kind, k, ut));
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = breakdownFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /* ─── окна и ящик ─── */

  const [dialog, setDialog] = useState<"group" | "stats" | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [renaming, setRenaming] = useState<CohortRow | null>(null);
  const groups = useResource(() => api.patientGroups(), [dialog === "group"], { enabled: dialog === "group" });

  /* выданное в этом ящике помнится: повтор после отказа посередине — только остальным (patientGroups/model.ts) */
  const progress = useRef(newProgress());
  const openAssign = () => {
    progress.current = newProgress();
    setAssigning(true);
  };

  const assign = async (surveyId: string, expiresAt: string | null) => {
    const outcome = await grantEach(progress.current, `${surveyId}|${expiresAt ?? ""}`, [...selected], (userId) =>
      api.grant(surveyId, userId, undefined, expiresAt),
    );
    if (outcome.error) {
      const reason = outcome.error instanceof Error ? outcome.error.message : ut("acc.grantFailed");
      throw new Error(partialFailure(outcome, reason, { done: ut("pg.assigned"), of: ut("an.of") }));
    }
    return `${ut("pg.assigned")} — ${outcome.done}`;
  };

  const tags = activeFilters(spec, ut, { survey: surveyTitle, scale: scaleTitle });
  const usableSurveys = (surveys.data ?? [])
    .filter((s) => s.responseCount > 0 || s.id === spec.surveyId)
    .sort((a, b) => a.title.localeCompare(b.title));
  /*
   * Отбор по снятой методике (ссылка, сохранённый отбор) — пунктом с
   * пометкой, а не «будь-яка методика»: список методик снятых не отдаёт, и
   * селект показывал первый пункт, хотя отбор по-прежнему шёл по снятой.
   */
  const surveyChoices = keepChosen(usableSurveys, spec.surveyId ?? "", (id) =>
    survey.data?.id === id ? { title: survey.data.title, retired: !!survey.data.archivedAt } : null,
  );
  const choiceWords = {
    retired: ut("mark.retired"),
    unavailable: ut("choice.unavailable"),
    unknown: survey.loading ? ut("common.loading") : ut("am.testUnavailable"),
  };
  const people = names?.items ?? [];
  const size = preview?.size ?? null;
  const zone = everyone.data?.size ?? null;

  const memberColumns: Column<CohortMember>[] = [
    {
      key: "name",
      header: ut("pg.patient"),
      required: true,
      sort: (p) => p.fullName,
      render: (p) => (
        <PersonCell
          name={p.fullName}
          to={`/patients/${p.userId}`}
          avatar={<Avatar name={p.fullName} size={34} />}
          sub={[
            p.sex === "male" ? ut("adm.male") : p.sex === "female" ? ut("adm.female") : null,
            p.birthYear ? `${p.birthYear} ${ut("pg.yearSuffix")}` : null,
            p.locality,
          ]
            .filter(Boolean)
            .join(", ")}
        />
      ),
    },
    {
      key: "unit",
      header: ut("person.unit"),
      width: 200,
      required: true,
      sort: (p) => p.unit ?? "",
      render: (p) => <span className="line-clamp-1 text-small text-text-2">{p.unit ?? "—"}</span>,
    },
    {
      key: "last",
      header: ut("coh2.lastResponse"),
      width: 300,
      required: true,
      sort: (p) => p.last?.submittedAt ?? "",
      render: (p) =>
        p.last ? (
          <span className="flex min-w-0 items-center gap-2">
            {p.last.severity ? (
              <SeverityTag level={p.last.severity} small>
                {ut(SEVERITY_LABEL[p.last.severity])}
              </SeverityTag>
            ) : !p.last.reliable ? (
              <Tag tone="attention">{ut("stats.unreliableCell")}</Tag>
            ) : null}
            <Link
              to={`/surveys/${p.last.surveyId}/responses/${p.last.responseId}`}
              className="min-w-0 truncate text-small text-text-2 no-underline hover:text-violet-ink hover:underline"
            >
              {surveyTitle(p.last.surveyId) ?? ut("coh.lastResult")}
              {p.last.submittedAt ? `, ${shortDate(p.last.submittedAt)}` : ""}
            </Link>
          </span>
        ) : (
          <span className="text-small text-muted">—</span>
        ),
    },
  ];

  return (
    <Page
      title={ut("coh.title")}
      meta={
        size !== null
          ? [
              fill(ut(`coh2.peopleN.${pluralForm(size, lang)}`), { n: size }),
              zone !== null
                ? fill(ut("coh2.metaOf"), { zone, n: tags.length })
                : fill(ut("coh2.metaConds"), { n: tags.length }),
            ]
          : [ut("coh2.metaHidden"), ut("coh2.metaNames")]
      }
      sub={ut("coh.lede")}
      actions={
        <>
          <MenuButton
            label={ut("coh.saved")}
            trigger={(p) => (
              <Button {...p} icon={<Pi.bookmark />}>
                {ut("coh.saved")}
              </Button>
            )}
          >
            {(close) => (
              <>
                {(saved.data ?? []).length === 0 ? (
                  <p className="m-0 px-2.5 py-2 text-small text-muted">{ut("coh.noneSaved")}</p>
                ) : (
                  (saved.data ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={c.id === savedId}
                      className={menuItemClass("left")}
                      onClick={() => {
                        close();
                        navigate(hrefOf(c));
                      }}
                    >
                      <Pi.filter size={15} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      {c.id === savedId ? <span className="text-caption text-muted">{ut("coh.opened")}</span> : null}
                    </button>
                  ))
                )}
                {opened ? (
                  <>
                    <MenuSeparator />
                    <button
                      type="button"
                      role="menuitem"
                      className={menuItemClass("left")}
                      onClick={() => {
                        close();
                        setNaming(true);
                      }}
                    >
                      <Pi.save size={15} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate">{ut("coh2.saveAsNew")}</span>
                    </button>
                  </>
                ) : null}
              </>
            )}
          </MenuButton>
          <Button
            variant="primary"
            icon={<Pi.save />}
            disabled={busy || invalid || (!!opened && !changed)}
            onClick={() => (opened ? updateOpened() : setNaming(true))}
          >
            {opened ? fill(ut("coh2.updateNamed"), { name: opened.title }) : ut("coh2.saveCohort")}
          </Button>
        </>
      }
    >
      <div className="grid items-start gap-4 min-[1180px]:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* ─── кого шукаємо ─── */}
          <Panel
            title={ut("coh.who")}
            icon={<Pi.sliders />}
            actions={
              tags.length ? (
                <Button variant="ghost" size="xs" onClick={() => setSpec({})}>
                  {ut("coh2.resetAll")}
                </Button>
              ) : null
            }
          >
            <FilterSection title={ut("coh2.aboutPerson")}>
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
            </FilterSection>

            <FilterSection title={ut("coh2.aboutSurvey")}>
              <Group legend={ut("coh.survey")}>
                <Select
                  aria-label={ut("coh.survey")}
                  value={spec.surveyId ?? ""}
                  /* смена методики снимает условия по шкалам: коды шкал принадлежат ей */
                  onChange={(e) => patch({ surveyId: e.target.value || null, scales: [] })}
                  disabled={!surveys.data}
                  className="w-full"
                >
                  <option value="">{ut("coh.anySurvey")}</option>
                  {surveyChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {choiceLabel(c, choiceWords)}
                    </option>
                  ))}
                </Select>
              </Group>
              <Group legend={ut("coh.period")} error={errors.period ? ut(errors.period) : null}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                  <Input
                    type="date"
                    aria-label={`${ut("coh.period")}: ${ut("st.dateFrom")}`}
                    aria-invalid={!!errors.period || undefined}
                    value={spec.from ?? ""}
                    max={spec.to ?? undefined}
                    onChange={(e) => patch({ from: e.target.value || null })}
                    className="px-2"
                  />
                  <span aria-hidden className="text-muted">
                    —
                  </span>
                  <Input
                    type="date"
                    aria-label={`${ut("coh.period")}: ${ut("st.dateTo")}`}
                    aria-invalid={!!errors.period || undefined}
                    value={spec.to ?? ""}
                    min={spec.from ?? undefined}
                    onChange={(e) => patch({ to: e.target.value || null })}
                    className="px-2"
                  />
                </div>
              </Group>
              <Group legend={ut("coh.severityAtLeast")} hint={ut("coh.severityHint")}>
                <Segmented
                  name="coh-severity"
                  value={spec.minSeverity ?? "any"}
                  options={[
                    { value: "any", label: ut("coh.anySeverity") },
                    ...MIN_SEVERITY.map((s) => ({ value: s, label: ut(SEVERITY_LABEL[s]).toLowerCase() })),
                  ]}
                  onChange={(v) => patch({ minSeverity: v === "any" ? null : v })}
                />
              </Group>
              <Group legend={ut("coh.extra")}>
                <div className="flex flex-col gap-1">
                  <Check checked={!!spec.repeatedOnly} onChange={(v) => patch({ repeatedOnly: v })}>
                    {ut("coh.repeated")}
                  </Check>
                  <Check checked={!!spec.riskOnly} onChange={(v) => patch({ riskOnly: v })}>
                    {ut("coh.risk")}
                  </Check>
                </div>
              </Group>
            </FilterSection>

            <FilterSection title={ut("coh.scaleConds")}>
              {spec.surveyId ? (
                survey.data ? (
                  <ScaleConditions scales={survey.data.scales} value={spec.scales ?? []} onChange={(scales) => patch({ scales })} />
                ) : (
                  <Loading rows={1} error={survey.error} onRetry={survey.reload} bare />
                )
              ) : (
                <p className="m-0 text-small text-muted">{ut("coh.scaleNeedSurvey")}</p>
              )}
            </FilterSection>
          </Panel>

          {/* ─── збережені ─── */}
          <Panel
            title={ut("coh.saved")}
            icon={<Pi.bookmark />}
            count={saved.data?.length ?? null}
            flush
            footer={<span className="text-caption text-muted">{ut("coh2.savedNote")}</span>}
          >
            {saved.error ? (
              <Loading error={saved.error} onRetry={saved.reload} bare />
            ) : !saved.data ? (
              <Loading rows={2} bare />
            ) : saved.data.length === 0 ? (
              <p className="m-0 px-4 pb-4 text-small text-muted">{ut("coh.noneSaved")}</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {saved.data.map((c) => {
                  const current = c.id === savedId;
                  return (
                    <li
                      key={c.id}
                      className={cx(
                        "grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 border-t border-divider px-4 py-3 first:border-t-0",
                        current && "bg-violet-tint",
                      )}
                    >
                      <IconTile icon={<Pi.filter />} tone={current ? "violet" : "neutral"} />
                      <span className="min-w-0">
                        <Popover title={c.title} note={shortDate(c.createdAt, new Date(0))} content={<p className="m-0">{describeSpec(c.spec, ut, { survey: surveyTitle })}</p>}>
                          <Link
                            to={hrefOf(c)}
                            aria-current={current ? "true" : undefined}
                            className="block truncate font-extrabold text-text no-underline hover:text-violet-ink"
                          >
                            {c.title}
                          </Link>
                        </Popover>
                        <small className="block text-caption text-muted">{fill(ut("coh2.savedOn"), { date: shortDate(c.createdAt, new Date(0)) })}</small>
                        {current && changed ? (
                          <span className="mt-2 flex flex-wrap items-center gap-1.5">
                            <Tag tone="attention">{ut("coh2.openedChanged")}</Tag>
                            <Button size="xs" disabled={busy || invalid} onClick={updateOpened}>
                              {ut("coh2.update")}
                            </Button>
                          </span>
                        ) : current ? (
                          <span className="mt-1.5 inline-flex">
                            <Tag tone="primary">{ut("coh.opened")}</Tag>
                          </span>
                        ) : null}
                      </span>
                      <ActionMenu
                        label={`${ut("coh.savedActions")}: ${c.title}`}
                        triggerSize="icon-sm"
                        entries={[
                          { label: ut("coh.open"), onSelect: () => navigate(hrefOf(c)) },
                          { label: ut("coh.rename"), onSelect: () => setRenaming(c) },
                          { label: ut("adm.delete"), onSelect: () => setDeleting(c), danger: true, ruled: true },
                        ]}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {/* ─── що вийшло ─── */}
          <Panel
            title={ut("coh.result")}
            icon={<Pi.usersRound />}
            sub={
              <span role="status">
                {counting ? ut("coh.counting") : preview ? ut("coh2.updatedNow") : ""}
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.length ? (
                <>
                  <ul aria-label={ut("coh.activeConditions")} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                    {tags.map((t) => (
                      <FilterTag key={t.id} label={t.label} onRemove={() => setSpec(t.without(spec))} />
                    ))}
                  </ul>
                  <Button variant="ghost" size="xs" onClick={() => setSpec({})}>
                    {ut("tbl.resetFacets")}
                  </Button>
                </>
              ) : (
                <p className="m-0 text-small text-muted">{ut("coh.noConditions")}</p>
              )}
            </div>

            <div className="mt-5">
              {/* ошибка набора без прежнего числа — слова, а не вечный скелет (cohorts/model.ts, resultView) */}
              {view === "error" ? (
                <Loading error={previewError || ut("common.error")} onRetry={count.reload} bare />
              ) : view === "invalid" ? (
                <p className="m-0 text-small text-muted">{ut("uit.coh.fixToCount")}</p>
              ) : view === "loading" || !preview ? (
                <Loading rows={3} bare />
              ) : (
                <Result preview={preview} zone={zone} sexSet={!!spec.sex} busy={counting || invalid} />
              )}
            </div>
          </Panel>

          {/* ─── що з ними зробити ─── */}
          <Panel
            title={ut("coh.actions")}
            icon={<Pi.zap />}
            flush
            footer={
              <span className="flex items-center gap-1.5 text-caption text-muted">
                <Ic.shieldCheck size={13} />
                {ut("coh2.actionsNote")}
              </span>
            }
          >
            <ActionRow
              icon={<Pi.list />}
              title={ut("coh.showNames")}
              sub={ut("coh2.namesSub")}
              action={
                <Button size="xs" disabled={busy || invalid || !preview || !preview.size} onClick={() => setAsking(true)}>
                  {ut("coh2.show")}
                </Button>
              }
            />
            <ActionRow
              icon={<Pi.chartColumn />}
              title={ut("coh.toStats")}
              sub={ut("coh2.statsSub")}
              action={
                <Button size="xs" disabled={invalid} onClick={() => setDialog("stats")}>
                  {ut("coh2.open")}
                </Button>
              }
            />
            <ActionRow
              icon={<Pi.fileSheet />}
              title={ut("coh2.csvTitle")}
              sub={ut("coh2.csvSub")}
              action={
                <Button size="xs" icon={<Ic.download />} disabled={!preview?.breakdownAllowed} onClick={exportCsv}>
                  {ut("coh2.csv")}
                </Button>
              }
            />
            <ActionRow
              icon={<Pi.clipboardPlus />}
              title={ut("coh2.assignTitle")}
              sub={ut("coh2.assignSub")}
              action={
                <Button size="xs" disabled={busy || invalid || !preview || !preview.size} onClick={() => (names ? namesRef.current?.scrollIntoView({ block: "start" }) : setAsking(true))}>
                  {ut("coh2.byName")}
                </Button>
              }
            />
          </Panel>
        </div>
      </div>

      {/* ─── поіменно ─── */}
      {names ? (
        <div ref={namesRef} className="mt-4 scroll-mt-4">
          <Panel
            title={ut("coh.namesTitle")}
            icon={<Pi.list />}
            count={names.suppressed ? null : people.length}
            flush
            actions={
              <Button variant="ghost" size="xs" onClick={() => setNames(null)}>
                {ut("coh.hideNames")}
              </Button>
            }
          >
            {names.suppressed ? (
              <p className="m-0 px-4 pb-4 text-body text-text">
                {ut("coh.namesSuppressed")} {names.smallCellFloor}
              </p>
            ) : people.length === 0 ? (
              <p className="m-0 px-4 pb-4 text-small text-muted">{ut("srch.nothing")}</p>
            ) : (
              <>
                <DataTable
                  rows={people}
                  columns={memberColumns}
                  rowKey={(p) => p.userId}
                  label={ut("coh.namesTitle")}
                  selectable
                  selected={selected}
                  onSelectedChange={setSelected}
                  pageSize={25}
                  hotkeys={!assigning}
                  bulkActions={() => (
                    <>
                      <Button variant="panel" size="xs" icon={<Pi.clipboardPlus />} onClick={openAssign}>
                        {ut("pg.assignTest")}
                      </Button>
                      <Button variant="panel" size="xs" icon={<Pi.usersRound />} onClick={() => setDialog("group")}>
                        {ut("pg.addToGroup")}
                      </Button>
                    </>
                  )}
                />
                {names.truncated ? <p className="m-0 px-4 py-3 text-small text-muted">{ut("coh.namesTruncated")}</p> : null}
              </>
            )}
          </Panel>
        </div>
      ) : null}

      {asking && preview?.size ? (
        <Modal
          title={fill(ut(`coh2.askNames.${pluralForm(preview.size, lang)}`), { n: preview.size })}
          sub={opened?.title}
          icon={<Ic.eye />}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button variant="primary" disabled={busy} onClick={showNames}>
                {ut("coh.showNames")}
              </Button>
              <Button onClick={() => setAsking(false)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("coh.namesWarn")}</p>
        </Modal>
      ) : null}
      {naming ? (
        <Modal
          title={ut("coh2.saveCohort")}
          icon={<Pi.save />}
          onClose={() => setNaming(false)}
          footer={
            <>
              <Button variant="primary" disabled={busy || invalid || !title.trim()} onClick={saveNew}>
                {ut("coh.save")}
              </Button>
              <Button onClick={() => setNaming(false)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim() && !invalid) saveNew();
            }}
          >
            <Field label={ut("coh.name")} hint={ut("coh.savedHint")}>
              <Input value={title} maxLength={200} autoFocus onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </form>
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={ut("coh.deleteConfirm")}
          sub={deleting.title}
          icon={<Ic.alert />}
          tone="warn"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="danger" disabled={busy} onClick={() => removeSaved(deleting)}>
                {ut("adm.delete")}
              </Button>
              <Button onClick={() => setDeleting(null)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{describeSpec(deleting.spec, ut, { survey: surveyTitle })}</p>
        </Modal>
      ) : null}

      <AssignDrawer

        choose="test"
        open={assigning}
        who={fill(ut("pg2.whoPicked"), { n: selected.size })}
        whoNote={ut("pg2.assignPickedNote")}
        onAssign={assign}
        onClose={() => setAssigning(false)}
        onReturn={() => setAssigning(true)}
      />
      {dialog === "group" ? (
        groups.data ? (
          <PickGroupDialog
            groups={groups.data}
            count={selected.size}
            onPick={async (groupId) => {
              /* списком, а не запросом на человека: сервер проверяет пачку целиком; повтор — «уже там» */
              await api.addPatientGroupMembers(groupId, [...selected]);
              setDialog(null);
              toast(ut("pg.added"), "ok");
            }}
            onClose={() => setDialog(null)}
          />
        ) : (
          <Modal title={ut("pg.addToGroup")} onClose={() => setDialog(null)}>
            <Loading rows={2} error={groups.error} onRetry={groups.reload} bare />
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

/** Строка «Що з ними зробити»: значок, что сделает и чем это обернётся, кнопка */
function ActionRow({ icon, title, sub, action }: { icon: ReactNode; title: string; sub: string; action: ReactNode }) {
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-divider px-4 py-3 first:border-t-0">
      <IconTile icon={icon} tone="neutral" />
      <span className="min-w-0">
        <b className="block font-extrabold text-text">{title}</b>
        <small className="block text-caption text-muted">{sub}</small>
      </span>
      {action}
    </div>
  );
}

/* ─────────── результат ─────────── */

/**
 * Число и разбивки.
 *
 * Число — крупно, рядом — из скольких обследованных зоны и доля. Скрытое
 * порогом — словами: «замало, щоб назвати число» и сам порог рядом, иначе
 * прочерк на месте главного числа экрана читался бы как поломка.
 *
 * Пока идёт пересчёт, прежний результат остаётся на месте приглушённым
 * (aria-busy): пустой экран на каждое нажатие мигал бы, а старое число без
 * пометки выдавало бы себя за новое.
 *
 * Разбивка по статі не рисуется, когда стать задана условием: в ней одна
 * строка на сто процентов, и это не сведение, а повтор условия.
 */
function Result({ preview, zone, sexSet, busy }: { preview: CohortPreview; zone: number | null; sexSet: boolean; busy: boolean }) {
  const { ut, lang } = useLang();
  const kinds = BREAKDOWNS.filter((k: BreakdownKind) => !(k === "sex" && sexSet));
  return (
    <div aria-busy={busy || undefined} className={cx("transition-opacity duration-[var(--dur-fast)]", busy && "opacity-60")}>
      {preview.size === null ? (
        <div>
          <p className="m-0 text-[20px] font-extrabold leading-[26px] text-text">{ut("coh.tooSmall")}</p>
          <p className="m-0 mt-1 max-w-[60ch] text-small text-muted">
            {ut("coh.floorHint")} {preview.smallCellFloor}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <span className="block text-caption font-bold text-muted">{ut("coh2.inCohort")}</span>
            <span className="mt-1 flex items-baseline gap-2">
              <span className="text-[48px] font-extrabold leading-none tracking-[-0.04em] tabular-nums text-text">{preview.size}</span>
              <span className="font-bold text-text-2">{ut(`coh2.people.${pluralForm(preview.size, lang)}`)}</span>
            </span>
          </div>
          {zone ? (
            <p className="m-0 pb-1 text-small text-text-2">
              {fill(ut("coh2.ofZone"), { zone, pct: Math.round((preview.size / zone) * 100) })}
              {sexSet ? `; ${ut("coh2.noSexSplit")}` : ""}
            </p>
          ) : null}
        </div>
      )}
      {preview.size === 0 ? <p className="m-0 mt-2 text-small text-muted">{ut("coh.nobody")}</p> : null}

      {preview.breakdownAllowed ? (
        <>
          {/* две колонки — от 1400: на 1280 в половине панели подписи подразделений обрезались бы на первом слове */}
          <div className="mt-6 grid gap-x-8 gap-y-6 min-[1400px]:grid-cols-2">
            {kinds.map((kind: BreakdownKind) => (
              <Breakdown
                key={kind}
                title={ut(BREAKDOWN_TITLE[kind])}
                rows={barRows(breakdownCells(preview, kind), preview.size)}
                label={(k) => breakdownLabel(kind, k, ut)}
                severity={kind === "severity"}
                floor={preview.smallCellFloor}
              />
            ))}
          </div>
          <Callout kind="line" icon={<Pi.eyeOff />} className="mt-5">
            {ut("coh.sharesNote")}
          </Callout>
        </>
      ) : preview.size !== 0 ? (
        <p className="m-0 mt-3 max-w-[60ch] text-small text-muted">{ut("coh.noBreakdown")}</p>
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
 * «Вік від — до» двумя полями.
 *
 * Набранное живёт в поле, а в правило уходит после паузы: иначе «35» по
 * буквам сначала стало бы «3», и под «від 25» поле покраснело бы ошибкой
 * диапазона посреди набора. Снятая меткой «×» граница приходит сверху и
 * переписывает поле.
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
    <div className="w-[84px] shrink-0">
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={120}
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={ph}
        value={value}
        onChange={(e) => set(e.target.value)}
        className="w-full text-center"
      />
    </div>
  );
  return (
    <div className="flex items-center gap-2">
      {field(ut("st.ageFrom"), ut("coh.fromWord"), lo, setLo)}
      <span className="text-small text-muted">{ut("coh.ageTo")}</span>
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
 * Условия «шкала · умова · бал» карточками на подложке.
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

  if (!scales.length) return <p className="m-0 text-small text-muted">{ut("coh.noScales")}</p>;

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r, i) => {
        const hint = range(r.code);
        return (
          <div key={r.key} className="flex flex-col gap-1.5 rounded-[12px] bg-sunk p-2.5">
            <Select aria-label={`${ut("coh.scale")} ${i + 1}`} value={r.code} onChange={(e) => set(r.key, { code: e.target.value })} className="h-9 w-full">
              {scales.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.title}
                </option>
              ))}
            </Select>
            <div className="grid grid-cols-[minmax(0,1fr)_72px_32px] items-center gap-1.5">
              <Select aria-label={`${ut("coh.operator")} ${i + 1}`} value={r.op} onChange={(e) => set(r.key, { op: e.target.value as ScaleCond["op"] })} className="h-9">
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {ut(OPERATOR_LABEL[op])}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                inputMode="decimal"
                aria-label={`${ut("coh.value")} ${i + 1}`}
                aria-describedby={hint ? `${idBase}-${r.key}` : undefined}
                placeholder={ut("coh.value")}
                value={r.value}
                onChange={(e) => set(r.key, { value: e.target.value })}
                className="h-9 px-2.5"
              />
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label={`${ut("st.removeCriterion")} ${i + 1}`}
                onClick={() => update(rows.filter((x) => x.key !== r.key))}
              >
                <Ic.x />
              </Button>
            </div>
            {hint ? (
              <p id={`${idBase}-${r.key}`} className="m-0 text-caption text-muted">
                {hint}
              </p>
            ) : null}
          </div>
        );
      })}
      <div>
        <button
          type="button"
          disabled={rows.length >= 10}
          onClick={() => update([...rows, { key: `c${++rowSeq}`, code: scales[0]!.code, op: ">=", value: "" }])}
          className="inline-flex h-9 min-h-0 cursor-pointer items-center gap-1.5 rounded-[18px] border-0 bg-transparent pl-2.5 pr-3 text-small font-semibold text-text-2 shadow-[inset_0_0_0_1.5px_var(--ctl)] hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Ic.plus size={14} />
          {ut("coh.addCond")}
        </button>
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
 * пресет с половиной условий читался бы как та же выборка.
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
    <Modal
      title={ut("coh.toStatsTitle")}
      icon={<Pi.chartColumn />}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" disabled={busy || !title.trim()} onClick={() => void create()}>
            {busy ? ut("co.saving") : ut("coh.createPreset")}
          </Button>
          <Button onClick={onClose}>{ut("common.cancel")}</Button>
        </>
      }
    >
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void create();
        }}
      >
        <p className="m-0 text-body text-text">{ut("coh.toStatsLede")}</p>
        {carried.length ? (
          <ul className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0">
            {carried.map((c) => (
              <li key={c.id}>
                <Tag tone="primary">{c.label}</Tag>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 mt-2 text-small text-muted">{ut("coh.toStatsNothing")}</p>
        )}
        {dropped.length ? (
          <>
            <p className="m-0 mt-3.5 text-body text-text">{ut("coh.toStatsDropped")}</p>
            <p className="m-0 mt-1 text-small text-muted">{dropped.map((k) => ut(k)).join(", ")}</p>
          </>
        ) : null}
        <div className="mt-4">
          <Field label={ut("coh.presetName")} error={error}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus required />
          </Field>
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
  const save = () =>
    void run(async () => {
      await api.updateCohort(row.id, { title: title.trim() });
      onSaved();
    }, ut("coh.renamed"));
  return (
    <Modal
      title={ut("coh.rename")}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" disabled={busy || !title.trim() || title.trim() === row.title} onClick={save}>
            {ut("common.save")}
          </Button>
          <Button onClick={onClose}>{ut("common.cancel")}</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) save();
        }}
      >
        <Field label={ut("coh.name")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus required />
        </Field>
      </form>
    </Modal>
  );
}
