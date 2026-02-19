/**
 * BPM detection service
 */
import type { BPMData } from "../types";
import { BPMDetectionError } from "../types";
import { showError } from "../utils/errors";

/**
 * Fetch BPM from server
 */
export async function fetchBPM(source: File | string): Promise<BPMData> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const formData = new FormData();
    if (source instanceof File) {
      formData.append("file", source);
    } else {
      formData.append("path", source);
    }

    const resp = await fetch("/api/detect-bpm", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errorData = await resp.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${resp.status}`);
    }

    const data = await resp.json();

    if (data.error) {
      throw new Error(data.error);
    }

    return {
      bpm: data.bpm || 0,
      beatOffset: data.beatOffset || 0,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("BPM detection failed:", err);
    throw new BPMDetectionError(
      "Failed to detect BPM. Beat synchronization will be disabled.",
      err instanceof Error ? err : undefined,
    );
  }
}

/**
 * Fetch stem separation from server
 */
export async function separateStems(
  file: File,
  onProgress?: (text: string) => void,
): Promise<{
  kick: string;
  drums: string;
  bass: string;
  vocals: string;
  other: string;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 min

  try {
    onProgress?.("Separating stems…");

    const formData = new FormData();
    formData.append("file", file);

    const resp = await fetch("/api/separate", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || "Stem separation failed");
    }

    const data = await resp.json();

    if (!data.stems) {
      throw new Error("Invalid response from server");
    }

    return data.stems;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof DOMException && err.name === "AbortError") {
      const msg = "Stem separation timed out after 5 minutes.";
      showError(msg);
      throw new Error(msg);
    }

    console.error("Stem separation error:", err);
    throw err instanceof Error ? err : new Error("Stem separation failed");
  }
}
