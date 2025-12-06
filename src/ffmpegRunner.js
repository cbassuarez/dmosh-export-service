const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const codecMap = {
  h264: 'libx264',
  h265: 'libx265',
  vp9: 'libvpx-vp9',
};

const allowedContainers = new Set(['mp4', 'mov', 'webm', 'mkv']);

function sanitizeContainer(container) {
  if (container && allowedContainers.has(container)) {
    return container;
  }
  return 'mp4';
}

function sanitizeCodec(videoCodec) {
  const normalized = videoCodec || 'h264';
  return codecMap[normalized] || codecMap.h264;
}

function buildOutputPath(jobId, container) {
  const safeContainer = sanitizeContainer(container);
  return path.join(os.tmpdir(), `dmosh-${jobId}.${safeContainer}`);
}

function computeDurationSeconds(settings) {
  if (!settings || typeof settings !== 'object') {
    return 5;
  }

  const fps = Number.isFinite(settings.fps) && settings.fps > 0 ? settings.fps : 24;

  let frameCount = null;
  const source = settings.source;

  if (source && typeof source === 'object') {
    const { inFrame, outFrame } = source;
    if (
      typeof inFrame === 'number' &&
      typeof outFrame === 'number' &&
      Number.isFinite(inFrame) &&
      Number.isFinite(outFrame) &&
      outFrame >= inFrame
    ) {
      frameCount = outFrame - inFrame + 1;
    }
  }

  let durationSeconds;

  if (frameCount && frameCount > 0) {
    durationSeconds = frameCount / fps;
  } else {
    durationSeconds = 5;
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = 5;
  }

  const minSeconds = 0.5;
  const maxSeconds = 60;
  durationSeconds = Math.min(maxSeconds, Math.max(minSeconds, durationSeconds));

  return durationSeconds;
}

function executeRender(job, { width, height, fps, container, codec, durationSeconds }) {
  const outputPath = buildOutputPath(job.id, container);
  if (fs.existsSync(outputPath)) {
    try {
      fs.unlinkSync(outputPath);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`Unable to remove existing output for job ${job.id}:`, error.message);
    }
  }

  return new Promise((resolve, reject) => {
    const args = [`-pix_fmt yuv420p`, '-an'];
    if (container === 'mp4' || container === 'mov') {
      args.push('-movflags +faststart');
    }

    const durationStr = durationSeconds.toFixed(3);
    const colorInput = `color=c=black:s=${width}x${height}:r=${fps}:d=${durationStr}`;

    ffmpeg()
      .input(colorInput)
      .inputFormat('lavfi')
      .videoCodec(codec)
      .fps(fps)
      .duration(durationSeconds)
      .outputOptions(args)
      .format(container)
      .on('progress', (progress) => {
        if (typeof progress.percent === 'number') {
          job.progress = Math.max(0, Math.min(100, Math.round(progress.percent)));
        } else if (!job.progress || job.progress < 50) {
          job.progress = 50;
        }
      })
      .on('error', (error) => {
        const message = error?.message || 'ffmpeg_error';
        reject(new Error(message));
      })
      .on('end', () => {
        job.progress = 100;
        resolve({ outputPath });
      })
      .save(outputPath);
  });
}

async function runExport(job, project, settings) {
  const {
    width: settingsWidth,
    height: settingsHeight,
    fps: settingsFps,
    source: settingsSource,
    fileName,
    container,
    videoCodec,
    audioCodec,
  } = settings || {};

  const width = Number.isFinite(settingsWidth) && settingsWidth > 0 ? settingsWidth : 640;
  const height = Number.isFinite(settingsHeight) && settingsHeight > 0 ? settingsHeight : 360;
  const fps = Number.isFinite(settingsFps) && settingsFps > 0 ? settingsFps : 24;
  const renderDuration = computeDurationSeconds({ fps, source: settingsSource });
  const safeContainer = sanitizeContainer(container);
  const desiredCodec = sanitizeCodec(videoCodec);

  try {
    return await executeRender(job, {
      width,
      height,
      fps,
      container: safeContainer,
      codec: desiredCodec,
      durationSeconds: renderDuration,
    });
  } catch (error) {
    if (desiredCodec === 'libx265') {
      // Attempt fallback if libx265 is unavailable
      job.progress = 0;
      return executeRender(job, {
        width,
        height,
        fps,
        container: safeContainer,
        codec: codecMap.h264,
        durationSeconds: renderDuration,
      });
    }
    throw error;
  }
}

module.exports = {
  runExport,
  computeDurationSeconds,
};
