import type { SurveyGroupWithCounts } from "@quizzy/shared";
import { Grid } from "../../ui/layout";
import { Field, Input, Select } from "../../ui/primitives";
import { Loc, Toggle } from "./fields";
import type { Draft } from "./model";
import { useLang } from "../../lang";

/**
 * Настройки прохождения — то, чего на кадрах нет, а у методики есть.
 *
 * Название и описание ушли наверх страницы (кадр f24), здесь осталось
 * остальное: инструкция, safety-план, группа, кто заполняет, видимость,
 * переключатели и пороги. Показывается в свёрнутом блоке под формой: убрать
 * совсем — значит снять возможность (у СР-45 заполняет клиницист, у шкал
 * риска есть эскалация), а развернуть на кадре, где этого нет, — спорить с
 * макетом там, где он молчит.
 */
export function Settings({
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
    <div className="flex flex-col gap-[15px] pt-[12px]">
      <Loc label={ut("cb.instructions")} value={draft.instructions} onChange={(v) => patch({ instructions: v })} multiline />
      <Loc
        label={ut("cb.safetyPlan")}
        value={draft.safetyPlan ?? undefined}
        onChange={(v) => patch({ safetyPlan: v })}
        multiline
        hint={ut("co.safetyShown")}
      />

      <Grid min={200}>
        <Field label={ut("cb.group")}>
          <Select value={draft.groupId ?? ""} onChange={(e) => patch({ groupId: e.target.value || null })}>
            <option value="">{ut("sel.noGroup")}</option>
            {/*
              Снятые с использования группы не предлагаются — кроме той, в
              которой методика уже лежит. Убрать её из списка целиком
              нельзя: <select> без совпадающего значения показывает первый
              вариант, и правка чего угодно на этом экране молча
              переносила бы методику в чужую группу.
            */}
            {groups
              .filter((g) => !g.archivedAt || g.id === draft.groupId)
              .map((g) => (
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

      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
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

      <p className="m-0 text-[13px] text-muted">{ut("cb.thresholdsHint")}</p>
      <Grid min={200}>
        <Field label={ut("cb.timeLimit")}>
          <Input
            type="number"
            value={draft.timeLimitSec ? draft.timeLimitSec / 60 : ""}
            onChange={(e) => patch({ timeLimitSec: e.target.value ? Number(e.target.value) * 60 : null })}
          />
        </Field>
        <Field label={ut("co.tooFastLabel")} hint={ut("co.byDefault1500")}>
          <Input
            type="number"
            value={draft.tooFastMs ?? ""}
            onChange={(e) => patch({ tooFastMs: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <Field label={ut("cb.escalation")} hint={ut("cb.noEscalation")}>
          <Input
            type="number"
            value={draft.alertEscalateMinutes ?? ""}
            onChange={(e) => patch({ alertEscalateMinutes: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
      </Grid>
    </div>
  );
}
