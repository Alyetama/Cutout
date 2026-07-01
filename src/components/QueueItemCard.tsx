import { CompareSlider } from "./CompareSlider";
import type { QueueItem } from "../lib/api";

interface Props {
  item: QueueItem;
  onSaveAs: (item: QueueItem) => void;
  onReveal: (item: QueueItem) => void;
  onEdit: (item: QueueItem) => void;
  onRemove: (item: QueueItem) => void;
  onRetry: (item: QueueItem) => void;
}

const STATUS_LABEL: Record<QueueItem["status"], string> = {
  queued: "Queued",
  processing: "Removing background…",
  done: "Done",
  failed: "Failed",
};

export function QueueItemCard({
  item,
  onSaveAs,
  onReveal,
  onEdit,
  onRemove,
  onRetry,
}: Props) {
  return (
    <div className={`card card-${item.status}`}>
      <div className="card-media">
        {item.status === "done" && item.before && item.after ? (
          <CompareSlider before={item.before} after={item.after} alt={item.name} />
        ) : (
          <div className="card-placeholder">
            {item.status === "processing" && <div className="spinner" />}
            {item.status === "queued" && <div className="dot-pulse" />}
            {item.status === "failed" && <div className="fail-mark">!</div>}
          </div>
        )}
      </div>

      <div className="card-body">
        <div className="card-head">
          <span className="card-name" title={item.inputPath}>
            {item.name}
          </span>
          <span className={`badge badge-${item.status}`}>
            {STATUS_LABEL[item.status]}
          </span>
        </div>

        {item.status === "failed" && (
          <div className="card-error">{item.error}</div>
        )}

        {item.status === "done" && item.savedPath && (
          <div className="card-path" title={item.savedPath}>
            Saved to {item.savedPath}
          </div>
        )}

        <div className="card-actions">
          {item.status === "done" && (
            <>
              <button className="btn" onClick={() => onEdit(item)}>
                Touch&nbsp;up…
              </button>
              <button className="btn" onClick={() => onSaveAs(item)}>
                Save&nbsp;As…
              </button>
              <button className="btn" onClick={() => onReveal(item)}>
                Show&nbsp;in&nbsp;Finder
              </button>
            </>
          )}
          {item.status === "failed" && (
            <button className="btn" onClick={() => onRetry(item)}>
              Try&nbsp;again
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => onRemove(item)}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
