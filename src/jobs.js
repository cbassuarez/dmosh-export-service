const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const JOBS = new Map();
const TMP_DIR = path.join(os.tmpdir(), 'dmosh-export-service');
const MAX_CONCURRENT_FFMPEG = parseInt(process.env.MAX_CONCURRENT_FFMPEG || '2', 10);
let activeRenders = 0;

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const SOFT_MAX_WIDTH = 3840;
const SOFT_MAX_HEIGHT = 2160;
const SOFT_MAX_DURATION_SECONDS = 10 * 60;
const EXTREME_MAX_DIMENSION = 8192;
const EXTREME_MAX_DURATION_SECONDS = 60 * 60;

function approxUncompressedGB(width, height, fps, seconds, bytesPerPixel = 4) {
  const frames = fps * seconds;
  const bytes = width * height * frames * bytesPerPixel;
  return bytes / (1024 * 1024 * 1024);
}

function resolveSourcePathFromProject(project, settings) {
  const mediaRoot = process.env.MEDIA_ROOT || process.cwd();
  const source = settings.source || { kind: 'timeline' };

  let sourceObj = null;

  if (source.kind === 'source' && source.sourceId && Array.isArray(project?.sources)) {
    sourceObj = project.sources.find((s) => s.id === source.sourceId) || null;
  } else if (source.kind === 'clip' && source.clipId && Array.isArray(project?.timeline?.clips)) {
    const clip = project.timeline.clips.find((c) => c.id === source.clipId);
    if (clip && Array.isArray(project.sources)) {
      sourceObj = project.sources.find((s) => s.id === clip.sourceId) || null;
    }
  } else if (source.kind === 'timeline' && Array.isArray(project?.timeline?.clips) && project.timeline.clips.length === 1) {
    const clip = project.timeline.clips[0];
    if (Array.isArray(project.sources)) {
      sourceObj = project.sources.find((s) => s.id === clip.sourceId) || null;
    }
  }

  if (!sourceObj) {
    return null;
  }

  const originalName = sourceObj.originalName || '';
  const extFromName = path.extname(originalName) || '.mp4';
  const hash = sourceObj.hash || '';

  const candidates = [];

  if (hash) {
    candidates.push(path.join(mediaRoot, `${hash}${extFromName}`));
    candidates.push(path.join(mediaRoot, hash));
  }

  if (originalName) {
    candidates.push(path.join(mediaRoot, originalName));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function logMemory(label) {
  if (process.env.NODE_ENV === 'production') return;
  const m = process.memoryUsage();
  console.log(`[mem] ${label}`, {
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
  });
}

function deriveRenderParams(project, settings) {
  const projectWidth = project?.settings?.width ?? 640;
  const projectHeight = project?.settings?.height ?? 360;

  let width = projectWidth;
  let height = projectHeight;

  if (settings.outputResolution === 'custom') {
    if (settings.width && settings.height) {
      width = settings.width;
      height = settings.height;
    }
  }

  const scale = settings.renderResolutionScale ?? 1;
  width = Math.max(16, Math.round(width * scale));
  height = Math.max(16, Math.round(height * scale));

  const projectFps = project?.timeline?.fps ?? project?.settings?.fps ?? 24;
  let fps = projectFps;

  if (settings.fpsMode === 'override' && settings.fps) {
    fps = settings.fps;
  }

  // Guard against bad fps values
  if (!Number.isFinite(fps) || fps <= 0) {
    fps = 24;
  }

  const durationFrames = computeDurationFrames(project, settings);
  const durationSeconds = Math.max(0.1, durationFrames / fps);

  if (process.env.NODE_ENV !== 'production') {
    const approxGB = approxUncompressedGB(width, height, fps, durationSeconds);
    console.log('[dmosh-export-service] deriveRenderParams', {
      projectWidth,
      projectHeight,
      projectFps,
      settingsWidth: settings.width,
      settingsHeight: settings.height,
      scale,
      width,
      height,
      fps,
      durationFrames,
      durationSeconds,
      approxUncompressedGB: approxGB.toFixed(3),
    });
  }

  return { width, height, fps, durationSeconds };
}

function computeDurationFrames(project, settings) {
  const source = settings.source || { kind: 'timeline' };

  const ensureMinFrames = (frames) => Math.max(1, frames || 0);

  let frames;

  if (source.kind === 'timeline') {
    if (typeof source.inFrame === 'number' && typeof source.outFrame === 'number') {
      frames = ensureMinFrames(source.outFrame - source.inFrame + 1);
    } else {
      const clips = project?.timeline?.clips ?? [];
      if (clips.length > 0) {
        const minStart = Math.min(...clips.map((c) => c.timelineStartFrame));
        const maxEnd = Math.max(
          ...clips.map((c) => c.timelineStartFrame + (c.endFrame - c.startFrame)),
        );
        frames = ensureMinFrames(maxEnd - minStart + 1);
      } else {
        const fps = project?.timeline?.fps ?? project?.settings?.fps ?? 24;
        frames = ensureMinFrames(fps);
      }
    }
  } else if (source.kind === 'clip' && source.clipId && project?.timeline?.clips) {
    const clips = project.timeline.clips;
    const clip = clips.find((c) => c.id === source.clipId);
    if (clip) {
      frames = ensureMinFrames(clip.endFrame - clip.startFrame + 1);
    }
  } else if (source.kind === 'source' && source.sourceId && project?.sources) {
    const src = project.sources.find((s) => s.id === source.sourceId);
    if (src?.durationFrames) {
      frames = ensureMinFrames(src.durationFrames);
    }
  }

  if (!frames) {
    const fps = project?.timeline?.fps ?? project?.settings?.fps ?? 24;
    frames = ensureMinFrames(fps);
  }

  if (process.env.NODE_ENV !== 'production') {
    if (frames > 60 * 60 * 60) { // > 1 hour at 60fps
      console.warn('[dmosh-export-service] computeDurationFrames: unusually large frame count', {
        frames,
        source,
      });
    } else {
      console.log('[dmosh-export-service] computeDurationFrames', { frames, source });
    }
  }

  return frames;
}

function mapVideoCodec(videoCodec, container) {
  if (!videoCodec) return container === 'webm' ? 'libvpx-vp9' : 'libx264';

  switch (videoCodec) {
    case 'h264':
      return 'libx264';
    case 'h265':
      return 'libx265';
    case 'vp9':
      return 'libvpx-vp9';
    case 'av1':
      return 'libaom-av1';
    case 'prores_422':
    case 'prores_422_hq':
      return 'prores_ks';
    default:
      return 'libx264';
  }
}

function pruneOldJobs() {
  const now = Date.now();
  const MAX_AGE_MS = 60 * 60 * 1000;
  for (const [id, job] of JOBS.entries()) {
    const created = Date.parse(job.createdAt || '') || 0;
    if (created && now - created > MAX_AGE_MS) {
      if (job.downloadPath && fs.existsSync(job.downloadPath)) {
        try {
          fs.unlinkSync(job.downloadPath);
        } catch (_) {}
      }
      JOBS.delete(id);
    }
  }
}

function startRender(job, project, settings, onDone) {
  const { width, height, fps, durationSeconds } = deriveRenderParams(project, settings);

  if (width > SOFT_MAX_WIDTH || height > SOFT_MAX_HEIGHT) {
    console.warn('[dmosh-export-service] large resolution requested', { id: job.id, width, height });
  }

  if (durationSeconds > SOFT_MAX_DURATION_SECONDS) {
    console.warn('[dmosh-export-service] long duration requested', { id: job.id, durationSeconds });
  }

  if (width > EXTREME_MAX_DIMENSION || height > EXTREME_MAX_DIMENSION || durationSeconds > EXTREME_MAX_DURATION_SECONDS) {
    job.status = 'failed';
    job.error = 'job_too_large';
    if (typeof onDone === 'function') {
      onDone();
    }
    return;
  }

  const container = settings.container || 'mp4';
  const outputPath = path.join(TMP_DIR, `${job.id}.${container}`);

  job.status = 'rendering';
  job.progress = 0;
  job.error = null;
  job.downloadPath = outputPath;

  const codec = mapVideoCodec(settings.videoCodec, container);
  const pixelFormat = settings.pixelFormat || 'yuv420p';
  const inputPath = resolveSourcePathFromProject(project, settings);

  let command;
  let usingRealContent = false;

  if (process.env.NODE_ENV !== 'production') {
    console.log('[dmosh-export-service] starting render', {
      id: job.id,
      width,
      height,
      fps,
      durationSeconds,
      container,
      codec,
      inputPath,
      outputPath,
    });
  }

  try {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Failed to remove existing file before render', outputPath, e);
    }
  }

  logMemory(`job ${job.id} start`);

  if (inputPath) {
    usingRealContent = true;
    const source = settings.source || { kind: 'timeline' };

    command = ffmpeg(inputPath);

    const needsScale =
      settings.outputResolution === 'custom' ||
      (width !== project?.settings?.width || height !== project?.settings?.height);

    if (needsScale) {
      command = command.videoFilters(`scale=${width}:${height}`);
    }

    let effectiveFps = fps;
    if (settings.fpsMode === 'override' && settings.fps) {
      effectiveFps = settings.fps;
    }

    if (effectiveFps && typeof effectiveFps === 'number') {
      command = command.outputOptions(['-r', String(effectiveFps)]);
    }

    if (source.kind === 'timeline' && typeof source.inFrame === 'number' && typeof source.outFrame === 'number') {
      const inSec = source.inFrame / fps;
      const outSec = source.outFrame / fps;
      command = command.setStartTime(inSec).outputOptions(['-t', String(Math.max(0.1, outSec - inSec))]);
    }

    const canCopyVideo =
      settings.outputResolution !== 'custom' &&
      !needsScale &&
      settings.fpsMode === 'project' &&
      (settings.rateControl?.mode === 'bitrate' || settings.rateControl?.mode === 'crf') &&
      (settings.videoCodec === 'h264' || !settings.videoCodec) &&
      (container === 'mp4' || container === 'mkv' || container === 'mov');

    if (canCopyVideo) {
      command = command.videoCodec('copy');
      if (settings.includeAudio && settings.audioCodec && settings.audioCodec !== 'none') {
        command = command.audioCodec('copy');
      } else {
        command = command.noAudio();
      }
    } else {
      command = command.videoCodec(codec).outputOptions(['-pix_fmt', pixelFormat]);

      if (settings.includeAudio && settings.audioCodec && settings.audioCodec !== 'none') {
        command = command.audioCodec(settings.audioCodec);
      } else {
        command = command.noAudio();
      }
    }
  } else {
    const input = `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSeconds}`;
    command = ffmpeg(input)
      .inputFormat('lavfi')
      .videoCodec(codec)
      .outputOptions(['-pix_fmt', pixelFormat])
      .noAudio();
  }

  command
    .on('start', (cmdLine) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[dmosh-export-service] ffmpeg start', { id: job.id, cmdLine });
      }
    })
    .on('progress', (progress) => {
      if (!JOBS.has(job.id)) {
        try {
          command.kill('SIGKILL');
        } catch (_) {}
        return;
      }

      const pct = typeof progress.percent === 'number'
        ? progress.percent
        : Math.min(99, job.progress + 1);

      job.progress = Math.max(job.progress, Math.min(100, Math.round(pct)));
    })
    .on('error', (err) => {
      job.status = 'failed';
      job.error = err?.message || 'ffmpeg_error';
      job.progress = 0;

      if (process.env.NODE_ENV !== 'production') {
        console.error('[dmosh-export-service] ffmpeg error', {
          id: job.id,
          error: job.error,
        });
      }

      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch (_) {}

      logMemory(`job ${job.id} end`);

      try {
        if (typeof onDone === 'function') {
          onDone();
        }
      } catch (_) {}
    })
    .on('end', () => {
      job.status = 'complete';
      job.progress = 100;

      if (process.env.NODE_ENV !== 'production') {
        console.log('[dmosh-export-service] ffmpeg complete', { id: job.id, outputPath, usingRealContent });
      }

      logMemory(`job ${job.id} end`);
      pruneOldJobs();

      try {
        if (typeof onDone === 'function') {
          onDone();
        }
      } catch (_) {}
    })
    .save(outputPath);
}

