import { useCallback, useRef, useState } from "react";

interface Props {
  before: string;
  after: string;
  alt: string;
}

/** A draggable before/after comparison. The "after" (cut-out, on a
 *  checkerboard) is the base; the original is revealed from the left edge. */
export function CompareSlider({ before, after, alt }: Props) {
  const [pos, setPos] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const updateFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.max(0, Math.min(100, pct)));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    updateFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) updateFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="compare"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="compare-checker">
        <img className="compare-img" src={after} alt={`${alt} — background removed`} draggable={false} />
      </div>
      <img
        className="compare-img compare-before"
        src={before}
        alt={`${alt} — original`}
        draggable={false}
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <div className="compare-divider" style={{ left: `${pos}%` }}>
        <div className="compare-handle" aria-hidden>
          ‹ ›
        </div>
      </div>
      <span className="compare-tag compare-tag-left">Original</span>
      <span className="compare-tag compare-tag-right">Cut&nbsp;out</span>
    </div>
  );
}
