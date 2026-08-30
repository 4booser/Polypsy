import { Field, Input, Textarea } from "../../ui/primitives";

/** Общие поля конструктора: двуязычный ввод и переключатель */
export function Loc({
  label,
  value,
  onChange,
  multiline,
  hint,
}: {
  label: string;
  value: Record<string, string> | null | undefined;
  onChange: (v: Record<string, string>) => void;
  multiline?: boolean;
  hint?: string;
}) {
  const v = value ?? {};
  return (
    <Field label={label} hint={hint}>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["uk", "ru"] as const).map((lang) =>
          multiline ? (
            <Textarea
              key={lang}
              value={v[lang] ?? ""}
              rows={3}
              placeholder={lang === "uk" ? "українською" : "по-русски"}
              onChange={(e) => onChange({ ...v, [lang]: e.target.value })}
            />
          ) : (
            <Input
              key={lang}
              value={v[lang] ?? ""}
              placeholder={lang === "uk" ? "українською" : "по-русски"}
              onChange={(e) => onChange({ ...v, [lang]: e.target.value })}
            />
          ),
        )}
      </div>
    </Field>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0" />
      <span className="text-small text-text">{label}</span>
    </label>
  );
}
