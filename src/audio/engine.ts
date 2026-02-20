/**
 * Audio engine for managing Tone.js instances and audio playback
 */
import type { StemUrls } from '../types';
import { store } from '../state/store';
import { FFT_SIZE, SPIKES_PER_BAND } from '../utils/constants';

export interface FreqModeAudio {
  player: TonePlayer;
  gainNode: ToneGain;
  fft: ToneFFT;
}

export interface StemModeAudio {
  players: Record<string, TonePlayer>;
  gainNodes: Record<string, ToneGain>;
  masterGain: ToneGain;
  ffts: Record<string, ToneFFT>;
  smoothed: Record<string, Float32Array>;
}

class AudioEngine {
  private freqAudio: FreqModeAudio | null = null;
  private stemAudio: StemModeAudio | null = null;
  private blobUrls: string[] = [];

  /**
   * Initialize frequency mode audio
   */
  async initFreqMode(fileUrl: string): Promise<void> {
    this.disposeAll();
    await Tone.start();

    console.log('[AudioEngine] Loading audio from:', fileUrl);

    const player = new Tone.Player({
      url: fileUrl,
      loop: true,
      autostart: false,
    });

    const gainNode = new Tone.Gain(store.config.masterVolume);
    const fft = new Tone.FFT(FFT_SIZE);

    player.connect(gainNode);
    gainNode.toDestination();
    player.connect(fft);

    try {
      await Tone.loaded();
      console.log('[AudioEngine] Audio loaded successfully');
    } catch (err) {
      console.error('[AudioEngine] Failed to load audio:', err);
      throw new Error(
        `Failed to load audio: ${err instanceof Error ? err.message : 'Unknown error'}. URL: ${fileUrl}`
      );
    }

    this.freqAudio = { player, gainNode, fft };
    store.setAudioReady(true);
  }

  /**
   * Initialize stem mode audio
   */
  async initStemMode(stemUrls: StemUrls): Promise<void> {
    this.disposeAll();
    await Tone.start();

    const masterGain = new Tone.Gain(store.config.masterVolume);
    masterGain.toDestination();

    const players: Record<string, TonePlayer> = {};
    const gainNodes: Record<string, ToneGain> = {};
    const ffts: Record<string, ToneFFT> = {};
    const smoothed: Record<string, Float32Array> = {};

    const stems: string[] = ['kick', 'drums', 'bass', 'vocals', 'other'];

    for (const stem of stems) {
      const url = stemUrls[stem as keyof StemUrls];
      if (!url) continue;

      // Pre-fetch stem audio
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        this.blobUrls.push(blobUrl);

        players[stem] = new Tone.Player({
          url: blobUrl,
          loop: true,
          autostart: false,
        });
      } catch {
        continue;
      }

      gainNodes[stem] = new Tone.Gain(1);
      players[stem].connect(gainNodes[stem]);
      gainNodes[stem].connect(masterGain);

      ffts[stem] = new Tone.FFT(FFT_SIZE);
      players[stem].connect(ffts[stem]);

      smoothed[stem] = new Float32Array(SPIKES_PER_BAND);
    }

    await Tone.loaded();

    this.stemAudio = {
      players,
      gainNodes,
      masterGain,
      ffts,
      smoothed,
    };
    store.setAudioReady(true);
  }

  /**
   * Dispose all audio resources
   */
  disposeAll(): void {
    // Dispose frequency mode
    if (this.freqAudio) {
      this.freqAudio.player.stop();
      this.freqAudio.player.dispose();
      this.freqAudio.gainNode.dispose();
      this.freqAudio.fft.dispose();
      this.freqAudio = null;
    }

    // Dispose stem mode
    if (this.stemAudio) {
      for (const stem of Object.keys(this.stemAudio.players)) {
        this.stemAudio.players[stem].stop();
        this.stemAudio.players[stem].dispose();
        this.stemAudio.gainNodes[stem].dispose();
        this.stemAudio.ffts[stem].dispose();
      }
      this.stemAudio.masterGain.dispose();
      this.stemAudio = null;
    }

    // Clean up blob URLs
    this.blobUrls.forEach(url => URL.revokeObjectURL(url));
    this.blobUrls = [];

    // Revoke user file object URL if present
    store.setCurrentObjectUrl(null);

    store.resetAudioState();
    store.setAudioReady(false);
  }

  /**
   * Start playback
   */
  start(offset: number = 0): void {
    const time = '+0';
    const isFreqMode = store.state.mode === 'freq';

    if (isFreqMode && this.freqAudio) {
      this.freqAudio.player.start(time, offset);
    } else if (!isFreqMode && this.stemAudio) {
      for (const stem of Object.keys(this.stemAudio.players)) {
        this.stemAudio.players[stem].start(time, offset);
      }
    }

    store.setPlaying(true);
    store.setPlaybackTiming(Tone.now(), offset);
  }

  /**
   * Stop playback
   */
  stop(): void {
    const isFreqMode = store.state.mode === 'freq';

    if (isFreqMode && this.freqAudio) {
      this.freqAudio.player.stop();
    } else if (!isFreqMode && this.stemAudio) {
      for (const stem of Object.keys(this.stemAudio.players)) {
        this.stemAudio.players[stem].stop();
      }
    }

    store.setPlaying(false);
    store.setStartOffset(this.getPlaybackPosition());
  }

  /**
   * Get current playback position
   */
  getPlaybackPosition(): number {
    if (!store.state.isPlaying) {
      return store.state.startOffset;
    }

    const elapsed = Tone.now() - store.state.playStartedAt;
    const duration = this.getDuration();

    if (duration === 0) return 0;
    return (store.state.startOffset + elapsed) % duration;
  }

  /**
   * Get audio duration
   */
  getDuration(): number {
    const isFreqMode = store.state.mode === 'freq';

    if (isFreqMode && this.freqAudio?.player.buffer) {
      return this.freqAudio.player.buffer.duration;
    } else if (!isFreqMode && this.stemAudio?.players.kick?.buffer) {
      return this.stemAudio.players.kick.buffer.duration;
    }
    return 0;
  }

  /**
   * Seek to a position
   */
  seek(position: number): void {
    store.setStartOffset(position);
    store.state.lastBeatIndex = -1;

    if (store.state.isPlaying) {
      this.stop();
      this.start(position);
    }
  }

  /**
   * Update master volume
   */
  setVolume(volume: number): void {
    const isFreqMode = store.state.mode === 'freq';

    if (isFreqMode && this.freqAudio) {
      this.freqAudio.gainNode.gain.value = volume;
    } else if (!isFreqMode && this.stemAudio) {
      this.stemAudio.masterGain.gain.value = volume;
    }
  }

  /**
   * Get FFT for frequency mode
   */
  getFreqFFT(): ToneFFT | null {
    return this.freqAudio?.fft || null;
  }

  /**
   * Get FFTs for stem mode
   */
  getStemFFTs(): Record<string, ToneFFT> | null {
    return this.stemAudio?.ffts || null;
  }

  /**
   * Get stem smoothed data
   */
  getStemSmoothed(): Record<string, Float32Array> | null {
    return this.stemAudio?.smoothed || null;
  }
}

// Export singleton
export const audioEngine = new AudioEngine();
export default audioEngine;
