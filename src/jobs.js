const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { runExport } = require('./ffmpegRunner');

const jobs = new Map();
const jobInputs = new Map();
let currentJobId = null;

const cleanupStatuses = new Set(['complete', 'failed', 'cancelled']);

function getJob(jobId) {
  return jobs.get(jobId);
}

function getDownloadPath(jobId) {
  const job = getJob(jobId);
  return job && job.downloadPath ? job.downloadPath : undefined;
}

function cleanupOldJobs() {
  const oneHour = 60 * 60 * 1000;
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (cleanupStatuses.has(job.status) && now - job.createdAt > oneHour) {
      if (job.downloadPath && fs.existsSync(job.downloadPath)) {
        try {
          fs.unlinkSync(job.downloadPath);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`Failed to delete file for job ${jobId}:`, error.message);
        }
      }
      jobs.delete(jobId);
      jobInputs.delete(jobId);
      if (currentJobId === jobId) {
        currentJobId = null;
      }
    }
  }
}

async function processNextJob() {
  if (currentJobId !== null) {
    return;
  }

  const nextEntry = [...jobs.entries()].find(([, job]) => job.status === 'queued');
  if (!nextEntry) {
    return;
  }

  const [jobId, job] = nextEntry;
  const { project, settings } = jobInputs.get(jobId) || {};

  currentJobId = jobId;
  job.status = 'rendering';
  job.progress = 0;

  try {
    const { outputPath } = await runExport(job, project || {}, settings || {});
    job.status = 'complete';
    job.progress = 100;
    job.downloadPath = outputPath;
    job.container = (settings && settings.container) || 'mp4';
  } catch (error) {
    job.status = 'failed';
    job.error = error?.message || 'export_failed';
  } finally {
    currentJobId = null;
    processNextJob();
  }
}

function enqueue(jobId) {
  if (currentJobId === null) {
    processNextJob();
  }
}

function createJob({ project, settings, clientVersion }) {
  const jobId = uuidv4();
  const job = {
    id: jobId,
    createdAt: Date.now(),
    status: 'queued',
    progress: 0,
    clientVersion,
  };

  jobs.set(jobId, job);
  jobInputs.set(jobId, { project, settings });
  enqueue(jobId);

  return job;
}

setInterval(cleanupOldJobs, 5 * 60 * 1000);

module.exports = {
  createJob,
  getJob,
  getDownloadPath,
  enqueue,
  processNextJob,
};
