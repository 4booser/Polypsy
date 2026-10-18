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
  dynamics: RespondentDynamics | null;
  dynamicsLoading: boolean;
  /** Динамику спрашивать есть смысл и право */
  wantsDynamics: boolean;
}

export function useResponseExtras(
  detail: ResponseDetail | null,
  opts: { prev?: boolean; dynamics?: boolean; conclusion?: boolean } = {},
): ResponseExtras {
  const { can } = useAuth();
  const id = detail?.id ?? null;
  const ctx = useResource(() => api.responseContext(id!), [id], { enabled: !!id, keep: false });
  const version = useResource(
    () =>
      api.survey(detail!.survey.id, detail!.survey.versionNumber).then(
        (survey): { survey: SurveyFull | null } => ({ survey }),
        () => ({ survey: null }),
      ),
    [detail?.survey.id, detail?.survey.versionNumber],
    { enabled: !!detail, keep: false },
  );
  const conclusion = useResource(
    () => (detail!.status === "completed" ? api.conclusion(id!) : Promise.resolve({ current: null, versions: [] })),
    [id, detail?.status],
    { enabled: !!id && opts.conclusion !== false, keep: false },
  );
  const prevId = opts.prev && ctx.data && id ? (previousComparable(ctx.data.attempts, id)?.id ?? null) : null;
  const prev = useResource(
    () => api.responseDetail(prevId!).then((d): { d: ResponseDetail | null } => ({ d }), () => ({ d: null })),
    [prevId],
    { enabled: !!prevId, keep: false },
  );
  const wantsDynamics = !!opts.dynamics && !!detail?.userId && detail.scores.length > 0 && can("patients.read");
  const dyn = useResource(
    () =>
      api.dynamics(detail!.userId!, detail!.survey.id).then(
        (d): { d: RespondentDynamics | null } => ({ d }),
        () => ({ d: null }),
      ),
    [detail?.userId, detail?.survey.id],
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
