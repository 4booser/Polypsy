/** Общие поля конструктора: двуязычный ввод и переключатель */
export function Loc({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: Record<string, string> | null | undefined;
  onChange: (v: Record<string, string>) => void;
  multiline?: boolean;
}) {
  const v = value ?? {};
  const Field = multiline ? "textarea" : "input";
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {(["uk", "ru"] as const).map((lang) => (
          <div key={lang} style={{ flex: 1 }}>
            <Field
              value={v[lang] ?? ""}
              rows={multiline ? 3 : undefined}
              placeholder={lang === "uk" ? "українською" : "по-русски"}
              onChange={(e: { target: { value: string } }) =>
                onChange({ ...v, [lang]: e.target.value })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 8, marginBottom: 8, cursor: "pointer" }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ width: 16 }} />
      <span style={{ color: "var(--text)", fontSize: 13 }}>{label}</span>
    </label>
  );
}

