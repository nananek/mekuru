import './style.css';
import { PencilEngine, Point } from './engine/PencilEngine';
import { DebugService } from './services/DebugService';

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('debug-canvas') as HTMLCanvasElement;
  const bridgeStatusIndicator = document.getElementById('bridge-status-indicator') as HTMLElement;
  const bridgeStatusText = document.getElementById('bridge-status-text') as HTMLElement;
  const jobCounterEl = document.getElementById('job-counter') as HTMLElement;
  const presetsContainer = document.getElementById('presets-container') as HTMLElement;
  const strokesList = document.getElementById('strokes-list') as HTMLElement;
  const refreshStrokesBtn = document.getElementById('refresh-strokes-btn') as HTMLButtonElement;
  const clearStrokesBtn = document.getElementById('clear-strokes-btn') as HTMLButtonElement;
  const clearCanvasBtn = document.getElementById('clear-canvas-btn') as HTMLButtonElement;
  const sendStrokeBtn = document.getElementById('send-stroke-btn') as HTMLButtonElement;
  const rerenderBtn = document.getElementById('rerender-btn') as HTMLButtonElement;
  const copyJsonBtn = document.getElementById('copy-json-btn') as HTMLButtonElement;

  const inspectorEmpty = document.getElementById('inspector-empty') as HTMLElement;
  const inspectorContent = document.getElementById('inspector-content') as HTMLElement;
  const statPoints = document.getElementById('stat-points') as HTMLElement;
  const statMode = document.getElementById('stat-mode') as HTMLElement;
  const statAltitude = document.getElementById('stat-altitude') as HTMLElement;
  const statPressure = document.getElementById('stat-pressure') as HTMLElement;
  const pointsTbody = document.getElementById('points-tbody') as HTMLElement;
  const capturedImageBox = document.getElementById('captured-image-box') as HTMLElement;
  const capturedImg = document.getElementById('captured-img') as HTMLImageElement;

  let jobsCompleted = 0;
  let activeStrokePoints: Point[] = [];
  let currentInspectedStroke: any = null;

  // Initialize Canvas & Engine
  const dpr = window.devicePixelRatio || 2;
  const logicalWidth = 800;
  const logicalHeight = 600;
  canvas.width = Math.round(logicalWidth * dpr);
  canvas.height = Math.round(logicalHeight * dpr);
  canvas.style.width = `${logicalWidth}px`;
  canvas.style.height = `${logicalHeight}px`;

  const engine = new PencilEngine(canvas, {
    onStrokeStart: () => {
      activeStrokePoints = [];
    },
    onPoint: (pt) => {
      activeStrokePoints.push(pt);
      updateInspectorPreview(activeStrokePoints);
    },
    onStrokeEnd: () => {
      if (activeStrokePoints.length > 0) {
        currentInspectedStroke = {
          points: [...activeStrokePoints],
          label: 'manual_canvas_stroke',
        };
        updateInspectorPreview(activeStrokePoints);
      }
    },
  });

  engine.fillPaperBackground();

  // ---------------------------------------------------------------------------
  // Live Bridge Worker (Polls /api/debug/bridge/poll and renders in background)
  // ---------------------------------------------------------------------------
  let bridgePollActive = true;

  const runBridge = async () => {
    while (bridgePollActive) {
      try {
        const res = await fetch('/api/debug/bridge/poll');
        if (res.ok) {
          bridgeStatusIndicator.className =
            'flex items-center gap-2 px-3 py-1 rounded-full bg-green-500/20 text-green-300 font-mono border border-green-500/30';
          bridgeStatusText.textContent = 'Bridge: Connected (Live)';

          const data = await res.json();
          if (data.job) {
            await handleJob(data.job);
          }
        } else {
          bridgeStatusIndicator.className =
            'flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/20 text-red-300 font-mono border border-red-500/30';
          bridgeStatusText.textContent = `Bridge: HTTP ${res.status}`;
        }
      } catch {
        bridgeStatusIndicator.className =
          'flex items-center gap-2 px-3 py-1 rounded-full bg-yellow-500/20 text-yellow-300 font-mono border border-yellow-500/30';
        bridgeStatusText.textContent = 'Bridge: Disconnected (Retrying)';
        await new Promise((r) => setTimeout(r, 2000));
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const handleJob = async (job: any) => {
    // Clear and draw onto main canvas to give visual feedback
    engine.clearCanvas();
    engine.replayStroke(job.points);

    // Snapshot image
    const imageBase64 = canvas.toDataURL('image/png');

    // Post result
    await fetch('/api/debug/bridge/response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: job.id,
        image_base64: imageBase64,
      }),
    });

    jobsCompleted++;
    jobCounterEl.textContent = `Jobs rendered: ${jobsCompleted}`;
    currentInspectedStroke = {
      id: job.id,
      points: job.points,
      label: 'llm_live_render',
    };
    updateInspectorPreview(job.points);
    loadRecentStrokes();
  };

  runBridge();

  // ---------------------------------------------------------------------------
  // Presets Runner
  // ---------------------------------------------------------------------------
  presetsContainer.addEventListener('click', async (e) => {
    const target = (e.target as HTMLElement).closest('.preset-btn') as HTMLElement;
    if (!target) return;

    const presetKey = target.dataset.preset;
    if (!presetKey) return;

    try {
      const presets = await DebugService.fetchPresets();
      const preset = presets[presetKey];
      if (preset && preset.points) {
        engine.clearCanvas();
        engine.replayStroke(preset.points);

        currentInspectedStroke = {
          points: preset.points,
          label: presetKey,
        };
        updateInspectorPreview(preset.points);

        // Auto-save to debug API
        await fetch('/api/debug/strokes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: presetKey,
            points: preset.points,
            metadata: {
              preset: presetKey,
              description: preset.description,
            },
            image_base64: canvas.toDataURL('image/png'),
          }),
        });

        loadRecentStrokes();
      }
    } catch (err) {
      alert(`プリセット実行エラー: ${err}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Recorded Strokes Management
  // ---------------------------------------------------------------------------
  const loadRecentStrokes = async () => {
    try {
      const strokes = await DebugService.fetchRecentStrokes(30);
      if (strokes.length === 0) {
        strokesList.innerHTML =
          '<div class="text-black/40 text-[11px] p-2 text-center">記録されたストロークはありません</div>';
        return;
      }

      strokesList.innerHTML = strokes
        .map(
          (s) => `
        <div class="stroke-item p-2 rounded-lg border border-black/10 hover:border-black/30 hover:bg-black/[0.02] cursor-pointer transition flex items-center justify-between" data-id="${s.id}">
          <div class="overflow-hidden pr-2">
            <div class="font-medium text-black/80 truncate">${s.label || '無題ストローク'}</div>
            <div class="text-[10px] text-black/40 font-mono mt-0.5">${s.created_at.slice(11, 19)} · ${s.point_count} pts</div>
          </div>
          <div class="flex-none flex items-center gap-1.5">
            ${
              s.has_image
                ? `<img src="/api/debug/strokes/${s.id}/image" class="w-8 h-8 rounded border border-black/10 object-cover bg-white" alt="thumb" />`
                : ''
            }
          </div>
        </div>
      `
        )
        .join('');
    } catch {
      strokesList.innerHTML =
        '<div class="text-red-500 text-[11px] p-2 text-center">ストローク一覧の取得に失敗しました</div>';
    }
  };

  strokesList.addEventListener('click', async (e) => {
    const item = (e.target as HTMLElement).closest('.stroke-item') as HTMLElement;
    if (!item) return;

    const id = item.dataset.id;
    if (!id) return;

    try {
      const detail = await DebugService.fetchStrokeDetail(id);
      currentInspectedStroke = detail;
      updateInspectorPreview(detail.points, detail);
    } catch (err) {
      alert(`ストローク取得エラー: ${err}`);
    }
  });

  refreshStrokesBtn.addEventListener('click', loadRecentStrokes);

  clearStrokesBtn.addEventListener('click', async () => {
    if (confirm('記録されたすべてのストロークを削除しますか？')) {
      await fetch('/api/debug/strokes', { method: 'DELETE' });
      loadRecentStrokes();
      inspectorEmpty.classList.remove('hidden');
      inspectorContent.classList.add('hidden');
    }
  });

  // ---------------------------------------------------------------------------
  // Canvas Actions
  // ---------------------------------------------------------------------------
  clearCanvasBtn.addEventListener('click', () => {
    engine.clearCanvas();
    activeStrokePoints = [];
  });

  sendStrokeBtn.addEventListener('click', async () => {
    if (!currentInspectedStroke || !currentInspectedStroke.points || currentInspectedStroke.points.length === 0) {
      alert('保存するストロークがありません。キャンバスに描画してください。');
      return;
    }

    try {
      await fetch('/api/debug/strokes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: currentInspectedStroke.label || 'manual_saved',
          points: currentInspectedStroke.points,
          metadata: { savedVia: 'workbench' },
          image_base64: canvas.toDataURL('image/png'),
        }),
      });
      loadRecentStrokes();
      alert('ストロークをデバッグAPIに保存しました');
    } catch (err) {
      alert(`保存エラー: ${err}`);
    }
  });

  rerenderBtn.addEventListener('click', () => {
    if (!currentInspectedStroke || !currentInspectedStroke.points) return;
    engine.clearCanvas();
    engine.replayStroke(currentInspectedStroke.points);
  });

  copyJsonBtn.addEventListener('click', () => {
    if (!currentInspectedStroke || !currentInspectedStroke.points) return;
    navigator.clipboard.writeText(JSON.stringify(currentInspectedStroke.points, null, 2));
    alert('ポイント列のJSONをクリップボードにコピーしました！');
  });

  // ---------------------------------------------------------------------------
  // Inspector UI Updates
  // ---------------------------------------------------------------------------
  function updateInspectorPreview(points: Point[], detail?: any) {
    if (!points || points.length === 0) {
      inspectorEmpty.classList.remove('hidden');
      inspectorContent.classList.add('hidden');
      return;
    }

    inspectorEmpty.classList.add('hidden');
    inspectorContent.classList.remove('hidden');

    statPoints.textContent = points.length.toString();

    let sumPress = 0;
    let minAlt = Math.PI / 2;
    for (const p of points) {
      sumPress += p.pressure;
      if (p.altitudeAngle < minAlt) {
        minAlt = p.altitudeAngle;
      }
    }
    const avgPress = sumPress / points.length;

    statPressure.textContent = avgPress.toFixed(2);
    statAltitude.textContent = `${minAlt.toFixed(2)} rad (${Math.round((minAlt * 180) / Math.PI)}°)`;

    const isShading = minAlt < PencilEngine.TILT_SHADING_THRESHOLD;
    statMode.textContent = isShading ? 'Tilt Shading' : 'Normal Line';
    statMode.className = `text-base font-bold font-mono mt-0.5 ${
      isShading ? 'text-amber-600' : 'text-blue-600'
    }`;

    // Image thumbnail
    if (detail && detail.has_image) {
      capturedImageBox.classList.remove('hidden');
      capturedImg.src = `/api/debug/strokes/${detail.id}/image`;
    } else {
      capturedImageBox.classList.add('hidden');
    }

    // Points table (first 10)
    const previewPoints = points.slice(0, 10);
    pointsTbody.innerHTML = previewPoints
      .map(
        (p, i) => `
      <tr class="hover:bg-black/5">
        <td class="p-1.5 text-black/40">${i + 1}</td>
        <td class="p-1.5">${Math.round(p.x)}</td>
        <td class="p-1.5">${Math.round(p.y)}</td>
        <td class="p-1.5">${p.pressure.toFixed(2)}</td>
        <td class="p-1.5">${p.altitudeAngle.toFixed(2)}</td>
      </tr>
    `
      )
      .join('');
  }

  // Initial load
  loadRecentStrokes();
});
