import type {
  AiFailure,
  PatternDto,
  PlanningRuleDto,
  ReviewDto,
  ReviewFindingDto,
  ReviewType,
  ReviewWithFindingsDto,
} from "@living-map/contracts";
import { useCallback, useEffect, useState } from "react";
import { FAILURE_TEXT } from "./plus";

function failureText(code: string | null): string {
  if (!code) return "";
  return Object.hasOwn(FAILURE_TEXT, code) ? FAILURE_TEXT[code as AiFailure] : FAILURE_TEXT.failed;
}

const TYPE_LABELS: Record<ReviewType, string> = {
  daily: "День",
  weekly: "Неделя",
  seasonal: "Сезон",
  yearly: "Год",
};

const STATUS_LABELS: Record<ReviewDto["status"], string> = {
  needs_ai: "Ждёт ИИ",
  processing: "Разбирается",
  ready: "Готово",
  no_useful_change: "Без изменений",
  failed: "Не удалось",
};

const FINDING_STATUS_LABELS: Record<ReviewFindingDto["status"], string> = {
  proposed: "",
  accepted: "Принято",
  corrected: "Исправлено",
  rejected: "Не моё",
};

// ponytail: correct for 1 and 2–4 (the common range — MIN_PATTERN_EVIDENCE starts at 2); 5+ still
// reads fine as the "many" form even though it's not grammatically the sharpest — not worth a full
// Russian pluralizer for a count that realistically stays small.
function pluralize(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  return n >= 2 && n <= 4 ? few : many;
}

function formatPeriod(review: Pick<ReviewDto, "type" | "periodStart" | "periodEnd" | "timeZone">): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { timeZone: review.timeZone });
  const start = fmt(review.periodStart);
  // periodEnd is exclusive (the instant the next period starts) — show the last day actually included.
  const end = fmt(new Date(new Date(review.periodEnd).getTime() - 1).toISOString());
  return review.type === "daily" ? start : `${start} — ${end}`;
}

type Handlers = {
  onRetry: (id: string) => Promise<{ ok: boolean }>;
  onAcceptFinding: (id: string) => Promise<{ ok: boolean }>;
  onCorrectFinding: (id: string, text: string, keepPattern: boolean) => Promise<{ ok: boolean }>;
  onRejectFinding: (id: string) => Promise<{ ok: boolean }>;
  onConfirmPattern: (id: string) => Promise<{ ok: boolean }>;
  onRejectPattern: (id: string) => Promise<{ ok: boolean }>;
  onDeactivateRule: (id: string) => Promise<{ ok: boolean }>;
};

/** Compact evidence list, shared by a finding's own evidence and a Pattern's supporting findings (M4). */
function EvidenceList({ items }: { items: readonly { id: string; text: string }[] }) {
  if (items.length === 0) return null;
  return (
    <ul data-testid="evidence-items" className="space-y-0.5 text-xs text-neutral-600">
      {items.map((item) => (
        <li key={item.id} className="pl-2">
          — {item.text}
        </li>
      ))}
    </ul>
  );
}

