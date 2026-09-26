import { Hono } from "hono";
import { z } from "zod";
import { langOf, parseBody } from "../lib/http";
import { forgetDevice, registerDevice } from "../lib/push";
import { requireAuth, type AppEnv } from "../middleware/auth";

export const pushRoutes = new Hono<AppEnv>();
pushRoutes.use("*", requireAuth);

/**
 * Регистрация устройства.
 *
 * Доступна всем ролям: пациенту нужны напоминания о назначении, специалисту —
 * тревоги. Токен привязывается к учётной записи, а не к человеку: на общем
 * планшете после выхода токен переезжает к следующему вошедшему, и первый
 * перестаёт получать чужие уведомления.
 */
const registerSchema = z.object({
  token: z.string().min(10).max(300),
  platform: z.enum(["ios", "android", "web"]),
});

pushRoutes.post("/register", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, registerSchema);
  // язык приложения приходит тем же заголовком, что у любого запроса
  await registerDevice(user.id, input.token, input.platform, langOf(c));
  return c.json({ ok: true });
});

pushRoutes.post("/forget", async (c) => {
  const input = await parseBody(c.req.raw, z.object({ token: z.string().min(10).max(300) }));
  await forgetDevice(input.token);
  return c.json({ ok: true });
});
