import type {
  ActionDto,
  AppError,
  ChangeLogEntryDto,
  CurrentViewDto,
  GoodLifeConditionDto,
  IntentionDto,
  Result,
  SeasonDto,
  StageWithActionsDto,
} from "@living-map/contracts";
import { useCallback, useEffect, useState } from "react";

// Utilitarian product screen (this stage's prompt §20): clarity, correct behavior, quick editing,
// persistence — deliberately not visually polished. No AI ordering, no Now, no timer.
export function App() {
  const [view, setView] = useState<CurrentViewDto | null>(null);
  const [history, setHistory] = useState<ChangeLogEntryDto[]>([]);
  const [lastError, setLastError] = useState<AppError | null>(null);

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

  if (!view) return <main className="p-6 font-sans text-sm">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6 font-sans text-sm text-neutral-900">
      <header>
        <h1 className="text-lg font-semibold">Living Map</h1>
      </header>

      {lastError && (
        <p data-testid="error" className="rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800">
          {lastError.code}: {lastError.message}
        </p>
      )}

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
        onUnblockAction={(id, expectedVersion) => run(window.livingMap.commands.unblockAction({ id, expectedVersion }))}
        onReorderActions={(stageId, orderedIds) =>
          run(window.livingMap.commands.reorderActions({ stageId, orderedIds }))
        }
      />

      <ChangeHistorySection entries={history} />

      <IsolationFooter />
    </main>
  );
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
      <h2 className="font-semibold">Current Season</h2>
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
        {season ? "Update season" : "Set season"}
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
      <h2 className="font-semibold">Good Life Conditions</h2>
      <ul className="space-y-1">
        {conditions.map((c, i) => (
          <li key={c.id} data-testid="condition" data-id={c.id} className="flex items-center gap-2">
            <EditableText value={c.text} onSave={(text) => onEdit(c.id, c.version, text)} testId="condition-text" />
            <ReorderButtons items={conditions} index={i} onReorder={onReorder} />
            <button type="button" data-testid="condition-remove" onClick={() => onRemove(c.id, c.version)}>
              Remove
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
          placeholder="What must stay true?"
        />
        <button
          type="button"
          data-testid="condition-add"
          onClick={() => {
            onAdd(newText);
            setNewText("");
          }}
        >
          Add
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
          Save
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
      <h2 className="font-semibold">New Intention</h2>
      <input
        data-testid="intention-title-new"
        className="w-full rounded border px-2 py-1"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        data-testid="intention-desired-result-new"
        className="w-full rounded border px-2 py-1"
        placeholder="Desired result: what must become true?"
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
        Create Intention
      </button>
    </section>
  );
}

type IntentionSectionProps = {
  intention: IntentionDto | null;
  stages: StageWithActionsDto[];
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
      <h2 className="font-semibold">Intention</h2>
      <input
        data-testid="intention-title"
        className="w-full rounded border px-2 py-1 font-medium"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
      />
      <textarea
        data-testid="intention-desired-result"
        className="w-full rounded border px-2 py-1"
        placeholder="Desired result"
        value={resultDraft}
        onChange={(e) => setResultDraft(e.target.value)}
      />
      {dirty && (
        <button
          type="button"
          data-testid="intention-save"
          onClick={() => props.onUpdateIntention(intention.id, intention.version, titleDraft, resultDraft)}
        >
          Save Intention
        </button>
      )}

      <StagesSection {...props} />
    </section>
  );
}

function StagesSection({ intention, stages, ...handlers }: IntentionSectionProps & { intention: IntentionDto }) {
  const [newTitle, setNewTitle] = useState("");
  return (
    <div data-testid="stages" className="space-y-3 border-t pt-3">
      <h3 className="font-semibold">Stages</h3>
      {stages.map((stage, i) => (
        <StageBlock key={stage.id} stage={stage} stages={stages} index={i} intention={intention} {...handlers} />
      ))}
      <div className="flex gap-2">
        <input
          data-testid="stage-new"
          className="flex-1 rounded border px-2 py-1"
          placeholder="New stage title"
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
          Add stage
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
          <span data-testid="stage-current-badge">current</span>
        ) : (
          <button
            type="button"
            data-testid="stage-set-current"
            onClick={() => handlers.onSetCurrentStage(intention.id, stage.id)}
          >
            Make current
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
  onReorderActions,
}: Pick<
  IntentionSectionProps,
  "onAddAction" | "onEditAction" | "onCompleteAction" | "onBlockAction" | "onUnblockAction" | "onReorderActions"
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
          onReorderActions={(ids) => onReorderActions(stage.id, ids)}
        />
      ))}
      <div className="flex gap-2">
        <input
          data-testid="action-title-new"
          className="rounded border px-2 py-0.5"
          placeholder="Action title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <input
          data-testid="action-done-when-new"
          className="flex-1 rounded border px-2 py-0.5"
          placeholder="doneWhen"
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
          Add action
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
  onReorderActions,
}: {
  action: ActionDto;
  actions: ActionDto[];
  index: number;
  onEditAction: (id: string, expectedVersion: number, title: string, doneWhen: string) => void;
  onCompleteAction: (id: string, expectedVersion: number) => void;
  onBlockAction: (id: string, expectedVersion: number, reason: string) => void;
  onUnblockAction: (id: string, expectedVersion: number) => void;
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
        <span data-testid="action-status">{action.status}</span>
      </div>
      <EditableText
        testId="action-done-when"
        value={action.doneWhen}
        onSave={(doneWhen) => onEditAction(action.id, action.version, action.title, doneWhen)}
      />
      {action.status === "blocked" && action.blocker && (
        <p data-testid="action-blocker-reason" className="text-red-700">
          Blocked: {action.blocker.reason}
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
              Complete
            </button>
            <input
              data-testid="action-block-reason"
              className="rounded border px-1"
              placeholder="Blocker reason"
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
            />
            <button
              type="button"
              data-testid="action-block"
              onClick={() => onBlockAction(action.id, action.version, blockReason)}
            >
              Block
            </button>
          </>
        )}
        {action.status === "blocked" && (
          <button type="button" data-testid="action-unblock" onClick={() => onUnblockAction(action.id, action.version)}>
            Unblock
          </button>
        )}
      </div>
    </div>
  );
}

function ChangeHistorySection({ entries }: { entries: ChangeLogEntryDto[] }) {
  return (
    <section data-testid="change-history" className="space-y-1 rounded border p-3">
      <h2 className="font-semibold">Recent Changes</h2>
      <ul className="space-y-0.5 text-neutral-600">
        {entries.map((entry) => (
          <li key={entry.id} data-testid="history-entry">
            v{entry.stateRevision} · {entry.actor} · {entry.commandType} · {entry.summary}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IsolationFooter() {
  const isolation = {
    require: typeof (window as unknown as Record<string, unknown>).require,
    process: typeof (window as unknown as Record<string, unknown>).process,
  };
  return (
    <p className="text-neutral-400" data-testid="isolation">
      window.require: {isolation.require} · window.process: {isolation.process}
    </p>
  );
}
