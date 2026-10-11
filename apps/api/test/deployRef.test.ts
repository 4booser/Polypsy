import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Выкатка проверяет тестами ровно тот коммит, который собирает (#161).
 *
 * Было: deploy.yml звал ci.yml без ref, и вызванный процесс выгружал ref
 * самого прогона. При ручном запуске (и откате из техпанели — он тоже
 * workflow_dispatch с ref: main) это main, а сборка брала введённый тег:
 * на сервер уезжал не тот код, что прошёл тесты, а откат на исправный тег
 * вставал, пока main красный.
 *
 * Проверка — по самим файлам воркфлоу: разбор YAML и прогон извлечённых
 * шагов на временном хранилище, где тег и main — разные коммиты. Выгрузку
 * (actions/checkout) изображает `git checkout` того, во что вычисляется её
 * `ref`.
 */

const ROOT = resolve(import.meta.dir, "../../..");

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  uses?: string;
  with?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}
type Workflow = { on?: Record<string, unknown>; true?: Record<string, unknown>; jobs: Record<string, Job> };

const load = (name: string) => Bun.YAML.parse(readFileSync(`${ROOT}/.github/workflows/${name}`, "utf8")) as Workflow;
const deploy = load("deploy.yml");
const ci = load("ci.yml");
const needsOf = (job: Job | undefined) => [job?.needs ?? []].flat();
const checkoutOf = (job: Job | undefined) => job?.steps?.find((s) => s.uses?.startsWith("actions/checkout"));

/**
 * Подстановка ${{ … }} в объёме, который здесь нужен: путь через точки и
 * `a || b` (пустое и отсутствующее — ложь, как у GitHub).
 */
