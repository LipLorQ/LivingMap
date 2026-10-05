import type {
  ActionDto,
  AppError,
  CaptureDto,
  ChangeLogEntryDto,
  CurrentViewDto,
  GoodLifeConditionDto,
  IntentionDto,
  OrderedActionPlanDto,
  ProjectViewDto,
  Result,
  SeasonDto,
  StageWithActionsDto,
} from "@living-map/contracts";
import { useCallback, useEffect, useState } from "react";
import { isLaterLocalDay, PROJECT_LIMIT_TEXT } from "./format";
import { MapScreen } from "./map";
import { MemoryPanel } from "./memory";
import { NowScreen } from "./now-screen";
import { PlusPanel } from "./plus";
import { PlanSection, ProposalsSection, STALE_PROPOSAL_TEXT } from "./proposals";
import { ReviewsPanel } from "./reviews";
import { RoutineSection } from "./routines";
import { EditableText, ReorderButtons } from "./shared-ui";

type Tab = "now" | "map" | "editor" | "memory" | "reviews";

// Stage 4: "Сейчас" is the default screen (execution interface); the previous utilitarian
// editing screen moves behind a "Замысел" tab (direct editing / fallback, per Stage 4 §15).
export function App() {
  const [view, setView] = useState<CurrentViewDto | null>(null);
  const [history, setHistory] = useState<ChangeLogEntryDto[]>([]);
  const [lastError, setLastError] = useState<AppError | null>(null);
  const [tab, setTab] = useState<Tab>("now");
  const [captures, setCaptures] = useState<CaptureDto[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusDraft, setPlusDraft] = useState("");

  const reload = useCallback(async () => {
    const [viewResult, historyResult, capturesResult] = await Promise.all([
      window.livingMap.queries.getCurrentView(),
      window.livingMap.queries.listChangeHistory({ limit: 20 }),
      window.livingMap.queries.listCaptures({ limit: 5 }),
    ]);
    if (viewResult.ok) setView(viewResult.value);
    if (historyResult.ok) setHistory(historyResult.value);
    if (capturesResult.ok) setCaptures(capturesResult.value);
  }, []);

  useEffect(() => {
    void reload();
    return window.livingMap.events.onStateChanged(() => void reload());
  }, [reload]);

  // While running, re-read authoritative figures each minute: no drift, and today rolls over at midnight.
  const running = view?.execution.state === "running";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void reload(), 60_000);
    return () => clearInterval(id);
  }, [running, reload]);

  // Idle overnight too (Stage 9 friction, 2026-10-05): with nothing written after midnight the screen kept
  // yesterday's «Сегодня» and last week's «За неделю». Once the local day turns, re-read the figures.
  const computedAt = view?.execution.computedAt;
  useEffect(() => {
    if (!computedAt) return;
    const id = setInterval(() => {
      if (isLaterLocalDay(computedAt, Date.now())) void reload();
    }, 60_000);
    return () => clearInterval(id);
  }, [computedAt, reload]);

  const run = useCallback(
    async <T,>(action: Promise<Result<T>>): Promise<Result<T>> => {
      const r = await action;
      setLastError(r.ok ? null : r.error);
      // Awaited: a button stays disabled until the fresh state is on screen (no stale second click).
      if (r.ok) await reload();
      return r;
    },
    [reload],
  );

  if (!view) return <main className="p-6 font-sans text-sm">Загрузка…</main>;

  const executionHandlers = {
    onStartWork: (actionId: string) => run(window.livingMap.commands.startWork({ actionId })),
    onPauseWork: (actionId: string) => run(window.livingMap.commands.pauseWork({ actionId })),
    onCompleteAction: (id: string, expectedVersion: number) =>
      run(window.livingMap.commands.completeAction({ id, expectedVersion })),
    onSetDailyWorkTarget: (minutes: number) => run(window.livingMap.commands.setDailyWorkTarget({ minutes })),
  };
  // Prefilled, never auto-sent: the user can edit the request first.
  const askAi = (text: string) => {
    setPlusDraft((draft) => (draft.trim() ? draft : text));
    setPlusOpen(true);
  };

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6 font-sans text-sm text-neutral-900">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Живая карта</h1>
        <nav className="flex items-center gap-2">
          <button
            type="button"
            data-testid="plus-open"
            aria-label="Написать Живой карте"
            title="Написать Живой карте"
            className="rounded-full border border-violet-500 bg-violet-600 px-3 text-lg leading-7 text-white"
            onClick={() => setPlusOpen((open) => !open)}
          >
            +
          </button>
          <button
            type="button"
            data-testid="nav-now"
            aria-current={tab === "now"}
            className={tab === "now" ? "font-semibold underline" : ""}
            onClick={() => setTab("now")}
          >
            Сейчас
          </button>
          <button
            type="button"
            data-testid="nav-map"
            aria-current={tab === "map"}
            className={tab === "map" ? "font-semibold underline" : ""}
            onClick={() => setTab("map")}
          >
            Карта
          </button>
          <button
            type="button"
            data-testid="nav-editor"
            aria-current={tab === "editor"}
            className={tab === "editor" ? "font-semibold underline" : ""}
            onClick={() => setTab("editor")}
          >
            Замыслы
          </button>
          <button
            type="button"
            data-testid="nav-memory"
            aria-current={tab === "memory"}
            className={tab === "memory" ? "font-semibold underline" : ""}
            onClick={() => setTab("memory")}
          >
            Память
          </button>
          <button
            type="button"
            data-testid="nav-reviews"
            aria-current={tab === "reviews"}
            className={tab === "reviews" ? "font-semibold underline" : ""}
            onClick={() => setTab("reviews")}
          >
            Разборы
            {(view.reviewInbox.readyReviews > 0 || view.reviewInbox.patternCandidates > 0) && (
              <span data-testid="reviews-badge" className="ml-1 rounded-full bg-violet-600 px-1.5 text-xs text-white">
                {view.reviewInbox.readyReviews + view.reviewInbox.patternCandidates}
              </span>
            )}
          </button>
        </nav>
      </header>

      {lastError && (
        <p data-testid="error" className="rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800">
          {translateErrorCode(lastError.code)}
        </p>
      )}

      {plusOpen && (
        <PlusPanel
          draft={plusDraft}
          onDraftChange={setPlusDraft}
          onClose={() => setPlusOpen(false)}
          captures={captures}
          pendingProposalIds={new Set(view.pendingProposals.filter((p) => p.status === "pending").map((p) => p.id))}
          onSubmit={(rawText) => run(window.livingMap.commands.submitCapture({ rawText }))}
          onRetry={(id) => run(window.livingMap.commands.retryCapture({ id }))}
        />
      )}

      <ProposalsSection
        proposals={view.pendingProposals}
        onAccept={(id) => run(window.livingMap.commands.acceptProposal({ id }))}
        onReject={(id) => run(window.livingMap.commands.rejectProposal({ id }))}
      />

      {tab === "memory" ? (
        <MemoryPanel onForget={(id) => run(window.livingMap.commands.forgetMemory({ id }))} />
      ) : tab === "reviews" ? (
        <ReviewsPanel
          onRetry={(id) => run(window.livingMap.commands.retryReview({ id }))}
          onAcceptFinding={(id) => run(window.livingMap.commands.acceptReviewFinding({ id }))}
          onCorrectFinding={(id, text, keepPattern) =>
            run(window.livingMap.commands.correctReviewFinding({ id, text, keepPattern }))
          }
          onRejectFinding={(id) => run(window.livingMap.commands.rejectReviewFinding({ id }))}
          onConfirmPattern={(id) => run(window.livingMap.commands.confirmPattern({ id }))}
          onRejectPattern={(id) => run(window.livingMap.commands.rejectPattern({ id }))}
          onDeactivateRule={(id) => run(window.livingMap.commands.deactivatePlanningRule({ id }))}
        />
      ) : tab === "now" ? (
        <NowScreen
          view={view}
          onConnectCalendar={(icalUrl) => run(window.livingMap.commands.connectCalendar({ icalUrl }))}
          onRefreshCalendar={() => run(window.livingMap.commands.refreshCalendar())}
          onDisconnectCalendar={() => run(window.livingMap.commands.disconnectCalendar())}
          onAskReplan={() => askAi("Перестрой текущий порядок действий.")}
          onOpenMap={() => setTab("map")}
          execution={executionHandlers}
        />
      ) : tab === "map" ? (
        <MapScreen
          view={view}
          run={run}
          execution={executionHandlers}
          onAskRebuild={askAi}
          onOpenNow={() => setTab("now")}
        />
      ) : (
        <>
          <SeasonSection
            season={view.season}
            onCreate={(focus) => run(window.livingMap.commands.createSeason({ focus }))}
            onUpdate={(expectedVersion, focus) =>
              run(window.livingMap.commands.updateSeasonFocus({ expectedVersion, focus, startsNewSeason: false }))
            }
          />

          <GoodLifeConditionsSection
            conditions={view.goodLifeConditions}
            onAdd={(text) => run(window.livingMap.commands.addGoodLifeCondition({ text }))}
            onEdit={(id, expectedVersion, text) =>
              run(window.livingMap.commands.editGoodLifeCondition({ id, expectedVersion, text }))
            }
            onRemove={(id, expectedVersion) =>
              run(window.livingMap.commands.removeGoodLifeCondition({ id, expectedVersion }))
            }
            onReorder={(orderedIds) => run(window.livingMap.commands.reorderGoodLifeConditions({ orderedIds }))}
          />

          <RoutineSection
            routines={view.routines}
            handlers={{
              onAdd: (kind, text) => run(window.livingMap.commands.addRoutineItem({ kind, text })),
              onEdit: (id, expectedVersion, patch) =>
                run(window.livingMap.commands.editRoutineItem({ id, expectedVersion, ...patch })),
              onRemove: (id, expectedVersion) =>
                run(window.livingMap.commands.removeRoutineItem({ id, expectedVersion })),
              onReorder: (kind, orderedIds) => run(window.livingMap.commands.reorderRoutineItems({ kind, orderedIds })),
            }}
          />

          <ProjectsSection
            projects={view.projects}
            slots={view.projectSlots}
            onCreateIntention={(title, desiredResult) =>
              run(window.livingMap.commands.createIntention({ title, desiredResult }))
            }
            onUpdateIntention={(id, expectedVersion, title, desiredResult) =>
              run(window.livingMap.commands.updateIntention({ id, expectedVersion, title, desiredResult }))
            }
            onAddStage={(intentionId, title) => run(window.livingMap.commands.addStage({ intentionId, title }))}
            onEditStage={(id, expectedVersion, title) =>
              run(window.livingMap.commands.editStage({ id, expectedVersion, title }))
            }
            onReorderStages={(intentionId, orderedIds) =>
              run(window.livingMap.commands.reorderStages({ intentionId, orderedIds }))
            }
            onSetCurrentStage={(intentionId, stageId) =>
              run(window.livingMap.commands.setCurrentStage({ intentionId, stageId }))
            }
            onAddAction={(stageId, title, doneWhen) =>
              run(window.livingMap.commands.addAction({ stageId, title, doneWhen }))
            }
            onEditAction={(id, expectedVersion, title, doneWhen) =>
              run(window.livingMap.commands.editAction({ id, expectedVersion, title, doneWhen }))
            }
            onCompleteAction={(id, expectedVersion) =>
              run(window.livingMap.commands.completeAction({ id, expectedVersion }))
            }
            onBlockAction={(id, expectedVersion, reason) =>
              run(window.livingMap.commands.blockAction({ id, expectedVersion, reason }))
            }
            onUnblockAction={(id, expectedVersion) =>
              run(window.livingMap.commands.unblockAction({ id, expectedVersion }))
            }
            onReopenAction={(id, expectedVersion) =>
              run(window.livingMap.commands.reopenAction({ id, expectedVersion }))
            }
            onReorderActions={(stageId, orderedIds) =>
              run(window.livingMap.commands.reorderActions({ stageId, orderedIds }))
            }
          />

          <ChangeHistorySection entries={history} />
        </>
      )}
    </main>
  );
}

