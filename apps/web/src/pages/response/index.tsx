import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { api } from "../../api";
import { ConclusionEditor } from "../../components/ConclusionEditor";
import { dateTime } from "../../format";
import { useLang } from "../../lang";
import { Loading } from "../../ui";
import { Page } from "../../ui/layout";
import { Button, Readout } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useResource } from "../../useResource";
import { buildResponseView, type QuestionView, type ScaleLadder } from "./model";

/*
 * Пройденный тест — кадры f31 и f34 макета, один экран.
 *
 * Два кадра — один экран в двух редакциях. f31 — ранняя: варианты стоят в
 * строку чипами с номером («1 Так · 2 Ні · 3 Нінаю»), веса не показаны,
 * блок «Результати» и кнопка заключения ещё не нарисованы, а один пункт
 * подсвечен как текущий. f34 — поздняя и полная: варианты столбиком, у
 * каждого справа вес в баллах, ниже лестница «від — до — текст» с
 * подсвеченной ступенью и кнопка «Створити заключення». Взята f34: она
 * содержит всё, что есть на f31, кроме номеров вариантов и подсветки
 * текущего пункта, — а и то и другое относится к прохождению, не к
 * просмотру. Номер варианта здесь ничего не сообщает (ключ ссылается на код
 * варианта, а не на его порядок), «текущего» пункта у сданного протокола нет.
 *
 * До этого экрана у прохождения не было адреса: его показывало модальное
 * окно в разборе случаев (Alerts.tsx, ResponseModal) и строка таблицы на
 * карточке методики. Переслать коллеге ссылку на конкретный протокол было
 * нельзя. Теперь адрес есть, и он лежит под методикой —
 * /surveys/:id/responses/:rid — там же, где ключ, бланк и доступ: раздел
 * «Тести» в верхней полосе остаётся подсвеченным, как на кадре, а адрес
 * читается как «методика → прохождение». Данные при этом грузятся по
 * идентификатору прохождения: оно само знает свою методику, и если в адресе
 * стоит чужая, экран уходит на правильный адрес, а не показывает описание
 * одной методики над ответами другой.
 *
 * Экран персонала. Пациент к нему не попадает по построению — маршрут лежит
 * в ветке консоли, у кабинета своя оболочка, — и потому веса вариантов здесь
 * показывать можно. Сам GET /api/responses/:id их не отдаёт как раз из-за
 * пациента; откуда они берутся и что бывает при смене версии методики,
 * рассказано в ./model.ts.
 */

/*
 * Замеры кадра f34 (кадр 1600 px, колонка 1200), сняты по пикселям:
 *
 *   заголовок «Опис тесту»      18/700 фиолетовым, текст 16/20 серым
 *   колонка пунктов              700 px по центру (x 451–1150)
 *   пункт                        заголовок 18/22 фиолетовым, до строк 20 px
 *   строка варианта              текст 1fr · вес 80 px · зазор 15 · высота 36 · шаг 51
 *   между пунктами               50 px, столько же до «Результати»
 *   ступень лестницы             «від» · поле 87 · «до» · поле 87 · текст 1fr, шаг 51
 *   кнопка                       45 px, 22/700, правый край — край колонки
 *
 * Шаг 51 — это 36 высоты Readout плюс 15 зазора: ритм строк здесь тот же,
 * что у формы (Field), и кадр с ним совпадает ровно, без округлений.
 * Единственное, что нарисовано на кадре и не набрано, — ширина «від»/«до»:
 * она задана словом, а не числом (22 px под «від»), чтобы русское «от»/«до»
 * не ломало сетку.
 */

