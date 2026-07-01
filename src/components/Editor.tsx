import { useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { prepareEdit, savePngBytes, stem, type QueueItem } from "../lib/api";

interface Props {
  item: QueueItem;
  onClose: () => void;
  onSaved: (afterDataUrl: string) => void;
}

type Mode = "erase" | "restore";

const MAX_EDIT_DIM = 3000; // cap working resolution so huge images stay responsive
const MAX_UNDO = 8;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image."));
    img.src = src;
  });
}

/** A basic manual touch-up brush: erase to transparent, or restore original
 *  pixels, refining Vision's automatic mask before saving. */
export function Editor({ item, onClose, onSaved }: Props) {
  const workRef = useRef<HTMLCanvasElement>(null);
  const origRef = useRef<HTMLCanvasElement | null>(null); // offscreen original
  const initialRef = useRef<ImageData | null>(null); // pristine result for Reset
  const undoStack = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("erase");
  const [brush, setBrush] = useState(48); // display px diameter
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [dirty, setDirty] = useState(false);

  // Load the full-resolution sources and set up the canvases.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sources = await prepareEdit(item.inputPath, item.savedPath!);
        const [resultImg, origImg] = await Promise.all([
          loadImage(sources.result),
          loadImage(sources.original),
        ]);
        if (cancelled) return;

        const natW = resultImg.naturalWidth;
        const natH = resultImg.naturalHeight;
        const scale = Math.min(1, MAX_EDIT_DIM / Math.max(natW, natH));
        const w = Math.round(natW * scale);
        const h = Math.round(natH * scale);

        const work = workRef.current!;
        work.width = w;
        work.height = h;
        const wctx = work.getContext("2d")!;
        wctx.drawImage(resultImg, 0, 0, w, h);
        initialRef.current = wctx.getImageData(0, 0, w, h);

        const orig = document.createElement("canvas");
        orig.width = w;
        orig.height = h;
        orig.getContext("2d")!.drawImage(origImg, 0, 0, w, h);
        origRef.current = orig;

        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item]);

  function toCanvasPt(e: React.PointerEvent): { x: number; y: number } {
    const canvas = workRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function radiusCanvasPx(): number {
    const canvas = workRef.current!;
    const rect = canvas.getBoundingClientRect();
    return (brush / 2) * (canvas.width / rect.width);
  }

  function stampDab(x: number, y: number, r: number) {
    const wctx = workRef.current!.getContext("2d")!;
    if (mode === "erase") {
      // Feathered erase: subtract alpha with a soft radial brush.
      const g = wctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.7, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      wctx.save();
      wctx.globalCompositeOperation = "destination-out";
      wctx.fillStyle = g;
      wctx.beginPath();
      wctx.arc(x, y, r, 0, Math.PI * 2);
      wctx.fill();
      wctx.restore();
    } else {
      // Feathered restore: paint back original pixels via a masked dab.
      const orig = origRef.current!;
      const size = Math.ceil(r * 2) + 2;
      const dab = document.createElement("canvas");
      dab.width = size;
      dab.height = size;
      const dctx = dab.getContext("2d")!;
      // Original pixels for this region.
      dctx.drawImage(orig, x - r - 1, y - r - 1, size, size, 0, 0, size, size);
      // Feather via a radial alpha mask.
      const g = dctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, r);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.7, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      dctx.globalCompositeOperation = "destination-in";
      dctx.fillStyle = g;
      dctx.fillRect(0, 0, size, size);
      wctx.drawImage(dab, x - r - 1, y - r - 1);
    }
  }

  function strokeTo(pt: { x: number; y: number }) {
    const r = radiusCanvasPx();
    const from = lastPt.current ?? pt;
    const dx = pt.x - from.x;
    const dy = pt.y - from.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, r / 3);
    const n = Math.max(1, Math.round(dist / step));
    for (let i = 1; i <= n; i++) {
      stampDab(from.x + (dx * i) / n, from.y + (dy * i) / n, r);
    }
    lastPt.current = pt;
  }

  function pushUndo() {
    const canvas = workRef.current!;
    const ctx = canvas.getContext("2d")!;
    undoStack.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (loading || error) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pushUndo();
    drawing.current = true;
    lastPt.current = null;
    const pt = toCanvasPt(e);
    strokeTo(pt);
    setDirty(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = workRef.current!.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (drawing.current) strokeTo(toCanvasPt(e));
  };
  const onPointerUp = () => {
    drawing.current = false;
    lastPt.current = null;
  };

  function undo() {
    const prev = undoStack.current.pop();
    if (!prev) return;
    workRef.current!.getContext("2d")!.putImageData(prev, 0, 0);
    // The first snapshot is the pristine result; an empty stack means we're
    // back to it, so there's nothing left to save.
    setDirty(undoStack.current.length > 0);
  }
  function reset() {
    if (!initialRef.current) return;
    pushUndo();
    workRef.current!.getContext("2d")!.putImageData(initialRef.current, 0, 0);
    setDirty(false);
  }

  async function commit() {
    try {
      setBusy(true);
      const dataUrl = workRef.current!.toDataURL("image/png");
      await savePngBytes(item.savedPath!, dataUrl);
      onSaved(dataUrl);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveCopy() {
    const dest = await saveDialog({
      defaultPath: `${stem(item.name)}-nobg.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!dest) return;
    setBusy(true);
    try {
      const dataUrl = workRef.current!.toDataURL("image/png");
      // Write the edit to the chosen path and keep the working file in sync.
      await savePngBytes(dest, dataUrl);
      await savePngBytes(item.savedPath!, dataUrl);
      onSaved(dataUrl);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="editor">
        <div className="editor-toolbar">
          <div className="seg">
            <button className={mode === "erase" ? "seg-on" : ""} onClick={() => setMode("erase")}>
              Erase
            </button>
            <button className={mode === "restore" ? "seg-on" : ""} onClick={() => setMode("restore")}>
              Restore
            </button>
          </div>
          <label className="brush-size">
            Brush
            <input
              type="range"
              min={6}
              max={140}
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
            />
          </label>
          <div className="editor-toolbar-spacer" />
          <button className="btn" onClick={undo} disabled={loading}>
            Undo
          </button>
          <button className="btn" onClick={reset} disabled={loading}>
            Reset
          </button>
          <button className="btn" onClick={saveCopy} disabled={loading || busy}>
            Save As…
          </button>
          <button className="btn btn-primary" onClick={() => commit()} disabled={loading || busy || !dirty}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        <div className="editor-stage">
          {loading && <div className="editor-status">Preparing full-resolution image…</div>}
          {error && <div className="editor-status editor-error">{error}</div>}
          <div className="editor-checker" style={{ display: loading || error ? "none" : "block" }}>
            <canvas
              ref={workRef}
              className={`editor-canvas cursor-${mode}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setCursor(null)}
            />
            {cursor && !loading && (
              <div
                className="brush-ring"
                style={{
                  left: cursor.x,
                  top: cursor.y,
                  width: brush,
                  height: brush,
                }}
              />
            )}
          </div>
        </div>

        <div className="editor-hint">
          {mode === "erase"
            ? "Paint over areas to remove them."
            : "Paint to bring back the original photo."}
        </div>
      </div>
    </div>
  );
}
