import { useState } from "react";
import type { SurveyFolder, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { Drawer, DrawerSection, eachOf, Modal, useAction, useToast } from "../../ui";
import { Ic } from "../../ui/icons";
import { Button, Field, Input, Select } from "../../ui/primitives";
import { Callout } from "../../ui/states";
import { useResource } from "../../useResource";
import { useLang } from "../../lang";
import { Mi } from "../methods/icons";
import { splitCode } from "../methods/model";
import { num, useCount } from "../methods/useCount";
import { folderOptions, localToday, movePlan, sameValue } from "./catalogue";
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

/* ─────────── отмеченные методики ─────────── */

/** Не прошедшая отмеченная методика и отказ сервера по ней */
type Missed = { item: SurveyListItem; reason: string | null };

/** Коды отмеченных одной строкой: «PHQ-9, GAD-7, AUDIT і ще 4» */
export function codesLine(items: readonly SurveyListItem[], andMore: string): string {
  const codes = items.slice(0, 8).map((s) => splitCode(s.title).code ?? s.title);
  return codes.join(", ") + (items.length > 8 ? ` ${andMore.replace("{n}", String(items.length - 8))}` : "");
}

/** Не прошедшие поимённо с причиной — в ящике, который остаётся открытым */
function MissedList({ missed }: { missed: readonly Missed[] }) {
  const { ut } = useLang();
  if (!missed.length) return null;
  return (
    <Callout kind="warn" role="alert" title={ut("mc.bulkFailed").replace("{n}", String(missed.length))} className="mt-3">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {missed.map(({ item, reason }) => (
          <li key={item.id}>
            <b className="text-text">{item.title}</b>
            {reason ? <span className="text-muted">{`: ${reason}`}</span> : null}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * Перенос отмеченных методик — в группу и папку разом.
 *
 * Одиночный перенос (MoveForm) двигает методику только по полкам её группы:
 * группу ей меняют в конструкторе. Отмеченные переносят, чтобы разложить
 * каталог, и чаще всего это как раз смена группы: методики «поза групами»
 * отдают отделению. Поэтому здесь сначала группа, потом папка в ней, и по
 * каждой методике — только нужные шаги (movePlan).
 *
 * Отказ по одной не отменяет остальных (eachOf): не прошедшие остаются в
 * ящике поимённо с причиной, перенесённые экран снимает с отметки.
 */
export function MoveManyForm({
  surveys,
  folders,
  groups,
  onClose,
  onMoved,
}: {
  surveys: SurveyListItem[];
  folders: SurveyFolder[];
  groups: SurveyGroupWithCounts[];
  onClose: () => void;
  /**
   * Что-то перенесено: экран снимает отметку с перенесённых до конца и
   * перечитывает каталог (в том числе ради тех, у кого сменилась одна группа)
   */
  onMoved: (moved: SurveyListItem[]) => void;
}) {
  const { ut } = useLang();
  const count = useCount();
  const toast = useToast();
  const { run, busy } = useAction();
  /* снятые группы в выбор не идут, как и у новой папки */
  const living = groups.filter((g) => !g.archivedAt);
  const [left, setLeft] = useState(surveys);
  const [missed, setMissed] = useState<Missed[]>([]);
  const commonGroup = sameValue(surveys.map((s) => s.groupId ?? null));
  const [groupId, setGroupId] = useState(() =>
    commonGroup && living.some((g) => g.id === commonGroup) ? commonGroup : living.length === 1 ? living[0]!.id : "",
  );
  const [folderId, setFolderId] = useState(() =>
    groupId && groupId === commonGroup ? (sameValue(surveys.map((s) => s.folderId ?? null)) ?? "") : "",
  );
  const options = groupId ? folderOptions(folders, groupId) : [];
  const todo = groupId
    ? left.filter((s) => {
        const plan = movePlan(s, groupId, folderId || null);
        return plan.group || plan.folder;
      })
    : [];

  async function submit() {
    let outcome: { done: SurveyListItem[]; failed: Missed[] } = { done: [], failed: [] };
    /* сменившие группу: откажет перенос в папку — методика уже в корне новой группы, и повтор считается отсюда */
    const regrouped = new Map<string, SurveyListItem>();
    await run(async () => {
      outcome = await eachOf(todo, async (s) => {
        const plan = movePlan(s, groupId, folderId || null);
        if (plan.group) {
          await api.updateSurvey(s.id, { groupId });
          regrouped.set(s.id, { ...s, groupId, folderId: null });
        }
        if (plan.folder) await api.moveSurvey(s.id, folderId || null);
      });
    });
    const { done, failed } = outcome;
    if (done.length) toast(ut("mc.movedN").replace("{n}", String(done.length)), "ok");
    // перечитать каталог и тогда, когда до конца не дошла ни одна, но группу сменили
    if (done.length || regrouped.size) onMoved(done);
    if (!failed.length) {
      if (done.length) onClose();
      return;
    }
    const failedIds = new Set(failed.map((f) => f.item.id));
    setLeft((prev) => prev.filter((s) => failedIds.has(s.id)).map((s) => regrouped.get(s.id) ?? s));
    setMissed(failed);
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={ut("mc.bulkMoveTitle")}
      sub={count(left.length, "methods")}
      icon={<CnIc.folder size={18} />}
      footer={
        <>
          {living.length ? (
            <Button variant="primary" disabled={busy || !todo.length} onClick={() => void submit()}>
              {todo.length && todo.length < left.length
                ? ut("mc.bulkMoveN").replace("{n}", num(todo.length))
                : ut("mc.bulkMove")}
            </Button>
          ) : null}
          <Button onClick={onClose}>{ut("ui.cancel")}</Button>
        </>
      }
    >
      <DrawerSection>
        <p className="m-0 mb-3 text-small text-text-2">{codesLine(left, ut("mc.andMore"))}</p>
        {living.length ? (
          <>
            <Field label={ut("f.group")} hint={ut("mc.bulkMoveGroupHint")}>
              <Select
                data-autofocus
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setFolderId("");
                }}
              >
                {groupId ? null : <option value="">{ut("mc.bulkMovePickGroup")}</option>}
                {living.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </Select>
            </Field>
            {groupId ? (
              <Field label={ut("cst.folder")}>
                <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                  <option value="">{ut("mc.bulkMoveRoot")}</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {/* отступ глубины — длинным тире, а не пробелами: пробелы селект схлопывает */}
                      {"— ".repeat(o.depth)}
                      {o.title}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {groupId && !todo.length ? <p className="m-0 text-small text-muted">{ut("mc.bulkMoveNothing")}</p> : null}
          </>
        ) : (
          <p className="m-0 text-small text-text-2">{ut("mc.bulkMoveNoGroups")}</p>
        )}
        <MissedList missed={missed} />
      </DrawerSection>
    </Drawer>
  );
}

/**
 * «Зняти з використання» для отмеченных — окно, как и у одной методики
 * (methods/ArchiveDialog), потому что шаг обрывает выдачу.
 *
 * Одна отмеченная методика снимается тем окном, с подтверждением кодом:
 * экран сюда её не шлёт. Здесь — список того, что снимается, наборы, где
 * эти методики стоят шагом, и сколько прохождений остаётся на месте.
 * Подтверждение — числом снимаемых: его нельзя набрать, не посмотрев на
 * список, а код здесь не один.
 */
export function ArchiveManyDialog({
  surveys,
  onClose,
  onDone,
}: {
  surveys: SurveyListItem[];
  onClose: () => void;
  /** Снятые: экран снимает с них отметку и перечитывает каталог */
  onDone: (archived: SurveyListItem[]) => void;
}) {
  const { ut } = useLang();
  const count = useCount();
  const toast = useToast();
  const { run, busy } = useAction();
  const [left, setLeft] = useState(surveys);
  const [missed, setMissed] = useState<Missed[]>([]);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === String(left.length);

  /* наборы закрыты правом — отказ значит «не знаем», и строка просто не рисуется */
  const batteries = useResource(() => api.batteries().catch(() => null), []);
  const ids = new Set(left.map((s) => s.id));
  const inBatteries = batteries.data?.filter((b) => !b.archived && b.items.some((i) => ids.has(i.surveyId))) ?? [];
  const responses = left.reduce((sum, s) => sum + s.responseCount, 0);

  async function submit() {
    let outcome: { done: SurveyListItem[]; failed: Missed[] } = { done: [], failed: [] };
    await run(async () => {
      outcome = await eachOf(left, (s) => api.archiveSurvey(s.id));
    });
    const { done, failed } = outcome;
    if (done.length) {
      toast(ut("mc.archivedN").replace("{n}", String(done.length)), "ok");
      onDone(done);
    }
    if (!failed.length) {
      if (done.length) onClose();
      return;
    }
    const failedIds = new Set(failed.map((f) => f.item.id));
    setLeft((prev) => prev.filter((s) => failedIds.has(s.id)));
    setMissed(failed);
    setTyped("");
  }

  return (
    <Modal
      title={ut("mc.arManyTitle").replace("{what}", count(left.length, "methods"))}
      icon={<Ic.archive />}
      tone="warn"
      width={580}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" icon={<Ic.archive />} disabled={!matches || busy} onClick={() => void submit()}>
            {ut("cl.archive")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-body text-text-2">{ut("mc.arManyLead")}</p>
      <ul className="m-0 mt-3 flex max-h-48 list-none flex-col gap-1 overflow-y-auto p-0">
        {left.map((s) => (
          <li key={s.id} className="truncate text-small text-text">
            {s.title}
          </li>
        ))}
      </ul>
      {inBatteries.length ? (
        <Callout kind="warn" icon={<Ic.layers />} className="mt-3">
          {ut("mc.arBatteriesText").replace("{names}", inBatteries.map((b) => `«${b.title}»`).join(", "))}
        </Callout>
      ) : null}
      <div className="mt-3">
        <Callout kind="info" icon={<Mi.archiveRestore />}>
          {ut("mc.arKept").replace("{n}", num(responses))}
        </Callout>
      </div>
      <MissedList missed={missed} />
      <div className="mt-4">
        <Field
          label={ut("mc.arManyConfirm").replace("{n}", String(left.length))}
          hint={matches ? ut("mc.arConfirmOk") : ut("mc.arManyConfirmHint")}
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" autoFocus autoComplete="off" />
        </Field>
      </div>
    </Modal>
  );
}