function evaluate(expr: string, ctx: Record<string, unknown>): string {
  const m = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(expr.trim());
  if (!m) return expr;
  for (const part of m[1]!.split("||").map((p) => p.trim())) {
    let v: unknown = ctx;
    for (const key of part.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return "";
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** Шаг run — так, как его запускает раннер: bash -eo pipefail, выходы в GITHUB_OUTPUT */
function runStep(step: Step, cwd: string, env: Record<string, string>): { ok: boolean; outputs: Record<string, string>; err: string } {
  const out = join(cwd, ".github-output");
  writeFileSync(out, "");
  const script = join(cwd, ".step.sh");
  writeFileSync(script, step.run ?? "");
  const p = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GITHUB_OUTPUT: out, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { ok: p.exitCode === 0, outputs, err: p.stderr.toString() };
}

describe("выкатка: тесты и сборка — один коммит", () => {
  test("ci.yml принимает ref и выгружает его в каждой задаче", () => {
    const on = (ci.on ?? ci.true ?? {}) as { workflow_call?: { inputs?: Record<string, { type?: string; required?: boolean }> } };
    const input = on.workflow_call?.inputs?.ref;
    expect(input, "у workflow_call нет входа ref").toBeDefined();
    expect(input?.type).toBe("string");
    // пуш и PR зовут ci.yml без входа — он не обязателен
    expect(input?.required ?? false).toBe(false);
    for (const [name, job] of Object.entries(ci.jobs)) {
      const checkout = checkoutOf(job);
      expect(checkout, `${name}: нет выгрузки`).toBeDefined();
      expect(checkout?.with?.ref, `${name}: выгрузка не берёт inputs.ref`).toBe("${{ inputs.ref }}");
    }
  });

  test("проверки и сборка ждут одного SHA из задачи target", () => {
    const target = deploy.jobs.target;
    expect(target, "нет задачи target").toBeDefined();
    expect(target?.outputs?.sha).toBe("${{ steps.sha.outputs.sha }}");
    const check = deploy.jobs.check!;
    expect(check.uses).toBe("./.github/workflows/ci.yml");
    expect(needsOf(check)).toContain("target");
    expect(check.with?.ref).toBe("${{ needs.target.outputs.sha }}");
    const build = deploy.jobs.build!;
    expect(needsOf(build)).toEqual(expect.arrayContaining(["target", "check"]));
    expect(checkoutOf(build)?.with?.ref).toBe("${{ needs.target.outputs.sha }}");
    expect(build.steps?.find((s) => s.id === "meta")?.env?.CHECKED_SHA).toBe("${{ needs.target.outputs.sha }}");
    // выкатка идёт после сборки — то есть после проверок
    expect(needsOf(deploy.jobs.deploy)).toContain("build");
  });

  describe("прогон шагов: ручная выкатка тега при ушедшем вперёд main", () => {
    let repo = "";
    let tagSha = "";
    let mainSha = "";

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "deploy-ref-"));
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "f"), "1");
      git(repo, "add", "f");
      git(repo, "commit", "-q", "-m", "выпуск");
      git(repo, "tag", "v1.0.0");
      tagSha = git(repo, "rev-parse", "HEAD");
      writeFileSync(join(repo, "f"), "2");
      git(repo, "commit", "-q", "-am", "красный main");
      mainSha = git(repo, "rev-parse", "HEAD");
    });

    afterAll(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    /** actions/checkout: выгрузить то, во что вычисляется ref; пусто — ref прогона */
    function checkout(step: Step | undefined, ctx: Record<string, unknown>, runRef: string): string {
      const ref = evaluate(step?.with?.ref ?? "", ctx) || runRef;
      git(repo, "checkout", "-q", "--detach", ref);
      return git(repo, "rev-parse", "HEAD");
    }

    test("тесты идут на коммите тега, сборка — на нём же, версия — тег", () => {
      // workflow_dispatch с ref: main и входом ref: v1.0.0 — так зовёт откат из техпанели
      const github = { event: { inputs: { ref: "v1.0.0" } }, ref: "refs/heads/main" };
      const target = deploy.jobs.target!;
      checkout(checkoutOf(target), { github }, "main");
      const resolved = runStep(target.steps!.find((s) => s.id === "sha")!, repo, {});
      expect(resolved.ok, resolved.err).toBe(true);
      const sha = resolved.outputs.sha!;
      expect(sha).toBe(tagSha);

      const needs = { target: { outputs: { sha } } };
      // вызванный ci.yml получает inputs.ref из with задачи check
      const inputs = { ref: evaluate(deploy.jobs.check!.with!.ref!, { github, needs }) };
      for (const [name, job] of Object.entries(ci.jobs)) {
        expect(checkout(checkoutOf(job), { github, inputs }, "main"), `ci.yml ${name}`).toBe(tagSha);
      }

      const build = deploy.jobs.build!;
      expect(checkout(checkoutOf(build), { github, needs }, "main")).toBe(tagSha);
      const meta = build.steps!.find((s) => s.id === "meta")!;
      const res = runStep(meta, repo, {
        INPUT_REF: evaluate(meta.env!.INPUT_REF!, { github }),
        CHECKED_SHA: evaluate(meta.env!.CHECKED_SHA!, { github, needs }),
        GITHUB_REF_NAME: "main",
      });
      expect(res.ok, res.err).toBe(true);
      expect(res.outputs.version).toBe("v1.0.0");
      expect(res.outputs.sha).toBe(tagSha);
      expect(res.outputs.sha).not.toBe(mainSha);
    });

    test("сборка останавливается, если выгружено не то, что проверено", () => {
      // контроль: сверка в шаге meta действительно сравнивает
      const meta = deploy.jobs.build!.steps!.find((s) => s.id === "meta")!;
      git(repo, "checkout", "-q", "--detach", "main");
      const res = runStep(meta, repo, { INPUT_REF: "v1.0.0", CHECKED_SHA: tagSha, GITHUB_REF_NAME: "main" });
      expect(res.ok).toBe(false);
      expect(res.outputs.sha).toBeUndefined();
      expect(runStep(meta, repo, { INPUT_REF: "v1.0.0", CHECKED_SHA: "", GITHUB_REF_NAME: "main" }).ok).toBe(false);
    });

    test("пуш тега: ref прогона — сам тег, ci.yml без входа выгружает его же", () => {
      const github = { event: {}, ref: "refs/tags/v1.0.0" };
      const target = deploy.jobs.target!;
      checkout(checkoutOf(target), { github }, "refs/tags/v1.0.0");
      expect(runStep(target.steps!.find((s) => s.id === "sha")!, repo, {}).outputs.sha).toBe(tagSha);
      // обычный пуш в ветку: входа нет, выгружается ref события — как было до #161
      expect(checkout(checkoutOf(ci.jobs.test), { github: { ref: "main" }, inputs: {} }, "main")).toBe(mainSha);
    });
  });
});
