const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const JOBS = new Map();
const TMP_DIR = path.join(os.tmpdir(), 'dmosh-export-service');
const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(os.tmpdir(), 'dmosh-media');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
if (!fs.existsSync(MEDIA_ROOT)) {
  fs.mkdirSync(MEDIA_ROOT, { recursive: true });
}

const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 20);
const RUNNING_JOBS = new Set();
const QUEUE = [];
const IS_DEV = process.env.NODE_ENV !== 'production';

function debugLog(label, payload) {
  if (!IS_DEV) return;
  console.log('[dmosh-export-service]', label, payload);
}

function debugError(label, payload) {
  if (!IS_DEV) return;
  console.error('[dmosh-export-service]', label, payload);
}

function pushJobDebug(job, label, payload) {
    // Always record debug entries so the frontend can inspect them,
      // even in production. Console logging is still dev-only.
      if (!job) return;
  if (!job.debug) job.debug = [];
  // keep it bounded
  if (job.debug.length > 50) job.debug.shift();
  job.debug.push({
    ts: new Date().toISOString(),
    label,
    payload,
  });
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

function safeBaseName(name) {
  if (!name) return null;
  return path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getMediaCandidatePaths({ hash, originalName, container }) {
  const paths = [];
  const safeName = safeBaseName(originalName);
  const base = path.join(MEDIA_ROOT, hash || '');

  const preferredExts = [];
  if (container) preferredExts.push(container);
  preferredExts.push('mp4', 'mov', 'mkv', 'webm');

  if (hash) {
    for (const ext of preferredExts) {
      paths.push(`${base}.${ext}`);
    }
    paths.push(base);
  }

  if (safeName) {
    paths.push(path.join(MEDIA_ROOT, safeName));
  }

  return paths;
}

function resolveMediaPathForSource(project, sourceRef, container) {
  if (!sourceRef) return null;

  const hash = sourceRef.hash;
  const originalName = sourceRef.originalName;

  if (!hash && !originalName) {
    return null;
  }

  const candidates = getMediaCandidatePaths({ hash, originalName, container });
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
        return candidate;
      }
    } catch (_) {
      // ignore
    }
  }
  return null;
}

function resolvePrimarySource(project, settings) {
  const sourceRef = settings.source || { kind: 'timeline' };

  const sources = project?.sources || [];
  const clips = project?.timeline?.clips || [];

  if (sourceRef.kind === 'source' && sourceRef.sourceId) {
    return sources.find((s) => s.id === sourceRef.sourceId) || null;
  }

  if (sourceRef.kind === 'clip' && sourceRef.clipId) {
    const clip = clips.find((c) => c.id === sourceRef.clipId);
    if (!clip) return null;
    return sources.find((s) => s.id === clip.sourceId) || null;
  }

  if (clips.length === 0) return null;

  const sourceIds = new Set(clips.map((c) => c.sourceId).filter(Boolean));
  if (sourceIds.size !== 1) {
    return null;
  }
  const [onlySourceId] = Array.from(sourceIds);
  return sources.find((s) => s.id === onlySourceId) || null;
}

