import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  basename,
  isImagePath,
  picturesDir,
  processImage,
  revealInFinder,
  saveToFolder,
  type QueueItem,
} from "./lib/api";
import { QueueItemCard } from "./components/QueueItemCard";
import { Editor } from "./components/Editor";

const CONCURRENCY = 2;
const SAVE_FOLDER_KEY = "cutout.saveFolder";

export default function App() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [saveFolder, setSaveFolder] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [editing, setEditing] = useState<QueueItem | null>(null);

  const itemsRef = useRef<QueueItem[]>([]);
  const pendingRef = useRef<{ id: string; inputPath: string }[]>([]);
  const activeRef = useRef(0);
  const saveFolderRef = useRef<string | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    saveFolderRef.current = saveFolder;
    if (saveFolder) localStorage.setItem(SAVE_FOLDER_KEY, saveFolder);
  }, [saveFolder]);

  // Resolve the default save folder once: stored choice, else the Pictures folder.
  useEffect(() => {
    const stored = localStorage.getItem(SAVE_FOLDER_KEY);
    if (stored) {
      setSaveFolder(stored);
      return;
    }
    picturesDir()
      .then(setSaveFolder)
      .catch(() => setSaveFolder(null));
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const processOne = useCallback(
    async (task: { id: string; inputPath: string }) => {
      updateItem(task.id, { status: "processing", error: undefined });
      try {
        const res = await processImage(task.inputPath);
        updateItem(task.id, {
          status: "done",
          resultPath: res.result_path,
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
        fresh.push({ id: crypto.randomUUID(), inputPath: p, name: basename(p), status: "queued" });
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
      if (p.type === "enter" || p.type === "over") setDragActive(true);
      else if (p.type === "drop") {
        setDragActive(false);
        addPaths(p.paths);
      } else setDragActive(false);
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

  const changeFolder = useCallback(async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") setSaveFolder(dir);
  }, []);

  const resetToPictures = useCallback(async () => {
    try {
      setSaveFolder(await picturesDir());
    } catch {
      /* ignore */
    }
  }, []);

  // Export one result to the save folder — no dialog.
  const saveItem = useCallback(async (item: QueueItem): Promise<void> => {
    const folder = saveFolderRef.current;
    if (!item.resultPath || !folder) return;
    setSavingIds((prev) => new Set(prev).add(item.id));
    try {
      const dest = await saveToFolder(item.inputPath, item.resultPath, folder);
      updateItem(item.id, { savedPath: dest });
    } catch (e) {
      alert(`Could not save: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }, [updateItem]);

  const saveAll = useCallback(async () => {
    const pending = itemsRef.current.filter((i) => i.status === "done" && !i.savedPath);
    for (const it of pending) await saveItem(it);
  }, [saveItem]);

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

  // After a touch-up: refresh the preview, and if the item was already exported,
  // re-export so the saved file reflects the edit.
  const onEditorSaved = useCallback(
    (afterDataUrl: string, beforeDataUrl?: string) => {
      if (!editing) return;
      updateItem(
        editing.id,
        beforeDataUrl ? { after: afterDataUrl, before: beforeDataUrl } : { after: afterDataUrl },
      );
      const it = itemsRef.current.find((i) => i.id === editing.id);
      const folder = saveFolderRef.current;
      if (it?.savedPath && it.resultPath && folder) {
        saveToFolder(it.inputPath, it.resultPath, folder)
          .then((dest) => updateItem(it.id, { savedPath: dest }))
          .catch(() => {});
      }
    },
    [editing, updateItem],
  );

  const stats = useMemo(() => {
    const total = items.length;
    const done = items.filter((i) => i.status === "done").length;
    const saved = items.filter((i) => i.savedPath).length;
    const failed = items.filter((i) => i.status === "failed").length;
    const busy = items.filter((i) => i.status === "processing" || i.status === "queued").length;
    const unsaved = items.filter((i) => i.status === "done" && !i.savedPath).length;
    return { total, done, saved, failed, busy, unsaved };
  }, [items]);

  const hasItems = items.length > 0;
  const folderName = saveFolder ? basename(saveFolder) : "Pictures";

  return (
    <div className={`app${dragActive ? " drag-active" : ""}`}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <Logo />
          <span className="brand-name">Cutout</span>
        </div>
        <div className="titlebar-tools">
          {stats.unsaved > 0 && (
            <button className="btn btn-small" onClick={saveAll}>
              Save all ({stats.unsaved})
            </button>
          )}
          {hasItems && (
            <button className="btn btn-small btn-ghost" onClick={clearAll}>
              Clear
            </button>
          )}
          <button className="btn btn-small btn-primary" onClick={chooseImages}>
            Add Images
          </button>
          <div className="settings-wrap">
            <button
              className="icon-btn"
              onClick={() => setShowSettings((s) => !s)}
              title="Settings"
              aria-label="Settings"
            >
              ⚙
            </button>
            {showSettings && (
              <>
                <div className="popover-scrim" onClick={() => setShowSettings(false)} />
                <div className="settings-pop">
                  <div className="settings-title">Save location</div>
                  <div className="settings-path" title={saveFolder ?? ""}>
                    {saveFolder ?? "Pictures"}
                  </div>
                  <div className="settings-row">
                    <button className="btn btn-small" onClick={changeFolder}>
                      Change…
                    </button>
                    <button className="btn btn-small btn-ghost" onClick={resetToPictures}>
                      Use Pictures
                    </button>
                  </div>
                  <p className="settings-note">Save writes here as “name-nobg.png”, no prompt.</p>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {hasItems && (
        <div className="statusbar">
          <span>
            {stats.total} image{stats.total === 1 ? "" : "s"}
          </span>
          <span className="dot-sep">•</span>
          <span>{stats.saved} saved</span>
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
          <span className="statusbar-spacer" />
          <span className="statusbar-dest" title={saveFolder ?? ""}>
            Saving to {folderName}
          </span>
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
                saving={savingIds.has(item.id)}
                onSave={saveItem}
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
