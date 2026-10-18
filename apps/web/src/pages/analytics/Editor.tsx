import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as KeyEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Scale, SurveyListItem, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { SeverityMeter } from "../../charts/clinical";
import { rungOf, type Rung } from "../../charts/ladder";
import { day } from "../../format";
import { useLang } from "../../lang";
import { useShellNav } from "../../shell/useShellNav";
import { Callout, KV, Loading, useAction, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { IconTile, Page, Panel, SideLayout } from "../../ui/layout";
import { MenuButton, MenuSeparator, menuItemClass } from "../../ui/menu";
import { Button, ButtonLink, Checkbox, ErrorText, Field, Input, Segmented, Select, Switch, Tag, Textarea } from "../../ui/primitives";
import { useResource, useResourceMap } from "../../useResource";
import { AIc } from "./icons";
import {
  ANY_TEST,
  OPS,
  OP_KEY,
  type DraftAction,
  type DraftChange,
  type DraftIssue,
  type DraftParam,
  type ModelDraft,
  type SavedModel,
  copyDraft,
  copyHref,
  draftChanges,
  draftFromRule,
  draftIssues,
  draftToPayload,
  dropPicked,
  emptyDraft,
  modelHref,
  newAction,
  newParam,
  ruleTests,
  sameDraft,
  surveysToLoad,
} from "./model";
import { ACT_ICON, ACT_KEY } from "./parts";
import { testsHref } from "./tests/model";

/*
 * Модель аналитики — правило поддержки решений (analytics-model,
 * analytics-model-new): одна форма на /analytics/:id и /analytics/new.
 *
 * Слева — то, что модель делает: имя и описание, условия (все через «і»,
 * у каждого — свой блок с полями своего вида) и действия. Справа — та же
 * модель словами («Як читається модель»: пропущенное — пунктиром), её
 * состояние и версия, а у новой — «Почати з копії».
 *
 * Чего правило на сервере не умеет, того и здесь нет (packages/shared/
 * src/rules.ts): «або» между условиями (evaluateRules требует every(met)),
 * условия по отдельному ответу и времени реакции. Об «або» форма говорит
 * строкой под условиями, «Об’єднати» в меню структуры стоит недоступным с
 * причиной.
 *
 * Сохранение — «Зберегти» (⌘S/Ctrl S): сначала своя проверка с отказами
 * под полями и сводкой со ссылками к ним, потом POST или PATCH; сервер
 * поднимает версию на каждой правке. Несохранённое помечено в шапке, его
 * можно отменить целиком, а закрытие вкладки с ним спрашивает браузер.
 */

/**
 * Обёртка с ключом: форма новой модели и форма правки — один компонент на
 * двух маршрутах, и без ключа переход с /analytics/:id на /analytics/new
 * оставил бы в полях чужую модель. Копия (?copy=) — тоже свой ключ.
 */
export default function AnalyticsModelPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const copy = id ? null : params.get("copy");
  return <ModelEditor key={`${id ?? "new"}:${copy ?? ""}`} id={id ?? null} copyFrom={copy} />;
}

/**
 * Методика, дочитанная целиком ради шкал и названия; null — сервер её не
 * отдал: она вне групп сотрудника или её уже нет.
 */
type LoadedSurvey = { title: string; archivedAt: string | null; scales: Scale[] } | null;