export default function ResponseView() {
  const { ut } = useLang();
  const { id: surveyId, rid } = useParams<{ id: string; rid: string }>();
  const [writing, setWriting] = useState(false);

  /*
   * Две загрузки одной парой: прохождение и действующая методика. Методика
   * берётся по идентификатору из адреса, а не из ответа о прохождении —
   * иначе запросы шли бы один за другим и экран ждал бы вдвое дольше. Цена
   * — один лишний запрос, когда адрес собран с чужой методикой; см. Navigate.
   */
  const res = useResource(
    async () => {
      const [detail, survey] = await Promise.all([api.responseDetail(rid!), api.survey(surveyId!)]);
      return { detail, survey };
    },
    [rid, surveyId],
    { enabled: !!rid && !!surveyId },
  );

  if (!res.data) return <Loading rows={8} error={res.error} onRetry={res.reload} />;
  const { detail, survey } = res.data;

  if (detail.survey.id !== survey.id) {
    return <Navigate to={`/surveys/${detail.survey.id}/responses/${detail.id}`} replace />;
  }

  const view = buildResponseView(detail, survey);

  return (
    <Page
      title={detail.survey.title}
      /*
        Кадр знает только «Назва тесту». Строка под заголовком — отступление
        от буквы: прохождение без даты и состояния на экране, на который
        ведёт пересылаемая ссылка, — это протокол без даты. Набрана она
        мета-строкой макета (13/400 серым), то есть тем, что у макета есть.
        Кто проходил — не печатается: GET /api/responses/:id имени не отдаёт
        (см. api_gaps в отчёте волны).
      */
      sub={`${ut(`rstatus.${detail.status}`, detail.status)} · ${dateTime(detail.submittedAt ?? detail.startedAt)}`}
    >
      {survey.description ? (
        <section className="mb-[40px]">
          <h2 className="m-0 mb-[12px] text-[18px] font-bold leading-tight text-primary">
            {ut("rsp.description")}
          </h2>
          <p className="m-0 whitespace-pre-wrap text-[16px] leading-[20px] text-muted">{survey.description}</p>
        </section>
      ) : null}

      <div className="mx-auto w-full max-w-[700px]">
        {view.stale ? (
          <p className="m-0 mb-[28px] text-[13px] leading-[19px] text-muted">{ut("rsp.staleVersion")}</p>
        ) : null}

        <ol className="m-0 flex list-none flex-col gap-[50px] p-0">
          {view.questions.map((q) => (
            <QuestionBlock key={q.questionId} q={q} />
          ))}
        </ol>

        <section className="mt-[50px]">
          <h2 className="m-0 mb-[20px] text-[18px] font-bold leading-[22px] text-primary">{ut("rsp.results")}</h2>
          {view.ladders.length ? (
            <div className="flex flex-col gap-[28px]">
              {view.ladders.map((l) => (
                <Ladder key={l.scaleId} l={l} titled={view.ladders.length > 1} />
              ))}
            </div>
          ) : (
            /*
              Пустой список баллов — не всегда «подсчёт выключен». Сервер
              заполняет response_scores только при сдаче, поэтому у незавершённого
              или брошенного прохождения при включённом подсчёте баллов тоже
              нет — но причина другая, и строка должна называть её, а не
              обещать, что баллов не будет. Сначала проверяется подсчёт, а не
              состояние: у методики без подсчёта и сданное прохождение пусто.
            */
            <p className="m-0 text-[13px] leading-[19px] text-muted">
              {!detail.survey.scoringEnabled || detail.status === "completed"
                ? ut("rsp.scoresOff")
                : ut("rsp.notSubmitted")}
            </p>
          )}
        </section>

        {/*
          Кнопка стоит под результатами, как на кадре, и раскрывает редактор
          заключения здесь же, а не уводит на другой экран: специалист пишет
          вывод, глядя на ответы, и убирать их с глаз в этот момент — значит
          заставить держать двести пунктов в голове. После раскрытия кнопка
          уходит: у редактора свои действия («зберегти», «підписати»), и
          вторая «створити» рядом с ними спрашивала бы, чем отличается.
        */}
        {writing ? (
          <div className="mt-[28px]">
            <ConclusionEditor responseId={detail.id} />
          </div>
        ) : (
          <div className="mt-[45px] flex justify-end">
            <Button size="md" onClick={() => setWriting(true)}>
              {ut("rsp.createConclusion")}
            </Button>
          </div>
        )}
      </div>
    </Page>
  );
}

