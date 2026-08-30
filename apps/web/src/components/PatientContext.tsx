import { Link } from "react-router-dom";
import type { Severity } from "@quizzy/shared";
import { api } from "../api";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Avatar, Loading } from "../ui";
import { Num, SectionLabel, Tag } from "../ui/primitives";
import { severityColor } from "../format";

/**
 * Кто этот человек — не уходя со списка.
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
  const { data, error } = useResource(() => api.dynamics(person.userId), [person.userId]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <Avatar name={person.fullName} size={38} />
        <div className="min-w-0">
          <div className="truncate text-body font-medium">{person.fullName}</div>
          <div className="truncate text-caption text-muted">{person.unit ?? "—"}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <SectionLabel>{ut("patients.measurements")}</SectionLabel>
          <Num className="text-section">{person.count ?? "—"}</Num>
        </div>
        <div>
          <SectionLabel>{ut("patients.last")}</SectionLabel>
          <Num className="text-section">{person.last?.slice(0, 10) ?? "—"}</Num>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>{ut("pt.byMethod")}</SectionLabel>
        {error ? (
          <p className="m-0 text-caption text-danger">{error}</p>
        ) : !data ? (
          <Loading rows={3} />
        ) : data.surveys.length === 0 ? (
          <p className="m-0 text-caption text-muted">{ut("pt.noCompleted")}</p>
        ) : (
          data.surveys.map((sv) => {
            /*
             * По методике показывается худшая степень среди её шкал на
             * последнем замере, а не первая попавшаяся: панель отвечает на
             * вопрос «стоит ли открывать карту», и ответ на него даёт худшее,
             * а не среднее.
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
              <div
                key={sv.surveyId}
                className="flex items-center justify-between gap-2 border-b border-hairline pb-2 last:border-0 last:pb-0"
              >
                <span className="min-w-0 truncate text-small">{sv.title}</span>
                {worst.severity ? (
                  <Tag className="shrink-0" tone="plain">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: severityColor[worst.severity] }}
                    />
                    {worst.label ?? worst.severity}
                  </Tag>
                ) : (
                  <Num className="shrink-0 text-caption text-muted">{sv.responseCount}</Num>
                )}
              </div>
            );
          })
        )}
      </div>

      <Link className="btn primary justify-center" to={`/patients/${person.userId}`}>
        {ut("pt.openCard")}
      </Link>
    </div>
  );
}
