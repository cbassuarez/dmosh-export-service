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

function executeRender(job, { width, height, fps, container, codec }) {
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

    ffmpeg()
      .input(`color=c=black:s=${width}x${height}:r=${fps}:d=1.0`)
      .inputFormat('lavfi')
      .videoCodec(codec)
      .fps(fps)
      .duration(1.0)
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
  const width = settings.width ?? 640;
  const height = settings.height ?? 360;
  const fps = settings.fps ?? 24;
  const container = sanitizeContainer(settings.container);
  const desiredCodec = sanitizeCodec(settings.videoCodec);

  try {
    return await executeRender(job, { width, height, fps, container, codec: desiredCodec });
  } catch (error) {
    if (desiredCodec === 'libx265') {
      // Attempt fallback if libx265 is unavailable
      job.progress = 0;
      return executeRender(job, { width, height, fps, container, codec: codecMap.h264 });
    }
    throw error;
  }
}

module.exports = {
  runExport,
};
