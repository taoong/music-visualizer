"""
Flask backend for Music Visualizer — Stem Separation mode.

Serves the frontend statically and provides a POST /api/separate endpoint
that uses Demucs (htdemucs_6s) to split a track into 5 stems:
  kick, drums, bass, vocals, other

Run:  pip install -r requirements.txt && python app.py
"""

import os
import uuid
import shutil
import subprocess
import tempfile

from flask import Flask, request, jsonify, send_from_directory
from pydub import AudioSegment

# ── Paths ──────────────────────────────────────────────────────
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'output')
os.makedirs(OUTPUT_DIR, exist_ok=True)

app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path='')


# ── Static file serving ───────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory(PROJECT_ROOT, 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(PROJECT_ROOT, path)


# ── Stem separation endpoint ──────────────────────────────────
@app.route('/api/separate', methods=['POST'])
def separate():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'Empty filename'}), 400

    job_id = str(uuid.uuid4())
    job_dir = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    # Save uploaded file
    tmp_path = os.path.join(job_dir, 'input_audio')
    file.save(tmp_path)

    try:
        # ── 1. Run Demucs htdemucs_6s ──────────────────────────
        demucs_out = os.path.join(job_dir, 'demucs_out')
        subprocess.run([
            'python', '-m', 'demucs',
            '--mp3', '--mp3-bitrate', '192',
            '-n', 'htdemucs_6s',
            '-o', demucs_out,
            tmp_path,
        ], check=True, capture_output=True, text=True)

        # Find the output directory (demucs names it after the model/track)
        model_dir = os.path.join(demucs_out, 'htdemucs_6s')
        track_dirs = os.listdir(model_dir)
        if not track_dirs:
            return jsonify({'error': 'Demucs produced no output'}), 500
        stem_dir = os.path.join(model_dir, track_dirs[0])

        # ── 2. Kick isolation via DSP (low-pass on drums stem) ─
        drums_path = os.path.join(stem_dir, 'drums.mp3')
        drums = AudioSegment.from_mp3(drums_path)

        # Export drums to wav for filtering
        drums_wav = os.path.join(job_dir, 'drums.wav')
        drums.export(drums_wav, format='wav')

        # Low-pass at 150Hz for kick
        kick_path = os.path.join(job_dir, 'kick.mp3')
        subprocess.run([
            'ffmpeg', '-y', '-i', drums_wav,
            '-af', 'lowpass=f=150',
            '-b:a', '192k', kick_path,
        ], check=True, capture_output=True)

        # High-pass at 150Hz for remaining drums
        drums_no_kick_path = os.path.join(job_dir, 'drums.mp3')
        subprocess.run([
            'ffmpeg', '-y', '-i', drums_wav,
            '-af', 'highpass=f=150',
            '-b:a', '192k', drums_no_kick_path,
        ], check=True, capture_output=True)

        # ── 3. Merge guitar + piano + other → single "other" ──
        guitar_path = os.path.join(stem_dir, 'guitar.mp3')
        piano_path = os.path.join(stem_dir, 'piano.mp3')
        other_orig_path = os.path.join(stem_dir, 'other.mp3')

        # Collect available stems for merging
        merge_inputs = []
        for p in [guitar_path, piano_path, other_orig_path]:
            if os.path.exists(p):
                merge_inputs.append(p)

        other_path = os.path.join(job_dir, 'other.mp3')
        if len(merge_inputs) > 1:
            filter_args = ''.join(
                f'[{i}:a]' for i in range(len(merge_inputs))
            ) + f'amix=inputs={len(merge_inputs)}:duration=longest'
            cmd = ['ffmpeg', '-y']
            for p in merge_inputs:
                cmd += ['-i', p]
            cmd += ['-filter_complex', filter_args, '-b:a', '192k', other_path]
            subprocess.run(cmd, check=True, capture_output=True)
        elif merge_inputs:
            shutil.copy2(merge_inputs[0], other_path)

        # ── 4. Copy bass and vocals ────────────────────────────
        bass_path = os.path.join(job_dir, 'bass.mp3')
        vocals_path = os.path.join(job_dir, 'vocals.mp3')
        shutil.copy2(os.path.join(stem_dir, 'bass.mp3'), bass_path)
        shutil.copy2(os.path.join(stem_dir, 'vocals.mp3'), vocals_path)

        # ── 5. Clean up large demucs output ────────────────────
        shutil.rmtree(demucs_out, ignore_errors=True)
        os.remove(tmp_path)
        if os.path.exists(drums_wav):
            os.remove(drums_wav)

        # ── 6. Return stem URLs ────────────────────────────────
        base = f'/server/output/{job_id}'
        return jsonify({
            'stems': {
                'kick': f'{base}/kick.mp3',
                'drums': f'{base}/drums.mp3',
                'bass': f'{base}/bass.mp3',
                'vocals': f'{base}/vocals.mp3',
                'other': f'{base}/other.mp3',
            }
        })

    except subprocess.CalledProcessError as e:
        return jsonify({
            'error': 'Stem separation failed',
            'detail': e.stderr or str(e),
        }), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── BPM detection endpoint ───────────────────────────────────
@app.route('/api/detect-bpm', methods=['POST'])
def detect_bpm():
    import librosa
    tmp_path = None
    try:
        if 'file' in request.files:
            file = request.files['file']
            tmp_path = os.path.join(tempfile.gettempdir(), f'bpm_{uuid.uuid4()}')
            file.save(tmp_path)
            audio_path = tmp_path
        elif 'path' in request.form:
            audio_path = os.path.join(PROJECT_ROOT, request.form['path'])
        else:
            return jsonify({'error': 'No file or path provided'}), 400

        y, sr = librosa.load(audio_path, sr=None, mono=True)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo))
        return jsonify({'bpm': bpm})
    except Exception as e:
        return jsonify({'error': str(e), 'bpm': 120}), 200
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