/** Пункт: заголовок с номером и столбик вариантов, выбранный — залит */
function QuestionBlock({ q }: { q: QuestionView }) {
  const { ut } = useLang();
  return (
    <li>
      {/*
        h2, а не h3: «Опис тесту», каждый пункт и «Результати» — соседи одного
        уровня под заголовком экрана, и на кадре набраны одним кеглем. Номер
        входит в заголовок («Питання №1 …»), как напечатано, — диктор так и
        читает «питання номер один», и это лучше, чем номер отдельным узлом.
      */}
      <h2 className="m-0 mb-[20px] text-[18px] font-bold leading-[22px] text-primary">
        {ut("rsp.questionN").replace("{n}", String(q.number))}
        {q.title ? ` ${q.title}` : ""}
      </h2>
      {q.options.length ? (
        <ul className="m-0 flex list-none flex-col gap-[15px] p-0">
          {q.options.map((o) => (
            <li key={o.id} className="grid grid-cols-[1fr_80px] items-stretch gap-[15px]">
              {/*
                Заливка — единственный признак выбора на кадре, и глазу его
                хватает: залитая строка среди контурных читается однозначно и
                переживает чёрно-белую печать. Диктору признак дан словом
                (sr-only «обрано»), полужирное начертание — тоже с кадра.
              */}
              <Readout look={o.chosen ? "fill" : "outline"} className={cx(o.chosen && "font-bold")}>
                <span className="text-primary">{o.text}</span>
                {o.chosen ? <span className="sr-only"> — {ut("rsp.chosen")}</span> : null}
                {/*
                  Критический вариант помечен словом, а не цветом: цвет один
                  не работает, и на протоколе с тревогой это не то место, где
                  можно положиться на оттенок.
                */}
                {o.riskFlag && o.chosen ? (
                  <span className="ml-2 text-[13px] font-normal text-danger">{ut("cases.criticalOption")}</span>
                ) : null}
              </Readout>
              <Readout look={o.chosen ? "fill" : "outline"} className={cx("justify-center", o.chosen && "font-bold")}>
                <span className="sr-only">{ut("cq.score")}: </span>
                <span className="text-primary tabular-nums">{o.score === null ? "—" : o.score}</span>
              </Readout>
            </li>
          ))}
        </ul>
      ) : (
        /*
          Пункт без вариантов (текст, число, дата, порядок) — одна залитая
          строка: на кадре таких пунктов нет, и залитое «поле с данными» —
          ближайшее из того, что на нём нарисовано.
        */
        <Readout look="fill">
          <span className="text-primary">{q.answered && q.free !== null ? q.free : ut("cases.skipped")}</span>
        </Readout>
      )}
      {q.options.length > 0 && !q.answered ? (
        <p className="m-0 mt-[8px] text-[13px] leading-[19px] text-muted">{ut("cases.skipped")}</p>
      ) : null}
    </li>
  );
}

/**
 * Лестница диапазонов одной шкалы: «від N до M — текст», попавшая ступень залита.
 *
 * Кадр рисует одну лестницу без подписи над ней: у методики макета одна
 * сумма, и залитая ступень — весь результат. Строка «шкала · значение ·
 * единицы» печатается только там, где без неё нельзя: у методик с
 * несколькими шкалами (titled) — иначе три одинаковых «від 1 до 10» не
 * отличить друг от друга; и у разошедшейся версии, где лестницы нет и
 * подпись полосы от сервера — единственное, что известно о результате.
 * Печатать её всегда было бы проще, но на единственной лестнице она
 * дублирует залитую ступень и уводит от кадра.
 */
function Ladder({ l, titled }: { l: ScaleLadder; titled: boolean }) {
  const { ut } = useLang();
  const orphanBand = !l.rows.length && l.bandLabel;
  return (
    <div>
      {titled || orphanBand ? (
        <p className="m-0 mb-[10px] text-[13px] leading-[19px] text-muted">
          {l.title} · <span className="tabular-nums">{l.value}</span> {ut(`norm.${l.normalization}`)}
          {/* при живой лестнице полоса и так залита — подпись только вместо лестницы */}
          {orphanBand ? ` — ${l.bandLabel}` : ""}
        </p>
      ) : null}
      {l.rows.length ? (
        <ol className="m-0 flex list-none flex-col gap-[15px] p-0">
          {l.rows.map((r) => (
            <li key={r.id} className="flex items-stretch gap-[10px]">
              {/* «від» и «до» на кадре строчные; словарь держит их прописными для конструктора */}
              <span className="flex w-[22px] shrink-0 items-center text-[16px] lowercase text-muted">
                {ut("cs.from")}
              </span>
              <Readout look={r.hit ? "fill" : "outline"} className={cx("w-[87px] shrink-0 justify-center", r.hit && "font-bold")}>
                <span className="text-primary tabular-nums">{r.min}</span>
              </Readout>
              <span className="flex w-[22px] shrink-0 items-center text-[16px] lowercase text-muted">{ut("cs.to")}</span>
              <Readout look={r.hit ? "fill" : "outline"} className={cx("w-[87px] shrink-0 justify-center", r.hit && "font-bold")}>
                <span className="text-primary tabular-nums">{r.max}</span>
              </Readout>
              <Readout look={r.hit ? "fill" : "outline"} className={cx("ml-[10px] min-w-0 flex-1", r.hit && "font-bold")}>
                <span className="text-primary">
                  {r.label}
                  {r.description ? <span className="font-normal"> — {r.description}</span> : null}
                </span>
                {r.hit ? <span className="sr-only"> — {ut("rsp.hitBand")}</span> : null}
              </Readout>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
