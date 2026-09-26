import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SampleFilters } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Loading, useAction, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { MenuButton, menuItemClass } from "../../ui/menu";
import { Button } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { useLocalityHints } from "./data";
import { CRITERION_LABEL, type Criterion, STATS_FILTERS, cleanFilters, filterErrors, presetHref, withoutCriteria } from "./model";
import {
  AgeRow,
  DateField,
  GlyphButton,
  GroupSelect,
  IconMinusThick,
  PatientField,
  SexSelect,
  StatInput,
  patchFilters,
} from "./parts";

/*
 * «Створення фільтра» и «Пресети фільтрів» — кадр f23. Адрес /statistics/
 * filters; пресет из списка открывается в той же форме (/filters/:id).
 * Дверь сюда — пункт «Керувати фільтрами» шестерёнки экрана f24.
 *
 * Что на кадре и как это легло на код (замеры f23 в координатах кадра 1600,
 * низ полосы шапки = 100):
 *
 *   «Створення фільтра» 24/700                 → Page `snug tight`, 140…170
 *   поля 450…1114 (665) с шагом 51, первое      → строки формы: поле #f0ecff,
 *   на 295; «−» 1123…1151 справа от каждого       подпись 16/700, глиф 8 справа
 *   «Стать» 96 + 20 + «Населений пункт», «+»    → последняя строка
 *   «Зберегти» 215×45 на 30 ниже, по 1150       → Button size="md"
 *   черта #cccccc 2px во всю колонку, 39 ниже   → <hr>
 *   «Пресети фільтрів» 20/700, шесть имён       → <h2> и сетка 455 | 1fr | 1fr,
 *   в три колонки (202, 655, правым краем 1398)   третья колонка — вправо
 *
 * «Пресети фільтрів» на кадре набраны красным (255, 0, 0) — и заголовок, и
 * имена. Опись кадров читает это как пометку макетчика «в работе, не
 * утверждено», а не как цвет интерфейса: больше красного текста нет ни на
 * одном из 53 кадров, а красным в консоли набраны только ошибки и опасные
 * действия. Здесь они фиолетовые, как все ссылки раздела; отступление
 * записано в docs/REWRITE-PLAN.md (раздел 13).
 *
 * Строки. «−» убирает строку-критерий вместе со значением (пресет его
 * больше не содержит), «+» последней строки возвращает убранные и
 * добавляет «Група пацієнтів» — критерий сервера, которого кадр не
 * рисует. «Стать» и «Населений пункт» стоят в одной строке с «+» и не
 * убираются: пустое поле и есть «критерия нет».
 *
 * «−» у «Назва фільтра» — сам пресет: у нового он очищает форму, у
 * сохранённого — удаляет пресет. Занятый моделями сервер не удалит
 * (err.filterPresetInUse с их числом), и отказ приходит тостом.
 */

