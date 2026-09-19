import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { t, type PatientGroupSurvey } from "@quizzy/shared";
import { api } from "../../api";
import { numericDate } from "../constructor/catalogue";
import { useLang } from "../../lang";
import { IconEdit, IconSearchGlass, Loading, useAction } from "../../ui";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Pager } from "../../ui/pager";
import { DEFAULT_PER, pageCount, pageFrom, perFrom, slicePage } from "../../ui/paging";
import { Button, Input } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { AddMemberDialog, AssignSurveyDialog, GroupForm } from "./dialogs";
import { keepPresent, matchesQuery, toggleIn } from "./model";
import { PersonGrid, SelectionBar } from "./PersonGrid";

/*
 * Карточка группы пациентов — кадр f20 макета, один свиток сверху вниз:
 *
 *   «Назва Групи»                     → заголовок экрана (h1), справа глиф правки
 *   «Опис Групи» + абзац              → description группы
 *   «Тести Групи» · «+»               → назначенные на группу методики, «+» назначает ещё
 *   «Пацієнт» · поиск · «+» · страницы → поиск по составу, «+» добавляет человека
 *   «Пацієнти Групи» · сетка 3×N       → состав с галочками выбора, «N вибрано»
 *
 * Всё приходит одним ответом GET /api/patient-groups/:id: сервер отдаёт
 * описание, состав и методики вместе именно потому, что экран открывает их
 * вместе (см. докблок маршрута).
 *
 * Чего на кадре нет, а здесь есть:
 *
 * 1. Глиф правки у заголовка. Сервер умеет PATCH названия и описания, а на
 *    кадре ни карандаша, ни формы нет; без глифа опечатка в названии жила бы
 *    вечно. Стоит там же, где на других экранах стоит шестерёнка, — справа в
 *    строке заголовка.
 * 2. Кнопка «Прибрати з групи» под сеткой. Галочки на кадре нарисованы, а
 *    действие над ними — нет; убрать человека из группы иначе нечем.
 *
 * Чего на кадре есть, а здесь иначе: у карточки теста вместо описания —
 * «призначено 05.02.2023 · до 01.03.2023 · пройшли 5 з 12». Описания
 * методики в ответе группы нет (api_gaps), а срок и «сколько уже сдали» —
 * то, ради чего на эту строку смотрят.
 */