/** «Разборы» (Stage 7): a learning surface — «Что стоит учитывать дальше», not a diary. */
export function ReviewsPanel(handlers: Handlers) {
  const [reviews, setReviews] = useState<ReviewDto[] | null>(null);
  const [selected, setSelected] = useState<ReviewWithFindingsDto | null>(null);
  const [candidates, setCandidates] = useState<PatternDto[] | null>(null);
  const [rules, setRules] = useState<PlanningRuleDto[] | null>(null);

  const load = useCallback(async () => {
    // Matches the nav badge's own scan window (`reviewInbox`, application.ts) so a ready Review that
    // still needs a decision is never pushed out of the badge count and out of this list at once.
    const [reviewsResult, candidatesResult, rulesResult] = await Promise.all([
      window.livingMap.queries.listReviews({ limit: 200 }),
      window.livingMap.queries.listPatternCandidates({ limit: 20 }),
      window.livingMap.queries.listPlanningRules({ limit: 50 }),
    ]);
    if (reviewsResult.ok) setReviews(reviewsResult.value);
    if (candidatesResult.ok) setCandidates(candidatesResult.value);
    if (rulesResult.ok) setRules(rulesResult.value);
  }, []);

  useEffect(() => {
    void load();
    return window.livingMap.events.onStateChanged(() => void load());
  }, [load]);

  const openReview = useCallback(async (id: string) => {
    const r = await window.livingMap.queries.getReview({ id });
    if (r.ok) setSelected(r.value);
  }, []);

  // Keeps an open detail view fresh after accept/correct/reject (each bumps state_revision).
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) return;
    return window.livingMap.events.onStateChanged(() => void openReview(selectedId));
  }, [selectedId, openReview]);

  const activeRules = rules?.filter((r) => r.status === "active") ?? [];
  const inactiveRules = rules?.filter((r) => r.status === "inactive") ?? [];

  return (
    <section data-testid="reviews" className="space-y-4">
      <h2 className="font-semibold">Разборы</h2>
      <p className="text-xs text-neutral-500">То, что стоит запомнить на будущее — не дневник и не отчёт о дне.</p>

      {!!candidates?.length && (
        <div data-testid="pattern-candidates" className="space-y-2 rounded border border-violet-300 bg-violet-50 p-3">
          <h3 className="font-semibold">Кажется, это повторяется</h3>
          {candidates.map((c) => (
            <div
              key={c.id}
              data-testid="pattern-candidate"
              data-id={c.id}
              className="space-y-1 rounded border bg-white p-2"
            >
              <p>{c.text}</p>
              <details data-testid="pattern-evidence">
                {/* M-C fix: count distinct reviews, not raw findings — sibling findings from the same
                    Review are not "different разборы" and would otherwise inflate this number. */}
                <summary className="cursor-pointer text-xs text-neutral-500">
                  Уже {c.supportingFindings.length} {pluralize(c.supportingFindings.length, "раз", "раза", "раз")} (
                  {(() => {
                    const n = new Set(c.supportingFindings.map((f) => f.reviewId)).size;
                    return `${n} разных ${pluralize(n, "разбор", "разбора", "разборов")}`;
                  })()}) — на чём это основано
                </summary>
                <ul className="mt-1 space-y-1">
                  {c.supportingFindings.map((f) => (
                    <li key={f.id} className="rounded border-l-2 border-violet-200 pl-2">
                      <p className="text-xs">
                        {TYPE_LABELS[f.reviewType]} · {f.text}
                      </p>
                      <EvidenceList items={f.evidenceItems} />
                    </li>
                  ))}
                </ul>
              </details>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="pattern-confirm"
                  onClick={() => void handlers.onConfirmPattern(c.id)}
                >
                  Учитывать дальше
                </button>
                <button type="button" data-testid="pattern-reject" onClick={() => void handlers.onRejectPattern(c.id)}>
                  Не учитывать
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {candidates?.length === 0 && (
        <p data-testid="no-pattern-candidates" className="text-xs text-neutral-500">
          Пока ничего не повторилось достаточно явно.
        </p>
      )}

      {!!activeRules.length && (
        <div data-testid="planning-rules" className="space-y-1 rounded border p-3">
          <h3 className="font-semibold">Что учитывать дальше</h3>
          <ul className="space-y-1">
            {activeRules.map((r) => (
              <li
                key={r.id}
                data-testid="planning-rule"
                data-id={r.id}
                className="flex items-center justify-between gap-2"
              >
                <span>{r.text}</span>
                <button
                  type="button"
                  data-testid="planning-rule-deactivate"
                  onClick={() => void handlers.onDeactivateRule(r.id)}
                >
                  Отключить
                </button>
              </li>
            ))}
          </ul>
          {!!inactiveRules.length && (
            <details data-testid="inactive-rules">
              <summary className="cursor-pointer text-xs text-neutral-500">
                Отключённые ({inactiveRules.length})
              </summary>
              <ul className="mt-1 space-y-0.5 text-neutral-500">
                {inactiveRules.map((r) => (
                  <li key={r.id}>{r.text}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {rules !== null && activeRules.length === 0 && (
        <p data-testid="no-planning-rules" className="text-xs text-neutral-500">
          Пока нечего учитывать на будущее.
        </p>
      )}

      <div data-testid="review-list" className="space-y-1">
        {reviews?.length === 0 && <p className="text-neutral-500">Пока нет разборов.</p>}
        {reviews?.map((r) => (
          <div
            key={r.id}
            data-testid="review-item"
            data-id={r.id}
            data-status={r.status}
            className={`flex items-center justify-between gap-2 rounded border px-2 py-1 ${selected?.id === r.id ? "border-blue-400 bg-blue-50" : ""}`}
          >
            <button type="button" className="flex-1 text-left" onClick={() => void openReview(r.id)}>
              <span className="font-medium">{TYPE_LABELS[r.type]}</span> · {formatPeriod(r)} ·{" "}
              <span data-testid="review-status">{STATUS_LABELS[r.status]}</span>
            </button>
            {r.status === "failed" && (
              <button type="button" data-testid="review-retry" onClick={() => void handlers.onRetry(r.id)}>
                Повторить
              </button>
            )}
          </div>
        ))}
      </div>

      {selected && (
        <ReviewDetail
          review={selected}
          onAcceptFinding={handlers.onAcceptFinding}
          onCorrectFinding={handlers.onCorrectFinding}
          onRejectFinding={handlers.onRejectFinding}
        />
      )}
    </section>
  );
}

function ReviewDetail({
  review,
  onAcceptFinding,
  onCorrectFinding,
  onRejectFinding,
}: {
  review: ReviewWithFindingsDto;
  onAcceptFinding: Handlers["onAcceptFinding"];
  onCorrectFinding: Handlers["onCorrectFinding"];
  onRejectFinding: Handlers["onRejectFinding"];
}) {
  return (
    <div data-testid="review-detail" className="space-y-2 rounded border p-3">
      <h3 className="font-semibold">
        {TYPE_LABELS[review.type]} · {formatPeriod(review)}
      </h3>
      {review.status === "no_useful_change" && (
        <p data-testid="review-no-useful-change" className="text-neutral-500">
          Тут как будто всё было как обычно — учитывать особо нечего.
        </p>
      )}
      {review.status === "failed" && (
        <p data-testid="review-failed" className="text-red-700">
          Не получилось разобраться: {failureText(review.lastError)}
        </p>
      )}
      {(review.status === "needs_ai" || review.status === "processing") && (
        <p className="text-neutral-500">
          {review.status === "processing" ? "Сейчас разбираюсь…" : "Ещё не разобрано."}
        </p>
      )}
      {review.findings.length > 0 && (
        <ul className="space-y-2">
          {review.findings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              onAccept={onAcceptFinding}
              onCorrect={onCorrectFinding}
              onReject={onRejectFinding}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingRow({
  finding,
  onAccept,
  onCorrect,
  onReject,
}: {
  finding: ReviewFindingDto;
  onAccept: Handlers["onAcceptFinding"];
  onCorrect: Handlers["onCorrectFinding"];
  onReject: Handlers["onRejectFinding"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(finding.text);
  const [keepPattern, setKeepPattern] = useState(false);

  return (
    <li
      data-testid="review-finding"
      data-id={finding.id}
      data-status={finding.status}
      className="space-y-1 rounded border p-2"
    >
      {editing ? (
        <div className="space-y-1">
          <textarea
            data-testid="finding-edit-text"
            className="w-full rounded border px-2 py-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
          />
          {finding.patternKey && (
            <label className="flex items-center gap-2 text-xs text-neutral-600">
              <input
                type="checkbox"
                data-testid="finding-keep-pattern"
                checked={keepPattern}
                onChange={(e) => setKeepPattern(e.target.checked)}
              />
              Это просто другие слова о том же, не другая суть
            </label>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="finding-edit-save"
              onClick={async () => {
                if ((await onCorrect(finding.id, draft, keepPattern)).ok) setEditing(false);
              }}
            >
              Сохранить
            </button>
            <button type="button" data-testid="finding-edit-cancel" onClick={() => setEditing(false)}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap">{finding.status === "corrected" ? finding.correctedText : finding.text}</p>
      )}
      <EvidenceList items={finding.evidenceItems} />
      {finding.suggestion && <p className="text-xs text-neutral-600">Может, стоит: {finding.suggestion}</p>}
      {finding.status === "proposed" && !editing && (
        <div className="flex gap-2 text-xs">
          <button type="button" data-testid="finding-accept" onClick={() => void onAccept(finding.id)}>
            Да, это про меня
          </button>
          <button
            type="button"
            data-testid="finding-edit"
            onClick={() => {
              setDraft(finding.text);
              setKeepPattern(false);
              setEditing(true);
            }}
          >
            Поправить
          </button>
          <button type="button" data-testid="finding-reject" onClick={() => void onReject(finding.id)}>
            Нет, не про меня
          </button>
        </div>
      )}
      {finding.status !== "proposed" && (
        <p data-testid="finding-status" className="text-xs text-neutral-500">
          {FINDING_STATUS_LABELS[finding.status]}
        </p>
      )}
    </li>
  );
}