const ERROR_MESSAGES: Record<AppError["code"], string> = {
  VALIDATION_ERROR: "Проверьте введённые данные.",
  NOT_FOUND: "Не найдено.",
  CONFLICT_RELOAD: "Данные изменились в другом месте — обновите и попробуйте снова.",
  PERMISSION_DENIED: "Действие не разрешено.",
  REQUIRES_CONFIRMATION: "Сначала посмотри, на что это повлияет, и подтверди.",
  STALE_PROPOSAL: STALE_PROPOSAL_TEXT,
  NEEDS_AI_REPLAN: "Нужно перепланирование ИИ.",
  INTEGRATION_UNAVAILABLE: "Внешний сервис недоступен.",
  STORAGE_ERROR: "Не удалось сохранить данные.",
  SCHEMA_INCOMPATIBLE: "Версия данных несовместима с приложением.",
  ACTIVE_PROJECT_LIMIT: PROJECT_LIMIT_TEXT,
};

function translateErrorCode(code: AppError["code"]): string {
  return ERROR_MESSAGES[code] ?? "Произошла ошибка.";
}

const HISTORY_LABELS: Record<string, string> = {
  "season.create": "Задан фокус сезона",
  "season.updateFocus": "Изменён фокус сезона",
  "season.changeSeason": "Начат новый сезон",
  "goodLifeCondition.add": "Добавлено ограничение: чем пользователь не хочет жертвовать",
  "goodLifeCondition.edit": "Изменено ограничение",
  "goodLifeCondition.remove": "Удалено ограничение",
  "goodLifeCondition.reorder": "Изменён порядок ограничений",
  "intention.create": "Создан замысел",
  "intention.update": "Изменён замысел",
  "intention.complete": "Проект завершён",
  "intention.release": "Проект отпущен",
  "intention.defer": "Проект поставлен на паузу",
  "intention.activate": "Проект снова в работе",
  "intention.reopen": "Проект возвращён из завершённых (на паузе)",
  "intention.reorder": "Изменён порядок проектов",
  "strategy.decade.add": "Добавлено десятилетие в карте",
  "strategy.decade.reword": "Уточнена формулировка десятилетия",
  "strategy.decade.course": "Сменён курс десятилетия",
  "strategy.decade.remove": "Убрано десятилетие из карты",
  "strategy.horizon.set": "Задано направление на 3 года",
  "strategy.horizon.reword": "Уточнена формулировка 3 лет",
  "strategy.horizon.course": "Сменён курс на 3 года",
  "strategy.year.set": "Задано направление года",
  "strategy.year.reword": "Уточнена формулировка года",
  "strategy.year.course": "Сменён курс года",
  "strategy.courseChange.resolve": "Отмечено: после смены курса всё пересобрано",
  "routine.add": "Добавлен пункт утра или вечера",
  "routine.edit": "Изменён пункт утра или вечера",
  "routine.remove": "Удалён пункт утра или вечера",
  "routine.reorder": "Изменён порядок утра или вечера",
  "stage.add": "Добавлен этап",
  "stage.edit": "Изменён этап",
  "stage.reorder": "Изменён порядок этапов",
  "stage.setCurrent": "Изменён текущий этап",
  "action.add": "Добавлено действие",
  "action.edit": "Изменено действие",
  "action.complete": "Действие завершено",
  "action.block": "Действие заблокировано",
  "action.unblock": "Действие снова доступно",
  "action.reopen": "Действие возвращено в работу",
  "action.reorder": "Изменён порядок показа действий в этапе",
  "proposal.reject": "Отклонено предложение ИИ",
  "proposal.stale": "Предложение ИИ устарело",
  "plan.reorder": "ИИ изменил порядок действий",
  "work.start": "Работа начата",
  "work.resume": "Работа продолжена",
  "work.pause": "Работа поставлена на паузу",
  "work.recover": "Работа поставлена на паузу после сбоя",
  "settings.dailyWorkTarget": "Изменена рабочая норма",
  "capture.create": "Сохранена запись «+»",
  "capture.retry": "Запись «+» снова ждёт ИИ",
  "capture.processed": "ИИ разобрал запись «+»",
  "memory.save": "ИИ сохранил в память",
  "memory.forget": "Удалено из памяти",
  "review.due": "Готов новый разбор",
  "review.processed": "ИИ разобрал период",
  "review.retry": "Разбор снова ждёт ИИ",
  "review.findingCreated": "ИИ нашёл, что учесть",
  "reviewFinding.accept": "Находка подтверждена",
  "reviewFinding.correct": "Находка исправлена",
  "reviewFinding.reject": "Находка проигнорирована",
  "pattern.candidate": "Похоже, что-то повторяется",
  "pattern.confirm": "Закономерность стала правилом",
  "pattern.reject": "Закономерность не признана правилом",
  "planningRule.activate": "Правило планирования включено",
  "planningRule.deactivate": "Правило планирования отключено",
};

