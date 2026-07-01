import { invoke } from "@tauri-apps/api/core";

export type Status = "queued" | "processing" | "done" | "failed";

export interface QueueItem {
  id: string;
  inputPath: string;
  name: string;
  status: Status;
  error?: string;
  savedPath?: string;
  before?: string; // data URL
  after?: string; // data URL
}

export interface ProcessResult {
  input_path: string;
  saved_path: string;
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

export function processImage(
  inputPath: string,
  outputDir: string | null,
): Promise<ProcessResult> {
  return invoke<ProcessResult>("process_image", {
    inputPath,
    outputDir: outputDir ?? null,
  });
}

export function prepareEdit(
  inputPath: string,
  savedPath: string,
): Promise<EditSources> {
  return invoke<EditSources>("prepare_edit", { inputPath, savedPath });
}

export function saveAs(srcPath: string, destPath: string): Promise<void> {
  return invoke("save_as", { srcPath, destPath });
}

export function savePngBytes(destPath: string, dataBase64: string): Promise<void> {
  return invoke("save_png_bytes", { destPath, dataBase64 });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}
