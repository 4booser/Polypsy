import { Hono } from "hono";
import { z } from "zod";
import type { OpsReleaseCompare, OpsReleases, OpsStatementPlan, OpsStatements, OpsTrace } from "@quizzy/shared";
import { audit } from "../lib/audit";
import { badRequestDetail, parseQuery } from "../lib/http";
import { compareReleases, listReleases } from "../lib/opsReleases";
import { collectStatements, explainStatement } from "../lib/opsStatements";
import { collectTrace } from "../lib/opsTrace";
import type { AppEnv } from "../middleware/auth";

/**
 * Техпанель, вторая половина наблюдаемости (волна 10, участок obs2a):
 * трасса одного запроса, сравнение выкаток, медленные SQL. История логов и
 * ошибок — в тех же /logs и /errors (routes/ops.ts), параметром `window`.
 *
 * Своим файлом, но под тем же замком: подключается в routes/ops.ts
 * строкой `opsRoutes.route("/", opsObsRoutes)` ПОСЛЕ его
 * `use("*", requireAuth, requireStaff, requirePermission("ops.read"))`, и
 * этот рубеж действует на каждый маршрут ниже. Своего use("*") здесь нет
 * намеренно: requireAuth дважды открыл бы вторую транзакцию запроса.
 * Подключать этот модуль куда-то ещё без замка нельзя.
 */
export const opsObsRoutes = new Hono<AppEnv>();

/* ─────────── трасса ─────────── */

/*
 * Номер запроса — то, что прислал клиент в x-request-id или сгенерировал
 * сервер: буквы, цифры и «._:-» (middleware/requestId.ts), не длиннее 64.
 */
const requestIdParam = z.string().min(4).max(64).regex(/^[A-Za-z0-9._:-]+$/);

opsObsRoutes.get("/trace/:requestId", async (c) => {
  const parsed = requestIdParam.safeParse(c.req.param("requestId"));
  if (!parsed.success) badRequestDetail("requestId: 4–64 знака из букв, цифр и «._:-»");
  const body: OpsTrace = await collectTrace(parsed.data);
  /*
   * Чтение трассы — в журнал, каждое, без склейки: это не опрос ленты, а
   * вопрос о конкретном обращении, и «кто разбирал запрос такого-то» —
   * законный вопрос к журналу. Номер разбираемого запроса — в `traced`, а
   * не в requestId: requestId в details — номер ЭТОГО запроса (audit.ts
   * кладёт его сам), и трасса трассы не должна выдавать себя за трассу.
   */
  await audit(c, {
    action: "ops.trace.read",
    details: {
      traced: body.requestId,
      found: body.lines.length > 0,
      lines: body.lines.length,
      audit: body.audit?.length ?? null,
    },
  });
  return c.json(body);
});

/* ─────────── выкатки ─────────── */

opsObsRoutes.get("/releases", async (c) => {
  const { failed: _failed, ...body } = await listReleases();
  return c.json(body satisfies OpsReleases);
});

const blank = (v: unknown) => (v === "" ? undefined : v);
const versionParam = z.preprocess(blank, z.string().max(120).optional());
const compareQuery = z.object({ before: versionParam, after: versionParam });

opsObsRoutes.get("/releases/compare", async (c) => {
  const q = parseQuery(c, compareQuery);
  const { failed: _failed, ...body } = await compareReleases(q);
  return c.json(body satisfies OpsReleaseCompare);
});

/* ─────────── медленные SQL ─────────── */

const statementsQuery = z.object({ sort: z.preprocess(blank, z.enum(["total", "calls", "mean"]).default("total")) });

opsObsRoutes.get("/statements", async (c) => {
  const { sort } = parseQuery(c, statementsQuery);
  const body: OpsStatements = await collectStatements(sort);
  return c.json(body);
});

opsObsRoutes.get("/statements/:id/plan", async (c) => {
  const body: OpsStatementPlan = await explainStatement(c.req.param("id"));
  /*
   * EXPLAIN — не чтение данных о людях, но это действие над базой по
   * кнопке, и в журнале оно должно быть видно: какой запрос и чем кончилось.
   */
  await audit(c, { action: "ops.statements.explain", details: { queryid: c.req.param("id").slice(0, 24), state: body.state } });
  return c.json(body);
});
