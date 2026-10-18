import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import type { FilterPresetListItem, PatientGroupWithCounts, SampleFilters } from "@quizzy/shared";
import { api } from "../../api";
import { day as dayOf } from "../../format";
import { useLang } from "../../lang";
import {
  Ic,
  KbdHints,
  KV,
  Loading,
  Modal,
  SearchField,
  Tooltip,
  useAction,
  useHotkeys,
  useToast,
} from "../../ui";
import { cx } from "../../ui/cx";
import { Count, IconTile, Page, Panel } from "../../ui/layout";
import { Button, ButtonLink, Field, Input } from "../../ui/primitives";
import { useResource } from "../../useResource";
import {
  CRITERION_LABEL,
  type Criterion,
  STATS_CHART,
  STATS_FILTERS,
  cleanFilters,
  criteriaOf,
  criterionValue,
  dayText,
  patchFilters,
  presetHref,
  presetProblem,
  statHref,
  withoutCriteria,
} from "./model";
import {
  AgeFields,
  CRITERION_ICON,
  GroupSelect,
  LocalityInput,
  PatientField,
  PeriodFields,
  SexField,
  St,
} from "./parts";

/*
 * Фільтри вибірки — дизайн statistics-filters: перечень пресетов слева,
 * пресет справа (/statistics/filters — новый, /statistics/filters/:id —
 * сохранённый).
 *
 * Пресет — именованный набор условий, который выборка модели берёт по
 * ссылке вместо своих фильтров. Условия — строками: дата, вік, пацієнт,
 * група убираются и возвращаются «Додати умову»; стать и населений пункт
 * стоят всегда — пустое поле и есть «будь-яка». Ниже — кто отбирается
 * словами и в каких моделях пресет стоит: правка пресета меняет все эти
 * выборки с ближайшего «Порівняти».
 *
 * Удаление занятого моделями пресета сервер не допустит
 * (err.filterPresetInUse); экран говорит это до нажатия: кнопка погашена,
 * причина рядом.
 */

/** Строки, которые убираются и возвращаются; стать и населённый пункт — всегда */
type RowKind = Extract<Criterion, "date" | "age" | "patient" | "group">;
const REMOVABLE: RowKind[] = ["date", "age", "patient", "group"];
/** Новый пресет начинается с даты и возраста — самых частых условий */
const START_ROWS: RowKind[] = ["date", "age"];

export default function StatFiltersPage() {
  const { id } = useParams<{ id: string }>();
  return <FiltersScreen key={id ?? "new"} id={id ?? null} />;
}

