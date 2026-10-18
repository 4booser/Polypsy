import type { SurveyGroupWithCounts } from "@quizzy/shared";
import { ShellIcon } from "../../shell/icons";
import { Panel } from "../../ui/layout";
import { Field, Input, Segmented, Select } from "../../ui/primitives";
import { EditLangSwitch, Loc, Toggle } from "./fields";
import { CnIc } from "./icons";
import type { Draft, Mode } from "./model";
import { useLang } from "../../lang";

/**
 * «Основне» — название, описание и инструкция; у новой методики ещё и вид
 * теста. Вид у сохранённой не переключается: он читается по ключу шкал
 * (model.ts, deriveMode), и смена его на живой методике перестроила бы ключ.
 */
export function MainSection({
  draft,
  patch,
  isNew,
  onMode,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  isNew: boolean;
  onMode: (m: Mode) => void;
}) {
  const { ut } = useLang();
  const mode = draft.mode ?? "specific";
  return (
    <Panel title={ut("ce.main")} icon={<ShellIcon name="file-text" />} actions={<EditLangSwitch />}>
      <Loc id="cn-title" label={ut("cn.testTitle")} value={draft.title} onChange={(v) => patch({ title: v })} />
      <Loc label={ut("cn.testDescription")} value={draft.description} onChange={(v) => patch({ description: v })} multiline rows={3} />
      <Loc
        label={ut("cb.instructions")}
        hint={ut("ce.instructionsHint")}
        value={draft.instructions}
        onChange={(v) => patch({ instructions: v })}
        multiline
        rows={3}
      />
      {isNew ? (
        <Field label={ut("cn.testKind")} hint={ut(mode === "specific" ? "cst.startSub.specific" : "cst.startSub.complex")}>
          <Segmented
            label={ut("cn.testKind")}
            value={mode}
            onChange={onMode}
            items={[
              { key: "specific", label: ut("cn.specific") },
              { key: "complex", label: ut("cn.complex") },
            ]}
          />
        </Field>
      ) : null}
    </Panel>
  );
}

/**
 * «Налаштування» — то, чего на макете конструктора нет развёрнутым, а у
 * методики есть: группа, кто заполняет, видимость, переключатели
 * прохождения, пороги, эскалация и план безопасности. Убрать нельзя — у СР-45
 * заполняет клиницист, у шкал риска есть эскалация.
 */
export function Settings({
  draft,
  groups,
  groupsError,
  patch,
}: {
  draft: Draft;
  /**
   * Группы методик; null — список ещё не пришёл или не пришёл вовсе.
   *
   * Экран подставлял на это время пустой список, и <select> без пункта
   * группы методики показывал первый — «Без групи»: человек читал, что
   * методика ни в какой группе, хотя она в группе и там останется. Пока
   * списка нет, группа подписана «завантаження», а селект выключен.
   */
  groups: SurveyGroupWithCounts[] | null;
  /** Почему список групп не пришёл — под полем, а не молчанием */
  groupsError?: string | null;
  patch: (p: Partial<Draft>) => void;
}) {
  const { ut } = useLang();
  return (
    <div className="flex flex-col gap-4">
      <Panel title={ut("ce.passing")} icon={<CnIc.settings />}>
        <div className="grid grid-cols-3 gap-x-3.5 max-[1100px]:grid-cols-1">
          {/*
            Смена группы выводит тест из папки, унаследованной из адреса
            («+ → Новий тест» в папке каталога): папка принадлежит группе, и
            пару «папка группы A — группа B» сервер отверг бы только по кнопке
            «Створити» (err.surveyFolderOtherGroup). Лучше завести тест в корне
            каталога новой группы, чем не завести вовсе; пока папка есть, об
            этом сказано под полем.
          */}
          <Field
            label={ut("cb.group")}
            hint={draft.folderId ? ut("cn.folderFollowsGroup") : undefined}
            error={groups === null && groupsError ? `${ut("net.loadFailed")}: ${groupsError}` : undefined}
          >
            <Select
              value={draft.groupId ?? ""}
              disabled={groups === null}
              onChange={(e) => patch({ groupId: e.target.value || null, folderId: null })}
            >
              <option value="">{ut("sel.noGroup")}</option>
              {groups === null && draft.groupId ? <option value={draft.groupId}>{ut("common.loading")}</option> : null}
              {/*
                Снятые с использования группы не предлагаются — кроме той, в
                которой методика уже лежит: <select> без совпадающего значения
                показывает первый вариант, и правка чего угодно на этом экране
                молча переносила бы методику в чужую группу.
              */}
              {(groups ?? [])
                .filter((g) => !g.archivedAt || g.id === draft.groupId)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={ut("cb.whoFills")}>
            <Select value={draft.administration} onChange={(e) => patch({ administration: e.target.value as Draft["administration"] })}>
              <option value="self">{ut("cb.selfAdmin")}</option>
              <option value="clinician">{ut("cb.clinicianAdmin")}</option>
              <option value="informant">{ut("cb.informantAdmin")}</option>
            </Select>
          </Field>
          <Field label={ut("cb.visibility")}>
            <Select value={draft.visibility} onChange={(e) => patch({ visibility: e.target.value as Draft["visibility"] })}>
              <option value="public">{ut("cb.allPatients")}</option>
              <option value="restricted">{ut("cb.byGrantOnly")}</option>
            </Select>
          </Field>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-6 max-[1100px]:grid-cols-1">
          <Toggle label={ut("cb.scoring")} value={draft.scoringEnabled} onChange={(v) => patch({ scoringEnabled: v })} />
          <Toggle label={ut("cb.showProgress")} value={draft.showProgress} onChange={(v) => patch({ showProgress: v })} />
          <Toggle label={ut("cb.allowBack")} value={draft.allowBack} onChange={(v) => patch({ allowBack: v })} />
          <Toggle label={ut("cb.allowRetake")} value={draft.allowRetake} onChange={(v) => patch({ allowRetake: v })} />
          <Toggle label={ut("cb.randomize")} value={draft.randomizeQuestions} onChange={(v) => patch({ randomizeQuestions: v })} />
          <Toggle label={ut("cb.anonymous")} value={draft.anonymous} onChange={(v) => patch({ anonymous: v })} />
          <Toggle
            label={ut("cb.showDynamics")}
            sub={ut("ce.showDynamicsSub")}
            value={draft.showResultsToPatient ?? false}
            onChange={(v) => patch({ showResultsToPatient: v })}
          />
        </div>
        <p className="m-0 mb-2 mt-3 text-small text-muted">{ut("cb.thresholdsHint")}</p>
        <div className="grid grid-cols-2 gap-x-3.5 max-[1100px]:grid-cols-1">
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
        </div>
      </Panel>

      {/* план безопасности и эскалация — про риск для человека: квадрат значка красный по праву */}
      <Panel
        title={ut("ce.safety")}
        icon={<CnIc.shieldAlert />}
        tone="risk"
        hint={ut("ce.safetyHint")}
        actions={<EditLangSwitch />}
      >
        <Field label={ut("cb.escalation")} hint={ut("cb.noEscalation")} className="max-w-[280px]">
          <Input
            type="number"
            value={draft.alertEscalateMinutes ?? ""}
            onChange={(e) => patch({ alertEscalateMinutes: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <Loc
          label={ut("cb.safetyPlan")}
          value={draft.safetyPlan ?? undefined}
          onChange={(v) => patch({ safetyPlan: v })}
          multiline
          hint={ut("co.safetyShown")}
        />
      </Panel>
    </div>
  );
}