function isSimpleTimeline(project, settings) {
  const sourceRef = settings.source || { kind: 'timeline' };
  if (sourceRef.kind !== 'timeline') return true;

  const clips = project?.timeline?.clips || [];
  if (clips.length === 0) return true;

  const sourceIds = new Set(clips.map((c) => c.sourceId).filter(Boolean));
  if (sourceIds.size !== 1) {
    return false;
  }

  const sorted = [...clips].sort((a, b) => (a.timelineStartFrame || 0) - (b.timelineStartFrame || 0));
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const prevEnd = (prev.timelineStartFrame || 0) + (prev.endFrame - prev.startFrame);
    const currentStart = sorted[i].timelineStartFrame || 0;
    if (currentStart < prevEnd) {
      return false;
    }
  }

  return true;
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
    if (frames > 60 * 60 * 60) {
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

function mapAudioCodec(audioCodec) {
  switch (audioCodec) {
    case 'aac':
      return 'aac';
    case 'pcm_s16le':
      return 'pcm_s16le';
    case 'opus':
      return 'libopus';
    case 'none':
      return 'none';
    default:
      return 'aac';
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

function scheduleNext() {
  if (RUNNING_JOBS.size >= MAX_CONCURRENT_JOBS) return;
  if (QUEUE.length === 0) return;

  const next = QUEUE.shift();
  if (!next) return;

  const { jobId, project, settings } = next;
  const job = JOBS.get(jobId);
  if (!job) {
    scheduleNext();
    return;
  }

  startRenderJob(job, project, settings);
}

function startRenderJob(job, project, settings) {
  RUNNING_JOBS.add(job.id);

  const safeSettings = settings || {};
  const container = safeSettings.container || 'mp4';
  const outputPath = path.join(TMP_DIR, `${job.id}.${container}`);

  job.status = 'rendering';
  job.progress = 0;
  job.error = null;
  job.downloadPath = outputPath;

  try {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Failed to remove existing file before render', outputPath, e);
    }
  }

  if (!isSimpleTimeline(project, safeSettings)) {
    job.status = 'failed';
    job.error = 'unsupported_timeline';
    job.progress = 0;
    job.downloadPath = null;
    RUNNING_JOBS.delete(job.id);
    pruneOldJobs();
    scheduleNext();
      debugError('unsupported_timeline', {
        jobId: job.id,
        source: safeSettings.source || null,
        clipCount: project?.timeline?.clips?.length ?? 0,
        trackCount: project?.timeline?.tracks?.length ?? 0,
      });
    return;
  }

    const primarySource = resolvePrimarySource(project, safeSettings);
    const inputPath = resolveMediaPathForSource(project, primarySource, container);

    pushJobDebug(job, 'resolve_media', {
      sourceId: primarySource?.id || null,
      hash: primarySource?.hash || null,
      originalName: primarySource?.originalName || null,
      inputPath,
    });

    if (!primarySource || !inputPath) {
      debugError('media_missing', {
        jobId: job.id,
        container,
        primarySource: primarySource
          ? {
              id: primarySource.id,
              originalName: primarySource.originalName,
              hash: primarySource.hash,
            }
          : null,
        candidates: primarySource
          ? getMediaCandidatePaths({
              hash: primarySource.hash,
              originalName: primarySource.originalName,
              container,
            })
          : [],
      });

      job.status = 'failed';
      job.error = 'media_missing';
      job.progress = 0;
      job.downloadPath = null;
      RUNNING_JOBS.delete(job.id);
      pruneOldJobs();
      scheduleNext();
      return;
    }

  const { width, height, fps, durationSeconds } = deriveRenderParams(project, safeSettings);

    if (width > EXTREME_MAX_DIMENSION || height > EXTREME_MAX_DIMENSION || durationSeconds > EXTREME_MAX_DURATION_SECONDS) {
      debugError('job_too_large', {
        jobId: job.id,
        width,
        height,
        fps,
        durationSeconds,
        EXTREME_MAX_DIMENSION,
        EXTREME_MAX_DURATION_SECONDS,
        approxUncompressedGB: approxUncompressedGB(width, height, fps, durationSeconds).toFixed(3),
      });

      job.status = 'failed';
      job.error = 'job_too_large';
      job.downloadPath = null;
      RUNNING_JOBS.delete(job.id);
      pruneOldJobs();
      scheduleNext();
      return;
    }

  if (width > SOFT_MAX_WIDTH || height > SOFT_MAX_HEIGHT) {
    console.warn('[dmosh-export-service] large resolution requested', { id: job.id, width, height });
  }

  if (durationSeconds > SOFT_MAX_DURATION_SECONDS) {
    console.warn('[dmosh-export-service] long duration requested', { id: job.id, durationSeconds });
  }

  const videoCodec = mapVideoCodec(safeSettings.videoCodec, container);
  const audioCodec = mapAudioCodec(safeSettings.audioCodec);

    // NOTE, IMPORTANT: Disable fast-path stream copy for now. The previous logic
      // only looked at *desired* output settings, not the *actual* input
      // codecs, which caused invalid MP4s (e.g. pcm_s24le in mp4) and
      // ffmpeg header failures. We can re-enable a smarter copy path
      // later by probing the input streams.
      const canCopy = false;

  pushJobDebug(job, 'ffmpeg_start', {
    container,
    inputPath,
    outputPath,
    width,
    height,
    fps,
    durationSeconds,
    videoCodec,
    audioCodec,
    canCopy,
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log('[dmosh-export-service] starting render', {
      id: job.id,
      container,
      inputPath,
      outputPath,
      width,
      height,
      fps,
      durationSeconds,
      videoCodec,
      audioCodec,
      canCopy,
    });
  }

  logMemory(`job ${job.id} start`);

  const command = ffmpeg(inputPath);
    let lastFfmpegCommandLine = null;
  const sourceRef = safeSettings.source || { kind: 'timeline' };
  let startSeconds = null;
  let clipDurationSeconds = null;

  if (sourceRef.kind === 'clip' && sourceRef.clipId && Array.isArray(project?.timeline?.clips)) {
    const clip = project.timeline.clips.find((c) => c.id === sourceRef.clipId);
    if (clip) {
      startSeconds = (clip.startFrame || 0) / fps;
      clipDurationSeconds = Math.max(0.1, (clip.endFrame - clip.startFrame + 1) / fps);
    }
  } else if (sourceRef.kind === 'timeline' && typeof sourceRef.inFrame === 'number' && typeof sourceRef.outFrame === 'number') {
    startSeconds = sourceRef.inFrame / fps;
    clipDurationSeconds = Math.max(0.1, (sourceRef.outFrame - sourceRef.inFrame + 1) / fps);
  }

  const needsScale =
    safeSettings.outputResolution === 'custom' ||
    (width !== project?.settings?.width || height !== project?.settings?.height) ||
    safeSettings.renderResolutionScale !== 1;

  if (needsScale) {
    command.videoFilters(`scale=${width}:${height}`);
  }

  if (safeSettings.fpsMode === 'override' && safeSettings.fps) {
    command.outputOptions(['-r', String(safeSettings.fps)]);
  }

  if (startSeconds !== null) {
    command.setStartTime(startSeconds);
  }
  if (clipDurationSeconds !== null) {
    command.setDuration(clipDurationSeconds);
  }

    if (canCopy && startSeconds === null && clipDurationSeconds === null) {
        // Fast path: copy video stream, but transcode audio so the MP4 muxer
        // never chokes on unsupported PCM variants (like pcm_s24le).
        command.outputOptions(['-c:v copy']);
    
        if (safeSettings.includeAudio === false || audioCodec === 'none') {
          command.noAudio();
        } else {
          // Re-encode audio to a container-safe codec (defaults to AAC).
          command.audioCodec(audioCodec);
        }
      } else {
    command.videoCodec(videoCodec);

    const pixelFormat = safeSettings.pixelFormat || 'yuv420p';
    const outputOptions = [`-pix_fmt ${pixelFormat}`];

    if (safeSettings.rateControl?.mode === 'crf' && typeof safeSettings.rateControl.value === 'number') {
      outputOptions.push(`-crf ${safeSettings.rateControl.value}`);
    } else if (safeSettings.rateControl?.mode === 'bitrate' && typeof safeSettings.rateControl.kbps === 'number') {
      outputOptions.push(`-b:v ${safeSettings.rateControl.kbps}k`);
    }

    if (audioCodec === 'none' || safeSettings.includeAudio === false) {
      command.noAudio();
    } else {
      command.audioCodec(audioCodec);
    }

    command.outputOptions(outputOptions);
  }

  command
    .on('start', (cmdLine) => {
      lastFfmpegCommandLine = cmdLine;
      if (IS_DEV) {
        debugLog('ffmpeg_start', {
          jobId: job.id,
          cmdLine,
          inputPath,
          outputPath,
          container,
          width,
          height,
          fps,
          durationSeconds,
          videoCodec,
          audioCodec,
          canCopy,
        });
      }
    })
    .on('stderr', (line) => {
          // Streaming ffmpeg stderr into both server logs and job.debug
          debugLog('ffmpeg_stderr', {
            jobId: job.id,
            line,
          });
          pushJobDebug(job, 'ffmpeg_stderr', line);
        })
    .on('progress', (progress) => {
      if (!JOBS.has(job.id)) {
        try {
          command.kill('SIGKILL');
        } catch (_) {}
        return;
      }
      const pct = typeof progress.percent === 'number' ? progress.percent : Math.min(99, job.progress + 1);
      job.progress = Math.max(job.progress, Math.min(100, Math.round(pct)));
    })
    .on('error', (err, stdout, stderr) => {
      job.status = 'failed';
      job.error = err?.code || err?.message || 'ffmpeg_error';
      job.progress = 0;

      debugError('ffmpeg_error', {
        jobId: job.id,
        errorMessage: err?.message,
        errorCode: err?.code,
        ffmpegCommand: lastFfmpegCommandLine,
        stdout: stdout && stdout.slice ? stdout.slice(0, 2000) : stdout,
        stderr: stderr && stderr.slice ? stderr.slice(0, 2000) : stderr,
      });

        pushJobDebug(job, 'ffmpeg_error', {
                errorMessage: err?.message || null,
                errorCode: err?.code || null,
                ffmpegCommand: lastFfmpegCommandLine,
                stdout: stdout && stdout.slice ? stdout.slice(0, 2000) : stdout,
                stderr: stderr && stderr.slice ? stderr.slice(0, 2000) : stderr,
              });

      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch (_) {}

      logMemory(`job ${job.id} end`);

      RUNNING_JOBS.delete(job.id);
      pruneOldJobs();
      scheduleNext();
    })
    .on('end', () => {
      job.status = 'complete';
      job.progress = 100;

      pushJobDebug(job, 'ffmpeg_complete', {
        outputPath,
      });

      debugLog('ffmpeg_complete', { jobId: job.id, outputPath });

      logMemory(`job ${job.id} end`);

      RUNNING_JOBS.delete(job.id);
      pruneOldJobs();
      scheduleNext();
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
    debug: [],
  };

  JOBS.set(id, job);
    debugLog('create_job', {
      jobId: id,
      container: job.container,
      clientVersion,
      runningJobs: RUNNING_JOBS.size,
      queueLength: QUEUE.length,
    });

  if (RUNNING_JOBS.size < MAX_CONCURRENT_JOBS) {
    setImmediate(() => startRenderJob(job, project || {}, safeSettings));
  } else if (QUEUE.length < MAX_QUEUE_LENGTH) {
    QUEUE.push({ jobId: id, project: project || {}, settings: safeSettings });
  } else {
    job.status = 'failed';
    job.error = 'over_capacity';
    job.progress = 0;
  }

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
  // exporting helpers for potential external use/testing
  resolveMediaPathForSource,
  getMediaCandidatePaths,
};
