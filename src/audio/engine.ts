/**
 * Audio engine for managing Tone.js instances and audio playback
 */
import * as Tone from 'tone';
import { store } from '../state/store';
import { FFT_SIZE } from '../utils/constants';

export interface FreqModeAudio {
  player: TonePlayer;
  gainNode: ToneGain;
  fft: ToneFFT;
}

export interface MicModeAudio {
  mic: ToneUserMedia;
  gainNode: ToneGain;
  fft: ToneFFT;
  silentGain: ToneGain;
}

class AudioEngine {
  private freqAudio: FreqModeAudio | null = null;
  private micAudio: MicModeAudio | null = null;
  private blobUrls: string[] = [];
  private rawAudioBuffer: AudioBuffer | null = null;
  private waveformAnalyser: Tone.Waveform | null = null;

  /**
   * Initialize frequency mode audio
   */
  async initFreqMode(source: string | File): Promise<void> {
    this.disposeAll();
    await Tone.start();

    console.log('[AudioEngine] Loading audio:', source instanceof File ? source.name : source);

    let player: TonePlayer;

    // Fetch bytes ourselves and decode directly, for File uploads and the
    // bundled sample track alike. Tone.Player's own URL loader (a detached
    // <a> element resolving the path, then its own fetch) is unreliable for
    // the multi-MB sample track inside a WKWebView loaded through Capacitor's
    // custom URL scheme — fetches of that file come back non-ok even though
    // the file is genuinely present in the bundle. Fetching it ourselves
    // (the same path File uploads already used successfully) sidesteps
    // whatever Tone's loader does differently.
    try {
      const arrayBuffer =
        source instanceof File
          ? await source.arrayBuffer()
          : await fetch(new URL(source, document.baseURI).href).then(r => {
              if (!r.ok) throw new Error(`could not load url: ${source} (${r.status})`);
              return r.arrayBuffer();
            });
      const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);
      this.rawAudioBuffer = audioBuffer;
      player = new Tone.Player(audioBuffer);
      player.loop = true;
    } catch (err) {
      console.error('[AudioEngine] Failed to load audio:', err);
      throw new Error(
        `Failed to load audio: ${err instanceof Error ? err.message : 'Unknown error'}. URL: ${source instanceof File ? source.name : source}`
      );
    }

    const gainNode = new Tone.Gain(store.config.masterVolume);
    const fft = new Tone.FFT(FFT_SIZE);

    player.connect(gainNode);
    gainNode.toDestination();
    player.connect(fft);

    this.waveformAnalyser = new Tone.Waveform(FFT_SIZE);
    player.connect(this.waveformAnalyser);

    this.freqAudio = { player, gainNode, fft };
    store.setAudioReady(true);
  }

  /**
   * Initialize microphone mode audio
   */
  async initMicMode(): Promise<void> {
    this.disposeAll();
    await Tone.start();

    console.log('[AudioEngine] Opening microphone…');

    const mic = new Tone.UserMedia();
    await mic.open();

    const gainNode = new Tone.Gain(store.config.masterVolume);
    const fft = new Tone.FFT(FFT_SIZE);

    // Parallel branches from mic (same pattern as freq mode):
    //   Branch 1: mic → gainNode → fft          (analysis)
    //   Branch 2: mic → gainNode → silentGain → destination  (keeps audio graph alive)
    //   Branch 3: mic → waveformAnalyser         (time-domain data)
    // Silent gain (volume 0) prevents mic feedback through speakers.
    const silentGain = new Tone.Gain(0);
    mic.connect(gainNode);
    gainNode.connect(fft);
    gainNode.connect(silentGain);
    silentGain.toDestination();

    this.waveformAnalyser = new Tone.Waveform(FFT_SIZE);
    mic.connect(this.waveformAnalyser);

    this.micAudio = { mic, gainNode, fft, silentGain };
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

    if (this.waveformAnalyser) {
      this.waveformAnalyser.dispose();
      this.waveformAnalyser = null;
    }

    this.rawAudioBuffer = null;

    // Dispose mic mode
    if (this.micAudio) {
      this.micAudio.mic.close();
      this.micAudio.mic.dispose();
      this.micAudio.gainNode.dispose();
      this.micAudio.fft.dispose();
      this.micAudio.silentGain.dispose();
      this.micAudio = null;
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
    // Mic mode is always "playing" while open — just set state
    if (store.state.mode === 'mic') {
      store.setPlaying(true);
      store.setPlaybackTiming(Tone.now(), 0);
      return;
    }

    if (this.freqAudio) {
      this.freqAudio.player.start('+0', offset);
    }

    store.setPlaying(true);
    store.setPlaybackTiming(Tone.now(), offset);
  }

  /**
   * Stop playback
   */
  stop(): void {
    // Mic mode: just toggle playing state (mic stays open)
    if (store.state.mode === 'mic') {
      store.setPlaying(false);
      return;
    }

    const currentPosition = this.getPlaybackPosition();

    if (this.freqAudio) {
      this.freqAudio.player.stop();
    }

    store.setPlaying(false);
    store.setStartOffset(currentPosition);
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
    if (this.freqAudio?.player.buffer) {
      return this.freqAudio.player.buffer.duration;
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
    if (store.state.mode === 'mic' && this.micAudio) {
      this.micAudio.gainNode.gain.value = volume;
    } else if (this.freqAudio) {
      this.freqAudio.gainNode.gain.value = volume;
    }
  }

  /**
   * Get waveform analyser
   */
  getWaveformAnalyser(): Tone.Waveform | null {
    return this.waveformAnalyser;
  }

  /**
   * Get FFT for frequency mode
   */
  getFreqFFT(): ToneFFT | null {
    return this.freqAudio?.fft || this.micAudio?.fft || null;
  }

  /**
   * Get cached AudioBuffer for client-side BPM detection
   */
  getAudioBuffer(): AudioBuffer | null {
    return this.rawAudioBuffer;
  }
}

// Export singleton
export const audioEngine = new AudioEngine();
export default audioEngine;
