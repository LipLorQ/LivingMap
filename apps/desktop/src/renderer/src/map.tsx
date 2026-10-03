import type {
  ActionDto,
  CourseChangeDto,
  CourseImpactDto,
  CourseLevel,
  CurrentViewDto,
  DecadePlanItemDto,
  EvidenceItemDto,
  IntentionStatus,
  ProjectViewDto,
  RemoveDecadeItemInput,
  Result,
  SaveStrategyInput,
  StrategyHistoryDto,
  UpdateSeasonFocusInput,
} from "@living-map/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { describeImpact, formatDateRu, formatProgress, formatYears, PROJECT_LIMIT_TEXT } from "./format";
import { type ExecutionHandlers, ExecutionPanel } from "./now-screen";
import { EditableText, ReorderButtons } from "./shared-ui";

type Run = <T>(action: Promise<Result<T>>) => Promise<Result<T>>;

const LEVEL_TITLES = {
  decades: "Куда я иду",
  horizon: "Ближайшие 3 года",
  year: "Этот год",
  season: "Этот сезон",
  projects: "Проекты",
  now: "Сейчас",
} as const;

function useDraft(value: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return [draft, setDraft];
}

function Arrow({ label = "почему это важно" }: { label?: string }) {
  return (
    <p aria-hidden="true" className="text-center text-neutral-400">
      ↓ {label}
    </p>
  );
}

function Evidence({ items }: { items: EvidenceItemDto[] }) {
  if (items.length === 0) return null;
  return (
    <ul data-testid="evidence" className="text-xs text-green-800">
      {items.map((e) => (
        <li key={`${e.kind}-${e.at}-${e.text}`}>
          ✓ {e.kind === "project_completed" ? "Завершён проект" : "Прожит сезон"} «{e.text}» · {formatDateRu(e.at)}
        </li>
      ))}
    </ul>
  );
}

