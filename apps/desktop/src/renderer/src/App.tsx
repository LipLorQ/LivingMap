import type {
  ActionDto,
  AppError,
  ChangeLogEntryDto,
  CurrentViewDto,
  GoodLifeConditionDto,
  IntentionDto,
  OrderedActionPlanDto,
  Result,
  SeasonDto,
  StageWithActionsDto,
} from "@living-map/contracts";
import { useCallback, useEffect, useState } from "react";
import { NowScreen } from "./now-screen";
import { PlanSection, ProposalsSection, STALE_PROPOSAL_TEXT } from "./proposals";

type Tab = "now" | "editor";

// Stage 4: "Сейчас" is the default screen (execution interface); the previous utilitarian
// editing screen moves behind a "Замысел" tab (direct editing / fallback, per Stage 4 §15).
export function App() {
  const [view, setView] = useState<CurrentViewDto | null>(null);
  const [history, setHistory] = useState<ChangeLogEntryDto[]>([]);
  const [lastError, setLastError] = useState<AppError | null>(null);
  const [tab, setTab] = useState<Tab>("now");

  const reload = useCallback(async () => {
    const [viewResult, historyResult] = await Promise.all([
      window.livingMap.queries.getCurrentView(),
      window.livingMap.queries.listChangeHistory({ limit: 20 }),
    ]);
    if (viewResult.ok) setView(viewResult.value);
    if (historyResult.ok) setHistory(historyResult.value);
  }, []);

  useEffect(() => {
    void reload();
    return window.livingMap.events.onStateChanged(() => void reload());
  }, [reload]);

  const run = useCallback(
    async <T,>(action: Promise<Result<T>>): Promise<Result<T>> => {
      const r = await action;
      setLastError(r.ok ? null : r.error);
      if (r.ok) void reload();
      return r;
    },
    [reload],
  );

  if (!view) return <main className="p-6 font-sans text-sm">Загрузка…</main>;

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6 font-sans text-sm text-neutral-900">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Живая карта</h1>
        <nav className="flex gap-2">
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
            data-testid="nav-editor"
            aria-current={tab === "editor"}
            className={tab === "editor" ? "font-semibold underline" : ""}
            onClick={() => setTab("editor")}
          >
            Замысел
          </button>
        </nav>
      </header>

      {lastError && (
        <p data-testid="error" className="rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800">
          {translateErrorCode(lastError.code)}
        </p>
      )}

      <ProposalsSection
        proposals={view.pendingProposals}
        onAccept={(id) => run(window.livingMap.commands.acceptProposal({ id }))}
        onReject={(id) => run(window.livingMap.commands.rejectProposal({ id }))}
      />

      {tab === "now" ? (
        <NowScreen
          view={view}
          onConnectCalendar={(icalUrl) => run(window.livingMap.commands.connectCalendar({ icalUrl }))}
          onRefreshCalendar={() => run(window.livingMap.commands.refreshCalendar())}
          onDisconnectCalendar={() => run(window.livingMap.commands.disconnectCalendar())}
        />
      ) : (
        <>
          <SeasonSection
            season={view.season}
            onCreate={(focus) => run(window.livingMap.commands.createSeason({ focus }))}
            onUpdate={(expectedVersion, focus) =>
              run(window.livingMap.commands.updateSeasonFocus({ expectedVersion, focus }))
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

          <IntentionSection
            intention={view.intention}
            stages={view.stages}
            plan={view.orderedActionPlan}
            unplannedActionIds={view.unplannedActionIds}
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
  REQUIRES_CONFIRMATION: "Требуется подтверждение.",
  STALE_PROPOSAL: STALE_PROPOSAL_TEXT,
  NEEDS_AI_REPLAN: "Нужно перепланирование ИИ.",
  INTEGRATION_UNAVAILABLE: "Внешний сервис недоступен.",
  STORAGE_ERROR: "Не удалось сохранить данные.",
  SCHEMA_INCOMPATIBLE: "Версия данных несовместима с приложением.",
};

function translateErrorCode(code: AppError["code"]): string {
  return ERROR_MESSAGES[code] ?? "Произошла ошибка.";
}

const HISTORY_LABELS: Record<string, string> = {
  "season.create": "Задан фокус сезона",
  "season.updateFocus": "Изменён фокус сезона",
  "goodLifeCondition.add": "Добавлено ограничение: чем пользователь не хочет жертвовать",
  "goodLifeCondition.edit": "Изменено ограничение",
  "goodLifeCondition.remove": "Удалено ограничение",
  "goodLifeCondition.reorder": "Изменён порядок ограничений",
  "intention.create": "Создан замысел",
  "intention.update": "Изменён замысел",
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

function reorderIds<T extends { id: string }>(items: readonly T[], index: number, delta: -1 | 1): string[] {
  const ids = items.map((i) => i.id);
  const target = index + delta;
  const swapped = [...ids];
  [swapped[index], swapped[target]] = [swapped[target] as string, swapped[index] as string];
  return swapped;
}

function ReorderButtons<T extends { id: string }>({
  items,
  index,
  onReorder,
}: {
  items: readonly T[];
  index: number;
  onReorder: (orderedIds: string[]) => void;
}) {
  return (
    <span className="space-x-1">
      <button
        type="button"
        data-testid="move-up"
        disabled={index === 0}
        onClick={() => onReorder(reorderIds(items, index, -1))}
      >
        ↑
      </button>
      <button
        type="button"
        data-testid="move-down"
        disabled={index === items.length - 1}
        onClick={() => onReorder(reorderIds(items, index, 1))}
      >
        ↓
      </button>
    </span>
  );
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
      <button
        type="button"
        data-testid="season-save"
        className="rounded border px-2 py-0.5"
        onClick={() => (season ? onUpdate(season.version, draft) : onCreate(draft))}
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

function EditableText({
  value,
  onSave,
  testId,
  multiline = false,
}: {
  value: string;
  onSave: (text: string) => void;
  testId: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const Field = multiline ? "textarea" : "input";
  return (
    <span className="flex flex-1 items-center gap-1">
      <Field
        data-testid={testId}
        className="flex-1 rounded border px-1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {draft !== value && (
        <button type="button" data-testid={`${testId}-save`} onClick={() => onSave(draft)}>
          Сохранить
        </button>
      )}
    </span>
  );
}

function CreateIntentionForm({ onCreate }: { onCreate: (title: string, desiredResult: string) => void }) {
  const [title, setTitle] = useState("");
  const [desiredResult, setDesiredResult] = useState("");
  return (
    <section data-testid="intention-create" className="space-y-2 rounded border p-3">
      <h2 className="font-semibold">Новый замысел</h2>
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

type IntentionSectionProps = {
  intention: IntentionDto | null;
  stages: StageWithActionsDto[];
  plan: OrderedActionPlanDto | null;
  unplannedActionIds: string[];
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

function IntentionSection(props: IntentionSectionProps) {
  if (!props.intention) return <CreateIntentionForm onCreate={props.onCreateIntention} />;
  return <IntentionEditor {...props} intention={props.intention} />;
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
      <h2 className="font-semibold">Замысел</h2>
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
      <h2 className="font-semibold">История изменений</h2>
      <ul className="space-y-0.5 text-neutral-600">
        {entries.map((entry) => (
          <li key={entry.id} data-testid="history-entry">
            {translateHistoryEntry(entry)}
          </li>
        ))}
      </ul>
    </section>
  );
}
