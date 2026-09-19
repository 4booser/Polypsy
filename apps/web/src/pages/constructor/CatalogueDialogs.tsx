import { useState } from "react";
import type { SurveyFolder, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { Modal, useAction } from "../../ui";
import { Button, Field, Input, Select } from "../../ui/primitives";
import { useLang } from "../../lang";
import { folderOptions, localToday } from "./catalogue";

/**
 * Окна каталога: папка (завести или переименовать) и перенос теста в папку.
 *
 * Окна, а не строки внутри списка: на макете каталог — плотный список, и
 * форма, раскрывающаяся между строками, сдвигала бы всё под ней. Общий
 * Modal даёт ловушку фокуса, Esc и возврат фокуса на кнопку, из которой
 * окно открыли, — писать это заново для двух форм означало бы третью копию
 * той же логики в проекте.
 */

/**
 * Папка: название, дата с макета, группа.
 *
 * Группа спрашивается только при заведении в корне и только если групп
 * больше одной: внутри папки группа наследуется от неё (папка группу не
 * меняет — см. surveyFolderUpdateSchema на сервере), а при единственной
 * группе выбор из одного — это вопрос, на который есть один ответ.
 */
export function FolderForm({
  folder,
  parent,
  groups,
  onClose,
  onSaved,
}: {
  /** Правимая папка; null — заводится новая */
  folder: SurveyFolder | null;
  /** Куда вкладывается новая; null — в корень */
  parent: SurveyFolder | null;
  groups: SurveyGroupWithCounts[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [title, setTitle] = useState(folder?.title ?? "");
  const [startsOn, setStartsOn] = useState(folder?.startsOn?.slice(0, 10) ?? localToday());
  /* снятые группы в выбор не идут: расформированному отделению новые полки не нужны */
  const living = groups.filter((g) => !g.archivedAt);
  const [groupId, setGroupId] = useState(folder?.groupId ?? parent?.groupId ?? living[0]?.id ?? "");
  const askGroup = !folder && !parent && living.length > 1;
  const noGroup = !folder && !parent && living.length === 0;

  async function submit() {
    const name = title.trim();
    if (!name || !groupId) return;
    const ok = await run(
      () =>
        folder
          ? api.updateSurveyFolder(folder.id, { title: name, startsOn })
          : api.createSurveyFolder({ groupId, title: name, startsOn, parentId: parent?.id ?? null }),
      folder ? ut("cat.folderRenamed") : ut("cat.folderCreated"),
    );
    if (ok) onSaved();
  }

  return (
    <Modal title={folder ? ut("cat.renameFolder") : ut("cat.newFolder")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {noGroup ? (
          <p className="m-0 mb-4 text-[13px] text-muted">{ut("cat.folderNeedsGroup")}</p>
        ) : (
          <>
            <Field label={ut("cat.folderTitle")}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} />
            </Field>
            <Field label={ut("cat.folderDate")}>
              <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
            </Field>
            {askGroup ? (
              <Field label={ut("cat.folderGroup")}>
                <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  {living.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </>
        )}
        <div className="mt-5 flex items-center gap-[14px]">
          {noGroup ? null : (
            <Button size="md" type="submit" disabled={busy || !title.trim() || !startsOn || !groupId}>
              {folder ? ut("ui.save") : ut("adm.create")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Перенос теста в папку своей группы.
 *
 * Список папок — только той группы, в которой лежит тест: сервер откажет
 * чужой папке (составной ключ в базе), и предлагать её значило бы
 * предлагать отказ. Тест без группы папки не имеет вовсе — ему показывается
 * причина и дверь в конструктор, а не пустой селект.
 */
export function MoveForm({
  survey,
  folders,
  onClose,
  onMoved,
}: {
  survey: SurveyListItem;
  folders: SurveyFolder[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [target, setTarget] = useState(survey.folderId ?? "");
  const options = survey.groupId ? folderOptions(folders, survey.groupId) : [];

  async function submit() {
    const ok = await run(() => api.moveSurvey(survey.id, target || null), ut("cat.moved"));
    if (ok) onMoved();
  }

  return (
    <Modal title={ut("cat.move")} onClose={onClose}>
      <p className="m-0 mb-4 text-[15px] font-bold text-primary">{survey.title}</p>
      {survey.groupId ? (
        <Field label={ut("cat.move")}>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} autoFocus>
            <option value="">{ut("cat.rootOption")}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {/* отступ глубины — длинным тире, а не пробелами: пробелы селект схлопывает */}
                {"— ".repeat(o.depth)}
                {o.title}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <p className="m-0 mb-4 text-[13px] text-muted">{ut("cat.noGroupForFolder")}</p>
      )}
      <div className="mt-5 flex items-center gap-[14px]">
        {survey.groupId ? (
          <Button size="md" disabled={busy || (survey.folderId ?? "") === target} onClick={() => void submit()}>
            {ut("ui.save")}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          {ut("ui.cancel")}
        </Button>
      </div>
    </Modal>
  );
}
