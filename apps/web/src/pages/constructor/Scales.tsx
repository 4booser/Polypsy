import { api } from "../../api";
import { useResource } from "../../useResource";
import { Loc } from "./fields";
import { newUid, parseItems, type Draft, type DraftScale } from "./model";
import { useLang } from "../../lang";
import { Grid, Panel, Stack } from "../../ui/layout";
import { Button, Field, Input, Select } from "../../ui/primitives";

export function Scales({ draft, setDraft }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const { ut } = useLang();
  // батареи нужны для каскадов: попадание в полосу может назначить углублённую
  const batteries = (useResource(() => api.batteries(), []).data ?? []).filter((b) => !b.archived);

  const upd = (i: number, s: Partial<DraftScale>) =>
    setDraft((d) => ({ ...d, scales: d.scales.map((x, k) => (k === i ? { ...x, ...s } : x)) }));

  return (
    <Stack>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 max-w-[60ch] text-caption text-muted">
            {ut("cs.keyNumbersHint")}
          </p>
          <Button
            variant="primary"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                scales: [
                  ...d.scales,
                  {
                    uid: newUid(),
                    code: "",
                    title: { uk: "", ru: "" },
                    kind: "clinical",
                    normalization: "raw",
                    key: [],
                    corrections: [],
                    norms: [],
                    stenTable: [],
                    bands: [],
                  },
                ],
              }))
            }
          >
            {ut("cs.addScale")}
          </Button>
        </div>
      </Panel>

      {draft.scales.map((s, i) => (
        <Panel
          key={s.uid}
          title={s.code || ut("cs.newScale")}
          actions={
            <Button variant="danger" size="sm" onClick={() => setDraft((d) => ({ ...d, scales: d.scales.filter((_, k) => k !== i) }))}>
              {ut("ui.delete")}
            </Button>
          }
        >
          <Grid min={160}>
            <Field label={ut("cs.code")}>
              <Input value={s.code} onChange={(e) => upd(i, { code: e.target.value })} placeholder="Sr" />
            </Field>
            <Field label={ut("cs.role")}>
              <Select value={s.kind} onChange={(e) => upd(i, { kind: e.target.value as DraftScale["kind"] })}>
                <option value="clinical">{ut("cs.clinical")}</option>
                <option value="validity">{ut("cs.validity")}</option>
              </Select>
            </Field>
            <Field label={ut("cs.normalization")}>
              <Select
                value={s.normalization}
                onChange={(e) => upd(i, { normalization: e.target.value as DraftScale["normalization"] })}
              >
                <option value="raw">{ut("cs.raw")}</option>
                <option value="ratio">{ut("cs.ratio")}</option>
                <option value="tscore">{ut("co.tScores")}</option>
                <option value="sten">{ut("cs.sten")}</option>
              </Select>
            </Field>
            {s.normalization === "ratio" ? (
              <Field label={ut("cs.denominator")}>
                <Input
                  type="number"
                  value={s.ratioDenominator ?? ""}
                  onChange={(e) => upd(i, { ratioDenominator: e.target.value ? Number(e.target.value) : null })}
                />
              </Field>
            ) : null}
          </Grid>

          <div className="mt-4">
            <Loc label={ut("cs.scaleTitle")} value={s.title} onChange={(v) => upd(i, { title: v })} />
          </div>

          {s.kind === "validity" ? (
            <div className="mt-4">
              <Grid min={160}>
                <Field label={ut("cs.threshold")}>
                  <Input
                    type="number"
                    step="0.01"
                    value={s.validityThreshold ?? ""}
                    onChange={(e) => upd(i, { validityThreshold: e.target.value ? Number(e.target.value) : null })}
                  />
                </Field>
                <Field label={ut("cs.violated")}>
                  <Select
                    value={s.validityDirection ?? "above"}
                    onChange={(e) => upd(i, { validityDirection: e.target.value as "above" | "below" })}
                  >
                    <option value="above">{ut("co.aboveThreshold")}</option>
                    <option value="below">{ut("co.belowThreshold")}</option>
                  </Select>
                </Field>
              </Grid>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label={ut("cs.keyYes")}>
              <Input
                value={s.key.filter((k) => k.matchKey === "yes").map((k) => k.item).join(", ")}
                placeholder="1, 2, 3, 5, 7"
                onChange={(e) =>
                  upd(i, {
                    key: [
                      ...parseItems(e.target.value).map((item) => ({ item, matchKey: "yes" })),
                      ...s.key.filter((k) => k.matchKey !== "yes"),
                    ],
                  })
                }
              />
            </Field>
            <Field label={ut("cs.keyNo")}>
              <Input
                value={s.key.filter((k) => k.matchKey === "no").map((k) => k.item).join(", ")}
                placeholder="4, 6, 8"
                onChange={(e) =>
                  upd(i, {
                    key: [
                      ...s.key.filter((k) => k.matchKey !== "no"),
                      ...parseItems(e.target.value).map((item) => ({ item, matchKey: "no" })),
                    ],
                  })
                }
              />
            </Field>
          </div>

          <p className="mt-3 text-caption text-muted">
            {ut("cs.keyCountPrefix")} {s.key.length} {ut("co.itemsGenitive")}
            {s.corrections.length ? ` · ${ut("cs.correctionsLabel")}: ${s.corrections.map((c) => `${c.from}×${c.coefficient}`).join(", ")}` : ""}
            {s.norms.length ? ` · ${ut("cs.normsLabel")}: ${s.norms.length}` : ""}
            {s.stenTable.length ? ` · ${ut("cs.stenRowsLabel")}: ${s.stenTable.length}` : ""}
          </p>
          <p className="text-caption text-muted">
            {ut("cs.jsonOnlyHint")}
          </p>

          <h3 className="mb-2 mt-4 font-display text-small font-medium">{ut("cs.bands")}</h3>
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr><th className="num">{ut("cs.from")}</th><th className="num">{ut("cs.to")}</th><th>{ut("cs.bandLabel")}</th><th>{ut("cs.severity")}</th><th className="num">{ut("cs.grade")}</th><th>{ut("cs.cascade")}</th><th>{ut("cs.repeatDays")}</th><th /></tr>
              </thead>
              <tbody>
                {s.bands.map((b, bi) => (
                  <tr key={bi}>
                    <td className="num w-[80px]">
                      <Input type="number" step="0.01" value={b.minScore}
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, minScore: Number(e.target.value) } : x)) })} />
                    </td>
                    <td className="num w-[80px]">
                      <Input type="number" step="0.01" value={b.maxScore}
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, maxScore: Number(e.target.value) } : x)) })} />
                    </td>
                    <td>
                      <div className="flex items-start gap-2">
                        <Input value={b.label.uk ?? ""} placeholder="українською"
                          onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, label: { ...x.label, uk: e.target.value } } : x)) })} />
                        <Input value={b.label.ru ?? ""} placeholder="по-русски"
                          onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, label: { ...x.label, ru: e.target.value } } : x)) })} />
                      </div>
                    </td>
                    <td className="w-[150px]">
                      <Select value={b.severity}
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, severity: e.target.value as DraftScale["bands"][number]["severity"] } : x)) })}>
                        <option value="none">{ut("cs.sevNormal")}</option>
                        <option value="mild">{ut("cs.sevMild")}</option>
                        <option value="moderate">{ut("cs.sevModerate")}</option>
                        <option value="severe">{ut("cs.sevSevere")}</option>
                      </Select>
                    </td>
                    <td className="num w-[80px]">
                      <Input type="number" value={b.grade ?? ""}
                        onChange={(e) => upd(i, { bands: s.bands.map((x, k) => (k === bi ? { ...x, grade: e.target.value ? Number(e.target.value) : null } : x)) })} />
                    </td>
                    <td className="w-[190px]">
                      <Select
                        value={b.cascadeBatteryId ?? ""}
                        title={ut("cs.cascadeHint")}
                        onChange={(e) =>
                          upd(i, {
                            bands: s.bands.map((x, k) =>
                              k === bi ? { ...x, cascadeBatteryId: e.target.value || null } : x,
                            ),
                          })
                        }
                      >
                        <option value="">{ut("co.noCascade")}</option>
                        {batteries.map((bat) => (
                          <option key={bat.id} value={bat.id}>{bat.title}</option>
                        ))}
                      </Select>
                    </td>
                    <td className="w-[96px]">
                      <Input
                        placeholder="7,30"
                        title={ut("cs.repeatHint")}
                        value={b.followUpDays ?? ""}
                        onChange={(e) =>
                          upd(i, {
                            bands: s.bands.map((x, k) =>
                              k === bi ? { ...x, followUpDays: e.target.value || null } : x,
                            ),
                          })
                        }
                      />
                    </td>
                    <td className="w-10">
                      <Button variant="danger" size="sm" onClick={() => upd(i, { bands: s.bands.filter((_, k) => k !== bi) })}>✕</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            className="mt-2"
            onClick={() => upd(i, { bands: [...s.bands, { minScore: 0, maxScore: 0, label: { uk: "", ru: "" }, severity: "none" }] })}
          >
            {ut("cs.addNorm")}
          </Button>
          <p className="mt-2 text-caption text-muted">
            {ut("cs.cascadeExplain")}
          </p>
        </Panel>
      ))}
    </Stack>
  );
}

/** «1, 2, 3, 5-7» → [1,2,3,5,6,7] */