/** Строки, которые убираются «−»: первые три с кадра и «Група пацієнтів» из «+» */
type RowKind = Exclude<Criterion, "sex" | "locality">;
const FRAME_ROWS: RowKind[] = ["date", "patient", "age"];

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
  const preset = useResource(() => api.filterPreset(id!), [id], { enabled: id !== null });
  const groups = useResource(() => api.patientGroups(), []);
  const hints = useLocalityHints();
  const listId = useId();
  /*
   * Заголовок у сохранённого пресета — «Зміна фільтра». Решение заказчика
   * 2026-09-26: адекватные фильтры. Кадр рисует форму нового пресета, и
   * «Створення фільтра» над уже существующим читалось как «сейчас будет
   * создан ещё один» — человек не понимал, правит он или копирует.
   */
  const heading = ut(id === null ? "st.filterNew" : "st.filterEdit");

  const [title, setTitle] = useState("");
  const [filters, setFilters] = useState<SampleFilters>({});
  const [rows, setRows] = useState<RowKind[]>(FRAME_ROWS);
  useEffect(() => {
    if (!preset.data) return;
    setTitle(preset.data.title);
    setFilters(preset.data.criteria);
    setRows(preset.data.criteria.patientGroupId ? [...FRAME_ROWS, "group"] : FRAME_ROWS);
  }, [preset.data]);

  const patch = (p: Partial<SampleFilters>) => setFilters((f) => patchFilters(f, p));
  const drop = (row: RowKind) => {
    setRows((r) => r.filter((x) => x !== row));
    setFilters((f) => withoutCriteria(f, [row]));
  };
  const add = (row: RowKind) => setRows((r) => [...FRAME_ROWS, "group" as const].filter((x) => x === row || r.includes(x)));
  const missing = ([...FRAME_ROWS, "group"] as RowKind[]).filter((r) => !rows.includes(r));

  const errs = filterErrors(filters);
  const save = () => {
    if (!title.trim()) {
      toast(ut("st.errFilterName"), "err");
      return;
    }
    if (errs.length) {
      toast(ut(errs[0]!), "err");
      return;
    }
    void run(async () => {
      const body = { title: title.trim(), criteria: cleanFilters(filters) };
      if (id === null) {
        const created = await api.createFilterPreset(body);
        navigate(presetHref(created.id), { replace: true });
      } else {
        await api.updateFilterPreset(id, body);
        presets.reload();
      }
    }, ut("st.presetSaved"));
  };

  /* «−» у названия: у нового — очистить форму, у сохранённого — удалить пресет */
  const dropPreset = () => {
    if (id === null) {
      setTitle("");
      setFilters({});
      setRows(FRAME_ROWS);
      return;
    }
    void run(async () => {
      if (!window.confirm(ut("st.presetDeleteConfirm"))) return false;
      await api.deleteFilterPreset(id);
      toast(ut("st.presetDeleted"), "ok");
      navigate(STATS_FILTERS, { replace: true });
    });
  };

  if (id !== null && !preset.data) {
    return (
      <Page title={heading} snug tight>
        <Loading rows={5} error={preset.error} onRetry={preset.reload} />
      </Page>
    );
  }

  const line = (key: string, content: ReactNode, glyph: ReactNode) => (
    /* поле 665 и глиф 8 правее — замер f23: 459…1123 и 1132…1160 */
    <div key={key} className="flex items-center gap-[8px]">
      <div className="flex w-[665px] min-w-0 max-w-[calc(100%-35px)]">{content}</div>
      {glyph}
    </div>
  );

  return (
    <Page title={heading} snug tight>
      {/* форма: 700 по центру, первое поле на 125 ниже строки заголовка (170 → 295) */}
      <div className="mx-auto mt-[125px] flex w-[700px] max-w-full flex-col gap-[15px]">
        {line(
          "title",
          <StatInput
            look="fill"
            label={ut("st.filterName")}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />,
          <GlyphButton label={id === null ? ut("st.clearForm") : ut("st.deletePreset")} onClick={dropPreset} disabled={busy}>
            <IconMinusThick />
          </GlyphButton>,
        )}
        {rows.map((row) =>
          line(
            row,
            row === "date" ? (
              <DateField
                look="fill"
                from={filters.from}
                to={filters.to}
                onChange={(p) => patch(p)}
                invalid={errs.includes("coh.errPeriod")}
              />
            ) : row === "patient" ? (
              <PatientField look="fill" value={filters.patientId} onChange={(patientId) => patch({ patientId })} />
            ) : row === "age" ? (
              <AgeRow
                look="fill"
                min={filters.ageMin}
                max={filters.ageMax}
                onChange={(p) => patch(p)}
                dash={17}
                gap={10}
                invalid={errs.includes("coh.errAge")}
              />
            ) : (
              <GroupSelect
                look="fill"
                value={filters.patientGroupId}
                onChange={(patientGroupId) => patch({ patientGroupId })}
                groups={groups.data}
              />
            ),
            <GlyphButton label={`${ut("st.removeCriterion")}: ${ut(CRITERION_LABEL[row])}`} onClick={() => drop(row)}>
              <IconMinusThick />
            </GlyphButton>,
          ),
        )}
        {line(
          "sex",
          /* «Стать» 96 + 20 + «Населений пункт» — замер f23: 459…554 и 575…1123 */
          <div className="flex min-w-0 flex-1 gap-[20px]">
            <SexSelect look="fill" value={filters.sex} onChange={(sex) => patch({ sex })} className="w-[96px] shrink-0" />
            <StatInput
              look="fill"
              label={ut("st.locality")}
              value={filters.locality ?? ""}
              maxLength={160}
              list={hints.length ? listId : undefined}
              autoComplete="off"
              onChange={(e) => patch({ locality: e.target.value })}
            />
            {hints.length ? (
              <datalist id={listId}>
                {hints.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
            ) : null}
          </div>,
          missing.length ? (
            <MenuButton label={ut("st.addCriterion")} glyph={<IconPlusThick />} align="right-out">
              {(close) =>
                missing.map((row) => (
                  <button
                    key={row}
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right-out")}
                    onClick={() => {
                      close();
                      add(row);
                    }}
                  >
                    {ut(CRITERION_LABEL[row])}
                  </button>
                ))
              }
            </MenuButton>
          ) : (
            <GlyphButton label={ut("st.addCriterion")} onClick={() => {}} disabled>
              <IconPlusThick />
            </GlyphButton>
          ),
        )}
        {/* перевёрнутый диапазон — словами у места, а не только красным значением */}
        {errs.length ? (
          <p role="alert" className="m-0 text-[13px] leading-[18px] text-danger">
            {errs.map((k) => ut(k)).join(" · ")}
          </p>
        ) : null}
        {/* «Зберегти» 30 ниже строк (15 шага + 15), правым краем по 1150 */}
        <div className="mt-[15px] flex justify-end">
          <Button size="md" className="w-[215px]" disabled={busy} onClick={save}>
            {ut("common.save")}
          </Button>
        </div>
      </div>

      <hr className="m-0 mt-[39px] h-[2px] border-0 bg-hairline" />

      <section aria-labelledby="st-presets">
        <h2 id="st-presets" className="m-0 mt-[26px] text-[20px] font-bold leading-[24px] text-primary">
          {ut("st.presets")}
        </h2>
        {presets.error ? (
          <Loading error={presets.error} onRetry={presets.reload} />
        ) : !presets.data ? null : presets.data.length === 0 ? (
          <p className="m-0 mt-[18px] text-[13px] text-muted">{ut("st.noPresets")}</p>
        ) : (
          <ul className="m-0 mt-[18px] grid list-none grid-cols-[455px_minmax(0,1fr)_minmax(0,1fr)] p-0 max-[900px]:grid-cols-1">
            {presets.data.map((p, i) => (
              <li key={p.id} className={cx("min-w-0 truncate", i % 3 === 2 && "text-right max-[900px]:text-left")}>
                <Link
                  to={presetHref(p.id)}
                  aria-current={p.id === id ? "page" : undefined}
                  className={cx(
                    "text-[20px] font-bold leading-[30px] text-primary no-underline",
                    "hover:underline aria-[current=page]:underline",
                  )}
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}