function tryStartQueuedJobs(projectLookup) {
  if (activeRenders >= MAX_CONCURRENT_FFMPEG) return;

  for (const job of JOBS.values()) {
    if (job.status === 'queued' && !job._started) {
      job._started = true;
      activeRenders += 1;

      const onDone = () => {
        activeRenders = Math.max(0, activeRenders - 1);
        if (createJob._projects) {
          createJob._projects.delete(job.id);
        }
        tryStartQueuedJobs(projectLookup);
      };

      const { project, settings } = projectLookup(job.id);
      startRender(job, project || {}, settings || {}, onDone);
      break;
    }
  }
}

function createJob({ project, settings, clientVersion }) {
  const id = uuidv4();

  const safeSettings = settings || {};

  const job = {
    id,
    status: 'queued',
    progress: 0,
    error: null,
    container: safeSettings.container || 'mp4',
    createdAt: new Date().toISOString(),
    clientVersion: clientVersion || null,
    downloadPath: null,
  };

  JOBS.set(id, job);

  if (!createJob._projects) {
    createJob._projects = new Map();
  }
  createJob._projects.set(id, { project: project || {}, settings: safeSettings });

  setImmediate(() => {
    tryStartQueuedJobs((jobId) => createJob._projects.get(jobId) || { project: {}, settings: safeSettings });
  });

  return job;
}

function getJob(id) {
  return JOBS.get(id) || null;
}

module.exports = {
  createJob,
  getJob,
  deriveRenderParams,
  computeDurationFrames,
};
