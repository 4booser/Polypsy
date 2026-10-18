import { useState } from "react";
import type { ImpersonationInfo, User } from "@quizzy/shared";
import { api, impersonationStore } from "../../../api";
import { timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { Strip, stripAction } from "../../../shell/Strip";

/**
 * Янтарная полоса во всю ширину: «Ви переглядаєте як …» и «Вийти» справа
 * (выноска набора, shell/Strip.tsx).
 *
 * Решение заказчика 2026-09-26: вход «от имени» — с баннером на всех экранах.
 * Янтарь здесь по прямому назначению — «требует внимания»: это единственное
 * состояние консоли, в котором человек видит не своё рабочее место, и
 * забыть об этом нельзя ни на одном экране, включая кабинет пациента.
 *
 * Полоса стоит над верхней полосой консоли (App.tsx), не прилипает и не
 * закрывает содержимое: прокручивается вместе со страницей только в
 * кабинете пациента, где своей верхней полосы нет. В печать не идёт.
 *
 * «Вийти» гасит сессию на сервере СВОИМ токеном (токен «от имени» пишет
 * только чтение) и возвращает к себе — на вкладку «Користувачі», откуда
 * вход и начинался. Хранилище вкладки чистится до запроса: даже если сеть
 * подведёт, вкладка вернётся к своей сессии, а сервер погасит чужую по сроку.
 */
export function ImpersonationBanner({ user, info }: { user: User; info: ImpersonationInfo }) {
  const { ut } = useLang();
  const [busy, setBusy] = useState(false);
  const exit = () => {
    setBusy(true);
    impersonationStore.clear();
    void api
      .endImpersonation(info.sessionId)
      .catch(() => {})
      .finally(() => window.location.assign("/ops/users"));
  };
  return (
    <Strip
      tone="warn"
      icon="eye"
      title={
        <>
          {ut("ops.imp.banner")} <span className="text-text">{user.fullName || user.email}</span>
        </>
      }
      action={
        <button type="button" onClick={exit} disabled={busy} className={stripAction}>
          {ut("ops.imp.exit")}
        </button>
      }
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">({user.email})</span>
      <span>
        {ut("ops.imp.readOnly")}, {ut("ops.imp.until")} <span className="font-bold text-text tabular-nums">{timeOfDay(info.expiresAt)}</span>
      </span>
      <span className="text-muted">{info.actorEmail}</span>
    </Strip>
  );
}
