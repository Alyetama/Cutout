import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  basename,
  isImagePath,
  processImage,
  revealInFinder,
  saveAs,
  stem,
  type QueueItem,
} from "./lib/api";
import { QueueItemCard } from "./components/QueueItemCard";
import { Editor } from "./components/Editor";

const CONCURRENCY = 2;

export default function App() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [editing, setEditing] = useState<QueueItem | null>(null);

  const itemsRef = useRef<QueueItem[]>([]);
  const pendingRef = useRef<{ id: string; inputPath: string }[]>([]);
  const activeRef = useRef(0);
  const outputRef = useRef<string | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    outputRef.current = outputFolder;
  }, [outputFolder]);

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const processOne = useCallback(
    async (task: { id: string; inputPath: string }) => {
      updateItem(task.id, { status: "processing", error: undefined });
      try {
        const res = await processImage(task.inputPath, outputRef.current);
        updateItem(task.id, {
          status: "done",
          savedPath: res.saved_path,
          before: res.before_preview,
          after: res.after_preview,
        });
      } catch (e) {
        updateItem(task.id, {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        activeRef.current -= 1;
        pump();
      }
    },
    [updateItem],
  );

  const pump = useCallback(() => {
    while (activeRef.current < CONCURRENCY && pendingRef.current.length > 0) {
      const task = pendingRef.current.shift()!;
      activeRef.current += 1;
      void processOne(task);
    }
  }, [processOne]);

  const addPaths = useCallback(
    (paths: string[]) => {
      const imgs = paths.filter(isImagePath);
      if (imgs.length === 0) return;
      const existing = new Set(itemsRef.current.map((i) => i.inputPath));
      const fresh: QueueItem[] = [];
      for (const p of imgs) {
        if (existing.has(p)) continue;
        existing.add(p);
        fresh.push({
          id: crypto.randomUUID(),
          inputPath: p,
          name: basename(p),
          status: "queued",
        });
      }
      if (fresh.length === 0) return;
      setItems((prev) => [...prev, ...fresh]);
      pendingRef.current.push(...fresh.map((i) => ({ id: i.id, inputPath: i.inputPath })));
      pump();
    },
    [pump],
  );

  // Native drag-and-drop (provides absolute file paths, unlike HTML5 DnD).
  useEffect(() => {
    const wv = getCurrentWebview();
    const unlisten = wv.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        setDragActive(true);
      } else if (p.type === "drop") {
        setDragActive(false);
        addPaths(p.paths);
      } else {
        setDragActive(false);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [addPaths]);

  const chooseImages = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff", "webp", "bmp", "gif"],
        },
      ],
    });
    if (!picked) return;
    addPaths(Array.isArray(picked) ? picked : [picked]);
  }, [addPaths]);

  const chooseFolder = useCallback(async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputFolder(dir);
  }, []);

  const onSaveAs = useCallback(async (item: QueueItem) => {
    if (!item.savedPath) return;
    const dest = await saveDialog({
      defaultPath: `${stem(item.name)}-nobg.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!dest) return;
    try {
      await saveAs(item.savedPath, dest);
    } catch (e) {
      alert(`Could not save: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  const onReveal = useCallback((item: QueueItem) => {
    if (item.savedPath) void revealInFinder(item.savedPath);
  }, []);

  const onRemove = useCallback((item: QueueItem) => {
    pendingRef.current = pendingRef.current.filter((t) => t.id !== item.id);
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }, []);

  const onRetry = useCallback(
    (item: QueueItem) => {
      updateItem(item.id, { status: "queued", error: undefined });
      pendingRef.current.push({ id: item.id, inputPath: item.inputPath });
      pump();
    },
    [pump, updateItem],
  );

  const clearAll = useCallback(() => {
    pendingRef.current = [];
    setItems([]);
  }, []);

  const onEditorSaved = useCallback(
    (afterDataUrl: string) => {
      if (editing) updateItem(editing.id, { after: afterDataUrl });
    },
    [editing, updateItem],
  );

  const stats = useMemo(() => {
    const total = items.length;
    const done = items.filter((i) => i.status === "done").length;
    const failed = items.filter((i) => i.status === "failed").length;
    const busy = items.filter((i) => i.status === "processing" || i.status === "queued").length;
    return { total, done, failed, busy };
  }, [items]);

  const hasItems = items.length > 0;

  return (
    <div className={`app${dragActive ? " drag-active" : ""}`}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <Logo />
          <span className="brand-name">Cutout</span>
        </div>
        <div className="titlebar-tools">
          <div className="output-control">
            <span className="output-label">Save to</span>
            {outputFolder ? (
              <span className="output-chip" title={outputFolder}>
                {basename(outputFolder)}
                <button className="chip-x" onClick={() => setOutputFolder(null)} title="Save beside originals instead">
                  ✕
                </button>
              </span>
            ) : (
              <span className="output-chip output-chip-default">Beside each original</span>
            )}
            <button className="btn btn-small" onClick={chooseFolder}>
              Choose Folder…
            </button>
          </div>
          {hasItems && (
            <button className="btn btn-small btn-ghost" onClick={clearAll}>
              Clear
            </button>
          )}
          <button className="btn btn-small btn-primary" onClick={chooseImages}>
            Add Images
          </button>
        </div>
      </header>

      {hasItems && (
        <div className="statusbar">
          <span>{stats.total} image{stats.total === 1 ? "" : "s"}</span>
          <span className="dot-sep">•</span>
          <span>{stats.done} done</span>
          {stats.busy > 0 && (
            <>
              <span className="dot-sep">•</span>
              <span className="status-busy">{stats.busy} in progress</span>
            </>
          )}
          {stats.failed > 0 && (
            <>
              <span className="dot-sep">•</span>
              <span className="status-failed">{stats.failed} failed</span>
            </>
          )}
        </div>
      )}

      <main className="content">
        {!hasItems ? (
          <button className="hero" onClick={chooseImages}>
            <div className="hero-inner">
              <Logo large />
              <h1>Drop images to remove their backgrounds</h1>
              <p>
                JPEG, PNG, HEIC and more — processed entirely on your Mac with Apple's Vision
                framework. Nothing is uploaded.
              </p>
              <span className="hero-cta">Choose Images…</span>
            </div>
          </button>
        ) : (
          <div className="grid">
            {items.map((item) => (
              <QueueItemCard
                key={item.id}
                item={item}
                onSaveAs={onSaveAs}
                onReveal={onReveal}
                onEdit={setEditing}
                onRemove={onRemove}
                onRetry={onRetry}
              />
            ))}
          </div>
        )}
      </main>

      {dragActive && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <Logo large />
            <span>Drop to remove backgrounds</span>
          </div>
        </div>
      )}

      {editing && (
        <Editor item={editing} onClose={() => setEditing(null)} onSaved={onEditorSaved} />
      )}
    </div>
  );
}

function Logo({ large }: { large?: boolean }) {
  const s = large ? 72 : 26;
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" fill="none" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6ea8ff" />
          <stop offset="1" stopColor="#a06bff" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="88" height="88" rx="22" fill="url(#lg)" />
      <path
        d="M30 66c6-18 12-30 20-30s10 8 18 8"
        stroke="#fff"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
        opacity="0.95"
      />
      <circle cx="63" cy="40" r="7" fill="#fff" />
    </svg>
  );
}