const PROPOSAL_KIND_LABELS: Record<string, string> = {
  route: "ИИ предложил маршрут",
  desired_result: "ИИ предложил новый желаемый результат",
};

const ACCEPTED_LABELS: Record<string, string> = {
  "proposal:route": "Принято предложение ИИ: маршрут",
  "proposal:desired_result": "Принято предложение ИИ: желаемый результат",
  "stage:added": "Из предложения ИИ: добавлен этап",
  "stage:edited": "Из предложения ИИ: изменён этап",
  "action:added": "Из предложения ИИ: добавлено действие",
  "action:edited": "Из предложения ИИ: изменено действие",
  "intention:desired result changed": "Из предложения ИИ: изменён желаемый результат",
};

/** Distinguishes the user's own changes, AI proposals, AI safe reorders and accepted AI changes. */
function translateHistoryEntry(entry: ChangeLogEntryDto): string {
  if (entry.commandType === "proposal.create") return PROPOSAL_KIND_LABELS[entry.summary] ?? "ИИ сделал предложение";
  if (entry.commandType === "proposal.accept") {
    if (entry.entityType === "plan") return "Из предложения ИИ: установлен порядок действий";
    return ACCEPTED_LABELS[`${entry.entityType}:${entry.summary}`] ?? "Принято предложение ИИ";
  }
  return HISTORY_LABELS[entry.commandType] ?? "Изменение";
}

