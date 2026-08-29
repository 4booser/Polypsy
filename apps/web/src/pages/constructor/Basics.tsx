import type { SurveyGroupWithCounts } from "@quizzy/shared";
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
    <>
      <div className="card">
        <h2>{ut("cb.titleAndDescription")}</h2>
        <p className="hint">{ut("cb.twoLangs")}</p>
        <Loc label={ut("cb.title")} value={draft.title} onChange={(v) => patch({ title: v })} />
        <Loc label={ut("cb.description")} value={draft.description} onChange={(v) => patch({ description: v })} multiline />
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
        />
        <p className="hint">
          Показывается обследуемому сразу после сдачи, если сработал критический пункт:
          телефоны доверия, дежурный психолог, куда обратиться прямо сейчас.
        </p>
      </div>

      <div className="card">
        <h2>{ut("cb.whoAndHow")}</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>{ut("cb.group")}</label>
            <select value={draft.groupId ?? ""} onChange={(e) => patch({ groupId: e.target.value || null })}>
              <option value="">— без группы —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>{ut("cb.whoFills")}</label>
            <select
              value={draft.administration}
              onChange={(e) => patch({ administration: e.target.value as Draft["administration"] })}
            >
              <option value="self">{ut("cb.selfAdmin")}</option>
              <option value="clinician">{ut("cb.clinicianAdmin")}</option>
              <option value="informant">{ut("cb.informantAdmin")}</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>{ut("cb.visibility")}</label>
            <select
              value={draft.visibility}
              onChange={(e) => patch({ visibility: e.target.value as Draft["visibility"] })}
            >
              <option value="public">{ut("cb.allPatients")}</option>
              <option value="restricted">{ut("cb.byGrantOnly")}</option>
            </select>
          </div>
        </div>

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

      <div className="card">
        <h2>{ut("cb.thresholds")}</h2>
        <p className="hint">
          Порог «слишком быстро» задаётся отдельно: матричный вопрос требует заметно больше
          времени, чем «да/нет», и общий порог либо пропускает небрежность, либо клевещет
        </p>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>{ut("cb.timeLimit")}</label>
            <input
              type="number"
              value={draft.timeLimitSec ? draft.timeLimitSec / 60 : ""}
              onChange={(e) => patch({ timeLimitSec: e.target.value ? Number(e.target.value) * 60 : null })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>«Слишком быстро», мс на вопрос</label>
            <input
              type="number"
              placeholder="1500 по умолчанию"
              value={draft.tooFastMs ?? ""}
              onChange={(e) => patch({ tooFastMs: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>{ut("cb.escalation")}</label>
            <input
              type="number"
              placeholder={ut("cb.noEscalation")}
              value={draft.alertEscalateMinutes ?? ""}
              onChange={(e) => patch({ alertEscalateMinutes: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
        </div>
      </div>
    </>
  );
}

