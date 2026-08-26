import type { SurveyGroupWithCounts } from "@quizzy/shared";
import { Loc, Toggle } from "./fields";
import type { Draft } from "./model";

export function Basics({
  draft,
  groups,
  patch,
}: {
  draft: Draft;
  groups: SurveyGroupWithCounts[];
  patch: (p: Partial<Draft>) => void;
}) {
  return (
    <>
      <div className="card">
        <h2>Название и описание</h2>
        <p className="hint">Слева украинский вариант, справа русский</p>
        <Loc label="Название" value={draft.title} onChange={(v) => patch({ title: v })} />
        <Loc label="Описание" value={draft.description} onChange={(v) => patch({ description: v })} multiline />
        <Loc
          label="Инструкция перед прохождением"
          value={draft.instructions}
          onChange={(v) => patch({ instructions: v })}
          multiline
        />
        <Loc
          label="Немедленные действия при критическом ответе (safety-план)"
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
        <h2>Кто и как проходит</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Группа</label>
            <select value={draft.groupId ?? ""} onChange={(e) => patch({ groupId: e.target.value || null })}>
              <option value="">— без группы —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Кто заполняет</label>
            <select
              value={draft.administration}
              onChange={(e) => patch({ administration: e.target.value as Draft["administration"] })}
            >
              <option value="self">Респондент сам</option>
              <option value="clinician">Специалист за респондента</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Видимость</label>
            <select
              value={draft.visibility}
              onChange={(e) => patch({ visibility: e.target.value as Draft["visibility"] })}
            >
              <option value="public">Всем пациентам</option>
              <option value="restricted">Только по назначению</option>
            </select>
          </div>
        </div>

        <Toggle label="Считать баллы по шкалам" value={draft.scoringEnabled} onChange={(v) => patch({ scoringEnabled: v })} />
        <Toggle label="Показывать прогресс" value={draft.showProgress} onChange={(v) => patch({ showProgress: v })} />
        <Toggle label="Разрешить возврат назад" value={draft.allowBack} onChange={(v) => patch({ allowBack: v })} />
        <Toggle label="Разрешить повторные прохождения" value={draft.allowRetake} onChange={(v) => patch({ allowRetake: v })} />
        <Toggle label="Перемешивать вопросы" value={draft.randomizeQuestions} onChange={(v) => patch({ randomizeQuestions: v })} />
        <Toggle label="Анонимно" value={draft.anonymous} onChange={(v) => patch({ anonymous: v })} />
      </div>

      <div className="card">
        <h2>Пороги</h2>
        <p className="hint">
          Порог «слишком быстро» задаётся отдельно: матричный вопрос требует заметно больше
          времени, чем «да/нет», и общий порог либо пропускает небрежность, либо клевещет
        </p>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>Лимит времени, минут</label>
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
            <label>Эскалация тревоги, минут</label>
            <input
              type="number"
              placeholder="без эскалации"
              value={draft.alertEscalateMinutes ?? ""}
              onChange={(e) => patch({ alertEscalateMinutes: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
        </div>
      </div>
    </>
  );
}

