"""Tests for the /api/detect-bpm endpoint."""

import sys
import types
from unittest.mock import MagicMock

# Stub out audioop/pyaudioop and pydub before importing app,
# since pydub requires audioop which was removed in Python 3.13.
for mod_name in ('audioop', 'pyaudioop'):
    if mod_name not in sys.modules:
        sys.modules[mod_name] = types.ModuleType(mod_name)

pydub_mock = types.ModuleType('pydub')
pydub_mock.AudioSegment = MagicMock()
sys.modules.setdefault('pydub', pydub_mock)
sys.modules.setdefault('pydub.audio_segment', pydub_mock)
sys.modules.setdefault('pydub.utils', types.ModuleType('pydub.utils'))

import io
from unittest.mock import patch

import numpy as np
import pytest

from app import app


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as c:
        yield c


@patch('app.RhythmExtractor2013')
@patch('app.MonoLoader')
def test_detect_bpm_returns_bpm_and_offset(mock_loader, mock_rhythm, client):
    """Normal response returns bpm and beatOffset."""
    mock_loader.return_value = MagicMock(return_value=np.zeros(44100))
    ticks = np.array([0.4, 0.8, 1.2, 1.6])
    mock_rhythm.return_value = MagicMock(return_value=(140.0, ticks, None, None, None))

    data = io.BytesIO(b'\x00' * 1000)
    resp = client.post('/api/detect-bpm', data={'file': (data, 'test.wav')})
    json_data = resp.get_json()

    assert resp.status_code == 200
    assert json_data['bpm'] == 140
    assert json_data['beatOffset'] == 0.4


@patch('app.RhythmExtractor2013')
@patch('app.MonoLoader')
def test_detect_bpm_empty_ticks(mock_loader, mock_rhythm, client):
    """Empty ticks array returns beatOffset of 0."""
    mock_loader.return_value = MagicMock(return_value=np.zeros(44100))
    ticks = np.array([])
    mock_rhythm.return_value = MagicMock(return_value=(120.0, ticks, None, None, None))

    data = io.BytesIO(b'\x00' * 1000)
    resp = client.post('/api/detect-bpm', data={'file': (data, 'test.wav')})
    json_data = resp.get_json()

    assert resp.status_code == 200
    assert json_data['bpm'] == 120
    assert json_data['beatOffset'] == 0.0


@patch('app.RhythmExtractor2013')
@patch('app.MonoLoader')
def test_detect_bpm_error_returns_defaults(mock_loader, mock_rhythm, client):
    """When essentia raises, bpm and beatOffset default to 0."""
    mock_loader.return_value = MagicMock(side_effect=RuntimeError('bad audio'))

    data = io.BytesIO(b'\x00' * 1000)
    resp = client.post('/api/detect-bpm', data={'file': (data, 'test.wav')})
    json_data = resp.get_json()

    assert resp.status_code == 200
    assert json_data['bpm'] == 0
    assert json_data['beatOffset'] == 0


def test_detect_bpm_no_file_or_path(client):
    """Missing file and path returns 400."""
    resp = client.post('/api/detect-bpm')
    json_data = resp.get_json()

    assert resp.status_code == 400
    assert 'error' in json_data


@patch('app.RhythmExtractor2013')
@patch('app.MonoLoader')
def test_detect_bpm_with_path(mock_loader, mock_rhythm, client):
    """Accepts a path form field instead of file upload."""
    mock_loader.return_value = MagicMock(return_value=np.zeros(44100))
    ticks = np.array([0.25, 0.75])
    mock_rhythm.return_value = MagicMock(return_value=(128.0, ticks, None, None, None))

    resp = client.post('/api/detect-bpm', data={'path': 'sample.mp3'})
    json_data = resp.get_json()

    assert resp.status_code == 200
    assert json_data['bpm'] == 128
    assert json_data['beatOffset'] == 0.25
