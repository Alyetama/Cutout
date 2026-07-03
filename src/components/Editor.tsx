import { useEffect, useRef, useState } from "react";
import { prepareEdit, savePngBytes, type QueueItem } from "../lib/api";

interface Props {
  item: QueueItem;
  onClose: () => void;
  onSaved: (afterDataUrl: string, beforeDataUrl?: string) => void;
}

type Tool = "erase" | "restore" | "crop";
type Rect = { x: number; y: number; w: number; h: number };

const MAX_EDIT_DIM = 3000; // cap working resolution so huge images stay responsive
const MAX_UNDO = 8;
const PREVIEW_DIM = 1100;
const MIN_CROP = 16;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image."));
    img.src = src;
  });
}

/** Downscale a canvas to a modest preview data URL for the queue card. */
function previewDataUrl(src: HTMLCanvasElement, maxDim = PREVIEW_DIM): string {
  const longest = Math.max(src.width, src.height);
  const s = Math.min(1, maxDim / longest);
  if (s === 1) return src.toDataURL("image/png");
  const t = document.createElement("canvas");
  t.width = Math.max(1, Math.round(src.width * s));
  t.height = Math.max(1, Math.round(src.height * s));
  t.getContext("2d")!.drawImage(src, 0, 0, t.width, t.height);
  return t.toDataURL("image/png");
}

/** Touch-up + crop: erase to transparent, restore original pixels, or crop the
 *  cut-out, refining Vision's automatic result before saving. */
