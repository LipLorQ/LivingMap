import type { AppError, ProbeDto } from "@living-map/contracts";
import { useCallback, useEffect, useState } from "react";

// Technical spike screen: proves renderer → preload → main → application → SQLite and back.
// Deliberately utilitarian; not product UI.
export function App() {
  const [revision, setRevision] = useState<number | null>(null);
  const [probes, setProbes] = useState<ProbeDto[]>([]);
  const [lastError, setLastError] = useState<AppError | null>(null);
  const [newTitle, setNewTitle] = useState("");

  const reload = useCallback(async () => {
    const [rev, list] = await Promise.all([
      window.livingMap.queries.getStateRevision(),
      window.livingMap.queries.listProbes(),
    ]);
    if (rev.ok) setRevision(rev.value.stateRevision);
    if (list.ok) setProbes(list.value);
  }, []);

  useEffect(() => {
    void reload();
    return window.livingMap.events.onStateChanged(() => void reload());
  }, [reload]);

  const create = async () => {
    const r = await window.livingMap.commands.createProbe({ title: newTitle });
    setLastError(r.ok ? null : r.error);
    if (r.ok) setNewTitle("");
  };

  const rename = async (id: string, baseVersion: number, title: string) => {
    const r = await window.livingMap.commands.renameProbe({ id, expectedVersion: baseVersion, title });
    setLastError(r.ok ? null : r.error);
  };

  const isolation = {
    require: typeof (window as unknown as Record<string, unknown>).require,
    process: typeof (window as unknown as Record<string, unknown>).process,
  };

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 font-sans text-sm text-neutral-900">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Living Map — architecture spike</h1>
        <p>
          state_revision: <span data-testid="revision">{revision ?? "…"}</span>
        </p>
        <p className="text-neutral-500" data-testid="isolation">
          window.require: {isolation.require} · window.process: {isolation.process}
        </p>
      </header>

      <section className="flex gap-2">
        <input
          data-testid="new-title"
          className="flex-1 rounded border px-2 py-1"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Probe title"
        />
        <button data-testid="create" type="button" className="rounded border px-3 py-1" onClick={() => void create()}>
          Create probe
        </button>
      </section>

      {lastError && (
        <p data-testid="error" className="rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800">
          {lastError.code}: {lastError.message}
        </p>
      )}

      <ul className="space-y-2" data-testid="probes">
        {probes.map((p) => (
          <ProbeRow key={p.id} probe={p} onRename={rename} />
        ))}
      </ul>
    </main>
  );
}

type Draft = { title: string; baseVersion: number };

function ProbeRow({
  probe,
  onRename,
}: {
  probe: ProbeDto;
  onRename: (id: string, baseVersion: number, title: string) => Promise<void>;
}) {
  // The edit remembers the version it started from. If the probe changes underneath
  // (e.g. MCP renamed it), submitting yields CONFLICT_RELOAD instead of a silent overwrite.
  const [draft, setDraft] = useState<Draft | null>(null);
  const submit = async () => {
    if (!draft) return;
    await onRename(probe.id, draft.baseVersion, draft.title);
    setDraft(null);
  };
  return (
    <li className="flex items-center gap-2 rounded border px-2 py-1" data-testid="probe" data-id={probe.id}>
      <span className="flex-1" data-testid="probe-title">
        {probe.title}
      </span>
      <span className="text-neutral-500" data-testid="probe-version">
        v{probe.version}
      </span>
      <input
        data-testid="rename-title"
        className="w-40 rounded border px-2 py-0.5"
        value={draft?.title ?? probe.title}
        onChange={(e) => setDraft({ title: e.target.value, baseVersion: draft?.baseVersion ?? probe.version })}
      />
      <button data-testid="rename" type="button" className="rounded border px-2 py-0.5" onClick={() => void submit()}>
        Rename
      </button>
    </li>
  );
}
