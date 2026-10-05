import type { AiFailure, CaptureDto } from "@living-map/contracts";
import { useEffect, useRef, useState } from "react";

export const FAILURE_TEXT: Record<AiFailure, string> = {
  not_installed: "На этом компьютере не найден Claude Code — установи его и войди в аккаунт.",
  not_authenticated: "ИИ не авторизован — открой Claude Code и войди в аккаунт claude.ai.",
  rate_limited: "Лимит ИИ по подписке исчерпан — попробуй позже.",
  offline: "Нет связи с ИИ — проверь интернет.",
  timeout: "ИИ не ответил вовремя.",
  malformed: "ИИ вернул непонятный ответ.",
  mcp_failed: "ИИ не смог подключиться к данным Живой карты.",
  failed: "ИИ не справился с разбором.",
};

/** The AI only suggests «Быт» for a clear one-off errand; the owner decides with one click (Stage 9, Day 1). */
function HouseholdSuggestion({
  capture,
  onAddHousehold,
}: {
  capture: CaptureDto;
  onAddHousehold: (captureId: string, text: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const result = capture.result;
  const text = result?.kind === "household" && "householdText" in result ? result.householdText : null;
  if (!text) return null;
  if (capture.householdItemId) {
    return (
      <p data-testid="capture-household-added" className="text-xs text-neutral-600">
        В «Быте»: {text}
      </p>
    );
  }
  return (
    <button
      type="button"
      data-testid="capture-household-add"
      className="rounded border border-violet-400 px-2 py-0.5 text-xs disabled:opacity-50"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onAddHousehold(capture.id, text);
        } finally {
          setBusy(false);
        }
      }}
    >
      Добавить в «Быт»: {text}
    </button>
  );
}

function CaptureStatus({
  capture,
  pendingProposalIds,
  onRetry,
  onAddHousehold,
}: {
  capture: CaptureDto;
  pendingProposalIds: ReadonlySet<string>;
  onRetry: (id: string) => Promise<unknown>;
  onAddHousehold: (captureId: string, text: string) => Promise<unknown>;
}) {
  if (capture.state === "pending") return <p className="text-xs text-neutral-500">Сохранено · ждёт ИИ</p>;
  if (capture.state === "processing") return <p className="text-xs text-violet-700">ИИ разбирает…</p>;
  if (capture.state === "failed") {
    return (
      <div className="space-y-1 text-xs">
        <p className="text-amber-800">Сохранено, но ИИ сейчас недоступен</p>
        {capture.lastError && <p className="text-neutral-600">{FAILURE_TEXT[capture.lastError]}</p>}
        <button
          type="button"
          data-testid="capture-retry"
          className="rounded border px-2 py-0.5"
          onClick={() => onRetry(capture.id)}
        >
          Повторить
        </button>
      </div>
    );
  }
  const proposalId = capture.result?.proposalId;
  return (
    <div className="space-y-1">
      {capture.result && (
        <p data-testid="capture-reply" className="whitespace-pre-wrap">
          {capture.result.reply}
        </p>
      )}
      {capture.memories.map((m) => (
        <p key={m.id} data-testid="capture-memory" className="text-xs text-neutral-600">
          Запомнила: {m.text}
        </p>
      ))}
      <HouseholdSuggestion capture={capture} onAddHousehold={onAddHousehold} />
      {proposalId && pendingProposalIds.has(proposalId) && (
        <p data-testid="capture-proposal" className="text-xs font-medium text-blue-800">
          Предложение ИИ ждёт твоего решения — оно вверху экрана.
        </p>
      )}
    </div>
  );
}

/** The universal `+` (Stage 6): one door, no "what is this?" choice before sending. Not a chat screen. */
export function PlusPanel({
  draft,
  onDraftChange,
  onClose,
  captures,
  pendingProposalIds,
  onSubmit,
  onRetry,
  onAddHousehold,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  onClose: () => void;
  captures: CaptureDto[];
  pendingProposalIds: ReadonlySet<string>;
  onSubmit: (rawText: string) => Promise<{ ok: boolean }>;
  onRetry: (id: string) => Promise<unknown>;
  onAddHousehold: (captureId: string, text: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);

  const send = async () => {
    if (sending.current || draft.trim().length === 0) return; // one click = one Capture, even on a fast double click
    sending.current = true;
    setBusy(true);
    try {
      if ((await onSubmit(draft)).ok) onDraftChange("");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <section data-testid="plus" className="space-y-3 rounded border-2 border-violet-300 bg-violet-50 p-3">
      <textarea
        ref={input}
        data-testid="plus-input"
        className="w-full rounded border bg-white px-2 py-1"
        rows={3}
        placeholder="Напиши что угодно: мысль, дело, вопрос, решение, событие…"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
        }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="plus-send"
          className="rounded border border-violet-500 bg-violet-600 px-3 py-1 text-white disabled:opacity-50"
          disabled={busy || draft.trim().length === 0}
          onClick={() => void send()}
        >
          Отправить
        </button>
        <button type="button" data-testid="plus-close" className="px-2 py-1" onClick={onClose}>
          Свернуть
        </button>
        <span className="text-xs text-neutral-500">Ctrl+Enter — отправить</span>
      </div>
      {captures.length > 0 && (
        <ul className="space-y-2 border-t border-violet-200 pt-2">
          {captures.map((c) => (
            <li key={c.id} data-testid="capture" data-state={c.state} className="space-y-1">
              <p className="line-clamp-3 whitespace-pre-wrap text-neutral-500">{c.rawText}</p>
              <CaptureStatus
                capture={c}
                pendingProposalIds={pendingProposalIds}
                onRetry={onRetry}
                onAddHousehold={onAddHousehold}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
