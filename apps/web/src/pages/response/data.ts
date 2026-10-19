import type { RespondentDynamics, ResponseContext, ResponseDetail, SurveyFull } from "@quizzy/shared";
import { api, type ConclusionState } from "../../api";
import { useAuth } from "../../auth";
import { useResource, type Resource } from "../../useResource";
import { previousComparable } from "./context";

/**
 * Всё, что экраны прохождения догружают вокруг протокола — каждое своим
 * запросом, чтобы протокол рисовался сразу, а отказ одного куска не гасил
 * экран:
 *
 *  - обстановка (человек, сигналы, попытки, правила) — /api/response-context;
 *  - методика ТОЙ версии, которую проходили: ключ шкал, инструкция, порог
 *    «слишком быстро»; не пришла — null, а не отказ экрана;
 *  - заключение этого прохождения — для пилюли черновика и панели;
 *  - прежняя попытка той же версии — сравнение по пунктам;
 *  - динамика человека по методике — сдвиг от старта и порог надёжной
 *    зміни, только тому, кто читает данные пациентов.
 *
 * keep: false у всего (#200, #177): данные прежнего прохождения под адресом
 * нового — чужие данные, а не устаревающие.
 */
export interface ResponseExtras {
  ctx: Resource<ResponseContext>;
  survey: SurveyFull | null;
  /** Методика той версии ещё грузится */
  surveyLoading: boolean;
  conclusion: Resource<ConclusionState>;
  prev: ResponseDetail | null;
  /** Динамика человека — по методике прохождения или по всем (opts.dynamics) */
  dynamics: RespondentDynamics | null;
  dynamicsLoading: boolean;
  /** Динамику спрашивать есть смысл и право */
  wantsDynamics: boolean;
}

export function useResponseExtras(
  /** Прохождение из адреса — обстановка и заключение спрашиваются по нему, не дожидаясь протокола */
  rid: string | null,
  detail: ResponseDetail | null,
  opts: {
    prev?: boolean;
    /**
     * Динамика человека: true — по методике прохождения (?survey=), "all" —
     * по всем его методикам одним чтением. Блок методики в общей динамике —
     * тот же, что в узкой (routes/dynamics.ts считает методики порознь), и
     * экран, которому нужны все методики (заключение: «Результати»), читает
     * динамику один раз, а не узкую рядом с общей.
     */
    dynamics?: boolean | "all";
    conclusion?: boolean;
  } = {},
): ResponseExtras {
  const { can } = useAuth();
  /*
   * Обстановка и заключение — вместе с протоколом, а не после него (волна
   * 27): им нужен только идентификатор прохождения из адреса. Прежде они
   * ждали протокол, прежняя попытка — обстановку, и экран открывался в три
   * захода. Право — то же, что у протокола (patients.read): без него ни
   * протокол, ни они не откроются, и лишний отказ в журнал доступа не
   * пишется. Право по профилю устарело — спросится, как только протокол
   * докажет обратное.
   */
  const early = !!rid && (can("patients.read") || !!detail);
  const ctx = useResource(() => api.responseContext(rid!), [rid], { enabled: early, keep: false });
  const version = useResource(
    () =>
      api.survey(detail!.survey.id, detail!.survey.versionNumber).then(
        (survey): { survey: SurveyFull | null } => ({ survey }),
        () => ({ survey: null }),
      ),
    [detail?.survey.id, detail?.survey.versionNumber],
    { enabled: !!detail, keep: false },
  );
  /*
   * По незавершённому заключения не бывает (сервер пишет его только по
   * сданному) — если протокол уже пришёл и он не сдан, спрашивать незачем;
   * если ещё не пришёл, ответ сервера по такому прохождению — та же пустая
   * история.
   */
  const unsubmitted = !!detail && detail.status !== "completed";
  const conclusion = useResource(
    () => (unsubmitted ? Promise.resolve({ current: null, versions: [] }) : api.conclusion(rid!)),
    [rid, unsubmitted],
    { enabled: early && opts.conclusion !== false, keep: false },
  );
  /* прежняя попытка — как только пришла обстановка с попытками, протокол ей не нужен */
  const prevId = opts.prev && ctx.data && rid ? (previousComparable(ctx.data.attempts, rid)?.id ?? null) : null;
  const prev = useResource(
    () => api.responseDetail(prevId!).then((d): { d: ResponseDetail | null } => ({ d }), () => ({ d: null })),
    [prevId],
    { enabled: !!prevId, keep: false },
  );
  const wantsDynamics = !!opts.dynamics && !!detail?.userId && detail.scores.length > 0 && can("patients.read");
  const scope = opts.dynamics === "all" ? null : (detail?.survey.id ?? null);
  const dyn = useResource(
    () =>
      api.dynamics(detail!.userId!, scope ?? undefined).then(
        (d): { d: RespondentDynamics | null } => ({ d }),
        () => ({ d: null }),
      ),
    [detail?.userId, scope],
    { enabled: wantsDynamics, keep: false },
  );
  return {
    ctx,
    survey: version.data?.survey ?? null,
    surveyLoading: !!detail && !version.data,
    conclusion,
    prev: prevId && prev.data?.d?.id === prevId ? prev.data.d : null,
    dynamics: dyn.data?.d ?? null,
    dynamicsLoading: wantsDynamics && !dyn.data,
    wantsDynamics,
  };
}
