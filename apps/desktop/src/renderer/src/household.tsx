import type { HouseholdListDto } from "@living-map/contracts";
import { useCallback, useEffect, useState } from "react";
import { civilDayOf, formatDayRu } from "./format";

/**
 * «Быт» (Stage 9, Day 1): a side pocket for small one-off errands of everyday life. Not project work and not a
 * task manager: no timer, no priority, no dates, no order. Done ones leave the list and stay as minimal history.
 */
export function HouseholdPanel({
  onAdd,
  onComplete,
}: {
  onAdd: (text: string) => Promise<{ ok: boolean }>;
  onComplete: (id: string) => Promise<{ ok: boolean }>;
}) {
  const [list, setList] = useState<HouseholdListDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await window.livingMap.queries.listHouseholdItems();
    if (r.ok) setList(r.value);
  }, []);

  useEffect(() => {
    void load();
    return window.livingMap.events.onStateChanged(() => void load());
  }, [load]);

  const once = (work: () => Promise<unknown>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await load();
    } finally {
      setBusy(false);
    }
  };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section data-testid="household" className="space-y-3">
      <h2 className="font-semibold">Быт</h2>
      <p className="text-xs text-neutral-500">
        Мелкие разовые дела жизни — не проекты и не календарь. Делаются в свободное время, без таймера.
      </p>

      {adding ? (
        <div className="flex gap-2">
          <input
            data-testid="household-new"
            className="flex-1 rounded border px-2 py-1"
            placeholder="Например: записаться к врачу"
            maxLength={300}
            value={draft}
            // biome-ignore lint/a11y/noAutofocus: the owner just pressed «+ Добавить» to type right here
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                void once(async () => {
                  if ((await onAdd(draft)).ok) setDraft("");
                })();
              }
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button
            type="button"
            data-testid="household-save"
            className="rounded border border-violet-500 bg-violet-600 px-3 py-1 text-white disabled:opacity-50"
            disabled={busy || draft.trim().length === 0}
            onClick={once(async () => {
              if ((await onAdd(draft)).ok) setDraft("");
            })}
          >
            Сохранить
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            Готово
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="household-add"
          className="rounded border px-3 py-1"
          onClick={() => setAdding(true)}
        >
          + Добавить
        </button>
      )}

      {list?.active.length === 0 && (
        <p data-testid="household-empty" className="text-neutral-500">
          Пока пусто — здесь появятся мелкие дела вроде «отвезти байк в ремонт».
        </p>
      )}
      <ul className="space-y-1">
        {list?.active.map((item) => (
          <li key={item.id} data-testid="household-item" className="flex items-center gap-2 rounded border px-2 py-1">
            <span className="flex-1 whitespace-pre-wrap">{item.text}</span>
            <button
              type="button"
              data-testid="household-done"
              className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
              disabled={busy}
              onClick={once(() => onComplete(item.id))}
            >
              Сделано
            </button>
          </li>
        ))}
      </ul>

      {!!list?.recentlyDone.length && (
        <details data-testid="household-done-list">
          <summary className="cursor-pointer text-xs text-neutral-500">
            Сделано недавно ({list.recentlyDone.length})
          </summary>
          <ul className="mt-1 space-y-0.5 text-neutral-500">
            {list.recentlyDone.map((item) => (
              <li key={item.id} data-testid="household-done-item">
                ✓ {item.text}
                {item.completedAt && (
                  <span className="text-xs"> · {formatDayRu(civilDayOf(item.completedAt, zone))}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
