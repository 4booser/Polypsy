import type { SurveyGroupWithCounts } from "@quizzy/shared";
import { Grid, Panel, Stack } from "../../ui/layout";
import { Field, Input, Select } from "../../ui/primitives";
import { Loc, Toggle } from "./fields";
import type { Draft } from "./model";
import { useLang } from "../../lang";

export function Basics({
  draft,
  groups,
  patch,
}: {
  draft: Draft;
  groups: SurveyGroupWithCounts[];
  patch: (p: Partial<Draft>) => void;
}) {
  const { ut } = useLang();
  return (
    <Stack>
      <Panel title={ut("cb.titleAndDescription")} hint={ut("cb.twoLangs")}>
        <Stack className="gap-4">
          <Loc label={ut("cb.title")} value={draft.title} onChange={(v) => patch({ title: v })} />
          <Loc
            label={ut("cb.description")}
            value={draft.description}
            onChange={(v) => patch({ description: v })}
            multiline
          />
          <Loc
            label={ut("cb.instructions")}
            value={draft.instructions}
            onChange={(v) => patch({ instructions: v })}
            multiline
          />
          <Loc
            label={ut("cb.safetyPlan")}
            value={draft.safetyPlan ?? undefined}
            onChange={(v) => patch({ safetyPlan: v })}
            multiline
            hint={ut("co.safetyShown")}
          />
        </Stack>
      </Panel>

      <Panel title={ut("cb.whoAndHow")}>
        <Grid min={220}>
          <Field label={ut("cb.group")}>
            <Select value={draft.groupId ?? ""} onChange={(e) => patch({ groupId: e.target.value || null })}>
              <option value="">{ut("sel.noGroup")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </Select>
          </Field>
          <Field label={ut("cb.whoFills")}>
            <Select
              value={draft.administration}
              onChange={(e) => patch({ administration: e.target.value as Draft["administration"] })}
            >
              <option value="self">{ut("cb.selfAdmin")}</option>
              <option value="clinician">{ut("cb.clinicianAdmin")}</option>
              <option value="informant">{ut("cb.informantAdmin")}</option>
            </Select>
          </Field>
          <Field label={ut("cb.visibility")}>
            <Select
              value={draft.visibility}
              onChange={(e) => patch({ visibility: e.target.value as Draft["visibility"] })}
            >
              <option value="public">{ut("cb.allPatients")}</option>
              <option value="restricted">{ut("cb.byGrantOnly")}</option>
            </Select>
          </Field>
        </Grid>

        <div className="mt-4 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <Toggle label={ut("cb.scoring")} value={draft.scoringEnabled} onChange={(v) => patch({ scoringEnabled: v })} />
          <Toggle label={ut("cb.showProgress")} value={draft.showProgress} onChange={(v) => patch({ showProgress: v })} />
          <Toggle label={ut("cb.allowBack")} value={draft.allowBack} onChange={(v) => patch({ allowBack: v })} />
          <Toggle label={ut("cb.allowRetake")} value={draft.allowRetake} onChange={(v) => patch({ allowRetake: v })} />
          <Toggle label={ut("cb.randomize")} value={draft.randomizeQuestions} onChange={(v) => patch({ randomizeQuestions: v })} />
          <Toggle label={ut("cb.anonymous")} value={draft.anonymous} onChange={(v) => patch({ anonymous: v })} />
          <Toggle
            label={ut("cb.showDynamics")}
            value={draft.showResultsToPatient ?? false}
            onChange={(v) => patch({ showResultsToPatient: v })}
          />
        </div>
      </Panel>

      <Panel
        title={ut("cb.thresholds")}
        hint={ut("cb.thresholdsHint")}
      >
        <Grid min={200}>
          <Field label={ut("cb.timeLimit")}>
            <Input
              type="number"
              value={draft.timeLimitSec ? draft.timeLimitSec / 60 : ""}
              onChange={(e) => patch({ timeLimitSec: e.target.value ? Number(e.target.value) * 60 : null })}
            />
          </Field>
          <Field label={ut("co.tooFastLabel")}>
            <Input
              type="number"
              placeholder={ut("co.byDefault1500")}
              value={draft.tooFastMs ?? ""}
              onChange={(e) => patch({ tooFastMs: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
          <Field label={ut("cb.escalation")}>
            <Input
              type="number"
              placeholder={ut("cb.noEscalation")}
              value={draft.alertEscalateMinutes ?? ""}
              onChange={(e) => patch({ alertEscalateMinutes: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
        </Grid>
      </Panel>
    </Stack>
  );
}
