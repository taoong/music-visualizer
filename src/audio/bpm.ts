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
 * Client-side BPM detection from an AudioBuffer using onset/autocorrelation.
 */
export function detectBPMFromBuffer(buffer: AudioBuffer): BPMData {
  // Extract mono channel, analyze first 30 seconds
  const sampleRate = buffer.sampleRate;
  const maxSamples = Math.min(buffer.length, sampleRate * 30);
  const channelData = buffer.getChannelData(0).subarray(0, maxSamples);

  // Compute energy in 20ms windows with 50% overlap (10ms hop)
  const windowSize = Math.round(sampleRate * 0.02);
  const hopSize = Math.round(windowSize / 2);
  const numFrames = Math.floor((channelData.length - windowSize) / hopSize);
  const energy = new Float32Array(numFrames);

  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const start = i * hopSize;
    for (let j = start; j < start + windowSize; j++) {
      sum += channelData[j] * channelData[j];
    }
    energy[i] = sum / windowSize;
  }

  // Onset detection: half-wave rectified energy differences
  const onset = new Float32Array(numFrames);
  for (let i = 1; i < numFrames; i++) {
    const diff = energy[i] - energy[i - 1];
    onset[i] = diff > 0 ? diff : 0;
  }

  // Autocorrelation over 60-200 BPM lag range
  const frameRate = sampleRate / hopSize;
  const minLag = Math.round(frameRate * (60 / 200)); // 200 BPM
  const maxLag = Math.round(frameRate * (60 / 60));   // 60 BPM
  const correlationLength = Math.min(onset.length, maxLag + 1);

  let bestLag = minLag;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag && lag < correlationLength; lag++) {
    let corr = 0;
    const limit = correlationLength - lag;
    for (let i = 0; i < limit; i++) {
      corr += onset[i] * onset[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const bpm = Math.round((frameRate * 60) / bestLag);

  // Beat offset: find first significant onset peak
  let threshold = 0;
  for (let i = 0; i < onset.length; i++) {
    threshold += onset[i];
  }
  threshold = (threshold / onset.length) * 2;

  let beatOffset = 0;
  for (let i = 0; i < onset.length; i++) {
    if (onset[i] > threshold) {
      beatOffset = (i * hopSize) / sampleRate;
      break;
    }
  }

  console.log(`[BPM] Client-side detection: ${bpm} BPM`);
  return { bpm, beatOffset };
}

/**
 * Try server-side BPM detection first, fall back to client-side.
 */
export async function detectBPMWithFallback(
  source: File | string,
  audioBuffer: AudioBuffer | null,
): Promise<BPMData | null> {
  try {
    return await fetchBPM(source);
  } catch {
    console.warn('[BPM] Server-side detection failed, trying client-side fallback');
  }

  if (audioBuffer) {
    try {
      return detectBPMFromBuffer(audioBuffer);
    } catch (err) {
      console.warn('[BPM] Client-side detection also failed:', err);
    }
  }

  return null;
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
