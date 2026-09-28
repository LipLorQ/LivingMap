import type {
  ActionDto,
  OrderedActionPlanDto,
  ProposalDto,
  RoutePreviewDto,
  StageWithActionsDto,
} from "@living-map/contracts";
import { useState } from "react";

export const STALE_PROPOSAL_TEXT =
  "Предложение устарело, потому что Живая карта изменилась. Попроси ИИ пересобрать его.";

const formatDate = (iso: string) => new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });

const ACTION_STATUS: Record<ActionDto["status"], string> = {
  open: "в работе",
  blocked: "заблокировано",
  done: "готово",
};

function kindTitle(p: ProposalDto): string {
  if (p.kind === "desired_result") return "Изменение желаемого результата";
  return p.payload.isFirstRoute ? "Первый маршрут" : "Изменение маршрута";
}

function Badge({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "new" | "changed" }) {
  const colors = {
    neutral: "bg-neutral-100 text-neutral-700",
    new: "bg-green-100 text-green-800",
    changed: "bg-amber-100 text-amber-800",
  }[tone];
  return <span className={`ml-1 rounded px-1 text-xs ${colors}`}>{children}</span>;
}

function Was({ value }: { value: string | null }) {
  if (value === null) return null;
  return <span className="block text-xs text-neutral-500 line-through">было: {value || "—"}</span>;
}