export function Editor({ item, onClose, onSaved }: Props) {
  const workRef = useRef<HTMLCanvasElement>(null);
  const origRef = useRef<HTMLCanvasElement | null>(null); // offscreen original
  const initialRef = useRef<ImageData | null>(null); // pristine result for Reset
  const undoStack = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const cropDrag = useRef<{ handle: string; startX: number; startY: number; startRect: Rect } | null>(
    null,
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>("erase");
  const [brush, setBrush] = useState(48); // display px diameter
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);

  // Load the full-resolution sources and set up the canvases.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sources = await prepareEdit(item.inputPath, item.resultPath!);
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

        setDims({ w, h });
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

  function toCanvasXY(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = workRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function radiusCanvasPx(): number {
    const canvas = workRef.current!;
    const rect = canvas.getBoundingClientRect();
    return (brush / 2) * (canvas.width / rect.width);
  }

  function stampDab(x: number, y: number, r: number) {
    const wctx = workRef.current!.getContext("2d")!;
    if (tool === "erase") {
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
      const orig = origRef.current!;
      const size = Math.ceil(r * 2) + 2;
      const dab = document.createElement("canvas");
      dab.width = size;
      dab.height = size;
      const dctx = dab.getContext("2d")!;
      dctx.drawImage(orig, x - r - 1, y - r - 1, size, size, 0, 0, size, size);
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

  // ---- Brush painting (erase / restore) ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (loading || error || tool === "crop") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pushUndo();
    drawing.current = true;
    lastPt.current = null;
    strokeTo(toCanvasXY(e.clientX, e.clientY));
    setDirty(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = workRef.current!.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (drawing.current) strokeTo(toCanvasXY(e.clientX, e.clientY));
  };
  const onPointerUp = () => {
    drawing.current = false;
    lastPt.current = null;
  };

  // ---- Crop selection ----
  function enterCrop() {
    setTool("crop");
    if (dims) setCrop({ x: 0, y: 0, w: dims.w, h: dims.h });
  }
  const cropDown = (e: React.PointerEvent) => {
    if (loading) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const handle = (e.target as HTMLElement).dataset.cropHandle ?? "draw";
    const p = toCanvasXY(e.clientX, e.clientY);
    const startRect =
      handle === "draw" ? { x: p.x, y: p.y, w: 0, h: 0 } : crop ?? { x: 0, y: 0, w: 0, h: 0 };
    if (handle === "draw") setCrop(startRect);
    cropDrag.current = { handle, startX: p.x, startY: p.y, startRect };
  };
  const cropMove = (e: React.PointerEvent) => {
    const d = cropDrag.current;
    if (!d || !dims) return;
    const { w: W, h: H } = dims;
    const p = toCanvasXY(e.clientX, e.clientY);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    let l = d.startRect.x;
    let t = d.startRect.y;
    let r = d.startRect.x + d.startRect.w;
    let b = d.startRect.y + d.startRect.h;
    if (d.handle === "move") {
      l += dx;
      r += dx;
      t += dy;
      b += dy;
      if (l < 0) { r -= l; l = 0; }
      if (t < 0) { b -= t; t = 0; }
      if (r > W) { l -= r - W; r = W; }
      if (b > H) { t -= b - H; b = H; }
    } else {
      if (d.handle === "draw") { r = d.startRect.x + dx; b = d.startRect.y + dy; }
      if (d.handle.includes("n")) t += dy;
      if (d.handle.includes("s")) b += dy;
      if (d.handle.includes("w")) l += dx;
      if (d.handle.includes("e")) r += dx;
      if (r < l) [l, r] = [r, l];
      if (b < t) [t, b] = [b, t];
      l = Math.max(0, Math.min(l, W));
      r = Math.max(0, Math.min(r, W));
      t = Math.max(0, Math.min(t, H));
      b = Math.max(0, Math.min(b, H));
    }
    setCrop({ x: l, y: t, w: r - l, h: b - t });
  };
  const cropUp = () => {
    cropDrag.current = null;
  };

  function applyCrop() {
    const c = workRef.current!;
    const orig = origRef.current!;
    if (!crop) return;
    const x = Math.round(Math.max(0, Math.min(crop.x, c.width)));
    const y = Math.round(Math.max(0, Math.min(crop.y, c.height)));
    const w = Math.round(Math.min(crop.w, c.width - x));
    const h = Math.round(Math.min(crop.h, c.height - y));
    if (w < MIN_CROP || h < MIN_CROP) return;

    const cropped = (src: HTMLCanvasElement) => {
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      out.getContext("2d")!.drawImage(src, x, y, w, h, 0, 0, w, h);
      return out;
    };
    const newWork = cropped(c);
    origRef.current = cropped(orig);

    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(newWork, 0, 0);
    initialRef.current = ctx.getImageData(0, 0, w, h);
    undoStack.current = [];

    setDims({ w, h });
    setCrop(null);
    setTool("erase");
    setDirty(true);
  }

  function undo() {
    const prev = undoStack.current.pop();
    if (!prev) return;
    workRef.current!.getContext("2d")!.putImageData(prev, 0, 0);
    setDirty(undoStack.current.length > 0);
  }
  function reset() {
    const init = initialRef.current;
    if (!init) return;
    const c = workRef.current!;
    c.width = init.width;
    c.height = init.height;
    c.getContext("2d")!.putImageData(init, 0, 0);
    setDims({ w: init.width, h: init.height });
    undoStack.current = [];
    setDirty(false);
  }

  async function commit() {
    try {
      setBusy(true);
      const full = workRef.current!.toDataURL("image/png");
      await savePngBytes(item.resultPath!, full);
      const after = previewDataUrl(workRef.current!);
      const before = origRef.current ? previewDataUrl(origRef.current) : undefined;
      onSaved(after, before);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const CROP_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="editor">
        <div className="editor-toolbar">
          <div className="seg">
            <button className={tool === "erase" ? "seg-on" : ""} onClick={() => setTool("erase")}>
              Erase
            </button>
            <button className={tool === "restore" ? "seg-on" : ""} onClick={() => setTool("restore")}>
              Restore
            </button>
            <button className={tool === "crop" ? "seg-on" : ""} onClick={enterCrop}>
              Crop
            </button>
          </div>

          {tool === "crop" ? (
            <div className="crop-actions">
              <button className="btn btn-small" onClick={applyCrop} disabled={loading}>
                Crop to selection
              </button>
              <button
                className="btn btn-small btn-ghost"
                onClick={() => dims && setCrop({ x: 0, y: 0, w: dims.w, h: dims.h })}
                disabled={loading}
              >
                Select all
              </button>
            </div>
          ) : (
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
          )}

          <div className="editor-toolbar-spacer" />
          <button className="btn" onClick={undo} disabled={loading}>
            Undo
          </button>
          <button className="btn" onClick={reset} disabled={loading}>
            Reset
          </button>
          <button className="btn btn-primary" onClick={() => commit()} disabled={loading || busy || !dirty}>
            {busy ? "Applying…" : "Apply"}
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
              className={`editor-canvas cursor-${tool}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setCursor(null)}
            />
            {tool === "crop" && crop && dims && (
              <div
                className="crop-overlay"
                onPointerDown={cropDown}
                onPointerMove={cropMove}
                onPointerUp={cropUp}
              >
                <div
                  className="crop-rect"
                  style={{
                    left: `${(crop.x / dims.w) * 100}%`,
                    top: `${(crop.y / dims.h) * 100}%`,
                    width: `${(crop.w / dims.w) * 100}%`,
                    height: `${(crop.h / dims.h) * 100}%`,
                  }}
                >
                  <div className="crop-move" data-crop-handle="move" />
                  {CROP_HANDLES.map((hd) => (
                    <span key={hd} className={`crop-h crop-h-${hd}`} data-crop-handle={hd} />
                  ))}
                </div>
              </div>
            )}
            {cursor && !loading && tool !== "crop" && (
              <div
                className="brush-ring"
                style={{ left: cursor.x, top: cursor.y, width: brush, height: brush }}
              />
            )}
          </div>
        </div>

        <div className="editor-hint">
          {tool === "erase" && "Paint over areas to remove them."}
          {tool === "restore" && "Paint to bring back the original photo."}
          {tool === "crop" && "Drag to select the area to keep, then Crop to selection."}
        </div>
      </div>
    </div>
  );
}
