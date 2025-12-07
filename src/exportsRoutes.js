const express = require('express');
const fs = require('fs');
const { createJob, getJob } = require('./jobs');

const IS_DEV = process.env.NODE_ENV !== 'production';

const router = express.Router();

router.post('/', (req, res) => {
  const { project, settings, clientVersion } = req.body || {};

  if (!settings || !settings.container || !settings.videoCodec) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const job = createJob({ project, settings, clientVersion });
  return res.status(201).json({ jobId: job.id });
});

router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'not_found' });
  }

  return res.json({
    id: job.id,
    status: job.status,
    progress: typeof job.progress === 'number' ? job.progress : null,
    error: job.error,
    downloadUrl: job.downloadPath ? `/exports/${job.id}/download` : null,
    debug: IS_DEV ? job.debug || [] : undefined,
  });
});

router.get('/:id/download', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'complete' || !job.downloadPath || !fs.existsSync(job.downloadPath)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const container = job.container || 'mp4';
  const mimeTypes = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
  };
  res.type(mimeTypes[container] || 'application/octet-stream');

  const filename = `dmosh-${job.id}.${container}`;
  return res.download(job.downloadPath, filename);
});

module.exports = router;