function RoutePreview({ proposal, preview }: { proposal: ProposalDto & { kind: "route" }; preview: RoutePreviewDto }) {
  const p = proposal.payload;
  return (
    <>
      <p data-testid="proposal-summary" className="text-neutral-600">
        Новых этапов: {p.newStages.length} · Переименовано этапов: {p.stageEdits.length} · Новых действий:{" "}
        {p.newActions.length} · Изменено действий: {p.actionEdits.length}
        {p.stageOrder ? " · Меняется последовательность этапов" : ""}
      </p>

      <h4 className="font-semibold">Новый маршрут</h4>
      <ol className="space-y-2">
        {preview.stages.map((stage, i) => (
          <li key={stage.id} data-testid="proposal-stage" className="rounded border p-2">
            <div className="font-medium">
              {i + 1}. {stage.title}
              {stage.isNew && <Badge tone="new">новый этап</Badge>}
              {stage.previousTitle !== null && <Badge tone="changed">переименован</Badge>}
              {stage.isCurrent && <Badge>текущий</Badge>}
            </div>
            <Was value={stage.previousTitle} />
            <ul className="mt-1 space-y-1 pl-4">
              {stage.actions.map((a) => {
                const changed = a.previousTitle !== null || a.previousDoneWhen !== null;
                return (
                  <li
                    key={a.id}
                    data-testid="proposal-action"
                    className={a.status === "done" ? "text-neutral-400" : ""}
                  >
                    {a.title}
                    {a.isNew && <Badge tone="new">новое</Badge>}
                    {changed && <Badge tone="changed">изменено</Badge>}
                    {!a.isNew && !changed && <Badge>{ACTION_STATUS[a.status]}</Badge>}
                    <Was value={a.previousTitle} />
                    <span className="block text-xs text-neutral-600">Готово, когда: {a.doneWhen || "—"}</span>
                    {a.previousDoneWhen !== null && (
                      <span className="block text-xs text-neutral-500 line-through">
                        было «готово, когда»: {a.previousDoneWhen || "—"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>

      <h4 className="font-semibold">Порядок действий</h4>
      <ol data-testid="proposal-order" className="list-decimal space-y-0.5 pl-6">
        {preview.order.map((o) => (
          <li key={o.actionId}>{o.title}</li>
        ))}
      </ol>
    </>
  );
}

function ProposalCard({
  proposal,
  onAccept,
  onReject,
}: {
  proposal: ProposalDto;
  onAccept: () => Promise<unknown>;
  onReject: () => Promise<unknown>;
}) {
  const stale = proposal.status === "stale";
  // One decision at a time: a double click must not fire a second accept/reject.
  const [busy, setBusy] = useState(false);
  const decide = (action: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      data-testid="proposal"
      data-status={proposal.status}
      className="space-y-2 rounded border-2 border-violet-300 bg-violet-50 p-3"
    >
      <h2 className="text-base font-semibold">Предложение ИИ: {kindTitle(proposal)}</h2>
      <p className="text-xs text-neutral-500">от {formatDate(proposal.createdAt)}</p>

      {stale && (
        <p
          data-testid="proposal-stale"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900"
        >
          {STALE_PROPOSAL_TEXT}
        </p>
      )}

      <h3 className="font-semibold">Зачем это</h3>
      <p data-testid="proposal-summary-text" className="whitespace-pre-wrap">
        {proposal.summary}
      </p>

      <details>
        <summary className="cursor-pointer font-medium text-neutral-600">Подробнее о логике</summary>
        <p data-testid="proposal-rationale" className="whitespace-pre-wrap">
          {proposal.rationale}
        </p>
      </details>

      {!stale && (
        <div className="space-y-2">
          <h3 className="font-semibold">Что изменится</h3>
          {proposal.kind === "route" && proposal.preview && (
            <RoutePreview proposal={proposal} preview={proposal.preview} />
          )}
          {proposal.kind === "desired_result" && (
            <div data-testid="proposal-desired-result" className="space-y-1">
              <p className="font-medium">Желаемый результат</p>
              <p className="text-neutral-500 line-through whitespace-pre-wrap">
                было: {proposal.payload.previousDesiredResult || "—"}
              </p>
              <p className="whitespace-pre-wrap">станет: {proposal.payload.desiredResult}</p>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {!stale && (
          <button
            type="button"
            data-testid="proposal-accept"
            className="rounded border border-violet-500 bg-violet-600 px-3 py-1 text-white disabled:opacity-50"
            disabled={busy}
            onClick={decide(onAccept)}
          >
            Подтвердить
          </button>
        )}
        <button
          type="button"
          data-testid="proposal-reject"
          className="rounded border px-3 py-1 disabled:opacity-50"
          disabled={busy}
          onClick={decide(onReject)}
        >
          Отклонить
        </button>
      </div>
    </section>
  );
}

export function ProposalsSection({
  proposals,
  onAccept,
  onReject,
}: {
  proposals: ProposalDto[];
  onAccept: (id: string) => Promise<unknown>;
  onReject: (id: string) => Promise<unknown>;
}) {
  if (proposals.length === 0) return null;
  return (
    <div data-testid="proposals" className="space-y-3">
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} onAccept={() => onAccept(p.id)} onReject={() => onReject(p.id)} />
      ))}
    </div>
  );
}

export function PlanSection({
  plan,
  stages,
  unplannedActionIds,
}: {
  plan: OrderedActionPlanDto | null;
  stages: StageWithActionsDto[];
  unplannedActionIds: string[];
}) {
  const actions = new Map(stages.flatMap((s) => s.actions).map((a) => [a.id, a]));
  return (
    <div data-testid="plan" className="space-y-2 border-t pt-3">
      <h3 className="font-semibold">Порядок действий</h3>
      {!plan ? (
        <p data-testid="plan-empty" className="text-neutral-600">
          Порядок ещё не утверждён. Обсуди замысел с ИИ — он предложит маршрут и порядок, а ты подтвердишь их здесь.
        </p>
      ) : (
        <>
          <ol data-testid="plan-order" className="list-decimal space-y-0.5 pl-6">
            {plan.orderedActionIds.map((id) => {
              const a = actions.get(id);
              return (
                <li
                  key={id}
                  data-testid="plan-item"
                  className={a?.status === "done" ? "text-neutral-400 line-through" : ""}
                >
                  {a?.title ?? "(действие не найдено)"}
                  {a && a.status !== "open" && <Badge>{ACTION_STATUS[a.status]}</Badge>}
                </li>
              );
            })}
          </ol>
          <p className="whitespace-pre-wrap text-neutral-700">
            <span className="font-medium">Почему такой порядок: </span>
            {plan.rationale}
          </p>
          <p className="text-xs text-neutral-500">
            Порядок составил {plan.createdBy === "mcp-ai" ? "ИИ" : "ты"} · обновлён {formatDate(plan.updatedAt)}
          </p>
        </>
      )}
      {unplannedActionIds.length > 0 && (
        <p
          data-testid="plan-unplanned"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900"
        >
          Не входят в порядок: {unplannedActionIds.map((id) => actions.get(id)?.title ?? "?").join(", ")}. Попроси ИИ
          обновить порядок.
        </p>
      )}
      <p className="text-xs text-neutral-500">
        Стрелки ↑↓ у действий меняют только порядок показа внутри этапа, а не порядок действий.
      </p>
    </div>
  );
}
