import type { MemoryDto, MemoryType } from "@living-map/contracts";
import { useCallback, useEffect, useState } from "react";

const TYPE_LABELS: Record<MemoryType, string> = {
  decision: "Решение",
  fact: "Факт",
  observation: "Наблюдение",
  preference: "Предпочтение",
  commitment: "Договорённость",
  idea: "Идея",
  note: "Заметка",
};

/** Memory v1: what LivingMap remembered from `+` — visible, searchable, forgettable. Not a knowledge base. */
export function MemoryPanel({ onForget }: { onForget: (id: string) => Promise<{ ok: boolean }> }) {
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<MemoryDto[] | null>(null);

  const load = useCallback(async () => {
    const r = await window.livingMap.queries.searchMemory({ query, limit: 50 });
    if (r.ok) setMemories(r.value);
  }, [query]);

  useEffect(() => {
    void load();
    return window.livingMap.events.onStateChanged(() => void load());
  }, [load]);

  return (
    <section data-testid="memory" className="space-y-3">
      <h2 className="font-semibold">Память</h2>
      <p className="text-xs text-neutral-500">
        Что Живая карта запомнила из твоих записей «+» и учитывает дальше. Сами записи при удалении не меняются.
      </p>
      <input
        data-testid="memory-search"
        type="search"
        className="w-full rounded border px-2 py-1"
        placeholder="Поиск по памяти"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {memories?.length === 0 && (
        <p className="text-neutral-500">{query.trim() ? "Ничего не найдено." : "Пока ничего не запомнено."}</p>
      )}
      <ul className="space-y-2">
        {memories?.map((m) => (
          <li key={m.id} data-testid="memory-item" className="flex items-start gap-2 rounded border px-2 py-1">
            <div className="flex-1">
              <p className="whitespace-pre-wrap">{m.text}</p>
              <p className="text-xs text-neutral-500">
                {TYPE_LABELS[m.type]} · {new Date(m.createdAt).toLocaleString("ru-RU")}
              </p>
            </div>
            <button
              type="button"
              data-testid="memory-forget"
              className="rounded border px-2 py-0.5 text-xs"
              onClick={async () => {
                if (!window.confirm("Забыть это? Живая карта перестанет это учитывать.")) return;
                if ((await onForget(m.id)).ok) void load();
              }}
            >
              Забыть
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
