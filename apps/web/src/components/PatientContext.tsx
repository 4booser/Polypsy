import type { Severity } from "@quizzy/shared";
import { api } from "../api";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Avatar, Loading } from "../ui";
import { ButtonLink, Num, SeverityTag } from "../ui/primitives";
import { day, severityKey } from "../format";

/**
 * Кто этот человек — не уходя со списка («хто це» набора).
 *
 * Раньше ответ на вопрос «а это кто?» стоил перехода в карту и возврата
 * назад: терялось место в списке из восьми тысяч строк и набранные фильтры.
 * При разборе очереди этот вопрос возникает на каждой второй строке.
 *
 * Панель намеренно короткая. Это не карта пациента, а ответ на один вопрос:
 * стоит ли открывать карту. Всё, что не помогает решить, сюда не попадает —
 * иначе панель превратится во вторую карту, и её начнут листать вместо
 * работы со списком.
 */
/** Порядок степеней: сравнивать словами нельзя, а числом — можно. */
const RANK: Record<Severity, number> = { none: 0, mild: 1, moderate: 2, severe: 3 };

/**
 * Минимум, который нужен панели.
 *
 * Не `Respondent`: панель открывается и из очереди работы, где строка — это
 * задача, а не человек, и полной карточки респондента там нет. Требовать её
 * значило бы делать лишний запрос ради двух полей, которые уже приехали.
 */
export interface ContextPerson {
  userId: string;
  fullName: string;
  unit?: string | null;
  /** Замеров и дата последнего — если список их знает; иначе прочерк. */
  count?: number | null;
  last?: string | null;
}

export function PatientContext({ person }: { person: ContextPerson }) {
  const { ut } = useLang();
  /* keep: false — баллы прежнего человека не встают под имя следующего (#177) */
  const { data, error } = useResource(() => api.dynamics(person.userId), [person.userId], { keep: false });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Avatar name={person.fullName} size={44} />
        <div className="min-w-0">
          <div className="truncate text-h3 font-extrabold text-text">{person.fullName}</div>
          <div className="truncate text-small text-muted">{person.unit ?? "—"}</div>
        </div>
      </div>

      <dl className="m-0 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-caption font-bold text-muted">{ut("patients.measurements")}</dt>
          <dd className="m-0 text-big font-extrabold text-text">
            <Num>{person.count ?? "—"}</Num>
          </dd>
        </div>
        <div>
          <dt className="text-caption font-bold text-muted">{ut("patients.last")}</dt>
          <dd className="m-0 text-section font-extrabold text-text">{person.last ? day(person.last) : "—"}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-caption font-bold text-muted">{ut("pt.byMethod")}</h3>
        {error ? (
          <Loading rows={1} error={error} bare />
        ) : !data ? (
          <Loading rows={3} bare />
        ) : data.surveys.length === 0 ? (
          <p className="m-0 text-small text-muted">{ut("pt.noCompleted")}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {data.surveys.map((sv) => {
              /*
               * По методике показывается худшая степень среди её шкал на
               * последнем замере, а не первая попавшаяся: панель отвечает на
               * вопрос «стоит ли открывать карту», и ответ на него даёт
               * худшее, а не среднее.
               */
              const worst = sv.scales.reduce<{ severity: Severity | null; label: string | null }>(
                (acc, scale) => {
                  const last = scale.points[scale.points.length - 1];
                  if (!last?.severity) return acc;
                  return RANK[last.severity] > RANK[acc.severity ?? "none"]
                    ? { severity: last.severity, label: last.bandLabel }
                    : acc;
                },
                { severity: null, label: null },
              );
              return (
                <li
                  key={sv.surveyId}
                  className="flex items-center justify-between gap-2 border-t border-divider py-2 first:border-t-0 first:pt-0"
                >
                  <span className="min-w-0 truncate text-body text-text">{sv.title}</span>
                  {worst.severity ? (
                    /*
                     * Подпись полосы задаёт методика; когда автор её не
                     * заполнил — ступень словарём, теми же словами, что на
                     * сводке и в карте. Тяжесть — всегда со словом.
                     */
                    <SeverityTag level={worst.severity} small>
                      {worst.label ?? ut(severityKey[worst.severity], worst.severity)}
                    </SeverityTag>
                  ) : (
                    <Num className="shrink-0 text-small text-muted">{sv.responseCount}</Num>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ButtonLink variant="primary" className="w-full" to={`/patients/${person.userId}`}>
        {ut("pt.openCard")}
      </ButtonLink>
    </div>
  );
}
