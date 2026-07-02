import { invoke } from "@tauri-apps/api/core";

export type Status = "queued" | "processing" | "done" | "failed";

export interface QueueItem {
  id: string;
  inputPath: string;
  name: string;
  status: Status;
  error?: string;
  resultPath?: string; // temp working PNG (full-res)
  savedPath?: string; // set once exported to the save folder
  before?: string; // data URL
  after?: string; // data URL
}

export interface ProcessResult {
  input_path: string;
  result_path: string;
  before_preview: string;
  after_preview: string;
}

export interface EditSources {
  original: string; // data URL
  result: string; // data URL
}

const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "heic",
  "heif",
  "tif",
  "tiff",
  "webp",
  "bmp",
  "gif",
]);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function processImage(inputPath: string): Promise<ProcessResult> {
  return invoke<ProcessResult>("process_image", { inputPath });
}

export function prepareEdit(
  inputPath: string,
  resultPath: string,
): Promise<EditSources> {
  return invoke<EditSources>("prepare_edit", { inputPath, resultPath });
}

export function picturesDir(): Promise<string> {
  return invoke<string>("pictures_dir");
}

/** Export a result into `destDir` as `<stem>-nobg.png` with no dialog; returns the saved path. */
export function saveToFolder(
  inputPath: string,
  resultPath: string,
  destDir: string,
): Promise<string> {
  return invoke<string>("save_to_folder", { inputPath, resultPath, destDir });
}

export function savePngBytes(destPath: string, dataBase64: string): Promise<void> {
  return invoke("save_png_bytes", { destPath, dataBase64 });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}