const ACTION_STATUS_LABELS: Record<ActionDto["status"], string> = {
  open: "в работе",
  blocked: "заблокировано",
  done: "готово",
};

function translateActionStatus(status: ActionDto["status"]): string {
  return ACTION_STATUS_LABELS[status] ?? status;
}

function SeasonSection({
  season,
  onCreate,
  onUpdate,
}: {
  season: SeasonDto | null;
  onCreate: (focus: string) => void;
  onUpdate: (expectedVersion: number, focus: string) => void;
}) {
  const [draft, setDraft] = useState(season?.focus ?? "");
  useEffect(() => setDraft(season?.focus ?? ""), [season?.focus]);
  return (
    <section data-testid="season" className="space-y-1 rounded border p-3">
      <h2 className="font-semibold">Фокус сезона</h2>
      <textarea
        data-testid="season-focus"
        className="w-full rounded border px-2 py-1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
      />
      {season && (
        <p className="text-xs text-neutral-600">
          Здесь можно уточнить слова. Если сезон действительно сменился, это делается на вкладке «Карта».
        </p>
      )}
      <button
        type="button"
        data-testid="season-save"
        className="rounded border px-2 py-0.5"
        onClick={() => {
          if (season) onUpdate(season.version, draft);
          else onCreate(draft);
        }}
      >
        Сохранить фокус
      </button>
    </section>
  );
}

