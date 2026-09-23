import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api";
import { dateTime, day } from "../../format";
import { useLang } from "../../lang";
import { Loading, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { IconGear, IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { ActionMenu } from "../../ui/menu";
import { Button, Readout } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { AssignSurveyDialog } from "../patientGroups/dialogs";
import { conclusionName, groupStatsText, leadAction, personFields, resultText, statsText } from "./model";

/*
 * Карточка пациента — кадр f19 макета, один свиток сверху вниз:
 *
 *   «Пацієнт» · [Відписатись]          → заголовок экрана, справа контурная кнопка
 *   плашки 3×3 (восемь заполнены)      → персональные данные, Readout look="fill"
 *   ── Тести · «+»                     → сданные прохождения: название (ссылка на
 *                                        просмотр), «Результат тесту», «Статистика»
 *   ── Групи                           → группы читателя, где человек состоит:
 *                                        название (ссылка), «Опис Групи», «Статистика Групи»
 *   ── Заключення · «+»                → подписанные и свой черновик: название
 *                                        (ссылка), «Список тестів та аналітики» чипами,
 *                                        «Висновки»
 *
 * Всё приходит одним ответом GET /api/patients/:id/card — сервер отдаёт
 * четыре блока вместе именно потому, что экран открывает их вместе.
 *
 * Замеры кадра. Кадр рисован на 1600px, но колонка содержимого на нём — от
 * 203 до 1403, то есть ровно 1200, как в консоли: числа взяты замером, без
 * коэффициента 0,75.
 *
 *   заголовок 24/700 · заголовки разделов 20/700 · кнопка в шапке 34px, 18/700,
 *   рамка #666666, радиус 5 · плашки 36px с шагом 51 (15 между), колонки по
 *   370 при зазоре 45 · разделитель 2px #b299cc: 30 от плашек, 32 до заголовка
 *   раздела, 16 после последней строки · строка списка: имя 17/700 фиолетовым
 *   в колонке 136, зазор колонок 36, подпись колонки 13/700 серым, текст
 *   13/400 серым, обе с межстрочным 14, шаг строк 82 (четыре строки текста
 *   плюс 8 сверху и 18 снизу: полоса подсветки на кадре несимметрична —
 *   11 над верхом литер подписи, 15 под низом последней строки) · подсветка
 *   строки #f7f5fa · чип 20px высотой и не уже 139, текст 15/700,
 *   зазор 7, радиус 4, отступ от подписи 11.
 *
 * Где кадры спорят, взят повторяющийся замер: от разделителя до верха
 * прописной в заголовке «Тести» и «Групи» — 38, у «Заключення» — 45; взято 38.
 *
 * Чего на кадре нет, а здесь есть, и почему:
 *
 * 1. Шестерёнка слева от «Відписатись» — меню «Огляд · Динаміка ·
 *    Хронологія», дверь к прежней карте (/patients/:id/case): план
 *    безопасности, записи приёма, направления и графики живут там, и
 *    карточка, с которой к ним не попасть, в кризис не работает как карта
 *    пациента. Шестерёнка — тот же знак, что у карточек людей на кадрах
 *    f04/f33, и стоит там же, где стоит у них. Ссылки в списке (см. п. 3)
 *    двери не заменяют: они ведут к одному прохождению, а не к человеку.
 * 2. Строка «…ще немає» в пустом разделе. Заголовок без единой строки под
 *    ним читается как «не загрузилось»; так же поступают соседние экраны
 *    (pg.empty, ppl.noPatients).
 * 3. Что скрыто от глаз: подписи плашек для диктора (<dt> sr-only), имя у
 *    глифов «+» и у шестерёнки, область нажатия 44 у глифов.
 *
 * Чего на кадре есть, а здесь иначе:
 *
 * - Чипы «Назва Аналітики» (сиреневые, залитые) не рисуются: аналитики как
 *   именованного объекта, который можно положить в заключение, на сервере
 *   нет, а заключение привязано к одному прохождению — в колонке всегда
 *   один чип с названием теста (см. api_gaps).
 * - Заключений по группе («Назва групи» в первой колонке второй и третьей
 *   строк кадра) нет: заключение в системе пишется по прохождению одного
 *   человека.
 * - Подписи «телефон», «email», «Населенний пункт» — как в словаре: с
 *   прописной и без опечатки («Населений»); те же ключи, что у карточки
 *   сотрудника, — второе написание тех же слов разошлось бы с первым.
 * - «Статистика» строки теста начинается с даты сдачи: у методики, сданной
 *   трижды, три одинаковых названия, и без даты строки неразличимы.
 * - «+» в «Заключення» — меню по сданным тестам, а не сразу форма: заключение
 *   пишется по прохождению (/responses/:id/conclusion), и без выбора, по
 *   какому, знак вёл бы в никуда.
 * - Подсвеченная первая строка «Групи» на кадре f19_2 прочитана как наведение,
 *   а не как зебра: зебра красила бы и первую с третьей строкой «Тестів», а
 *   там из четырёх строк не подсвечена ни одна. Подсветка ложится при наведении
 *   на имя строки — единственное, на что здесь можно нажать.
 *
 * Прежняя карта (сводка, динамика, хронология) не удалена — она переехала на
 * /patients/:id/case (pages/CaseCard.tsx); старые адреса перенаправляются.
 */

export default function PatientCard() {
  const { userId } = useParams<{ userId: string }>();
  const id = userId!;
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.patientCard(id), [id]);
  const [assigning, setAssigning] = useState(false);

  if (res.error) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const card = res.data;
  const base = `/patients/${card.id}`;
  const action = leadAction(card);

  const fields = personFields(
    card,
    {
      firstName: ut("person.firstName"),
      lastName: ut("person.lastName"),
      middleName: ut("ppl.middleName"),
      sex: ut("person.sex"),
      birthDate: ut("person.birthDate"),
      phone: ut("ppl.phone"),
      city: ut("ppl.city"),
      email: ut("person.email"),
      male: ut("person.sex.male"),
      female: ut("person.sex.female"),
    },
    day,
  );

  /*
   * Одна кнопка на два действия: закрепить за собой (take) или отпустить.
   * После ответа карточка перечитывается — ведущий приходит с сервера, и
   * подпись кнопки обязана отражать его, а не нажатие.
   */
  const toggleLead = () =>
    void run(async () => {
      await api.takeLead(card.id, action === "subscribe");
      res.reload();
    }, ut(action === "subscribe" ? "pcard.subscribed" : "pcard.unsubscribed"));

  const conclusionTargets = card.responses.length
    ? card.responses.map((r) => ({
        label: `${r.surveyTitle} · ${r.submittedAt ? dateTime(r.submittedAt) : "—"}`,
        to: `/responses/${r.responseId}/conclusion`,
      }))
    : [{ label: ut("pcard.noTests"), disabled: true }];

  return (
    <Page
      title={ut("pg.patient")}
      actions={
        <>
          <ActionMenu
            label={ut("pcard.clinical")}
            glyph={<IconGear />}
            entries={[
              { label: ut("pc.overview"), to: `${base}/case` },
              { label: ut("pc.dynamics"), to: `${base}/case/dynamics` },
              { label: ut("tl.title"), to: `${base}/case/timeline` },
            ]}
          />
          <OutlineButton onClick={toggleLead} disabled={busy}>
            {ut(action === "subscribe" ? "pcard.subscribe" : "pcard.unsubscribe")}
          </OutlineButton>
        </>
      }
    >
      {/* сетка плашек — замер кадра: колонки по 370 при зазоре 45, шаг строк 51 (плашка 36 + 15) */}
      <dl className="m-0 mb-[30px] grid grid-cols-3 gap-x-[45px] gap-y-[15px] max-[900px]:grid-cols-1">
        {fields.map((f) => (
          <div key={f.key} className="min-w-0">
            {/* sr-only, а не hidden: подпись нужна диктору, с экрана её убирает кадр */}
            <dt className="sr-only">{f.label}</dt>
            <Readout as="dd" look="fill" className="m-0 min-w-0">
              {f.value ? (
                <span className="min-w-0 truncate text-text">{f.value}</span>
              ) : (
                <span className="min-w-0 truncate font-bold text-primary">{f.label}</span>
              )}
            </Readout>
          </div>
        ))}
      </dl>

      <Section
        title={ut("top.tests")}
        glyph={
          <Button size="glyph" variant="ghost" aria-label={ut("pg.assignTest")} onClick={() => setAssigning(true)}>
            <IconPlusThick />
          </Button>
        }
      >
        {card.responses.length === 0 ? (
          <Empty>{ut("pcard.noTests")}</Empty>
        ) : (
          <ul className="m-0 list-none p-0">
            {card.responses.map((r) => (
              <Row key={r.responseId} name={r.surveyTitle} to={`/surveys/${r.surveyId}/responses/${r.responseId}`}>
                <Column label={ut("pcard.result")}>{resultText(r.scales, { none: ut("pcard.noScores") })}</Column>
                <Column label={ut("top.statistics")}>{statsText(r, { unreliable: ut("pcard.unreliable") }, day)}</Column>
              </Row>
            ))}
          </ul>
        )}
      </Section>

      <Section title={ut("top.groups")}>
        {card.groups.length === 0 ? (
          <Empty>{ut("pcard.noGroups")}</Empty>
        ) : (
          <ul className="m-0 list-none p-0">
            {card.groups.map((g) => (
              <Row key={g.id} name={g.title} to={`/patient-groups/${g.id}`}>
                <Column label={ut("pg.description")}>{g.description ?? ut("pg.noDescription")}</Column>
                <Column label={ut("pcard.groupStats")}>
                  {groupStatsText(g, { members: ut("pg.members"), tests: ut("pg.tests") })}
                </Column>
              </Row>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={ut("pcard.conclusions")}
        glyph={<ActionMenu label={ut("pcard.newConclusion")} glyph={<IconPlusThick />} entries={conclusionTargets} />}
      >
        {card.conclusions.length === 0 ? (
          <Empty>{ut("pcard.noConclusions")}</Empty>
        ) : (
          <ul className="m-0 list-none p-0">
            {card.conclusions.map((c) => (
              <Row key={c.id} name={conclusionName(c, { draft: ut("pcard.draft") })} to={`/responses/${c.responseId}/conclusion`}>
                <Column label={ut("pcard.composition")}>
                  <Chips items={[c.surveyTitle]} />
                </Column>
                <Column label={ut("pcard.findings")}>{c.text}</Column>
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {assigning ? (
        <AssignSurveyDialog
          title={ut("pg.assignTest")}
          onAssign={async (surveyId, expiresAt) => {
            await api.grant(surveyId, card.id, undefined, expiresAt);
            return ut("pg.assigned");
          }}
          onClose={() => setAssigning(false)}
        />
      ) : null}
    </Page>
  );
}

/* ─────────── куски кадра ─────────── */

/**
 * Контурная кнопка шапки: 34px, 18/700 фиолетовым, рамка в пиксель цветом
 * рамки поля, без заливки. У Button такого начертания нет — все его варианты
 * без рамки (`border-0`), и перебить это классом снаружи нельзя: `border` и
 * `border-0` — одна и та же утилита, побеждает не порядок в строке. Свой
 * элемент здесь, а не новый вариант в примитивах: карточка — единственное
 * место макета с такой кнопкой, и вынести её в каркас будет уместно после
 * слияния, когда станет видно, нужна ли она второму экрану.
 */
function OutlineButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-[34px] items-center justify-center whitespace-nowrap rounded-[5px] border border-field-border",
        "bg-transparent px-[14px] text-[18px] font-bold leading-none text-primary",
        "transition-colors duration-[var(--dur-fast)] hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-45",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * Раздел свитка: линия сверху, заголовок 20/700 и глиф справа в одной
 * строке.
 *
 * Линия — 2px цветом --primary-rule, и это ровно #b299cc кадра. Не
 * --primary-dim: приглушённая ступень в tokens.css осветлена до порога
 * контраста ТЕКСТА (#7a4ea6), а порог текста линии не писан — сам файл
 * оговаривает это у --polsy-violet-soft. Линия здесь — главный структурный
 * знак экрана на всю колонку 1200, и разница (122,78,166) против
 * (178,153,204) на ней видна глазом.
 *
 * Заголовок — <h2>: <h1> занят словом «Пацієнт». Строка заголовка не ниже
 * 27 — высоты глифа — и в разделе без глифа («Групи») стоит на той же
 * высоте, что и с ним: так на кадре. Глиф и прописные заголовка — по одной
 * оси: кадры о смещении «+» спорят (f19_1 даёт «+» на 4 ниже прописных,
 * f19_2 — на 3 выше), и середина спора — это и есть одна ось.
 *
 * Отступ до первой строки — 14, а не 9: полоса подсветки строки начинается
 * на кадре в 73 от кромки линии (32 + 27 + 14), тогда как верх литер — в 85
 * (плюс 8 отступа строки и ~4 полусвинца). Девятка с симметричным 13/13 в
 * строке давала верные литеры при полосе, задранной на 5 вверх.
 */
function Section({ title, glyph, children }: { title: string; glyph?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t-2 border-primary-rule pb-[16px] pt-[32px]">
      <div className="mb-[14px] flex min-h-[27px] items-center justify-between gap-[24px]">
        <h2 className="m-0 text-[20px] font-bold leading-[24px] text-primary">{title}</h2>
        {glyph}
      </div>
      {children}
    </section>
  );
}

/**
 * Строка раздела: имя-ссылка в колонке 136 и две колонки текста с подписями.
 *
 * Ссылка — только имя, а не вся строка: диктору имя ссылки — «Назва тесту»,
 * а не три абзаца. Подсветка при этом ложится на строку целиком (на кадре
 * f19_2 так подсвечена первая строка «Групи»): `has-[a:hover]` красит строку,
 * когда наведено на её ссылку, и не обещает нажатия там, где его нет.
 *
 * Цвет — --primary-tint, и это ровно #f7f5fa кадра. Не --surface-2: та
 * ступень разрешается в #f0ecff, то есть в заливку плашек персональных
 * данных этого же экрана, — подсветка вышла бы втрое плотнее кадровой и
 * сравнялась бы по цвету с шапкой, перестав читаться как временная.
 *
 * Отступы 8 сверху и 18 снизу, а не 13/13: на кадре полоса несимметрична
 * относительно текста (11 над верхом литер подписи, 15 под низом последней
 * строки). Шаг строк при этом прежний, 82, — смещены только кромки полосы,
 * литеры остались на замеренных 85 от кромки разделителя (см. Section).
 */
function Row({ name, to, children }: { name: string; to: string; children: ReactNode }) {
  return (
    <li
      className={cx(
        "grid grid-cols-[136px_1fr_1fr] gap-x-[36px] pb-[18px] pt-[8px]",
        "max-[900px]:grid-cols-1 max-[900px]:gap-y-[8px]",
        "transition-colors duration-[var(--dur-fast)] has-[a:hover]:bg-primary-tint",
        "has-[a:focus-visible]:bg-primary-tint",
      )}
    >
      <Link
        to={to}
        className={cx(
          "block min-w-0 self-start text-[17px] font-bold leading-[20px] text-primary no-underline hover:no-underline",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        )}
      >
        {name}
      </Link>
      {children}
    </li>
  );
}

/**
 * Колонка строки: подпись 13/700 серым и под ней текст 13/400, межстрочный у
 * обеих 14 — на кадре подпись и абзац идут одним потоком, без ступеньки.
 *
 * Три строки, а не «сколько придёт»: на кадре в каждой колонке ровно три
 * строки рыбы, и это единственное, что держит одинаковый шаг строк раздела
 * (82). Обрезанное не пропадает — имя строки ведёт на само прохождение,
 * группу или заключение, где тот же текст напечатан целиком.
 */
function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-[13px] font-bold leading-[14px] text-muted">{label}</span>
      {typeof children === "string" ? (
        <p className="m-0 line-clamp-3 whitespace-pre-line text-[13px] leading-[14px] text-muted">{children}</p>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * Чипы состава заключения: плашка 20px, не уже 139, текст 15/700 фиолетовым
 * на заливке --primary-soft, зазор 7, перенос строкой. Ширина растёт с
 * названием, а не режет его: на кадре чипы одной ширины, потому что и
 * названия в них одной длины.
 *
 * Чип один, и он светлый. На кадре их два вида: светлый «Назва тесту» и
 * залитый сиреневым «Назва Аналітики». Второго здесь нет не по забывчивости —
 * аналитики как именованного объекта, который можно положить в заключение, на
 * сервере не существует (см. api_gaps); рисовать пустой второй вид значило бы
 * обещать сущность, которой нет.
 */
function Chips({ items }: { items: string[] }) {
  return (
    <ul className="m-0 mt-[11px] flex list-none flex-wrap gap-[7px] p-0">
      {items.map((it) => (
        <li
          key={it}
          className={cx(
            "inline-flex h-[20px] min-w-[139px] items-center justify-center rounded-[4px]",
            "bg-primary-soft px-[10px] text-[15px] font-bold leading-none text-primary",
          )}
        >
          {it}
        </li>
      ))}
    </ul>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 py-[13px] text-[13px] leading-[14px] text-muted">{children}</p>;
}