function FiltersScreen({ id }: { id: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();

  const presets = useResource(() => api.filterPresets(), []);
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const preset = useResource(() => api.filterPreset(id!), [id], { enabled: id !== null, manual: true });
  const groups = useResource(() => api.patientGroups(), []);

  const [title, setTitle] = useState("");
  const [filters, setFilters] = useState<SampleFilters>({});
  const [rows, setRows] = useState<RowKind[]>(id === null ? START_ROWS : []);
  const [doomed, setDoomed] = useState(false);
  const [errTitle, setErrTitle] = useState(false);
  const reset = () => {
    if (!preset.data) {
      setTitle("");
      setFilters({});
      setRows(START_ROWS);
      return;
    }
    setTitle(preset.data.title);
    setFilters(preset.data.criteria);
    setRows(REMOVABLE.filter((r) => criteriaOf(preset.data!.criteria).includes(r)));
  };
  useEffect(() => {
    if (preset.data) reset();
    // reset читает preset.data — он и есть зависимость
  }, [preset.data]);

  const patch = (p: Partial<SampleFilters>) => setFilters((f) => patchFilters(f, p));
  const drop = (row: RowKind) => {
    setRows((r) => r.filter((x) => x !== row));
    setFilters((f) => withoutCriteria(f, [row]));
  };
  const add = (row: RowKind) => setRows((r) => REMOVABLE.filter((x) => x === row || r.includes(x)));
  const missing = REMOVABLE.filter((r) => !rows.includes(r));

  const save = () => {
    const problem = presetProblem(title, filters);
    setErrTitle(problem === "st.errFilterName");
    if (problem) {
      toast(ut(problem), "err");
      return;
    }
    void run(async () => {
      const body = { title: title.trim(), criteria: cleanFilters(filters) };
      if (id === null) {
        const created = await api.createFilterPreset(body);
        presets.reload();
        navigate(presetHref(created.id), { replace: true });
      } else {
        await api.updateFilterPreset(id, body);
        presets.reload();
        preset.reload();
      }
    }, ut("st.presetSaved"));
  };

  /* Ctrl/⌘ + S — «Зберегти» */
  const [saveRef] = useState<{ current: () => void }>(() => ({ current: () => {} }));
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saveRef]);

  const remove = () =>
    void run(async () => {
      if (id === null) return false;
      await api.deleteFilterPreset(id);
      setDoomed(false);
      toast(ut("st.presetDeleted"), "ok");
      presets.reload();
      navigate(STATS_FILTERS, { replace: true });
    });

  const used = preset.data?.modelCount ?? 0;
  const heading = id === null ? ut("st.filterNew") : (preset.data?.title ?? ut("st.filterEdit"));

  return (
    <div className="flex min-h-0 flex-1">
      <PresetList presets={presets.data} error={presets.error} onRetry={presets.reload} current={id} />
      <Page
        title={heading}
        meta={
          id === null
            ? [ut("st.presetNewMeta"), ut("st.conditionsSubLong")]
            : [ut("st.presetMeta"), used ? ut("st.usedInN").replace("{n}", String(used)) : ut("st.unused")]
        }
        actions={
          <ButtonLink to={STATS_CHART}>
            <St.chartColumn />
            {ut("sn.chart")}
          </ButtonLink>
        }
      >
        {id !== null && !preset.data ? (
          <Loading rows={5} error={preset.error} onRetry={preset.reload} />
        ) : (
          <>
            <Panel
              title={id === null ? ut("st.filterNew") : ut("st.filterEdit")}
              icon={<St.sliders />}
              sub={
                preset.data
                  ? ut("st.changedOn").replace("{d}", dayText(preset.data.updatedAt.slice(0, 10)))
                  : undefined
              }
              footer={
                <>
                  {id === null ? (
                    <Button variant="quiet" onClick={reset}>
                      {ut("st.clearForm")}
                    </Button>
                  ) : (
                    <>
                      <Button icon={<St.trash />} disabled={busy || used > 0} onClick={() => setDoomed(true)}>
                        {ut("st.deletePreset")}
                      </Button>
                      {used > 0 ? (
                        <span className="max-w-[300px] text-small leading-[17px] text-muted">
                          {ut("st.presetInUse").replace("{n}", String(used))}
                        </span>
                      ) : null}
                    </>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    {id !== null ? (
                      <Button variant="ghost" onClick={reset}>
                        {ut("common.cancel")}
                      </Button>
                    ) : null}
                    <Tooltip label={ut("common.save")} kbd="Ctrl S">
                      <Button variant="primary" icon={<Ic.check />} disabled={busy} onClick={save}>
                        {ut("common.save")}
                      </Button>
                    </Tooltip>
                  </span>
                </>
              }
            >
              <Field label={ut("st.filterName")} error={errTitle ? ut("st.errFilterName") : null}>
                <Input
                  data-autofocus
                  value={title}
                  maxLength={200}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    if (e.target.value.trim()) setErrTitle(false);
                  }}
                />
              </Field>
              <div className="mb-1 mt-5 flex flex-wrap items-baseline gap-2">
                <h3 className="m-0 text-h3 font-extrabold text-text">{ut("st.conditions")}</h3>
                <span className="text-small text-muted">{ut("st.conditionsSubLong")}</span>
              </div>
              <div className="flex flex-col">
                {rows.map((row) => (
                  <Condition
                    key={row}
                    kind={row}
                    hint={ut(HINT[row])}
                    onRemove={() => drop(row)}
                  >
                    {row === "date" ? (
                      <PeriodFields inline from={filters.from} to={filters.to} onChange={(p) => patch(p)} />
                    ) : row === "age" ? (
                      <AgeFields inline min={filters.ageMin} max={filters.ageMax} onChange={(p) => patch(p)} />
                    ) : row === "patient" ? (
                      <PatientField
                        label={ut("st.patient")}
                        value={filters.patientId}
                        onChange={(patientId) => patch({ patientId })}
                      />
                    ) : (
                      <GroupSelect
                        value={filters.patientGroupId}
                        groups={groups.data}
                        onChange={(patientGroupId) => patch({ patientGroupId })}
                      />
                    )}
                  </Condition>
                ))}
                <Condition kind="sex" hint={ut("st.sexHint")}>
                  <div className="max-w-[340px]">
                    <SexField value={filters.sex} onChange={(sex) => patch({ sex })} />
                  </div>
                </Condition>
                <Condition kind="locality" hint={ut("st.localityHint")}>
                  <div className="max-w-[340px]">
                    <LocalityInput value={filters.locality} onChange={(locality) => patch({ locality })} />
                  </div>
                </Condition>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-control border-[1.5px] border-dashed border-control px-2 py-1.5">
                <span className="flex items-center gap-1.5 px-1.5 text-small font-bold text-text-2">
                  <Ic.plus size={14} />
                  {ut("st.addCriterion")}
                </span>
                {missing.map((row) => (
                  <Button key={row} variant="ghost" size="xs" icon={CRITERION_ICON[row]} onClick={() => add(row)}>
                    {ut(CRITERION_LABEL[row])}
                  </Button>
                ))}
                {!missing.length ? <span className="text-small text-muted">{ut("st.allAdded")}</span> : null}
              </div>
            </Panel>

            <div className="mt-4 grid items-stretch gap-4 grid-cols-2 max-[1100px]:grid-cols-1">
              <Panel title={ut("st.whoTitle")} icon={<St.usersRound />}>
                <Who filters={filters} groups={groups.data} />
                <p className="m-0 mt-3 text-small text-muted">{ut("st.whoNote")}</p>
              </Panel>
              <Panel
                title={ut("st.usedTitle")}
                icon={<St.link />}
                sub={id !== null ? (used ? ut("st.usedInN").replace("{n}", String(used)) : ut("st.unused")) : undefined}
                flush
              >
                {id === null || !preset.data ? (
                  <p className="m-0 px-4 pb-4 text-small text-muted">{ut("st.usedNew")}</p>
                ) : (
                  <>
                    {preset.data.usedBy.length ? (
                      <ul className="m-0 list-none px-1.5 pb-1 pt-0">
                        {preset.data.usedBy.map((m) => (
                          <li key={m.id}>
                            <Link
                              to={statHref(m.id)}
                              className="flex items-center gap-2 rounded-control px-2.5 py-2 no-underline hover:bg-sunk"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-bold text-text">{m.title}</span>
                                <small className="block text-caption text-muted">
                                  {ut("st.samplesNos").replace("{list}", m.samples.join(", "))}
                                </small>
                              </span>
                              <St.arrowUpRight size={15} className="text-muted" />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {used > preset.data.usedBy.length ? (
                      <p className="m-0 px-4 pb-1 text-small text-text-2">
                        {ut("st.othersUse").replace("{n}", String(used - preset.data.usedBy.length))}
                      </p>
                    ) : null}
                    <p className="m-0 px-4 pb-4 pt-1 text-small text-muted">
                      {used ? ut("st.presetEffect") : ut("st.unusedLong")}
                    </p>
                  </>
                )}
              </Panel>
            </div>
          </>
        )}
      </Page>

      {doomed ? (
        <Modal
          title={ut("st.presetDeleteConfirm")}
          sub={ut("st.cannotUndo")}
          icon={<St.trash />}
          tone="warn"
          onClose={() => setDoomed(false)}
          footer={
            <>
              <Button variant="primary" icon={<St.trash />} disabled={busy} onClick={remove}>
                {ut("st.deletePreset")}
              </Button>
              <Button onClick={() => setDoomed(false)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 pt-3.5 text-body text-text-2">{heading}</p>
        </Modal>
      ) : null}
    </div>
  );
}

const HINT: Record<RowKind, "st.dateHint" | "st.ageHint" | "st.patientRowHint" | "st.groupHint"> = {
  date: "st.dateHint",
  age: "st.ageHint",
  patient: "st.patientRowHint",
  group: "st.groupHint",
};

/** Строка условия: значок и имя слева, поля и пояснение посередине, «прибрати» справа */
function Condition({
  kind,
  hint,
  onRemove,
  children,
}: {
  kind: Criterion;
  hint: string;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const { ut } = useLang();
  const label = ut(CRITERION_LABEL[kind]);
  return (
    <div className="grid grid-cols-[176px_minmax(0,1fr)_36px] items-start gap-3.5 border-t border-divider py-3.5 first:border-t-0 first:pt-1 max-[1100px]:grid-cols-[minmax(0,1fr)_36px]">
      <div className="flex h-10 items-center gap-2.5 font-bold text-text max-[1100px]:col-span-2">
        <IconTile icon={CRITERION_ICON[kind]} tone="neutral" />
        {label}
      </div>
      <div className="min-w-0">
        {children}
        <p className="m-0 mt-1.5 text-small text-muted">{hint}</p>
      </div>
      <div className="pt-1">
        {onRemove ? (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={`${ut("st.removeCriterion")}: ${label}`}
            title={`${ut("st.removeCriterion")}: ${label}`}
            onClick={onRemove}
          >
            <Ic.x />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Кого отбирает пресет — словами, по условию в строке; пустое условие — «будь-який» */
function Who({ filters, groups }: { filters: SampleFilters; groups: PatientGroupWithCounts[] | null }) {
  const { ut } = useLang();
  const f = cleanFilters(filters);
  const group = f.patientGroupId ? groups?.find((g) => g.id === f.patientGroupId) : undefined;
  const rows: [ReactNode, ReactNode][] = [
    [ut("person.sex"), criterionValue("sex", f, ut) || ut("st.anySex")],
    [ut("st.chipAge"), criterionValue("age", f, ut) ? ut("st.yearsRange").replace("{r}", criterionValue("age", f, ut)) : ut("st.anyAge")],
    [ut("st.period"), criterionValue("date", f, ut) ? ut("st.inclusive").replace("{r}", criterionValue("date", f, ut)) : ut("st.anyPeriod")],
    [ut("st.locality"), f.locality ?? ut("st.anyLocality")],
    [ut("st.group"), f.patientGroupId ? (group?.title ?? ut("st.groupUnavailable")) : ut("st.anyGroup")],
  ];
  if (f.patientId) rows.push([ut("st.patient"), ut("st.onePatient")]);
  return <KV rows={rows} w={130} />;
}

/* ─────────── перечень пресетов ─────────── */

function PresetList({
  presets,
  error,
  onRetry,
  current,
}: {
  presets: FilterPresetListItem[] | null;
  error: string | null;
  onRetry: () => void;
  current: string | null;
}) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const words = (p: FilterPresetListItem) =>
    criteriaOf(p.criteria)
      .map((k) => criterionValue(k, p.criteria, ut) || ut(CRITERION_LABEL[k]))
      .join(", ");
  const needle = q.trim().toLowerCase();
  const found = (presets ?? []).filter(
    (p) => !needle || p.title.toLowerCase().includes(needle) || words(p).toLowerCase().includes(needle),
  );

  /* J / K — следующий и предыдущий пресет перечня */
  const step = (d: 1 | -1) => {
    if (!found.length) return;
    const at = found.findIndex((p) => p.id === current);
    const next = found[at < 0 ? 0 : Math.max(0, Math.min(found.length - 1, at + d))];
    if (next) navigate(presetHref(next.id));
  };
  useHotkeys({ j: () => step(1), k: () => step(-1) });

  return (
    <aside
      aria-label={ut("st.presets")}
      className="flex w-[320px] shrink-0 flex-col border-r border-border bg-panel max-[1180px]:w-[264px] max-[860px]:hidden"
    >
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <h2 className="m-0 text-[18px] font-extrabold tracking-[-0.01em] text-text">{ut("st.presets")}</h2>
        {presets ? <Count n={presets.length} /> : null}
        <ButtonLink
          to={STATS_FILTERS}
          size="icon-sm"
          variant="quiet"
          className="ml-auto"
          aria-label={ut("st.newPreset")}
          title={ut("st.newPreset")}
        >
          <Ic.plus />
        </ButtonLink>
      </div>
      <div className="px-4 pb-3">
        <SearchField value={q} onChange={setQ} placeholder={ut("st.presetFind")} width={0} slash />
      </div>
      <div className="kit-scroll min-h-0 flex-1 overflow-y-auto border-t border-divider px-2 py-2">
        {error ? (
          <div className="px-2">
            <Loading bare error={error} onRetry={onRetry} />
          </div>
        ) : !presets ? (
          <Loading bare rows={4} />
        ) : !found.length ? (
          <p className="m-0 px-2 py-2 text-small text-muted">{needle ? ut("am.emptySearch") : ut("st.noPresets")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {found.map((p) => {
              const n = criteriaOf(p.criteria).length;
              return (
                <li key={p.id}>
                  <NavLink
                    to={presetHref(p.id)}
                    className={({ isActive }) =>
                      cx(
                        "block rounded-[12px] px-3 py-2.5 no-underline",
                        isActive ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "hover:bg-sunk",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className="flex items-baseline gap-2">
                          <span
                            className={cx("min-w-0 flex-1 truncate font-extrabold", isActive ? "text-violet-ink" : "text-text")}
                          >
                            {p.title}
                          </span>
                          <span className="shrink-0 text-caption text-muted">
                            {ut("st.condN").replace("{n}", String(n))}
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-small text-text-2">{words(p) || ut("st.everyone")}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-caption text-muted">
                          <St.sigma size={13} />
                          <span className="min-w-0 flex-1 truncate">
                            {p.modelCount ? ut("st.usedInN").replace("{n}", String(p.modelCount)) : ut("st.unused")}
                          </span>
                          <span className="shrink-0">{ut("st.changedOn").replace("{d}", dayOf(p.updatedAt))}</span>
                        </span>
                      </>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-divider px-4 py-2.5">
        <KbdHints
          keys={[
            ["J K", ut("st.kRows")],
            ["/", ut("hotkey.search")],
          ]}
        />
        {presets ? (
          <span className="ml-auto text-caption font-bold tabular-nums text-text-2">
            {ut("kit.ofTotal").replace("{n}", String(found.length)).replace("{total}", String(presets.length))}
          </span>
        ) : null}
      </div>
    </aside>
  );
}
