import { test } from "@playwright/test";
import { login } from "/Users/abooser/Documents/repos/Quizzy/e2e/helpers";
import { writeFileSync } from "node:fs";

const OUT = "/private/tmp/claude-501/-Users-abooser/8920a3fd-63a6-45a7-ae19-e613a37aec81/scratchpad";

/* слова, которые бывают только по-русски: ы, ъ, э, ё и характерные окончания */
const RU_ONLY = /[ыъэё]/i;

const SCREENS = [
  "/", "/today", "/my-schedule", "/worklist", "/alerts", "/patients", "/referrals",
  "/messages", "/department-report", "/unit-report", "/surveys", "/batteries",
  "/schedules", "/invites", "/kiosk-sessions", "/compare", "/surveillance",
  "/cohorts", "/search", "/pathways", "/conclusion-batch", "/constructor",
  "/groups", "/permissions", "/users", "/consent-text", "/audit",
];

test("аудит: украинская локаль", async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("button", { name: "УКР" }).click();
  await page.waitForTimeout(400);

  const found: Record<string, string[]> = {};
  for (const path of SCREENS) {
    await page.goto(path);
    try {
      await page.locator("h1").first().waitFor({ timeout: 8000 });
      await page.waitForTimeout(700);
    } catch { /* экран не открылся — заметим отдельно */ }

    const text = await page.locator("body").innerText().catch(() => "");
    const words = [...new Set(text.split(/[\s,.:;()«»…—\-/|]+/).filter((w) => RU_ONLY.test(w) && w.length > 2))];
    if (words.length) found[path] = words;
  }
  writeFileSync(`${OUT}/audit-lang.json`, JSON.stringify(found, null, 2));
});
