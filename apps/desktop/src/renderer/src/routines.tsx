import type { RoutineItemDto, RoutineKind } from "@living-map/contracts";
import { useState } from "react";
import { EditableText, ReorderButtons } from "./shared-ui";

const TITLES: Record<RoutineKind, string> = { morning: "Утро", evening: "Вечер" };
const HINTS: Record<RoutineKind, string> = {
  morning: "Что у тебя каждое утро, пока не началась работа. Несколько пунктов, не список дел.",
  evening: "Что у тебя каждый вечер, когда работа закончилась. Несколько пунктов, не список дел.",
};

export type RoutineHandlers = {
  onAdd: (kind: RoutineKind, text: string) => void;
  onEdit: (id: string, expectedVersion: number, patch: { text?: string; active?: boolean }) => void;
  onRemove: (id: string, expectedVersion: number) => void;
  onReorder: (kind: RoutineKind, orderedIds: string[]) => void;
};

function RoutineList({
  kind,
  items,
  handlers,
}: {
  kind: RoutineKind;
  items: RoutineItemDto[];
  handlers: RoutineHandlers;
}) {
  const [newText, setNewText] = useState("");
  return (
    <div data-testid={`routine-${kind}`} className="space-y-1">
      <h3 className="font-medium">{TITLES[kind]}</h3>
      <p className="text-xs text-neutral-500">{HINTS[kind]}</p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={item.id} data-testid="routine-item" data-active={item.active} className="flex items-center gap-2">
            <EditableText
              testId="routine-text"
              value={item.text}
              onSave={(text) => handlers.onEdit(item.id, item.version, { text })}
            />
            <ReorderButtons items={items} index={i} onReorder={(ids) => handlers.onReorder(kind, ids)} />
            <button
              type="button"
              data-testid="routine-toggle"
              onClick={() => handlers.onEdit(item.id, item.version, { active: !item.active })}
            >
              {item.active ? "Выключить" : "Включить"}
            </button>
            <button type="button" data-testid="routine-remove" onClick={() => handlers.onRemove(item.id, item.version)}>
              Удалить
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          data-testid={`routine-new-${kind}`}
          className="flex-1 rounded border px-2 py-1"
          placeholder={kind === "morning" ? "Например: стакан воды" : "Например: почитать"}
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
        />
        <button
          type="button"
          data-testid={`routine-add-${kind}`}
          disabled={newText.trim().length === 0}
          onClick={() => {
            handlers.onAdd(kind, newText);
            setNewText("");
          }}
        >
          Добавить
        </button>
      </div>
    </div>
  );
}

/** Stable morning/evening anchors of the day. Not work, not tasks: they never enter the order or the timer. */
export function RoutineSection({ routines, handlers }: { routines: RoutineItemDto[]; handlers: RoutineHandlers }) {
  return (
    <section data-testid="routines" className="space-y-3 rounded border p-3">
      <h2 className="font-semibold">Утро и вечер</h2>
      <p className="text-xs text-neutral-500">
        Это опора дня, а не работа: пункты показываются на экране «Сейчас» и не попадают ни в порядок действий, ни в
        рабочее время.
      </p>
      <RoutineList kind="morning" items={routines.filter((r) => r.kind === "morning")} handlers={handlers} />
      <RoutineList kind="evening" items={routines.filter((r) => r.kind === "evening")} handlers={handlers} />
    </section>
  );
}
