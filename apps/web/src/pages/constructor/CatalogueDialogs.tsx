import { useState } from "react";
import type { SurveyFolder, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { Drawer, DrawerSection, useAction } from "../../ui";
import { Button, Field, Input, Select } from "../../ui/primitives";
import { useLang } from "../../lang";
import { folderOptions, localToday } from "./catalogue";
import { CnIc } from "./icons";

/**
 * Ящики каталога: папка (завести или переименовать) и перенос теста в папку.
 *
 * Ящики, а не окна: это действия, а окно в наборе — только для шага, который
 * обязан прервать работу (ui/README.md). И не строки внутри списка: на макете
 * каталог — плотный список, и форма между строками сдвигала бы всё под ней.
 * Ящик даёт ловушку фокуса, Esc и возврат фокуса на кнопку, из которой его
 * открыли. Пока ящик смонтирован, он открыт: экран каталога монтирует его на
 * время действия и снимает по onClose — так было и с окнами.
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

  const formId = folder ? `cat-folder-${folder.id}` : "cat-folder-new";
  return (
    <Drawer
      open
      onClose={onClose}
      title={folder ? ut("cat.renameFolder") : ut("cat.newFolder")}
      sub={parent?.title ?? folder?.title}
      icon={<CnIc.folderPlus size={18} />}
      footer={
        <>
          {noGroup ? null : (
            <Button variant="primary" type="submit" form={formId} disabled={busy || !title.trim() || !startsOn || !groupId}>
              {folder ? ut("ui.save") : ut("adm.create")}
            </Button>
          )}
          <Button onClick={onClose}>{ut("ui.cancel")}</Button>
        </>
      }
    >
      <DrawerSection>
        <form
          id={formId}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {noGroup ? (
            <p className="m-0 text-small text-text-2">{ut("cat.folderNeedsGroup")}</p>
          ) : (
            <>
              <Field label={ut("cat.folderTitle")}>
                <Input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
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
        </form>
      </DrawerSection>
    </Drawer>
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
    <Drawer
      open
      onClose={onClose}
      title={ut("cat.move")}
      sub={survey.title}
      icon={<CnIc.folder size={18} />}
      footer={
        <>
          {survey.groupId ? (
            <Button variant="primary" disabled={busy || (survey.folderId ?? "") === target} onClick={() => void submit()}>
              {ut("ui.save")}
            </Button>
          ) : null}
          <Button onClick={onClose}>{ut("ui.cancel")}</Button>
        </>
      }
    >
      <DrawerSection>
        {survey.groupId ? (
          <Field label={ut("cat.move")}>
            <Select data-autofocus value={target} onChange={(e) => setTarget(e.target.value)}>
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
          <p className="m-0 text-small text-text-2">{ut("cat.noGroupForFolder")}</p>
        )}
      </DrawerSection>
    </Drawer>
  );
}