export default function PatientGroupCard() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const groupId = id!;
  const { run } = useAction();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const card = useResource(() => api.patientGroup(groupId), [groupId]);
  const group = card.data;

  /*
   * Поиск и страницы — на клиенте: состав приходит целиком (он и так
   * ограничен зоной видимости читателя), и ходить на сервер за каждой
   * буквой значило бы писать в журнал доступа запись на каждое нажатие.
   */
  const members = useMemo(
    () => (group?.members ?? []).filter((m) => matchesQuery(q, m.fullName, m.email)),
    [group, q],
  );
  const pages = pageCount(members.length, per);
  const rows = slicePage(members, page, per);

  useEffect(() => {
    if (group && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [group, page, pages, update]);

  /* выбор живёт на экране и не переживает уход с него: это не данные */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const chosen = useMemo(() => keepPresent(selected, group?.members ?? []), [selected, group]);

  type Dialog = "edit" | "assign" | "add" | null;
  const [dialog, setDialog] = useState<Dialog>(null);

  /*
   * Окно что-то изменило — после закрытия карточку надо перечитать. Флаг
   * один на оба окна (назначить тест, добавить людей) и перечитывание
   * только по нему: GET /api/patient-groups/:id пишет в журнал доступа
   * запись о чтении поимённого состава, и «Скасувати», за которым ничего
   * не назначено и никто не добавлен, не должно оставлять след о доступе
   * к персональным данным. Ref, а не state: флаг ничего не рисует, а
   * closeDialog уходит в окно свойством и с state мог бы закрыться
   * устаревшим значением.
   */
  const dirty = useRef(false);
  const closeDialog = () => {
    setDialog(null);
    if (dirty.current) card.reload();
    dirty.current = false;
  };

  const memberIds = useMemo(() => new Set((group?.members ?? []).map((m) => m.userId)), [group]);

  const removeChosen = async () => {
    /*
     * По одному запросу на человека: маршрута «пачкой» нет. Первый отказ
     * останавливает цикл — иначе на экране «убрано» при половине убранных,
     * а вторая половина осталась без объяснения.
     */
    const ok = await run(async () => {
      for (const userId of chosen) await api.removePatientGroupMember(groupId, userId);
    }, ut("pg.removed"));
    setSelected(new Set());
    if (ok) card.reload();
  };

  if (card.error) return <Loading error={card.error} onRetry={card.reload} />;
  if (!group) return <Loading rows={6} />;

  return (
    <Page
      title={group.title}
      actions={
        <Button size="glyph" variant="ghost" aria-label={ut("pg.edit")} onClick={() => setDialog("edit")}>
          <span className="[&>svg]:size-[22px]">
            <IconEdit />
          </span>
        </Button>
      }
    >
      {/* ── Опис Групи ── */}
      <section aria-labelledby="pg-description">
        <h2 id="pg-description" className={h2}>
          {ut("pg.description")}
        </h2>
        <p className="m-0 mt-[14px] max-w-[110ch] text-[15px] leading-[22px] text-muted">
          {group.description ? group.description : <span className="text-faint">{ut("pg.noDescription")}</span>}
        </p>
      </section>

      <Rule />

      {/* ── Тести Групи ── */}
      <section aria-labelledby="pg-tests">
        <div className="flex items-center justify-between gap-[14px]">
          <h2 id="pg-tests" className={h2}>
            {ut("pg.groupTests")}
          </h2>
          <Button size="glyph" variant="ghost" aria-label={ut("cn.assignGroup")} onClick={() => setDialog("assign")}>
            <IconPlusThick />
          </Button>
        </div>
        {group.surveys.length === 0 ? (
          <p className="m-0 mt-[14px] text-[13px] text-muted">{ut("pg.noTests")}</p>
        ) : (
          <ul className="m-0 mt-[14px] grid list-none grid-cols-2 gap-x-[48px] gap-y-[24px] p-0 max-[900px]:grid-cols-1">
            {group.surveys.map((s) => (
              <SurveyRow key={s.surveyId} survey={s} total={group.members.length} />
            ))}
          </ul>
        )}
      </section>

      <Rule />

      {/* ── Пацієнт · поиск · «+» · страницы ── */}
      {/*
        Та же строка, что над каждым списком консоли (заголовок → поиск →
        «+» → страницы), только внутри свитка: её заголовок — «Пацієнт», а не
        имя экрана, и рисует её экран сам, не Page.

        Кегль у «Пацієнт» — 24/700, как у имени экрана, а не 18 остальных
        подзаголовков свитка: на кадре он набран ровно так же, как
        «Пацієнти» на f05 и «Групи» на f10, — строка над списком перенесена
        внутрь свитка вместе со своим размером. Ступень разметки при этом
        h2: h1 у экрана один, это название группы.
      */}
      <div className="flex items-center gap-[24px] max-[900px]:flex-wrap">
        <h2 className="m-0 text-[24px] font-bold leading-tight text-primary">{ut("pg.patient")}</h2>
        <div className="relative min-w-0 flex-1">
          <Input
            look="outline"
            aria-label={ut("pg.patientSearch")}
            value={q}
            onChange={(e) => update({ q: e.target.value, page: null })}
            className="pr-[44px]"
            autoComplete="off"
            maxLength={120}
          />
          <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
            <IconSearchGlass />
          </span>
        </div>
        <Button size="glyph" variant="ghost" aria-label={ut("pg.addPatient")} onClick={() => setDialog("add")}>
          <IconPlusThick />
        </Button>
        <div className="ml-auto shrink-0">
          <Pager
            page={page}
            pages={pages}
            per={per}
            onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
            onPage={(n) => update({ page: n > 1 ? String(n) : null })}
          />
        </div>
      </div>

      {/* ── Пацієнти Групи ── */}
      <section aria-labelledby="pg-members" className="mt-[40px]">
        <h2 id="pg-members" className={h2}>
          {ut("pg.groupPatients")}
        </h2>
        {rows.length === 0 ? (
          <p className="m-0 mt-[14px] text-[13px] text-muted">{q.trim() ? ut("pt.nobodyFound") : ut("pg.noMembers")}</p>
        ) : (
          <PersonGrid
            className="mt-[14px]"
            people={rows}
            selected={chosen}
            onToggle={(userId) => setSelected((prev) => toggleIn(prev, userId))}
          />
        )}
        <SelectionBar count={chosen.size} onClear={() => setSelected(new Set())}>
          <Button variant="ghost" onClick={() => void removeChosen()}>
            {ut("pg.removeFromGroup")}
          </Button>
        </SelectionBar>
      </section>

      {dialog === "edit" ? (
        <GroupForm
          group={group}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            /* состав и методики не менялись — подменяем шапку, не перечитывая всё */
            card.patch({ ...group, title: saved.title, description: saved.description });
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "assign" ? (
        <AssignSurveyDialog
          title={ut("cn.assignGroup")}
          onAssign={async (surveyId, expiresAt) => {
            const res = await api.assignSurveyToPatientGroup(groupId, { surveyId, expiresAt });
            dirty.current = true;
            /* число адресатов — после тире: слово не склоняется по числу */
            return `${ut("cn.assignedToGroup")} «${group.title}»: ${ut("cn.recipients")} — ${res.recipients}`;
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "add" ? (
        <AddMemberDialog
          groupId={groupId}
          members={memberIds}
          onAdded={() => {
            dirty.current = true;
          }}
          onClose={closeDialog}
        />
      ) : null}
    </Page>
  );
}

/* 18/700 фиолетовым — ступень заголовка внутри экрана (см. Panel в layout.tsx); «Пацієнт» — исключение, см. выше */
const h2 = "m-0 text-[18px] font-bold leading-tight text-primary";

/**
 * Фиолетовая линия между блоками — на кадре она нарисована, и она не
 * серая: --primary-dim, тот же фиолетовый вполсилы, что у неактивной вкладки.
 */
function Rule() {
  return <hr className="my-[30px] border-0 border-t border-primary-dim" />;
}

/**
 * Карточка теста группы: название 15/700 фиолетовым (ссылка на методику),
 * справа серым — когда назначено, до какого срока и сколько из состава уже
 * сдали. Два столбца внутри строки, как на кадре: название | описание.
 */
function SurveyRow({ survey, total }: { survey: PatientGroupSurvey; total: number }) {
  const { ut, lang } = useLang();
  const parts = [`${ut("pg.assignedOn")} ${numericDate(survey.assignedAt)}`];
  if (survey.expiresAt) parts.push(`${ut("pg.until")} ${numericDate(survey.expiresAt)}`);
  parts.push(`${ut("pg.completed")} ${survey.completedCount} ${ut("common.of")} ${total}`);
  return (
    <li className="flex items-start gap-[24px]">
      <Link
        to={`/surveys/${survey.surveyId}`}
        className="w-[136px] shrink-0 text-[15px] font-bold leading-[20px] text-primary no-underline hover:underline"
      >
        {t(survey.title, lang)}
      </Link>
      <p className="m-0 min-w-0 flex-1 text-[11px] leading-[15px] text-muted">{parts.join(" · ")}</p>
    </li>
  );
}