function GoodLifeConditionsSection({
  conditions,
  onAdd,
  onEdit,
  onRemove,
  onReorder,
}: {
  conditions: GoodLifeConditionDto[];
  onAdd: (text: string) => void;
  onEdit: (id: string, expectedVersion: number, text: string) => void;
  onRemove: (id: string, expectedVersion: number) => void;
  onReorder: (orderedIds: string[]) => void;
}) {
  const [newText, setNewText] = useState("");
  return (
    <section data-testid="good-life-conditions" className="space-y-2 rounded border p-3">
      <h2 className="font-semibold">Чем ты не хочешь жертвовать ради целей?</h2>
      <ul className="space-y-1">
        {conditions.map((c, i) => (
          <li key={c.id} data-testid="condition" data-id={c.id} className="flex items-center gap-2">
            <EditableText value={c.text} onSave={(text) => onEdit(c.id, c.version, text)} testId="condition-text" />
            <ReorderButtons items={conditions} index={i} onReorder={onReorder} />
            <button type="button" data-testid="condition-remove" onClick={() => onRemove(c.id, c.version)}>
              Удалить
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          data-testid="condition-new"
          className="flex-1 rounded border px-2 py-1"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="Например: сном, здоровьем, отношениями, свободным временем..."
        />
        <button
          type="button"
          data-testid="condition-add"
          onClick={() => {
            onAdd(newText);
            setNewText("");
          }}
        >
          Добавить
        </button>
      </div>
    </section>
  );
}

function CreateIntentionForm({
  onCreate,
  full,
}: {
  onCreate: (title: string, desiredResult: string) => void;
  full: boolean;
}) {
  const [title, setTitle] = useState("");
  const [desiredResult, setDesiredResult] = useState("");
  return (
    <section data-testid="intention-create" className="space-y-2 rounded border p-3">
      <h2 className="font-semibold">Новый замысел</h2>
      {full && (
        <p data-testid="intention-limit-note" className="text-amber-800">
          {PROJECT_LIMIT_TEXT}
        </p>
      )}
      <input
        data-testid="intention-title-new"
        className="w-full rounded border px-2 py-1"
        placeholder="Название замысла"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        data-testid="intention-desired-result-new"
        className="w-full rounded border px-2 py-1"
        placeholder="Что должно стать реальностью, чтобы этот замысел считался воплощённым?"
        value={desiredResult}
        onChange={(e) => setDesiredResult(e.target.value)}
      />
      <button
        type="button"
        data-testid="intention-create-submit"
        onClick={() => {
          onCreate(title, desiredResult);
          setTitle("");
          setDesiredResult("");
        }}
      >
        Создать замысел
      </button>
    </section>
  );
}

type ProjectHandlers = {
  onCreateIntention: (title: string, desiredResult: string) => void;
  onUpdateIntention: (id: string, expectedVersion: number, title: string, desiredResult: string) => void;
  onAddStage: (intentionId: string, title: string) => void;
  onEditStage: (id: string, expectedVersion: number, title: string) => void;
  onReorderStages: (intentionId: string, orderedIds: string[]) => void;
  onSetCurrentStage: (intentionId: string, stageId: string) => void;
  onAddAction: (stageId: string, title: string, doneWhen: string) => void;
  onEditAction: (id: string, expectedVersion: number, title: string, doneWhen: string) => void;
  onCompleteAction: (id: string, expectedVersion: number) => void;
  onBlockAction: (id: string, expectedVersion: number, reason: string) => void;
  onUnblockAction: (id: string, expectedVersion: number) => void;
  onReopenAction: (id: string, expectedVersion: number) => void;
  onReorderActions: (stageId: string, orderedIds: string[]) => void;
};

type IntentionSectionProps = ProjectHandlers & {
  intention: IntentionDto | null;
  stages: StageWithActionsDto[];
  plan: OrderedActionPlanDto | null;
  unplannedActionIds: string[];
};

/** Every project of the Season (up to three active) with its own route, then the form for a new one. */
function ProjectsSection({
  projects,
  slots,
  ...handlers
}: ProjectHandlers & { projects: ProjectViewDto[]; slots: CurrentViewDto["projectSlots"] }) {
  return (
    <div className="space-y-3">
      {projects.map((project) => (
        <IntentionEditor
          key={project.intention.id}
          {...handlers}
          intention={project.intention}
          stages={project.stages}
          plan={project.orderedActionPlan}
          unplannedActionIds={project.unplannedActionIds}
        />
      ))}
      <CreateIntentionForm onCreate={handlers.onCreateIntention} full={slots.active >= slots.max} />
    </div>
  );
}

function IntentionEditor(props: IntentionSectionProps & { intention: IntentionDto }) {
  const { intention } = props;
  const [titleDraft, setTitleDraft] = useState(intention.title);
  const [resultDraft, setResultDraft] = useState(intention.desiredResult);
  useEffect(() => {
    setTitleDraft(intention.title);
    setResultDraft(intention.desiredResult);
  }, [intention.title, intention.desiredResult]);
  const dirty = titleDraft !== intention.title || resultDraft !== intention.desiredResult;

  return (
    <section data-testid="intention" className="space-y-3 rounded border p-3">
      <h2 className="font-semibold">
        Замысел
        {intention.status === "deferred" && <span className="ml-2 font-normal text-neutral-500">на паузе</span>}
      </h2>
      <input
        data-testid="intention-title"
        className="w-full rounded border px-2 py-1 font-medium"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
      />
      <textarea
        data-testid="intention-desired-result"
        className="w-full rounded border px-2 py-1"
        placeholder="Желаемый результат"
        value={resultDraft}
        onChange={(e) => setResultDraft(e.target.value)}
      />
      {dirty && (
        <button
          type="button"
          data-testid="intention-save"
          onClick={() => props.onUpdateIntention(intention.id, intention.version, titleDraft, resultDraft)}
        >
          Сохранить замысел
        </button>
      )}

      <StagesSection {...props} />
      <PlanSection plan={props.plan} stages={props.stages} unplannedActionIds={props.unplannedActionIds} />
    </section>
  );
}

function StagesSection({ intention, stages, ...handlers }: IntentionSectionProps & { intention: IntentionDto }) {
  const [newTitle, setNewTitle] = useState("");
  return (
    <div data-testid="stages" className="space-y-3 border-t pt-3">
      <h3 className="font-semibold">Этапы</h3>
      {stages.map((stage, i) => (
        <StageBlock key={stage.id} stage={stage} stages={stages} index={i} intention={intention} {...handlers} />
      ))}
      <div className="flex gap-2">
        <input
          data-testid="stage-new"
          className="flex-1 rounded border px-2 py-1"
          placeholder="Название нового этапа"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <button
          type="button"
          data-testid="stage-add"
          onClick={() => {
            handlers.onAddStage(intention.id, newTitle);
            setNewTitle("");
          }}
        >
          Добавить этап
        </button>
      </div>
    </div>
  );
}

function StageBlock({
  stage,
  stages,
  index,
  intention,
  ...handlers
}: IntentionSectionProps & {
  stage: StageWithActionsDto;
  stages: StageWithActionsDto[];
  index: number;
  intention: IntentionDto;
}) {
  return (
    <div
      data-testid="stage"
      data-id={stage.id}
      className={`space-y-2 rounded border p-2 ${stage.isCurrent ? "border-blue-400 bg-blue-50" : ""}`}
    >
      <div className="flex items-center gap-2">
        <EditableText
          testId="stage-title"
          value={stage.title}
          onSave={(title) => handlers.onEditStage(stage.id, stage.version, title)}
        />
        <ReorderButtons items={stages} index={index} onReorder={(ids) => handlers.onReorderStages(intention.id, ids)} />
        {stage.isCurrent ? (
          <span data-testid="stage-current-badge">текущий</span>
        ) : (
          <button
            type="button"
            data-testid="stage-set-current"
            onClick={() => handlers.onSetCurrentStage(intention.id, stage.id)}
          >
            Сделать текущим
          </button>
        )}
      </div>
      <ActionsSection
        stage={stage}
        onAddAction={handlers.onAddAction}
        onEditAction={handlers.onEditAction}
        onCompleteAction={handlers.onCompleteAction}
        onBlockAction={handlers.onBlockAction}
        onUnblockAction={handlers.onUnblockAction}
        onReopenAction={handlers.onReopenAction}
        onReorderActions={handlers.onReorderActions}
      />
    </div>
  );
}

function ActionsSection({
  stage,
  onAddAction,
  onEditAction,
  onCompleteAction,
  onBlockAction,
  onUnblockAction,
  onReopenAction,
  onReorderActions,
}: Pick<
  IntentionSectionProps,
  | "onAddAction"
  | "onEditAction"
  | "onCompleteAction"
  | "onBlockAction"
  | "onUnblockAction"
  | "onReopenAction"
  | "onReorderActions"
> & { stage: StageWithActionsDto }) {
  const [newTitle, setNewTitle] = useState("");
  const [newDoneWhen, setNewDoneWhen] = useState("");
  return (
    <div data-testid="actions" className="space-y-2 pl-4">
      {stage.actions.map((action, i) => (
        <ActionRow
          key={action.id}
          action={action}
          actions={stage.actions}
          index={i}
          onEditAction={onEditAction}
          onCompleteAction={onCompleteAction}
          onBlockAction={onBlockAction}
          onUnblockAction={onUnblockAction}
          onReopenAction={onReopenAction}
          onReorderActions={(ids) => onReorderActions(stage.id, ids)}
        />
      ))}
      <div className="flex gap-2">
        <input
          data-testid="action-title-new"
          className="rounded border px-2 py-0.5"
          placeholder="Новое действие"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <input
          data-testid="action-done-when-new"
          className="flex-1 rounded border px-2 py-0.5"
          placeholder="Готово, когда"
          value={newDoneWhen}
          onChange={(e) => setNewDoneWhen(e.target.value)}
        />
        <button
          type="button"
          data-testid="action-add"
          onClick={() => {
            onAddAction(stage.id, newTitle, newDoneWhen);
            setNewTitle("");
            setNewDoneWhen("");
          }}
        >
          Добавить действие
        </button>
      </div>
    </div>
  );
}

function ActionRow({
  action,
  actions,
  index,
  onEditAction,
  onCompleteAction,
  onBlockAction,
  onUnblockAction,
  onReopenAction,
  onReorderActions,
}: {
  action: ActionDto;
  actions: ActionDto[];
  index: number;
  onEditAction: (id: string, expectedVersion: number, title: string, doneWhen: string) => void;
  onCompleteAction: (id: string, expectedVersion: number) => void;
  onBlockAction: (id: string, expectedVersion: number, reason: string) => void;
  onUnblockAction: (id: string, expectedVersion: number) => void;
  onReopenAction: (id: string, expectedVersion: number) => void;
  onReorderActions: (orderedIds: string[]) => void;
}) {
  const [blockReason, setBlockReason] = useState("");
  return (
    <div data-testid="action" data-id={action.id} data-status={action.status} className="space-y-1 rounded border p-2">
      <div className="flex items-center gap-2">
        <EditableText
          testId="action-title"
          value={action.title}
          onSave={(title) => onEditAction(action.id, action.version, title, action.doneWhen)}
        />
        <ReorderButtons items={actions} index={index} onReorder={onReorderActions} />
        <span data-testid="action-status">{translateActionStatus(action.status)}</span>
      </div>
      <EditableText
        testId="action-done-when"
        value={action.doneWhen}
        onSave={(doneWhen) => onEditAction(action.id, action.version, action.title, doneWhen)}
      />
      {action.status === "blocked" && action.blocker && (
        <p data-testid="action-blocker-reason" className="text-red-700">
          Причина блокировки: {action.blocker.reason}
        </p>
      )}
      <div className="flex gap-2">
        {action.status === "open" && (
          <>
            <button
              type="button"
              data-testid="action-complete"
              onClick={() => onCompleteAction(action.id, action.version)}
            >
              Готово
            </button>
            <input
              data-testid="action-block-reason"
              className="rounded border px-1"
              placeholder="Причина блокировки"
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
            />
            <button
              type="button"
              data-testid="action-block"
              onClick={() => onBlockAction(action.id, action.version, blockReason)}
            >
              Заблокировать
            </button>
          </>
        )}
        {action.status === "blocked" && (
          <button type="button" data-testid="action-unblock" onClick={() => onUnblockAction(action.id, action.version)}>
            Разблокировать
          </button>
        )}
        {action.status === "done" && (
          <button type="button" data-testid="action-reopen" onClick={() => onReopenAction(action.id, action.version)}>
            Вернуть в работу
          </button>
        )}
      </div>
    </div>
  );
}

function ChangeHistorySection({ entries }: { entries: ChangeLogEntryDto[] }) {
  return (
    <section data-testid="change-history" className="space-y-1 rounded border p-3">
      <details data-testid="change-history-details">
        <summary className="cursor-pointer font-semibold">История изменений</summary>
        <ul className="mt-1 space-y-0.5 text-neutral-600">
          {entries.map((entry) => (
            <li key={entry.id} data-testid="history-entry">
              {translateHistoryEntry(entry)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
