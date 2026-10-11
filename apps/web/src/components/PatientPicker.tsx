import { useState } from "react";
import { api, type Patient } from "../api";
import { useLang } from "../lang";
import { Field, Input, Select } from "../ui/primitives";
import { useDebounced, useResource, type Resource } from "../useResource";

/**
 * Выбор пациента зоны — с поиском на сервере (#174).
 *
 * GET /api/access/patients отдаёт не больше ста человек: ФИО зашифровано,
 * упорядочить и листать его в SQL нечем, поэтому сервер ищет сам и
 * обрезает выдачу (routes/access.ts, PATIENT_LIMIT). «Доступ до методики»,
 * «Набори» и «Провести методику» брали первую сотню без поиска и фильтровали
 * её у себя: сто первого человека нельзя было ни найти, ни назначить, а
 * «никого не найдено» выглядело как «его нет в зоне». Теперь набранное
 * уходит серверу, а усечённая выдача говорит о себе — «звузьте пошук».
 * Образец — «Додати пацієнта» в группах (patientGroups/dialogs.tsx).
 */

export interface PatientsFound {
  items: Patient[];
  truncated: boolean;
}

/** Запрос поиска: пустая строка — без параметра (первые сто по алфавиту) */
export function searchPatients(query: string): Promise<PatientsFound> {
  const search = query.trim();
  return api.patients(search ? { search } : {});
}

/**
 * Найденные сервером на набранное — не на каждую букву. `onlyTyped` — не
 * спрашивать, пока ничего не набрано (наборам первая сотня по алфавиту ни к
 * чему: предложения там появляются только под набранным).
 */
export function usePatientSearch(query: string, options: { onlyTyped?: boolean } = {}): Resource<PatientsFound> {
  const settled = useDebounced(query.trim(), 300);
  return useResource(() => searchPatients(settled), [settled], { enabled: !options.onlyTyped || settled !== "" });
}

/**
 * Пункты списка: найденные без исключённых, а выбранный — впереди, даже если
 * новый поиск его не вернул. Управляемый <select> без совпадающего пункта
 * показал бы «— виберіть —», а отправил бы выбранного раньше.
 */
export function pickerOptions(
  found: readonly Patient[],
  chosen: Patient | null,
  exclude: ReadonlySet<string> = new Set(),
): Patient[] {
  const rest = found.filter((p) => !exclude.has(p.id) && p.id !== chosen?.id);
  return chosen ? [chosen, ...rest] : rest;
}

/** Разметка выбора — отдельно от загрузки, чтобы её можно было нарисовать в тесте */
export function PatientPickerView({
  query,
  onQuery,
  found,
  value,
  chosen,
  onPick,
  exclude,
  label,
  emptyLabel,
  className,
}: {
  query: string;
  onQuery: (q: string) => void;
  found: Pick<Resource<PatientsFound>, "data" | "error">;
  /** id выбранного или "" */
  value: string;
  /** Выбранный целиком — чтобы пункт пережил смену поиска */
  chosen: Patient | null;
  onPick: (p: Patient | null) => void;
  exclude?: ReadonlySet<string>;
  label: string;
  emptyLabel: string;
  className?: string;
}) {
  const { ut } = useLang();
  const options = pickerOptions(found.data?.items ?? [], value ? chosen : null, exclude);
  return (
    <div className={className}>
      <Field label={ut("pg.patientSearch")}>
        <Input value={query} onChange={(e) => onQuery(e.target.value)} autoComplete="off" maxLength={120} />
      </Field>
      <Field label={label}>
        <Select
          value={value}
          onChange={(e) => onPick(options.find((p) => p.id === e.target.value) ?? null)}
        >
          <option value="">{emptyLabel}</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName} · {p.email}
            </option>
          ))}
        </Select>
      </Field>
      {found.error ? (
        <p className="m-0 text-caption text-danger">{found.error}</p>
      ) : found.data?.truncated ? (
        <p className="m-0 text-caption text-muted">{ut("pg.truncated")}</p>
      ) : found.data && options.length === 0 ? (
        <p className="m-0 text-caption text-muted">{ut("pt.nobodyFound")}</p>
      ) : null}
    </div>
  );
}

/** Поле поиска, список найденных и пометка об усечении; выбранное — id в `value` */
export function PatientPicker({
  value,
  onChange,
  exclude,
  label,
  emptyLabel,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  exclude?: ReadonlySet<string>;
  label: string;
  emptyLabel: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Patient | null>(null);
  const found = usePatientSearch(query);
  return (
    <PatientPickerView
      query={query}
      onQuery={setQuery}
      found={found}
      value={value}
      chosen={chosen?.id === value ? chosen : null}
      onPick={(p) => {
        setChosen(p);
        onChange(p?.id ?? "");
      }}
      exclude={exclude}
      label={label}
      emptyLabel={emptyLabel}
      className={className}
    />
  );
}
