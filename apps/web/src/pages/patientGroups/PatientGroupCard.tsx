import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useMatch, useParams, useSearchParams } from "react-router-dom";
import { t, type PatientGroupSurvey } from "@quizzy/shared";
import { api } from "../../api";
import { numericDate } from "../constructor/catalogue";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading, useAction } from "../../ui";
import { IconDots, IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { ActionMenu } from "../../ui/menu";
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
 * Замеры f14, по которым собрана эта страница: имя экрана 20/700 (прописная
 * «Н» 152…165 — ступень ниже, чем 24/700 списков), подзаголовки свитка тоже
 * 20/700, абзац описания 15/20 во всю колонку 1200, разделители 2px #b299cc
 * (линии y 344-345 и 569-570), от абзаца до линии 31 и от линии до
 * подзаголовка 18, от второй линии до верхней рамки поиска 40.
 *
 * Чего на кадре нет, а здесь есть:
 *
 * 1. Правка названия и описания. Сервер умеет PATCH, а на кадре ни
 *    карандаша, ни формы нет — в строке заголовка справа чисто. Глиф с глаз
 *    убран, окно осталось и открывается адресом /patient-groups/:id/edit:
 *    без него опечатка в названии жила бы вечно.
 * 2. Пункт «Прибрати з групи» в меню «⋯» под сеткой. Галочки на кадре
 *    нарисованы, а действие над ними — нет; убрать человека из группы иначе
 *    нечем.
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
  /*
   * Окно правки названия и описания открывается адресом
   * /patient-groups/:id/edit — на кадре f14 в строке заголовка справа чисто,
   * и глифа-карандаша там быть не может. Начальное состояние, а не эффект:
   * закрыв окно, человек остаётся на карточке, и открывать его снова на
   * каждую отрисовку было бы западнёй.
   */
  const editing = useMatch("/patient-groups/:id/edit") !== null;
  const [dialog, setDialog] = useState<Dialog>(editing ? "edit" : null);

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
    <Page title={group.title} titleSize={20}>
      {/* ── Опис Групи ── */}
      <section aria-labelledby="pg-description">
        <h2 id="pg-description" className={h2}>
          {ut("pg.description")}
        </h2>
        {/* межстрочный 20 и во всю колонку: на кадре четыре строки с верхами 237/257/277/297 */}
        <p className="m-0 mt-[14px] text-[15px] leading-[20px] text-muted">
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

        Зазоры на кадре разные, и одним числом их не выразить: «Пацієнт»
        кончается на 284, поле начинается на 300 (16), поле кончается на 983,
        «+» стоит 997…1023 (14), а блок страниц отжат вправо (подпись с
        1185). Поэтому поле и «+» собраны в свой ряд с зазором 14, а внешний
        зазор — 16. Верхний отступ строки — 40: на кадре от нижней кромки
        линии (570) до верхней рамки поля (610) ровно столько, а поле в
        строке самое высокое (36 против 30 у заголовка), то есть верх строки
        и есть верх поля. Число стоит здесь целиком, а не складывается с
        нижним просветом линии: соседние отступы в потоке схлопываются в
        больший, и 18 + 22 дали бы 22, а не 40.

        Кегль у «Пацієнт» — 24/700, как у имени экрана, а не 18 остальных
        подзаголовков свитка: на кадре он набран ровно так же, как
        «Пацієнти» на f05 и «Групи» на f10, — строка над списком перенесена
        внутрь свитка вместе со своим размером. Ступень разметки при этом
        h2: h1 у экрана один, это название группы.
      */}
      <div className="mt-[40px] flex items-center gap-[16px] max-[900px]:flex-wrap">
        <h2 className="m-0 text-[24px] font-bold leading-tight text-primary">{ut("pg.patient")}</h2>
        <div className="flex min-w-0 flex-1 items-center gap-[14px]">
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
        </div>
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
        {/* под сеткой на кадре только счётчик; действия — за «⋯», как на f05 */}
        <SelectionBar count={chosen.size}>
          <ActionMenu
            label={ut("pt.selectionActions")}
            glyph={<IconDots />}
            entries={[
              { label: ut("pg.removeFromGroup"), onSelect: () => void removeChosen() },
              { label: ut("pg.clearSelection"), onSelect: () => setSelected(new Set()) },
            ]}
          />
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

/*
 * 20/700 фиолетовым — та же ступень, что у разделов карточки пациента
 * (Section в PatientCard.tsx). Замер f14: прописные «О», «Т», «П» в «Опис
 * Групи», «Тести Групи» и «Пацієнти Групи» — 14 px, то есть кегль 20, а не
 * 18. «Пацієнт» — исключение, см. ниже.
 */
const h2 = "m-0 text-[20px] font-bold leading-[24px] text-primary";

/**
 * Фиолетовая линия между блоками — на кадре она 2px и цвета #b299cc
 * (--primary-rule), тот же знак, что делит разделы карточки пациента. Не
 * --primary-dim: приглушённая ступень словаря осветлена до порога контраста
 * ТЕКСТА (#7a4ea6), а линия — не текст, и разница на ней видна глазом.
 *
 * Просветы несимметричны: сверху 31 (низ последней строки абзаца 313, линия
 * 344), снизу 18 до верха строчного блока подзаголовка (линия 345,
 * прописная «Тести Групи» 367).
 */
function Rule() {
  return <hr className="mb-[18px] mt-[30px] border-0 border-t-2 border-primary-rule" />;
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
