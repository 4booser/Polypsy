import { useState } from "react";
import type { ImpersonationInfo, User } from "@quizzy/shared";
import { api, impersonationStore } from "../../../api";
import { timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { Button } from "../../../ui/primitives";

/**
 * Янтарная полоса во всю ширину: «Ви переглядаєте як … · Вийти».
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
    <div
      role="status"
      className="w-full shrink-0 border-b border-accent bg-accent-soft print:hidden"
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center gap-x-[14px] gap-y-[6px] px-[16px] py-[8px] text-[15px] leading-[20px] text-text">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {ut("ops.imp.banner")} <strong className="font-bold">{user.fullName || user.email}</strong>
          <span className="text-text-2"> ({user.email})</span>
        </span>
        <span className="text-[13px] text-text-2">
          {ut("ops.imp.readOnly")} · {ut("ops.imp.until")} <span className="font-mono tabular-nums">{timeOfDay(info.expiresAt)}</span>
          {" · "}
          {info.actorEmail}
        </span>
        <span className="ml-auto">
          <Button variant="ghost" onClick={exit} disabled={busy}>
            {ut("ops.imp.exit")}
          </Button>
        </span>
      </div>
    </div>
  );
}
