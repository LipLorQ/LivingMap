import { useEffect, useState } from "react";

export function reorderIds<T extends { id: string }>(items: readonly T[], index: number, delta: -1 | 1): string[] {
  const ids = items.map((i) => i.id);
  const target = index + delta;
  const swapped = [...ids];
  [swapped[index], swapped[target]] = [swapped[target] as string, swapped[index] as string];
  return swapped;
}

export function ReorderButtons<T extends { id: string }>({
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
        aria-label="Выше"
        disabled={index === 0}
        onClick={() => onReorder(reorderIds(items, index, -1))}
      >
        ↑
      </button>
      <button
        type="button"
        data-testid="move-down"
        aria-label="Ниже"
        disabled={index === items.length - 1}
        onClick={() => onReorder(reorderIds(items, index, 1))}
      >
        ↓
      </button>
    </span>
  );
}

export function EditableText({
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
