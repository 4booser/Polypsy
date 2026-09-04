import { Hono } from "hono";
import { audit } from "../lib/audit";
import { badRequest } from "../lib/http";
import {
  calendarAuthorizeUrl,
  calendarConnection,
  disconnectCalendar,
  meetConfigured,
  storeCalendarGrant,
} from "../lib/meet";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Подключение календаря специалиста для дистанционного приёма.
 *
 * Отдельно от входа через Google, и это не удобство разработчика: вход
 * просит почту и имя, а здесь спрашивается право писать в личный календарь
 * живого человека. Просить его у всех и сразу ради возможности, нужной
 * немногим, было бы неверно — а объединив, отменить одно без другого стало
 * бы нельзя.
 */
export const meetRoutes = new Hono<AppEnv>();

meetRoutes.use("*", requireAuth, requireStaff, requirePermission("appointments.manage"));

/**
 * Состояние подключения одним запросом.
 *
 * Экран приёма спрашивает его, чтобы решить, предлагать ли поле для ссылки
 * руками. Показывать «встреча создастся сама» там, где она не создастся, —
 * худший из вариантов: специалист узнает об этом от пациента.
 */
meetRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const connection = meetConfigured() ? await calendarConnection(user.id) : null;
  return c.json({
    configured: meetConfigured(),
    connected: Boolean(connection),
    email: connection?.email ?? null,
  });
});

meetRoutes.post("/connect", async (c) => {
  if (!meetConfigured()) badRequest("err.googleNotConfigured");
  const user = c.get("user");
  /*
   * Состояние несёт идентификатор специалиста, подписанный тем же секретом,
   * что и токены доступа. Хранить соответствие в памяти процесса нельзя:
   * инстансов API может быть несколько, и возврат от Google придёт не в тот,
   * что выдал ссылку.
   */
  const { signState } = await import("../lib/meetState");
  const url = calendarAuthorizeUrl(signState(user.id));
  await audit(c, { action: "meet.connect_start", subjectUserId: user.id });
  return c.json({ url });
});

meetRoutes.post("/callback", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as { code?: string; state?: string };
  if (!body.code || !body.state) badRequest("err.googleBadCallback");

  const { verifyState } = await import("../lib/meetState");
  const owner = verifyState(body.state);
  /*
   * Возврат принимается только тем, кто его начал. Иначе чужой код,
   * подсунутый в форму, подключил бы календарь одного специалиста к учётной
   * записи другого — и события начали бы появляться не у того человека.
   */
  if (!owner || owner !== user.id) badRequest("err.googleBadCallback");

  const email = await storeCalendarGrant(user.id, body.code);
  await audit(c, {
    action: "meet.connected",
    subjectUserId: user.id,
    details: { googleEmail: email },
  });
  return c.json({ connected: true, email });
});

meetRoutes.post("/disconnect", async (c) => {
  const user = c.get("user");
  await disconnectCalendar(user.id);
  await audit(c, { action: "meet.disconnected", subjectUserId: user.id });
  return c.json({ connected: false });
});