/** Сначала буква заглавная, потом строчная — значит, это слово, а не код («SI»): его можно начать со строчной */
function lowerFirst(s: string): string {
  return s.length > 1 && s[0] !== s[0]!.toLowerCase() && s[1] === s[1]!.toLowerCase() ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Место отказа на форме — id поля, к которому ведёт ссылка сводки */
function fieldId(d: ModelDraft, i: DraftIssue): string {
  if (i.param !== undefined) return `am-${d.params[i.param]?.key ?? "x"}-${i.field}`;
  if (i.action !== undefined) return `am-${d.actions[i.action]?.key ?? "x"}-${i.field}`;
  return `am-${i.field}`;
}

function ModelEditor({ id, copyFrom }: { id: string | null; copyFrom: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const nav = useShellNav();
  const canManage = nav ? nav.access.can("decisions.manage") : true;
  const isNew = id === null;

  const surveys = useResource(() => api.surveys(), []);
  /*
   * Правило читается из общего списка: маршрута «одно правило» на сервере
   * нет. Список короткий; он же — образцы для «Почати з копії». Сам не
   * перечитывается (manual) — правку в полях не затрёт.
   */
  const rules = useResource(() => api.decisionRules(), [], { manual: true });

  /* исходное состояние формы — с чем сравнивается «не збережено» и куда возвращает «Скасувати зміни» */
  const [base, setBase] = useState<ModelDraft | null>(isNew && !copyFrom ? emptyDraft() : null);
  const [draft, setDraft] = useState<ModelDraft | null>(base);
  const [missing, setMissing] = useState(false);
  const saved: SavedModel | null = id !== null ? (rules.data?.find((r) => r.id === id) ?? null) : null;

  useEffect(() => {
    if (!rules.data) return;
    if (id !== null) {
      const rule = rules.data.find((r) => r.id === id);
      if (!rule) {
        setMissing(true);
        return;
      }
      const d = draftFromRule(rule);
      setBase(d);
      setDraft(d);
      return;
    }
    if (copyFrom) {
      const rule = rules.data.find((r) => r.id === copyFrom);
      const d = rule ? copyDraft(rule, ut("am.copyOf").replace("{title}", rule.title)) : emptyDraft();
      setBase(emptyDraft());
      setDraft((cur) => cur ?? d);
    }
    /* язык подписи копии берётся один раз — при открытии формы, поэтому ut не в зависимостях */
  }, [id, copyFrom, rules.data]);

  /*
   * Методики целиком — по требованию и один раз: выбранные в условиях (ради
   * шкал) и стоящие в действиях, но отсутствующие в коротком списке (ради
   * названия). Отказ запоминается как null: чужую или удалённую методику
   * сервер не отдаст и со второго раза.
   */
  const wanted = draft && surveys.data ? surveysToLoad(draft, new Set(surveys.data.map((s) => s.id))) : [];
  const loaded: Record<string, LoadedSurvey> = useResourceMap("analytics.surveyMeta", wanted, (surveyId) =>
    api.survey(surveyId).then((s) => ({ title: s.title, archivedAt: s.archivedAt ?? null, scales: s.scales })),
  );

  /* отказы видны после первой попытки сохранить и дальше сходят по мере правки */
  const [tried, setTried] = useState(false);
  const issues = useMemo(() => (draft ? draftIssues(draft) : []), [draft]);
  const shownIssues = tried ? issues : [];
  const dirty = !!draft && !!base && !sameDraft(base, draft);

  const patch = (next: Partial<ModelDraft>) => setDraft((d) => (d ? { ...d, ...next } : d));
  const patchParam = (key: string, next: Partial<DraftParam>) =>
    setDraft((d) => (d ? { ...d, params: d.params.map((p) => (p.key === key ? { ...p, ...next } : p)) } : d));
  const patchAction = (key: string, next: Partial<DraftAction>) =>
    setDraft((d) => (d ? { ...d, actions: d.actions.map((a) => (a.key === key ? { ...a, ...next } : a)) } : d));

  const removePicked = () => {
    if (!draft) return;
    const next = dropPicked(draft);
    if (next === draft) {
      toast(ut("am.noneSelected"), "info");
      return;
    }
    setDraft(next);
  };

  const save = useCallback(() => {
    /* без права правок кнопки погашены — и ⌘S тоже ничего не шлёт: сервер ответил бы 403 */
    if (!draft || busy || !canManage) return;
    setTried(true);
    if (draftIssues(draft).length) return;
    void run(
      async () => {
        const payload = draftToPayload(draft);
        if (id === null) {
          const created = await api.createDecisionRule(payload);
          /* replace: «назад» из правки новой модели ведёт в перечень, а не в пустую форму */
          navigate(modelHref(created.id), { replace: true });
        } else {
          await api.updateDecisionRule(id, payload);
          setTried(false);
          rules.reload();
        }
      },
      ut(id === null ? "am.createdOk" : "am.saved"),
    );
  }, [draft, busy, canManage, id, run, navigate, rules, ut]);

  /* ⌘S / Ctrl S — сохранить, как в любом редакторе; браузерное «сохранить страницу» здесь бессмысленно */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === "KeyS") {
        e.preventDefault();
        save();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [save]);

  /*
   * Несохранённое при закрытии вкладки — спросит браузер своими словами. И у
   * новой модели (и у копии): её набирают с нуля, и закрытая вкладка унесла
   * бы всю форму, а не одну правку.
   */
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  if (missing) {
    return (
      <Page title={ut("am.notFound")} back={{ to: "/analytics", label: ut("am.title") }}>
        <Panel>
          <p className="m-0 text-body text-text-2">{ut("am.notFoundHint")}</p>
          <ButtonLink to="/analytics" className="mt-3">
            {ut("am.backToList")}
          </ButtonLink>
        </Panel>
      </Page>
    );
  }
  if (!draft || !surveys.data || (!isNew && !base)) {
    return (
      <Page title={isNew ? ut("am.newTitle") : ut("top.analytics")} back={{ to: "/analytics", label: ut("am.title") }}>
        <Loading
          rows={6}
          error={rules.error ?? surveys.error}
          onRetry={() => {
            if (rules.error) rules.reload();
            if (surveys.error) surveys.reload();
          }}
        />
      </Page>
    );
  }

  const surveyList = surveys.data;
  const titleOf = (sid: string) => surveyList.find((s) => s.id === sid)?.title ?? surveyLabel(ut, loaded, sid);
  const scalesOf = (sid: string) => (sid && sid !== ANY_TEST ? loaded[sid]?.scales : undefined);
  const issueAt = (field: DraftIssue["field"], at: { param?: number; action?: number } = {}) =>
    shownIssues.find((i) => i.field === field && i.param === at.param && i.action === at.action) ?? null;
  const fieldError = (field: DraftIssue["field"], at: { param?: number; action?: number } = {}) => {
    const hit = issueAt(field, at);
    return hit ? ut(hit.key) : null;
  };
  const picked = draft.params.filter((p) => p.picked).length + draft.actions.filter((a) => a.picked).length;
  const baseFor = (i: number) => (base && !isNew ? (base.params[i] ?? null) : null);

  const header = isNew
    ? {
        title: ut("am.newTitle"),
        meta: [ut("am.newMeta1"), ut("am.newMeta2")] as [ReactNode, ReactNode],
        actions: (
          <>
            <Button variant="quiet" onClick={() => navigate("/analytics")}>
              {ut("common.cancel")}
            </Button>
            <Button variant="primary" icon={<Ic.check />} disabled={busy || !canManage} onClick={save} title={ut("am.saveKbd")}>
              {ut("am.create")}
            </Button>
          </>
        ),
      }
    : {
        title: base?.title || ut("top.analytics"),
        meta: [
          ut("am.versionCap").replace("{n}", String(saved?.version ?? "")),
          saved?.updatedAt ? ut("am.changedOn").replace("{date}", day(saved.updatedAt)) : "",
        ] as [ReactNode, ReactNode],
        actions: (
          <>
            {dirty ? (
              <Tag tone="attention" icon={<AIc.circleDot size={12} />}>
                {ut("am.unsaved")}
              </Tag>
            ) : null}
            <MenuButton label={ut("am.structureMenu")} glyph={<AIc.settings size={16} />} triggerSize="icon" align="right" plateClassName="min-w-[240px]">
              {(close) => (
                <>
                  <MenuItem icon={<Ic.plus size={15} />} onClick={() => (close(), patch({ actions: [...draft.actions, newAction()] }))}>
                    {ut("am.addAction")}
                  </MenuItem>
                  <MenuItem icon={<AIc.listChecks size={15} />} onClick={() => (close(), patch({ params: [...draft.params, newParam()] }))}>
                    {ut("am.addParam")}
                  </MenuItem>
                  {/* блок условий у правила один — объединять нечего; пункт стоит с причиной, а не пропадает */}
                  <MenuItem icon={<AIc.gitCompare size={15} />} disabled hint={ut("am.mergeUnavailable")}>
                    {ut("am.merge")}
                  </MenuItem>
                  <MenuItem icon={<AIc.trash size={15} />} onClick={() => (close(), removePicked())}>
                    {ut("am.deleteSelected")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Ic.info size={15} />}
                    onClick={() => {
                      close();
                      const el = document.getElementById("am-about");
                      el?.scrollIntoView({ block: "center" });
                      el?.querySelector<HTMLElement>('[role="switch"]')?.focus();
                    }}
                  >
                    {ut("am.about")}
                  </MenuItem>
                </>
              )}
            </MenuButton>
            <Button variant="quiet" disabled={!dirty} onClick={() => base && (setDraft(base), setTried(false))}>
              {ut("am.discard")}
            </Button>
            <Button variant="primary" icon={<Ic.check />} disabled={busy || !canManage} onClick={save} title={ut("am.saveKbd")}>
              {ut("common.save")}
            </Button>
          </>
        ),
      };

  const jump = (target: string) => {
    const el = document.getElementById(target);
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  };

  return (
    <Page title={header.title} meta={header.meta} back={{ to: "/analytics", label: ut("am.title") }} actions={header.actions}>
      <SideLayout
        narrow
        side={
          <>
            <ReadModel draft={draft} isNew={isNew} titleOf={titleOf} scalesOf={scalesOf} />
            <AboutPanel draft={draft} saved={saved} dirty={dirty} changes={base && !isNew ? draftChanges(base, draft) : []} onChange={patch} />
            {isNew ? (
              <CopyPanel rules={rules.data ?? []} />
            ) : (
              <LinksPanel id={id!} draft={draft} titleOf={titleOf} />
            )}
          </>
        }
      >
        {shownIssues.length ? (
          <Callout kind="line" role="alert" icon={<Ic.circleAlert />} title={ut(isNew ? "am.notCreated" : "am.notSaved")}>
            <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
              {shownIssues.map((i, n) => {
                const where =
                  i.param !== undefined
                    ? `${ut("am.condN").replace("{n}", String(i.param + 1))}: `
                    : i.action !== undefined
                      ? `${ut("am.actN").replace("{n}", String(i.action + 1))}: `
                      : "";
                const text = ut(i.key);
                return (
                  <li key={n}>
                    <a
                      href={`#${fieldId(draft, i)}`}
                      onClick={(e) => {
                        e.preventDefault();
                        jump(i.field === "params" ? "am-add-kinds" : i.field === "actions" ? "am-add-action" : fieldId(draft, i));
                      }}
                      className="inline-flex items-start gap-1.5 text-small font-bold text-risk-ink underline decoration-risk-line underline-offset-[3px]"
                    >
                      <Ic.circleAlert size={14} className="mt-0.5" />
                      {where ? where + lowerFirst(text) : text}
                    </a>
                  </li>
                );
              })}
            </ul>
          </Callout>
        ) : null}

        <Panel title={ut("am.nameTitle")} icon={<Ic.type />}>
          <Field label={ut("am.modelName")} error={fieldError("title")}>
            <Input id="am-title" value={draft.title} onChange={(e) => patch({ title: e.target.value })} maxLength={200} />
          </Field>
          <Field
            label={ut("am.modelNote")}
            hint={isNew ? ut("am.noteHintNew") : ut("am.noteHint").replace("{n}", String(draft.note.length))}
          >
            <Textarea
              rows={2}
              value={draft.note}
              onChange={(e) => patch({ note: e.target.value })}
              maxLength={2000}
              placeholder={ut("am.notePlaceholder")}
            />
          </Field>
        </Panel>

        <Panel
          title={ut("am.condTitle")}
          icon={<AIc.listChecks />}
          sub={ut("am.condSub")}
          actions={
            isNew ? null : (
              <>
                <span className="text-caption text-muted">{ut("am.pickedN").replace("{n}", String(picked))}</span>
                <Button variant="quiet" size="xs" icon={<AIc.trash />} disabled={picked === 0} onClick={removePicked}>
                  {ut("am.removePicked")}
                </Button>
              </>
            )
          }
        >
          {draft.params.map((p, i) => (
            <Fragment key={p.key}>
              {i > 0 ? <Joiner /> : null}
              <CondBox
                p={p}
                n={i + 1}
                bad={shownIssues.some((x) => x.param === i)}
                onChange={(next) => patchParam(p.key, next)}
                onRemove={() => patch({ params: draft.params.filter((x) => x.key !== p.key) })}
              >
                {p.kind === "scale" ? (
                  <ScaleCond
                    p={p}
                    surveys={surveyList}
                    loaded={loaded}
                    was={baseFor(i)}
                    errors={{
                      test: fieldError("test", { param: i }),
                      scale: fieldError("scale", { param: i }),
                      threshold: fieldError("threshold", { param: i }),
                    }}
                    onChange={(next) => patchParam(p.key, next)}
                  />
                ) : p.kind === "history" ? (
                  <div className="grid grid-cols-1 items-end gap-x-4 @[420px]:grid-cols-[170px_minmax(0,1fr)]">
                    <Field label={ut("am.completedAtLeast")} error={fieldError("count", { param: i })}>
                      <Input
                        id={`am-${p.key}-count`}
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={p.completedAtLeast}
                        suffix={ut("am.times")}
                        onChange={(e) => patchParam(p.key, { completedAtLeast: e.target.value })}
                      />
                    </Field>
                    <p className="m-0 pb-2.5 text-small text-text-2">{ut("am.historyHint")}</p>
                  </div>
                ) : (
                  <Field label={ut("am.riskLevel")}>
                    <Segmented
                      wide
                      label={ut("am.riskLevel")}
                      value={p.severity}
                      onChange={(v) => patchParam(p.key, { severity: v })}
                      items={[
                        { key: "moderate", label: ut("am.riskModerate") },
                        { key: "severe", label: ut("am.riskSevere") },
                      ]}
                    />
                  </Field>
                )}
              </CondBox>
            </Fragment>
          ))}
          <AddKinds onAdd={(over) => patch({ params: [...draft.params, newParam(over)] })} />
          {fieldError("params") ? <ErrorText className="mt-2">{fieldError("params")}</ErrorText> : null}
          <p className="m-0 mt-2.5 flex items-center gap-1.5 text-small text-muted">
            <Ic.info size={13} />
            {ut("am.operatorOnlyAnd")}
          </p>
        </Panel>

        <Panel title={ut("am.actTitle")} icon={<AIc.zap />} sub={ut("am.actSub")}>
          <ul className="m-0 list-none p-0 @container">
            {draft.actions.map((a, i) => (
              <ActionRow
                key={a.key}
                a={a}
                n={i + 1}
                surveys={surveyList}
                loaded={loaded}
                error={fieldError("advise", { action: i }) ?? fieldError("suggest", { action: i }) ?? fieldError("pathway", { action: i })}
                onChange={(next) => patchAction(a.key, next)}
                onRemove={() => patch({ actions: draft.actions.filter((x) => x.key !== a.key) })}
              />
            ))}
          </ul>
          {fieldError("actions") ? <ErrorText className="mb-2">{fieldError("actions")}</ErrorText> : null}
          <Button id="am-add-action" size="xs" icon={<Ic.plus />} className="mt-2" onClick={() => patch({ actions: [...draft.actions, newAction()] })}>
            {ut("am.addAction")}
          </Button>
        </Panel>
      </SideLayout>
    </Page>
  );
}

/** Пункт меню структуры: кнопка с значком; недоступный — с причиной подсказкой */
function MenuItem({
  icon,
  children,
  onClick,
  disabled,
  hint,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      title={disabled ? hint : undefined}
      className={menuItemClass("right", disabled ? "disabled" : "normal")}
      onClick={disabled ? undefined : onClick}
    >
      <span className="inline-flex text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/* ─────────── условие ─────────── */

/**
 * Вид параметра одним значением — тем, каким его выбирают и человек, и код.
 *
 * «Будь-який тест» — не отдельный вид условия: сервер держит его как то же
 * условие по шкале с surveyId: null (см. ANY_TEST в model.ts). Но выбирают
 * его наравне с остальными видами, поэтому здесь четыре значения, а не три.
 */
export type ParamPick = "scale" | "any" | "risk" | "history";

export const PARAM_PICKS: readonly ParamPick[] = ["scale", "any", "risk", "history"];

export const PARAM_PICK_KEY: Record<ParamPick, UiKey> = {
  scale: "am.testResult",
  any: "am.anyTest",
  risk: "am.kindRisk",
  history: "am.kindHistory",
};

const PICK_ICON: Record<ParamPick, (size: number) => ReactNode> = {
  scale: (s) => <Ic.clipboard size={s} />,
  any: (s) => <AIc.shuffle size={s} />,
  risk: (s) => <AIc.flag size={s} />,
  history: (s) => <Ic.history size={s} />,
};

export function paramPick(p: DraftParam): ParamPick {
  if (p.kind === "risk") return "risk";
  if (p.kind === "history") return "history";
  return p.surveyId === ANY_TEST ? "any" : "scale";
}

/**
 * Смена вида уже заведённого параметра.
 *
 * Возвращает ровно то, что меняется, и НЕ трогает остального: строка,
 * переведённая на флаг риска и обратно, возвращается со своей шкалой,
 * условием и порогом. Сбрасывается только то, что после смены заведомо
 * бессмысленно: методика при переходе на «будь-який тест» и обратно (это
 * разные вопросы — «какой тест» и «любой»), а вместе с ней код шкалы,
 * потому что коды у методик свои.
 *
 * Решает записанная методика, а не вид, с которого меняют: флаг риска и
 * история хранят её нетронутой, и обход через них обязан вести туда же,
 * куда и прямой переход. Иначе «Будь-який тест» → «Прапор ризику» →
 * «Результат тесту» возвращал «Будь-який тест», а «Результат тесту» → «Прапор
 * ризику» → «Будь-який тест» уносил код шкалы прежней методики.
 */
export function paramKindOver(p: DraftParam, next: ParamPick): Partial<DraftParam> {
  if (paramPick(p) === next) return {};
  const named = p.surveyId !== "" && p.surveyId !== ANY_TEST;
  switch (next) {
    case "risk":
      return { kind: "risk" };
    case "history":
      return { kind: "history" };
    case "any":
      return { kind: "scale", surveyId: ANY_TEST, scaleCode: named ? "" : p.scaleCode };
    case "scale":
      return p.surveyId === ANY_TEST ? { kind: "scale", surveyId: "", scaleCode: "" } : { kind: "scale" };
  }
}

/**
 * Блок условия: квадрат значка вида, вид — меню (вид заведённого условия
 * меняется, не теряя шкалы, условия и порога), «умова N», отметка для
 * «Прибрати позначені» и корзина. Блок с отказом — в рамке риска.
 */
function CondBox({
  p,
  n,
  bad,
  onChange,
  onRemove,
  children,
}: {
  p: DraftParam;
  n: number;
  bad: boolean;
  onChange: (next: Partial<DraftParam>) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { ut } = useLang();
  const kind = paramPick(p);
  return (
    <section
      id={`cond-${n}`}
      aria-label={`${ut("am.condN").replace("{n}", String(n))}: ${ut(PARAM_PICK_KEY[kind])}`}
      className={cx("@container rounded-panel border bg-panel px-4 pb-4 pt-3", bad ? "border-risk-line" : "border-border")}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <IconTile icon={PICK_ICON[kind](16)} />
        <MenuButton
          label={ut("am.paramKind")}
          plateClassName="min-w-[240px]"
          trigger={(t) => (
            <button
              type="button"
              {...t}
              className="inline-flex h-8 min-h-0 cursor-pointer items-center gap-1.5 rounded-[9px] border-0 bg-transparent px-1.5 text-[14px] font-extrabold text-text hover:bg-sunk focus-visible:outline-2 focus-visible:outline-focus"
            >
              {ut(PARAM_PICK_KEY[kind])}
              <Ic.chevronDown size={13} className="text-muted" />
              <span className="sr-only">{ut("am.changeKind")}</span>
            </button>
          )}
        >
          {(close) =>
            PARAM_PICKS.map((k) => (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={k === kind}
                className={menuItemClass("left")}
                onClick={() => {
                  close();
                  onChange(paramKindOver(p, k));
                }}
              >
                <span className="inline-flex text-muted">{PICK_ICON[k](15)}</span>
                <span className="min-w-0 flex-1 truncate">{ut(PARAM_PICK_KEY[k])}</span>
                {k === kind ? <Ic.check size={15} className="text-violet-ink" /> : null}
              </button>
            ))
          }
        </MenuButton>
        <span className="text-caption text-muted">{ut("am.condN").replace("{n}", String(n)).toLowerCase()}</span>
        <span className="ml-auto flex items-center gap-1">
          <Checkbox checked={p.picked} aria-label={ut("am.pickParam")} onChange={(e) => onChange({ picked: e.target.checked })} />
          <Button variant="quiet" size="icon-sm" aria-label={ut("am.removeCond")} title={ut("am.removeCond")} onClick={onRemove}>
            <AIc.trash size={15} />
          </Button>
        </span>
      </div>
      {children}
    </section>
  );
}

/** «і водночас» между блоками: условия правила выполняются все разом */
function Joiner() {
  const { ut } = useLang();
  return (
    <div className="relative flex h-10 items-center gap-2.5 pl-5 text-small font-semibold text-muted before:absolute before:bottom-0 before:left-8 before:top-0 before:w-[1.5px] before:bg-border">
      <b aria-hidden className="relative grid size-[26px] place-items-center rounded-full bg-sunk text-caption font-extrabold text-text-2 shadow-[inset_0_0_0_1px_var(--border)]">
        {ut("am.and")}
      </b>
      {ut("am.andAlso")}
    </div>
  );
}

/** Строка «+ Результат тесту · Будь-який тест · …» — новое условие нужного вида одним нажатием */
function AddKinds({ onAdd }: { onAdd: (over: Partial<DraftParam>) => void }) {
  const { ut } = useLang();
  return (
    <div
      id="am-add-kinds"
      tabIndex={-1}
      role="group"
      aria-label={ut("am.addParam")}
      className="mt-3 flex flex-wrap items-center gap-0.5 rounded-[12px] border-[1.5px] border-dashed border-control px-2 py-1.5 outline-none"
    >
      <span aria-hidden className="mx-1 inline-flex text-muted">
        <Ic.plus size={14} />
      </span>
      {PARAM_PICKS.map((k) => (
        <Button key={k} variant="ghost" size="xs" icon={PICK_ICON[k](14)} onClick={() => onAdd(paramKindOver(newParam(), k))}>
          {ut(PARAM_PICK_KEY[k])}
        </Button>
      ))}
    </div>
  );
}

/**
 * Опции селекта методик: список api.surveys() и — если выбранной в нём нет —
 * она сама, отдельной опцией впереди.
 *
 * Список не отдаёт снятые с использования и методики вне групп сотрудника,
 * а в сохранённом правиле такой идентификатор — обычное дело: модель
 * пережила методику. Без своей опции контролируемый <select> не совпадает
 * ни с одной и рисуется пустым, а при сохранении идентификатор уходит на
 * сервер молча. Подпись — название с пометкой «знято з використання», когда
 * методику удалось дочитать, и «недоступний», когда сервер отказал.
 */
export function SurveyOptions({
  surveys,
  current,
  loaded,
}: {
  surveys: SurveyListItem[];
  /** Значение селекта: "", ANY_TEST или идентификатор методики */
  current: string;
  loaded: Record<string, LoadedSurvey>;
}) {
  const { ut } = useLang();
  const orphan = current && current !== ANY_TEST && !surveys.some((s) => s.id === current) ? current : null;
  return (
    <>
      {orphan ? <option value={orphan}>{surveyLabel(ut, loaded, orphan)}</option> : null}
      {surveys.map((s) => (
        <option key={s.id} value={s.id}>
          {s.title}
        </option>
      ))}
    </>
  );
}

/** Подпись методики, которой нет в коротком списке: название, пометка или отказ сервера */
function surveyLabel(ut: (k: UiKey) => string, loaded: Record<string, LoadedSurvey>, id: string): string {
  const meta = loaded[id];
  if (meta === undefined) return ut("common.loading");
  if (meta === null) return ut("am.testUnavailable");
  return meta.archivedAt ? `${meta.title} (${ut("mark.retired")})` : meta.title;
}

/**
 * Выбор теста с поиском глазами — собственный раскрывающийся список, а не
 * <select>. Форма модели сама берёт штатный Select (тестов в группах —
 * десятки, тип-ахед браузера справляется), а этот список живёт для
 * редактора статистической модели (pages/statistics/Editor.tsx), который
 * зовёт его отсюда.
 *
 * Что обещает клавиатуре и диктору: role="combobox" с aria-expanded и
 * aria-controls, role="listbox"/"option" внутри, обход стрелками, Home,
 * End, выбор по Enter и пробелу, Esc и Tab закрывают, подсвеченный пункт
 * назван через aria-activedescendant, выбранный помечен aria-selected.
 */
export function TestPicker({
  value,
  surveys,
  loaded,
  onChange,
}: {
  value: string;
  surveys: SurveyListItem[];
  loaded: Record<string, LoadedSurvey>;
  onChange: (id: string) => void;
}) {
  const { ut } = useLang();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  const orphan = value && value !== ANY_TEST && !surveys.some((s) => s.id === value) ? value : null;
  const items: { id: string; title: string }[] = orphan
    ? [{ id: orphan, title: surveyLabel(ut, loaded, orphan) }, ...surveys.map((s) => ({ id: s.id, title: s.title }))]
    : surveys.map((s) => ({ id: s.id, title: s.title }));

  /* подсвеченный пункт при раскрытии — текущий выбор, а не первый в списке */
  const show = () => {
    const i = items.findIndex((it) => it.id === value);
    setAt(i < 0 ? 0 : i);
    setOpen(true);
  };

  /* подсвеченный пункт держим в виду: обход стрелками уходит за край панели */
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('[data-at="1"]')?.scrollIntoView({ block: "nearest" });
  }, [open, at]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKey = (e: KeyEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      /* Tab не гасим: он уходит дальше по форме, но список за собой закрывает */
      if (e.key === "Escape") e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const it = items[at];
      if (it) choose(it.id);
      return;
    }
    const next =
      e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setAt(Math.max(0, Math.min(items.length - 1, next)));
  };

  const chosen =
    value === ""
      ? null
      : value === ANY_TEST
        ? ut("am.anyTest")
        : (surveys.find((s) => s.id === value)?.title ?? surveyLabel(ut, loaded, value));

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${at}` : undefined}
        aria-label={ut("am.testName")}
        className={cx(
          "flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border border-field-border bg-panel px-3 text-left text-body font-medium",
          "transition-[border-color,box-shadow] duration-[var(--dur-fast)] hover:border-muted",
          "focus-visible:border-violet-ring focus-visible:shadow-[0_0_0_3px_var(--vtint)] focus-visible:outline-none",
        )}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <Ic.clipboard size={15} className="text-muted" />
        <span className={cx("min-w-0 flex-1 truncate", chosen ? "text-text" : "text-muted")}>{chosen ?? ut("am.testName")}</span>
        <Ic.chevronDown size={14} className="text-muted" />
      </button>
      {open ? (
        <>
          {/* подложка: нажатие мимо панели закрывает список, а не попадает в поле под ним */}
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            ref={panel}
            id={id}
            role="listbox"
            aria-label={ut("am.testName")}
            className="kit-scroll absolute left-0 top-[calc(100%+4px)] z-50 max-h-[360px] w-full overflow-y-auto rounded-[12px] border border-border bg-panel p-1 shadow-pop"
          >
            {items.length === 0 ? (
              <p className="m-0 px-2.5 py-2 text-body text-muted">{ut("am.noTests")}</p>
            ) : (
              items.map((it, i) => (
                <div
                  key={it.id}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={it.id === value}
                  data-at={i === at ? "1" : undefined}
                  onClick={() => choose(it.id)}
                  className={cx(
                    "flex h-9 cursor-pointer items-center rounded-[8px] px-2.5 text-body",
                    i === at && "bg-violet-tint",
                    it.id === value ? "font-bold text-violet-ink" : "font-medium text-text",
                  )}
                >
                  <span className="truncate">{it.title}</span>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Лестница полос шкалы методики — в форме, которую понимает шкала тяжести */
function rungsOfScale(scale: Scale | undefined): Rung[] {
  return (scale?.bands ?? []).map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity }));
}

/**
 * Поля условия по шкале: тест и шкала (или код шкалы у «будь-якого»), что
 * сравниваем, условие и порог. Под ними — где на лестнице тяжести шкалы
 * встаёт порог: «не менше 20» у PHQ-9 — это вход в «тяжку», и видеть это
 * надо до сохранения, а не после первого срабатывания.
 */
function ScaleCond({
  p,
  surveys,
  loaded,
  was,
  errors,
  onChange,
}: {
  p: DraftParam;
  surveys: SurveyListItem[];
  loaded: Record<string, LoadedSurvey>;
  /** То же условие в сохранённой модели — для «було 19» под порогом */
  was: DraftParam | null;
  errors: { test: string | null; scale: string | null; threshold: string | null };
  onChange: (next: Partial<DraftParam>) => void;
}) {
  const { ut } = useLang();
  const any = p.surveyId === ANY_TEST;
  const list = !any && p.surveyId ? (loaded[p.surveyId]?.scales ?? []) : [];
  /* шкала из сохранённого правила, которой у методики уже нет, остаётся видимой — иначе её потеряют молча */
  const orphan = p.scaleCode && !list.some((s) => s.code === p.scaleCode) ? p.scaleCode : null;
  const scale = list.find((s) => s.code === p.scaleCode);
  const rungs = rungsOfScale(scale);
  const value = p.value.trim() === "" ? null : Number(p.value);
  const changed = was && was.kind === "scale" && was.scaleCode === p.scaleCode && was.value !== p.value && was.value !== "";
  const testName = !any && p.surveyId ? (surveys.find((s) => s.id === p.surveyId)?.title ?? surveyLabel(ut, loaded, p.surveyId)) : "";

  return (
    <>
      <div className="grid grid-cols-1 gap-x-4 @[420px]:grid-cols-2">
        {any ? (
          <Field label={ut("am.scaleCode")} error={errors.scale} hint={errors.scale ? undefined : ut("am.scaleCodeHint")}>
            <Input id={`am-${p.key}-scale`} value={p.scaleCode} maxLength={40} onChange={(e) => onChange({ scaleCode: e.target.value })} />
          </Field>
        ) : (
          <>
            <Field label={ut("am.testLabel")} error={errors.test}>
              <Select id={`am-${p.key}-test`} value={p.surveyId} onChange={(e) => onChange({ surveyId: e.target.value, scaleCode: "" })}>
                <option value="" disabled>
                  {ut("am.pickTest")}
                </option>
                <SurveyOptions surveys={surveys} current={p.surveyId} loaded={loaded} />
              </Select>
            </Field>
            <Field label={ut("am.scale")} error={errors.scale}>
              <Select
                id={`am-${p.key}-scale`}
                value={p.scaleCode}
                disabled={!p.surveyId}
                onChange={(e) => onChange({ scaleCode: e.target.value })}
              >
                <option value="" disabled>
                  {ut("am.pickScale")}
                </option>
                {orphan ? <option value={orphan}>{orphan}</option> : null}
                {list.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.title}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-4 @[620px]:grid-cols-[minmax(0,1fr)_170px_160px]">
        <Field label={ut("am.metric")} className="col-span-2 @[620px]:col-span-1">
          <Segmented
            wide
            label={ut("am.metric")}
            value={p.metric}
            onChange={(v) => onChange({ metric: v })}
            items={[
              { key: "raw", label: ut("am.metricRaw") },
              { key: "normed", label: ut("am.metricNormed") },
            ]}
          />
        </Field>
        <Field label={ut("am.op")}>
          <Select value={p.op} onChange={(e) => onChange({ op: e.target.value as DraftParam["op"] })}>
            {OPS.map((op) => (
              <option key={op} value={op}>
                {ut(OP_KEY[op])}
              </option>
            ))}
          </Select>
        </Field>
        <div className="min-w-0">
          <Field label={ut("am.threshold")} error={errors.threshold}>
            <Input
              id={`am-${p.key}-threshold`}
              type="number"
              step="any"
              value={p.value}
              placeholder={ut("am.numberPh")}
              onChange={(e) => onChange({ value: e.target.value })}
            />
          </Field>
          {changed && !errors.threshold ? (
            <ErrorText tone="warn" className="-mt-2">
              {ut("kit.was").replace("{v}", was!.value)}
            </ErrorText>
          ) : null}
        </div>
      </div>
      {any ? null : (
        <div className="mt-3 border-t border-divider pt-3">
          {scale && rungs.length && p.metric === "raw" ? (
            <>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-caption font-bold text-muted">{ut("am.rulerTitle").replace("{test}", testName)}</span>
                {value !== null && Number.isFinite(value) && rungOf(rungs, value) ? (
                  <span className="text-small text-text-2">
                    {ut("am.rulerBand").replace("{band}", rungOf(rungs, value)!.label)}
                  </span>
                ) : null}
              </div>
              <SeverityMeter
                rungs={rungs}
                value={value !== null && Number.isFinite(value) ? value : null}
                label={`${scale.title}: ${ut(OP_KEY[p.op])} ${p.value}`}
              />
            </>
          ) : (
            <p className="m-0 flex items-center gap-2 text-small text-muted">
              <AIc.ruler size={14} />
              {!scale ? ut("am.rulerPick") : p.metric === "normed" ? ut("am.rulerNormed") : ut("am.rulerNoBands")}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/* ─────────── действие ─────────── */

function ActionRow({
  a,
  n,
  surveys,
  loaded,
  error,
  onChange,
  onRemove,
}: {
  a: DraftAction;
  n: number;
  surveys: SurveyListItem[];
  loaded: Record<string, LoadedSurvey>;
  error: string | null;
  onChange: (next: Partial<DraftAction>) => void;
  onRemove: () => void;
}) {
  const { ut } = useLang();
  return (
    <li
      id={`act-${n}`}
      aria-label={`${ut("am.actN").replace("{n}", String(n))}: ${ut(ACT_KEY[a.kind])}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 border-t border-divider py-3.5 first:border-t-0 first:pt-0.5 @[600px]:grid-cols-[236px_minmax(0,1fr)_auto]"
    >
      <Field label={ut("am.actionKind")} className="col-span-2 @[600px]:col-span-1">
        <Select value={a.kind} onChange={(e) => onChange({ kind: e.target.value as DraftAction["kind"] })}>
          <option value="advise">{ut("am.actAdvise")}</option>
          <option value="notify_duty">{ut("am.actNotify")}</option>
          <option value="suggest_survey">{ut("am.actSuggest")}</option>
          {/*
           * Маршрут помощи — только у уже сохранённого действия: справочника
           * маршрутов в консоли нет, и выбрать новый неоткуда, а старый
           * должен пережить открытие и сохранение формы.
           */}
          {a.kind === "suggest_pathway" ? <option value="suggest_pathway">{ut("am.actPathway")}</option> : null}
        </Select>
      </Field>
      {a.kind === "advise" ? (
        <Field label={ut("am.adviseText")} error={error} hint={error ? undefined : ut("am.adviseWhere")}>
          <Textarea
            id={`am-${a.key}-advise`}
            rows={2}
            value={a.text}
            maxLength={2000}
            placeholder={ut("am.advisePh")}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </Field>
      ) : a.kind === "suggest_survey" ? (
        <Field label={ut("am.suggestTest")} error={error} hint={error ? undefined : ut("am.suggestWhere")}>
          <Select id={`am-${a.key}-suggest`} value={a.surveyId} onChange={(e) => onChange({ surveyId: e.target.value })}>
            <option value="" disabled>
              {ut("am.pickTest")}
            </option>
            <SurveyOptions surveys={surveys} current={a.surveyId} loaded={loaded} />
          </Select>
        </Field>
      ) : a.kind === "suggest_pathway" ? (
        <Field label={ut("am.pathwayId")} error={error}>
          <Input id={`am-${a.key}-pathway`} value={a.pathwayId} onChange={(e) => onChange({ pathwayId: e.target.value })} />
        </Field>
      ) : (
        /* «повідомити чергового» параметров не имеет — вместо поля одна фраза о том, что случится */
        <p className="m-0 text-small text-text-2 @[600px]:pt-7">{ut("am.notifyHint")}</p>
      )}
      {/* у «повідомити чергового» во второй колонке фраза без подписи — отметке не нужен отступ под подпись, пока строка узкая */}
      <span className={cx("flex items-center gap-1", a.kind === "notify_duty" ? "@[600px]:pt-7" : "pt-7")}>
        <Checkbox checked={a.picked} aria-label={ut("am.pickAction")} onChange={(e) => onChange({ picked: e.target.checked })} />
        <Button variant="quiet" size="icon-sm" aria-label={ut("am.removeAct")} title={ut("am.removeAct")} onClick={onRemove}>
          <AIc.trash size={15} />
        </Button>
      </span>
    </li>
  );
}

/* ─────────── правая колонка ─────────── */

/** Значок действия по его виду — тот же, что в перечне */
const iconOf = (a: DraftAction): ReactNode => ACT_ICON[a.kind];

/** Пропуск в подсказке модели: то, чего не хватает, — пунктиром */
function Gap({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center rounded-[6px] border-[1.5px] border-dashed border-risk-line px-[7px] align-[1px] text-caption font-bold text-risk-ink">
      {children}
    </span>
  );
}

/**
 * «Як читається модель»: та же модель одной фразой и списком действий.
 *
 * Собирается из черновика на лету — правка поля сразу меняет фразу; чего не
 * хватает для сохранения, стоит пунктиром на своём месте. Фраза — из кусков
 * словаря, а не одним шаблоном: число условий и их виды свободны, и шаблон
 * на все сочетания не написать ни на одном из трёх языков.
 */
function ReadModel({
  draft,
  isNew,
  titleOf,
  scalesOf,
}: {
  draft: ModelDraft;
  isNew: boolean;
  titleOf: (id: string) => string;
  scalesOf: (id: string) => Scale[] | undefined;
}) {
  const { ut } = useLang();
  let gaps = false;
  const gap = (k: UiKey) => {
    gaps = true;
    return <Gap>{ut(k)}</Gap>;
  };

  const lead = draft.params.find((p) => p.kind === "scale" && p.surveyId && p.surveyId !== ANY_TEST)?.surveyId ?? null;
  const anyOnly = !lead && draft.params.some((p) => p.kind === "scale" && p.surveyId === ANY_TEST);
  const leadNode = lead ? <b>{titleOf(lead)}</b> : anyOnly ? ut("am.rdAnyTest") : draft.params.some((p) => p.kind === "scale") ? gap("am.gapTest") : ut("am.rdSomeTest");

  const clauses: ReactNode[] = draft.params.map((p) => {
    if (p.kind === "risk") {
      return (
        <>
          {ut("am.rdRisk")} <b>{ut(p.severity === "severe" ? "am.riskSevere" : "am.riskModerate").toLowerCase()}</b>
        </>
      );
    }
    if (p.kind === "history") {
      return (
        <>
          {ut("am.rdHistory")} <b>{p.completedAtLeast.trim() || "—"}</b>
        </>
      );
    }
    const scale = scalesOf(p.surveyId)?.find((s) => s.code === p.scaleCode);
    const scaleNode =
      p.surveyId === ANY_TEST ? (
        p.scaleCode.trim() ? (
          <>
            {ut("am.rdScaleWord")} <b>{p.scaleCode.trim()}</b>
          </>
        ) : (
          gap("am.gapCode")
        )
      ) : p.scaleCode ? (
        <b>{scale ? lowerFirst(scale.title) : p.scaleCode}</b>
      ) : (
        gap("am.gapScale")
      );
    const other = p.surveyId && p.surveyId !== ANY_TEST && p.surveyId !== lead ? <>{titleOf(p.surveyId)}: </> : null;
    const ok = p.value.trim() !== "" && Number.isFinite(Number(p.value));
    return (
      <>
        {other}
        {scaleNode} {ut(OP_KEY[p.op]).toLowerCase()} {ok ? <b>{p.value.trim()}</b> : gap("am.gapThreshold")} (
        {ut(p.metric === "raw" ? "am.metricRaw" : "am.metricNormed").toLowerCase()})
      </>
    );
  });

  const acts = draft.actions.map((a) => {
    if (a.kind === "notify_duty") return <>{ut("am.rdNotify")}</>;
    if (a.kind === "advise")
      return (
        <>
          {ut("am.rdAdvise")} {a.text.trim() ? <>«{a.text.trim()}»</> : gap("am.gapAdvice")}
        </>
      );
    if (a.kind === "suggest_survey")
      return (
        <>
          {ut("am.rdSuggest")} {a.surveyId ? <b>{titleOf(a.surveyId)}</b> : gap("am.gapTest")}
        </>
      );
    return (
      <>
        {ut("am.rdPathway")} {a.pathwayId.trim() ? <b>{a.pathwayId.trim()}</b> : gap("am.gapPathway")}
      </>
    );
  });

  return (
    <Panel title={ut(isNew ? "am.readTitleNew" : "am.readTitle")} icon={<AIc.bookOpenText />}>
      <p className="m-0 text-body leading-[21px] text-text [&_b]:font-extrabold">
        {ut("am.rdLead")} {leadNode}
        {", "}
        {clauses.map((c, i) => (
          <Fragment key={i}>
            {i > 0 ? (i === clauses.length - 1 ? ` ${ut("am.and")} ` : ", ") : null}
            {c}
          </Fragment>
        ))}
        {clauses.length ? ", " : ""}
        {ut("am.rdThen")}
      </p>
      {acts.length ? (
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0 text-[13px] leading-[19px] text-text">
          {draft.actions.map((a, i) => (
            <li key={a.key} className="flex gap-2 [&_b]:font-extrabold">
              <span className="mt-0.5 inline-flex text-violet-ink">{iconOf(a)}</span>
              <span>
                {acts[i]}
                {i === acts.length - 1 ? "." : ";"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mt-2.5 text-small">{gap("am.gapAction")}</p>
      )}
      {gaps ? <p className="m-0 mt-3 text-small text-muted">{ut("am.gapNote")}</p> : null}
    </Panel>
  );
}

/** Что поменялось — словами панели «Про модель» */
function changeText(ut: (k: UiKey) => string, c: DraftChange): string {
  const n = (k: UiKey, v: number) => ut(k).replace("{n}", String(v));
  switch (c.kind) {
    case "title":
      return ut("am.chTitle");
    case "note":
      return ut("am.chNote");
    case "enabled":
      return ut(c.on ? "am.chOn" : "am.chOff");
    case "threshold":
      return ut("am.chThreshold").replace("{from}", c.from).replace("{to}", c.to || "—");
    case "param":
      return n("am.condN", c.index + 1).toLowerCase();
    case "paramsAdded":
      return n("am.chParamsAdded", c.n);
    case "paramsRemoved":
      return n("am.chParamsRemoved", c.n);
    case "action":
      return n("am.actN", c.index + 1).toLowerCase();
    case "actionsAdded":
      return n("am.chActionsAdded", c.n);
    case "actionsRemoved":
      return n("am.chActionsRemoved", c.n);
  }
}

/** «Про модель»: включена ли (часть формы — сохраняется вместе с ней), версия, правки, даты */
function AboutPanel({
  draft,
  saved,
  dirty,
  changes,
  onChange,
}: {
  draft: ModelDraft;
  saved: SavedModel | null;
  dirty: boolean;
  changes: DraftChange[];
  onChange: (next: Partial<ModelDraft>) => void;
}) {
  const { ut } = useLang();
  const rows: [ReactNode, ReactNode][] = [
    [
      ut("am.state"),
      <Switch
        key="on"
        checked={draft.enabled}
        onChange={(v) => onChange({ enabled: v })}
        label={ut(draft.enabled ? "am.stateOn" : "am.stateOff")}
        sub={saved ? (draft.enabled ? undefined : ut("am.disabledNote")) : ut("am.stateNewSub")}
      />,
    ],
    [
      ut("am.version"),
      saved ? (
        <span key="v">
          <b className="font-extrabold">{saved.version}</b>
          {dirty ? <span className="text-muted"> {ut("am.versionNext").replace("{n}", String(saved.version + 1))}</span> : null}
        </span>
      ) : (
        <span key="v" className="text-muted">
          {ut("am.versionLater")}
        </span>
      ),
    ],
  ];
  if (saved && changes.length) {
    rows.push([
      ut("am.changes"),
      <span key="c" className="flex flex-wrap gap-1">
        {changes.map((c, i) => (
          <Tag key={i} tone="attention" icon={<AIc.circleDot size={12} />}>
            {changeText(ut, c)}
          </Tag>
        ))}
      </span>,
    ]);
  }
  if (saved?.createdAt) rows.push([ut("am.createdAt"), day(saved.createdAt)]);
  if (saved?.updatedAt) rows.push([ut("am.updatedAt"), day(saved.updatedAt)]);
  return (
    <section id="am-about">
      <Panel title={ut("am.about")} icon={<Ic.info />}>
        <KV rows={rows} w={96} className="items-center" />
      </Panel>
    </section>
  );
}

/** Строка-ссылка правой колонки (.lrow набора): значок, текст с пояснением, стрелка */
function LinkRow({ to, icon, title, sub, out }: { to: string; icon: ReactNode; title: ReactNode; sub?: ReactNode; out?: boolean }) {
  return (
    <Link
      to={to}
      className="flex min-h-11 items-center gap-2.5 rounded-control px-2.5 py-1.5 font-semibold text-text no-underline hover:bg-sunk hover:no-underline"
    >
      <span className="inline-flex text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {sub ? <small className="block text-caption font-medium text-muted">{sub}</small> : null}
      </span>
      {out ? <AIc.arrowUpRight size={15} className="text-muted" /> : null}
    </Link>
  );
}

/** Ссылки модели: аналитика её методики и копия как новая модель */
function LinksPanel({ id, draft, titleOf }: { id: string; draft: ModelDraft; titleOf: (sid: string) => string }) {
  const { ut } = useLang();
  const named = ruleTests({ conditions: draftToPayload(draft).conditions }).find((t) => t !== ANY_TEST) ?? null;
  return (
    <section className="rounded-panel border border-border bg-panel p-1.5 shadow-panel" aria-label={ut("am.links")}>
      {named ? (
        <LinkRow to={testsHref(named)} icon={<Ic.gauge size={16} />} title={`${ut("ant.title")}: ${titleOf(named)}`} out />
      ) : null}
      <LinkRow to={copyHref(id)} icon={<AIc.copy size={16} />} title={ut("am.duplicateAsNew")} sub={ut("am.duplicateSub")} />
    </section>
  );
}

/** «Почати з копії»: образцы — уже заведённые модели; условия и действия переносятся в форму */
function CopyPanel({ rules }: { rules: SavedModel[] }) {
  const { ut } = useLang();
  if (!rules.length) return null;
  return (
    <Panel title={ut("am.copyTitle")} icon={<AIc.copy />} sub={ut("am.copySub")} flush>
      <ul className="m-0 list-none px-1.5 pb-1.5 pt-0">
        {rules.map((r) => (
          <li key={r.id} className="flex items-center gap-2.5 rounded-control px-2.5 py-1.5 hover:bg-sunk">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-text">{r.title}</span>
              <small className="block text-caption text-muted">
                {ut("am.copyCounts").replace("{c}", String(r.conditions.length)).replace("{a}", String(r.actions.length))}
              </small>
            </span>
            <ButtonLink to={copyHref(r.id)} size="xs" aria-label={`${ut("am.copyBtn")}: ${r.title}`}>
              <AIc.copy size={13} />
              {ut("am.copyBtn")}
            </ButtonLink>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