/** What a change of course may touch, in plain words — shown BEFORE anything is applied. */
function ImpactPanel({
  impact,
  testPrefix,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  impact: CourseImpactDto;
  testPrefix: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div data-testid={`${testPrefix}-impact`} className="space-y-2 rounded border-2 border-amber-400 bg-amber-50 p-3">
      {impact.items.length > 0 ? (
        <>
          <p className="font-medium">Это может затронуть:</p>
          <ul className="list-disc pl-5">
            {impact.items.map((item) => (
              <li key={item.id} data-testid="impact-item">
                {describeImpact(item)}
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-600">
            Само ничего не поменяется: потом можно будет посмотреть, что пересобрать, и решить, что делать с каждым.
          </p>
        </>
      ) : (
        <p data-testid="impact-none">Ниже это ничего не затронет.</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid={`${testPrefix}-confirm-course`}
          className="rounded border border-amber-600 bg-amber-600 px-3 py-1 text-white"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" data-testid={`${testPrefix}-cancel-course`} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

/**
 * Two honest ways to edit something that exists (Stage 8 §12): a wording edit (the meaning is the same —
 * nothing below is looked at) or a change of course (the meaning changes — the impact is shown first and
 * confirmed). The renderer only asks; the application decides and verifies.
 */
function CourseFlow({
  testPrefix,
  level,
  targetId,
  canWord,
  canChange,
  courseLabel = "Сменить курс",
  confirmLabel = "Да, меняю курс",
  previewYears,
  onWording,
  onCourse,
}: {
  testPrefix: string;
  level: CourseLevel;
  targetId?: string;
  /** Decade only: where the statement is being moved to (moving INTO the current years matters too). */
  previewYears?: { startYear: number; endYear: number };
  canWord: boolean;
  canChange: boolean;
  courseLabel?: string;
  confirmLabel?: string;
  onWording: () => Promise<unknown>;
  onCourse: (fingerprint: string) => Promise<Result<unknown>>;
}) {
  const [impact, setImpact] = useState<CourseImpactDto | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = (work: () => Promise<unknown>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid={`${testPrefix}-save-wording`}
          disabled={!canWord || busy}
          title="Смысл тот же, меняются только слова"
          onClick={guard(onWording)}
        >
          Сохранить как уточнение
        </button>
        <button
          type="button"
          data-testid={`${testPrefix}-change-course`}
          disabled={!canChange || busy}
          title="Меняется сам смысл: сначала покажу, что это затронет"
          onClick={guard(async () => {
            const preview = await window.livingMap.queries.previewCourseImpact({
              level,
              ...(targetId ? { targetId } : {}),
              ...(previewYears ? previewYears : {}),
            });
            if (preview.ok) setImpact(preview.value);
          })}
        >
          {courseLabel}
        </button>
      </div>
      {impact && (
        <ImpactPanel
          impact={impact}
          testPrefix={testPrefix}
          confirmLabel={confirmLabel}
          onCancel={() => setImpact(null)}
          onConfirm={guard(async () => {
            const result = await onCourse(impact.fingerprint);
            // Applied, or stale (something below moved): either way the owner starts again from a fresh preview.
            setImpact(null);
            return result;
          })}
        />
      )}
    </div>
  );
}

// ─── 1. Decades ──────────────────────────────────────────────────────────────────────────────────

function DecadeRow({ item, run, currentYear }: { item: DecadePlanItemDto; run: Run; currentYear: number }) {
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useDraft(item.statement);
  const [start, setStart] = useDraft(String(item.startYear));
  const [end, setEnd] = useDraft(String(item.endYear));
  const [removal, setRemoval] = useState<CourseImpactDto | null>(null);
  const years = { startYear: Number(start), endYear: Number(end) };
  const yearsChanged = years.startYear !== item.startYear || years.endYear !== item.endYear;
  const save = (mode: "wording" | "course", impactFingerprint?: string): SaveStrategyInput => ({
    level: "decade",
    id: item.id,
    expectedVersion: item.version,
    ...years,
    statement,
    mode,
    ...(impactFingerprint === undefined ? {} : { impactFingerprint }),
  });
  const removeInput = (impactFingerprint: string): RemoveDecadeItemInput => ({
    id: item.id,
    expectedVersion: item.version,
    impactFingerprint,
  });
  return (
    <li data-testid="decade" data-id={item.id} className="space-y-1 rounded border border-neutral-200 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-neutral-500">{formatYears(item.startYear, item.endYear)}</span>
        <span data-testid="decade-statement" className="flex-1">
          {item.statement}
        </span>
        {item.startYear <= currentYear && currentYear <= item.endYear && (
          <span className="rounded bg-violet-100 px-1 text-xs text-violet-800">сейчас</span>
        )}
        <button type="button" data-testid="decade-edit" onClick={() => setEditing((v) => !v)}>
          {editing ? "Закрыть" : "Править"}
        </button>
        <button
          type="button"
          data-testid="decade-remove"
          onClick={async () => {
            const preview = await window.livingMap.queries.previewCourseImpact({ level: "decade", targetId: item.id });
            if (preview.ok) setRemoval(preview.value);
          }}
        >
          Убрать
        </button>
      </div>
      <Evidence items={item.evidence} />
      {editing && (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap gap-2">
            <input
              data-testid="decade-start"
              aria-label="С года"
              className="w-20 rounded border px-1"
              inputMode="numeric"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <input
              data-testid="decade-end"
              aria-label="По год"
              className="w-20 rounded border px-1"
              inputMode="numeric"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
            <input
              data-testid="decade-statement-input"
              aria-label="Несколько слов о десятилетии"
              className="flex-1 rounded border px-1"
              maxLength={120}
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </div>
          <CourseFlow
            testPrefix="decade"
            level="decade"
            targetId={item.id}
            previewYears={years}
            canWord={!yearsChanged && statement.trim() !== item.statement && statement.trim().length > 0}
            canChange={statement.trim().length > 0 && (yearsChanged || statement.trim() !== item.statement)}
            onWording={() => run(window.livingMap.commands.saveStrategy(save("wording")))}
            onCourse={(fp) => run(window.livingMap.commands.saveStrategy(save("course", fp)))}
          />
        </div>
      )}
      {removal && (
        <ImpactPanel
          impact={removal}
          testPrefix="decade-remove"
          confirmLabel="Да, убираю"
          onCancel={() => setRemoval(null)}
          onConfirm={async () => {
            await run(window.livingMap.commands.removeDecadeItem(removeInput(removal.fingerprint)));
            setRemoval(null);
          }}
        />
      )}
    </li>
  );
}

function DecadesLevel({ view, run }: { view: CurrentViewDto; run: Run }) {
  const { decadePlan, currentYear } = view.strategy;
  const [start, setStart] = useState(String(currentYear));
  const [end, setEnd] = useState(String(currentYear + 9));
  const [statement, setStatement] = useState("");
  return (
    <section
      data-testid="map-decades"
      className="space-y-2 rounded border border-neutral-200 p-3 text-sm text-neutral-700"
    >
      <h2 className="font-semibold text-neutral-600">{LEVEL_TITLES.decades}</h2>
      {decadePlan.length === 0 ? (
        <p data-testid="decades-empty" className="text-neutral-500">
          Здесь пока пусто. Набросай, куда хочешь прийти за десятилетия, — буквально несколько слов на каждое.
        </p>
      ) : (
        <ul className="space-y-1">
          {decadePlan.map((item) => (
            <DecadeRow key={item.id} item={item} run={run} currentYear={currentYear} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          data-testid="decade-new-start"
          aria-label="С года"
          className="w-20 rounded border px-1"
          inputMode="numeric"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <input
          data-testid="decade-new-end"
          aria-label="По год"
          className="w-20 rounded border px-1"
          inputMode="numeric"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
        <input
          data-testid="decade-new-statement"
          className="flex-1 rounded border px-2 py-1"
          maxLength={120}
          placeholder="Несколько слов об этих годах"
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
        <button
          type="button"
          data-testid="decade-add"
          disabled={statement.trim().length === 0}
          onClick={async () => {
            const r = await run(
              window.livingMap.commands.saveStrategy({
                level: "decade",
                startYear: Number(start),
                endYear: Number(end),
                statement,
              }),
            );
            if (r.ok) setStatement("");
          }}
        >
          Добавить
        </button>
      </div>
    </section>
  );
}

// ─── 2./3. Three years and this year ─────────────────────────────────────────────────────────────

function HorizonLevel({ view, run }: { view: CurrentViewDto; run: Run }) {
  const { horizon, decadePlan, currentYear } = view.strategy;
  const [startYear, setStartYear] = useDraft(String(horizon?.startYear ?? currentYear));
  const [direction, setDirection] = useDraft(horizon?.direction ?? "");
  const [why, setWhy] = useDraft(horizon?.whyItMatters ?? "");
  const served = horizon ? decadePlan.filter((d) => horizon.decadeItemIds.includes(d.id)) : [];
  const yearsChanged = horizon !== null && Number(startYear) !== horizon.startYear;
  const build = (mode?: "wording" | "course", impactFingerprint?: string): SaveStrategyInput => ({
    level: "horizon",
    ...(horizon ? { expectedVersion: horizon.version } : {}),
    startYear: Number(startYear),
    direction,
    whyItMatters: why,
    ...(mode ? { mode } : {}),
    ...(impactFingerprint === undefined ? {} : { impactFingerprint }),
  });
  const dirty =
    horizon === null || direction.trim() !== horizon.direction || why.trim() !== horizon.whyItMatters || yearsChanged;
  return (
    <section data-testid="map-horizon" className="space-y-2 rounded border border-neutral-300 p-3">
      <h2 className="font-semibold">
        {LEVEL_TITLES.horizon}
        {horizon && (
          <span className="ml-2 font-normal text-neutral-500">{formatYears(horizon.startYear, horizon.endYear)}</span>
        )}
      </h2>
      {horizon && served.length > 0 && (
        <p data-testid="horizon-serves" className="text-xs text-neutral-500">
          Служит: {served.map((d) => `«${d.statement}»`).join(", ")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {horizon && (
          <input
            data-testid="horizon-start"
            aria-label="Первый год"
            className="w-20 rounded border px-1"
            inputMode="numeric"
            value={startYear}
            onChange={(e) => setStartYear(e.target.value)}
          />
        )}
        <input
          data-testid="horizon-direction"
          className="flex-1 rounded border px-2 py-1"
          maxLength={200}
          placeholder="Куда ты придёшь за эти 3 года?"
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
        />
      </div>
      <input
        data-testid="horizon-why"
        className="w-full rounded border px-2 py-1"
        maxLength={200}
        placeholder="Почему это важно для того, куда ты идёшь?"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
      />
      {horizon ? (
        <>
          <Evidence items={horizon.evidence} />
          <CourseFlow
            testPrefix="horizon"
            level="horizon"
            canWord={dirty && !yearsChanged && direction.trim().length > 0}
            canChange={dirty && direction.trim().length > 0}
            onWording={() => run(window.livingMap.commands.saveStrategy(build("wording")))}
            onCourse={(fp) => run(window.livingMap.commands.saveStrategy(build("course", fp)))}
          />
        </>
      ) : (
        <button
          type="button"
          data-testid="horizon-set"
          disabled={direction.trim().length === 0}
          onClick={() => run(window.livingMap.commands.saveStrategy(build()))}
        >
          Задать
        </button>
      )}
    </section>
  );
}

function YearLevel({ view, run }: { view: CurrentViewDto; run: Run }) {
  const { year, currentYear } = view.strategy;
  const [yearValue, setYearValue] = useDraft(String(year?.year ?? currentYear));
  const [direction, setDirection] = useDraft(year?.direction ?? "");
  const [why, setWhy] = useDraft(year?.whyItMatters ?? "");
  const yearChanged = year !== null && Number(yearValue) !== year.year;
  const build = (mode?: "wording" | "course", impactFingerprint?: string): SaveStrategyInput => ({
    level: "year",
    ...(year ? { expectedVersion: year.version } : {}),
    year: Number(yearValue),
    direction,
    whyItMatters: why,
    ...(mode ? { mode } : {}),
    ...(impactFingerprint === undefined ? {} : { impactFingerprint }),
  });
  const dirty = year === null || direction.trim() !== year.direction || why.trim() !== year.whyItMatters || yearChanged;
  return (
    <section data-testid="map-year" className="space-y-2 rounded border border-neutral-400 p-3">
      <h2 className="font-semibold">
        {LEVEL_TITLES.year}
        <span className="ml-2 font-normal text-neutral-500">{year?.year ?? currentYear}</span>
      </h2>
      {year && !year.isCurrentYear && (
        <p data-testid="year-outdated" className="text-amber-800">
          Это направление на {year.year} год. Задай, куда ты идёшь в {currentYear}-м.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {year && (
          <input
            data-testid="year-number"
            aria-label="Год"
            className="w-20 rounded border px-1"
            inputMode="numeric"
            value={yearValue}
            onChange={(e) => setYearValue(e.target.value)}
          />
        )}
        <input
          data-testid="year-direction"
          className="flex-1 rounded border px-2 py-1"
          maxLength={200}
          placeholder="Что должно получиться в этом году?"
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
        />
      </div>
      <input
        data-testid="year-why"
        className="w-full rounded border px-2 py-1"
        maxLength={200}
        placeholder="Почему это важно для ближайших 3 лет?"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
      />
      {year ? (
        <>
          <Evidence items={year.evidence} />
          <CourseFlow
            testPrefix="year"
            level="year"
            canWord={dirty && !yearChanged && direction.trim().length > 0}
            canChange={dirty && direction.trim().length > 0}
            onWording={() => run(window.livingMap.commands.saveStrategy(build("wording")))}
            onCourse={(fp) => run(window.livingMap.commands.saveStrategy(build("course", fp)))}
          />
        </>
      ) : (
        <button
          type="button"
          data-testid="year-set"
          disabled={direction.trim().length === 0}
          onClick={() => run(window.livingMap.commands.saveStrategy(build()))}
        >
          Задать
        </button>
      )}
    </section>
  );
}

// ─── 4. The Season ───────────────────────────────────────────────────────────────────────────────

function SeasonLevel({ view, run }: { view: CurrentViewDto; run: Run }) {
  const { season, strategy } = view;
  const [focus, setFocus] = useDraft(season?.focus ?? "");
  const [why, setWhy] = useDraft(season?.whyItMatters ?? "");
  const dirty = season !== null && (focus.trim() !== season.focus || why.trim() !== season.whyItMatters);
  const update = (startsNewSeason: boolean, impactFingerprint?: string): UpdateSeasonFocusInput => ({
    expectedVersion: (season as NonNullable<typeof season>).version,
    focus,
    whyItMatters: why,
    startsNewSeason,
    ...(impactFingerprint === undefined ? {} : { impactFingerprint }),
  });
  return (
    <section data-testid="map-season" className="space-y-2 rounded border-2 border-violet-400 bg-violet-50 p-4">
      <h2 className="text-base font-semibold">{LEVEL_TITLES.season}</h2>
      <p className="text-sm text-neutral-600">Главная цель</p>
      <textarea
        data-testid="map-season-focus"
        className="w-full rounded border px-2 py-1 text-lg font-medium"
        rows={2}
        maxLength={500}
        placeholder="Что главное в этом сезоне жизни?"
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
      />
      <input
        data-testid="map-season-why"
        className="w-full rounded border px-2 py-1"
        maxLength={200}
        placeholder="Почему это важно для этого года?"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
      />
      {season ? (
        <>
          <p className="text-xs text-neutral-500">Сезон идёт с {formatDateRu(season.startedAt)}</p>
          {strategy.seasonProgress && (
            <p data-testid="season-progress">
              Завершено проектов: {strategy.seasonProgress.completed} из {strategy.seasonProgress.total}
            </p>
          )}
          <Evidence items={strategy.seasonEvidence} />
          <CourseFlow
            testPrefix="season"
            level="season"
            canWord={dirty && focus.trim().length > 0}
            canChange={focus.trim().length > 0 && focus.trim() !== season.focus}
            courseLabel="Начался новый сезон"
            confirmLabel="Да, начинаю новый сезон"
            onWording={() => run(window.livingMap.commands.updateSeasonFocus(update(false)))}
            onCourse={(fp) => run(window.livingMap.commands.updateSeasonFocus(update(true, fp)))}
          />
        </>
      ) : (
        <button
          type="button"
          data-testid="map-season-create"
          disabled={focus.trim().length === 0}
          onClick={() =>
            run(
              window.livingMap.commands.createSeason({
                focus,
                ...(why.trim() ? { whyItMatters: why } : {}),
              }),
            )
          }
        >
          Задать главную цель
        </button>
      )}
    </section>
  );
}

// ─── 5. Projects ─────────────────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<IntentionStatus, string> = {
  active: "в работе",
  deferred: "на паузе",
  completed: "завершён",
  released: "отпущен",
};

function ProjectCard({
  project,
  index,
  activeProjects,
  currentAction,
  run,
  onReorder,
}: {
  project: ProjectViewDto;
  index: number;
  activeProjects: ProjectViewDto[];
  currentAction: CurrentViewDto["currentAction"];
  run: Run;
  onReorder: (orderedIds: string[]) => void;
}) {
  const { intention } = project;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<"completed" | "released" | null>(null);
  const currentStage = project.stages.find((s) => s.isCurrent);
  const change = (to: IntentionStatus) =>
    run(window.livingMap.commands.changeIntentionStatus({ id: intention.id, expectedVersion: intention.version, to }));
  const isActive = intention.status === "active";
  return (
    <li
      data-testid="map-project"
      data-id={intention.id}
      data-status={intention.status}
      className={`space-y-2 rounded border p-3 ${isActive ? "border-blue-300 bg-white" : "border-neutral-200 bg-neutral-50"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 data-testid="map-project-title" className="flex-1 text-base font-medium">
          {intention.title}
        </h3>
        <span data-testid="map-project-status" className="rounded bg-neutral-100 px-1 text-xs">
          {STATUS_LABELS[intention.status]}
        </span>
        {isActive && activeProjects.length > 1 && (
          <ReorderButtons items={activeProjects.map((p) => p.intention)} index={index} onReorder={onReorder} />
        )}
      </div>
      <div className="flex items-center gap-1 text-neutral-700">
        <span className="font-medium">Почему это важно:</span>
        <EditableText
          testId="map-project-why"
          value={intention.whyItMatters}
          onSave={(whyItMatters) =>
            run(
              window.livingMap.commands.updateIntention({
                id: intention.id,
                expectedVersion: intention.version,
                title: intention.title,
                desiredResult: intention.desiredResult,
                whyItMatters,
              }),
            )
          }
        />
      </div>
      <p data-testid="map-project-progress" className="text-sm text-neutral-700">
        {formatProgress(project.progress)}
      </p>
      {currentStage && (
        <p data-testid="map-project-stage" className="text-sm">
          <span className="font-medium">Сейчас этап: </span>
          {currentStage.title}
        </p>
      )}
      {isActive && project.needsAiReplan && (
        <p data-testid="map-project-needs-replan" className="text-sm text-amber-800">
          В этом проекте нужен новый порядок действий.
        </p>
      )}
      <button type="button" data-testid="map-project-open" onClick={() => setOpen((v) => !v)}>
        {open ? "Скрыть этапы и действия" : "Открыть этапы и действия"}
      </button>
      {open && (
        <ol data-testid="map-project-stages" className="space-y-1 pl-4">
          {project.stages.map((stage) => (
            <li key={stage.id} data-testid="map-stage" className={stage.isCurrent ? "font-medium" : ""}>
              {stage.title}
              {stage.isCurrent && <span className="ml-1 text-xs text-blue-700">текущий</span>}
              <ul className="pl-4 font-normal">
                {stage.actions.map((action: ActionDto) => (
                  <li
                    key={action.id}
                    data-testid="map-action"
                    data-current={currentAction?.actionId === action.id}
                    className={action.status === "done" ? "text-neutral-400 line-through" : ""}
                  >
                    {currentAction?.actionId === action.id ? "▶ " : "· "}
                    {action.title}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        {intention.status === "active" && (
          <button type="button" data-testid="project-defer" onClick={() => change("deferred")}>
            Пауза
          </button>
        )}
        {intention.status === "deferred" && (
          <button type="button" data-testid="project-activate" onClick={() => change("active")}>
            Продолжить
          </button>
        )}
        {confirming === null ? (
          <>
            <button type="button" data-testid="project-complete" onClick={() => setConfirming("completed")}>
              Завершить
            </button>
            <button type="button" data-testid="project-release" onClick={() => setConfirming("released")}>
              Отпустить
            </button>
          </>
        ) : (
          <span data-testid="project-confirm" className="flex items-center gap-2">
            {confirming === "completed"
              ? "Результат достигнут, проект завершён?"
              : "Отпустить проект, не доводя до результата?"}
            <button
              type="button"
              data-testid="project-confirm-yes"
              className="rounded border border-neutral-700 px-2"
              onClick={async () => {
                await change(confirming);
                setConfirming(null);
              }}
            >
              Да
            </button>
            <button type="button" data-testid="project-confirm-no" onClick={() => setConfirming(null)}>
              Нет
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

function ProjectsLevel({ view, run }: { view: CurrentViewDto; run: Run }) {
  const active = view.projects.filter((p) => p.intention.status === "active");
  const paused = view.projects.filter((p) => p.intention.status === "deferred");
  const full = view.projectSlots.active >= view.projectSlots.max;
  return (
    <section data-testid="map-projects" className="space-y-2 rounded border border-blue-300 p-3">
      <h2 className="font-semibold">
        {LEVEL_TITLES.projects}
        <span data-testid="project-slots" className="ml-2 font-normal text-neutral-500">
          занято мест: {view.projectSlots.active} из {view.projectSlots.max}
        </span>
      </h2>
      {full && (
        <p data-testid="project-limit-note" className="text-amber-800">
          {PROJECT_LIMIT_TEXT}
        </p>
      )}
      {view.projects.length === 0 ? (
        <p data-testid="projects-empty" className="text-neutral-500">
          Пока нет проектов. Начни с вкладки «Замыслы».
        </p>
      ) : (
        <ul className="space-y-2">
          {active.map((project, index) => (
            <ProjectCard
              key={project.intention.id}
              project={project}
              index={index}
              activeProjects={active}
              currentAction={view.currentAction}
              run={run}
              onReorder={(orderedIds) => run(window.livingMap.commands.reorderProjects({ orderedIds }))}
            />
          ))}
          {paused.map((project) => (
            <ProjectCard
              key={project.intention.id}
              project={project}
              index={0}
              activeProjects={active}
              currentAction={view.currentAction}
              run={run}
              onReorder={() => {}}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── 6. Now, and the path up from it ─────────────────────────────────────────────────────────────

function PathLine({ testId, label, children }: { testId: string; label: string; children: ReactNode }) {
  return (
    <li data-testid={testId}>
      <span className="text-neutral-500">{label}: </span>
      {children}
    </li>
  );
}

const NOT_SET = <span className="text-neutral-400">пока не задано</span>;

function NowLevel({
  view,
  execution,
  onOpenNow,
}: {
  view: CurrentViewDto;
  execution: ExecutionHandlers;
  onOpenNow: () => void;
}) {
  const { currentAction, strategy } = view;
  const project = view.projects.find((p) => p.intention.id === currentAction?.intentionId);
  const stage = project?.stages.find((s) => s.id === currentAction?.stageId);
  const action = stage?.actions.find((a) => a.id === currentAction?.actionId);
  const served = strategy.horizon
    ? strategy.decadePlan.filter((d) => strategy.horizon?.decadeItemIds.includes(d.id))
    : [];
  return (
    <section data-testid="map-now" className="space-y-2 rounded border-2 border-blue-300 bg-blue-50 p-3">
      <h2 className="font-semibold">{LEVEL_TITLES.now}</h2>
      {currentAction && action && project && stage ? (
        <>
          <p data-testid="map-now-action" className="text-lg font-medium">
            {action.title}
          </p>
          <p className="text-xs text-neutral-600">Вот куда ведёт это действие, если идти вверх:</p>
          <ol data-testid="map-path" className="space-y-0.5 text-sm">
            <PathLine testId="path-action" label="Действие">
              {action.title}
            </PathLine>
            <PathLine testId="path-stage" label="Этап">
              {stage.title}
            </PathLine>
            <PathLine testId="path-project" label="Проект">
              {project.intention.title}
              {project.intention.whyItMatters && (
                <span className="text-neutral-500"> — {project.intention.whyItMatters}</span>
              )}
            </PathLine>
            <PathLine testId="path-season" label="Главная цель сезона">
              {view.season?.focus ?? NOT_SET}
              {view.season?.whyItMatters && <span className="text-neutral-500"> — {view.season.whyItMatters}</span>}
            </PathLine>
            <PathLine testId="path-year" label="Этот год">
              {strategy.year ? strategy.year.direction : NOT_SET}
              {strategy.year?.whyItMatters && <span className="text-neutral-500"> — {strategy.year.whyItMatters}</span>}
            </PathLine>
            <PathLine testId="path-horizon" label="Ближайшие 3 года">
              {strategy.horizon ? strategy.horizon.direction : NOT_SET}
              {strategy.horizon?.whyItMatters && (
                <span className="text-neutral-500"> — {strategy.horizon.whyItMatters}</span>
              )}
            </PathLine>
            <PathLine testId="path-decade" label="Куда я иду">
              {served.length > 0
                ? served.map((d) => `${formatYears(d.startYear, d.endYear)}: ${d.statement}`).join("; ")
                : NOT_SET}
            </PathLine>
          </ol>
          <ExecutionPanel action={action} execution={view.execution} handlers={execution} />
        </>
      ) : (
        <p data-testid="map-now-empty" className="text-neutral-600">
          Сейчас нечего делать по подтверждённому порядку.
        </p>
      )}
      <button type="button" data-testid="map-open-now" onClick={onOpenNow}>
        Перейти к экрану «Сейчас»
      </button>
    </section>
  );
}

// ─── Course changes waiting to be rebuilt ────────────────────────────────────────────────────────

const LEVEL_NAMES: Record<CourseLevel, string> = {
  decade: "Куда я иду",
  horizon: "Ближайшие 3 года",
  year: "Этот год",
  season: "Этот сезон",
};

function OpenCourseChange({
  change,
  run,
  onAskRebuild,
}: {
  change: CourseChangeDto;
  run: Run;
  onAskRebuild: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="course-change"
      data-id={change.id}
      className="space-y-2 rounded border-2 border-amber-400 bg-amber-50 p-3"
    >
      <p>
        <span className="font-medium">Курс изменён</span> ({LEVEL_NAMES[change.level]}): «{change.summary}»
      </p>
      <button type="button" data-testid="course-change-show" onClick={() => setOpen((v) => !v)}>
        Посмотреть, что нужно пересобрать
      </button>
      {open && (
        <div data-testid="course-change-impact" className="space-y-2">
          {change.impact.length > 0 ? (
            <ul className="list-disc pl-5">
              {change.impact.map((item) => (
                <li key={item.id} data-testid="impact-item">
                  {describeImpact(item)}
                </li>
              ))}
            </ul>
          ) : (
            <p>Ниже уже нечего пересматривать.</p>
          )}
          <p className="text-xs text-neutral-600">
            Ничего не изменено само. Реши, что из этого больше не подходит, и пересобери — сам или вместе с ИИ.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="course-change-ask-ai"
              className="rounded border border-violet-500 bg-violet-600 px-3 py-1 text-white"
              onClick={() =>
                onAskRebuild(
                  `Курс изменился: «${change.summary}». Посмотри, какие проекты больше не подходят, и предложи, как пересобрать их маршруты.`,
                )
              }
            >
              Попросить ИИ перестроить
            </button>
            <button
              type="button"
              data-testid="course-change-resolve"
              onClick={() => run(window.livingMap.commands.resolveCourseChange({ id: change.id }))}
            >
              Всё пересобрано
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── History ─────────────────────────────────────────────────────────────────────────────────────

function HistorySection({ history }: { history: StrategyHistoryDto | null }) {
  const empty = !history || (history.pastSeasons.length === 0 && history.currentSeasonClosedProjects.length === 0);
  return (
    <section data-testid="map-history" className="rounded border p-3">
      <details>
        <summary className="cursor-pointer font-semibold">История сезонов</summary>
        {empty ? (
          <p className="mt-1 text-neutral-500">
            Пока нечего вспоминать: здесь появятся прожитые сезоны и закрытые проекты.
          </p>
        ) : (
          <div className="mt-2 space-y-3">
            {history && history.currentSeasonClosedProjects.length > 0 && (
              <div data-testid="history-current">
                <p className="font-medium">В этом сезоне закрыто</p>
                <ul>
                  {history.currentSeasonClosedProjects.map((p) => (
                    <li key={p.id} data-testid="history-project">
                      {p.status === "completed" ? "✓ завершён" : "отпущен"}: «{p.title}» · {formatDateRu(p.closedAt)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {history?.pastSeasons.map((season) => (
              <div key={season.id} data-testid="history-season" className="space-y-1">
                <p className="font-medium">
                  «{season.focus}»{" "}
                  <span className="font-normal text-neutral-500">
                    {formatDateRu(season.startedAt)} — {formatDateRu(season.endedAt)}
                  </span>
                </p>
                <ul>
                  {season.closedProjects.map((p) => (
                    <li key={p.id} data-testid="history-project">
                      {p.status === "completed" ? "✓ завершён" : "отпущен"}: «{p.title}»
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </details>
    </section>
  );
}

// ─── The screen ──────────────────────────────────────────────────────────────────────────────────

/**
 * The Full Map (Stage 8): one life, one causal line. A vertical zoom from the sparse decades down to the
 * one current Action — far = coarse, near = detailed. It renders the same state as the main screen
 * (`view`); it owns no strategic state and no business rules.
 */
export function MapScreen({
  view,
  run,
  execution,
  onAskRebuild,
  onOpenNow,
}: {
  view: CurrentViewDto;
  run: Run;
  execution: ExecutionHandlers;
  onAskRebuild: (text: string) => void;
  onOpenNow: () => void;
}) {
  const [history, setHistory] = useState<StrategyHistoryDto | null>(null);
  // The history is derived from the same state as `view`: refetch whenever the view is refreshed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `view` is the refresh trigger, not a value read inside
  useEffect(() => {
    let alive = true;
    void window.livingMap.queries.getStrategyHistory().then((r) => {
      if (alive && r.ok) setHistory(r.value);
    });
    return () => {
      alive = false;
    };
  }, [view]);

  return (
    <div data-testid="map-screen" className="space-y-3">
      {view.strategy.openCourseChanges.map((change) => (
        <OpenCourseChange key={change.id} change={change} run={run} onAskRebuild={onAskRebuild} />
      ))}
      <DecadesLevel view={view} run={run} />
      <Arrow />
      <HorizonLevel view={view} run={run} />
      <Arrow />
      <YearLevel view={view} run={run} />
      <Arrow />
      <SeasonLevel view={view} run={run} />
      <Arrow label="служит этой цели" />
      <ProjectsLevel view={view} run={run} />
      <Arrow label="сейчас в работе" />
      <NowLevel view={view} execution={execution} onOpenNow={onOpenNow} />
      <HistorySection history={history} />
    </div>
  );
}
