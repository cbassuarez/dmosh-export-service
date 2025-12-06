const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const JOBS = new Map();
const TMP_DIR = path.join(os.tmpdir(), 'dmosh-export-service');

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Safety caps for stub rendering (can be relaxed/removed later)
const MAX_WIDTH = 1920;          // max output width for stub
const MAX_HEIGHT = 1080;         // max output height for stub
const MAX_FPS = 60;              // max fps for stub
const MAX_DURATION_SECONDS = 60; // max duration (seconds) for stub

function approxUncompressedGB(width, height, fps, seconds, bytesPerPixel = 4) {
  const frames = fps * seconds;
  const bytes = width * height * frames * bytesPerPixel;
  return bytes / (1024 * 1024 * 1024);
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

  // Keep copies before clamping
  const unclampedWidth = width;
  const unclampedHeight = height;

  // Clamp to safety caps
  width = Math.min(width, MAX_WIDTH);
  height = Math.min(height, MAX_HEIGHT);

  const projectFps = project?.timeline?.fps ?? project?.settings?.fps ?? 24;
  let fps = projectFps;

  if (settings.fpsMode === 'override' && settings.fps) {
    fps = settings.fps;
  }

  // Guard against bad fps values
  if (!Number.isFinite(fps) || fps <= 0) {
    fps = 24;
  }

  const unclampedFps = fps;
  fps = Math.min(fps, MAX_FPS);

  const durationFrames = computeDurationFrames(project, settings);
  let durationSeconds = durationFrames / fps;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = 1;
  }

  const unclampedDurationSeconds = durationSeconds;
  durationSeconds = Math.min(durationSeconds, MAX_DURATION_SECONDS);

  if (process.env.NODE_ENV !== 'production') {
    const approxGB = approxUncompressedGB(width, height, fps, durationSeconds);
    console.log('[dmosh-export-service] deriveRenderParams', {
      projectWidth,
      projectHeight,
      projectFps,
      settingsWidth: settings.width,
      settingsHeight: settings.height,
      scale,
      unclampedWidth,
      unclampedHeight,
      width,
      height,
      unclampedFps,
      fps,
      durationFrames,
      unclampedDurationSeconds,
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

function startStubRender(job, project, settings) {
  const { width, height, fps, durationSeconds } = deriveRenderParams(project, settings);

  const container = settings.container || 'mp4';
  const outputPath = path.join(TMP_DIR, `${job.id}.${container}`);

  job.status = 'rendering';
  job.progress = 0;
  job.error = null;
  job.downloadPath = outputPath;

  const codec = mapVideoCodec(settings.videoCodec, container);

  if (process.env.NODE_ENV !== 'production') {
    console.log('[dmosh-export-service] starting stub render', {
      id: job.id,
      width,
      height,
      fps,
      durationSeconds,
      container,
      codec,
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

  const input = `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSeconds}`;

  const command = ffmpeg(input)
    .inputFormat('lavfi')
    .videoCodec(codec)
    .outputOptions(['-pix_fmt', settings.pixelFormat || 'yuv420p'])
    .noAudio()
    .on('start', (cmdLine) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[dmosh-export-service] ffmpeg start', { id: job.id, cmdLine });
      }
    })
    .on('progress', (progress) => {
      const jobRef = JOBS.get(job.id);
      if (!jobRef) {
        try {
          command.kill('SIGKILL');
        } catch (_) {}
        return;
      }

      const pct = typeof progress.percent === 'number'
        ? progress.percent
        : Math.min(99, jobRef.progress + 1);

      jobRef.progress = Math.max(jobRef.progress, Math.min(100, Math.round(pct)));
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
    })
    .on('end', () => {
      job.status = 'complete';
      job.progress = 100;

      if (process.env.NODE_ENV !== 'production') {
        console.log('[dmosh-export-service] ffmpeg complete', { id: job.id, outputPath });
      }

      logMemory(`job ${job.id} end`);
      pruneOldJobs();
    })
    .save(outputPath);
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

  setImmediate(() => startStubRender(job, project || {}, safeSettings));

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
