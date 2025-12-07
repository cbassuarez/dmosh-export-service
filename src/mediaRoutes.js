const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const multer = require('multer');
const { getMediaCandidatePaths } = require('./jobs');

const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(os.tmpdir(), 'dmosh-media');
if (!fs.existsSync(MEDIA_ROOT)) {
  fs.mkdirSync(MEDIA_ROOT, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, MEDIA_ROOT);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ext = path.extname(file.originalname || '');
    cb(null, `upload-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
});

const router = express.Router();

function safeBaseName(name) {
  if (!name) return null;
  return path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function deduceExtension(originalName, mimetype) {
  const safeName = safeBaseName(originalName);
  let ext = '';

  if (safeName) {
    ext = path.extname(safeName);
  }

  if (!ext) {
    const map = {
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
      'video/x-matroska': '.mkv',
    };
    ext = map[mimetype] || '';
  }

  return ext;
}

async function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

router.post('/upload', upload.single('file'), async (req, res, next) => {
  const file = req.file;
  const { hash, originalName } = req.body || {};

  if (!file || !hash) {
    if (file?.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (_) {}
    }
    return res.status(400).json({ error: 'invalid_request', details: 'file and hash are required' });
  }

  try {
    const computed = await computeFileHash(file.path);
    if (computed !== hash) {
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch (_) {}
      return res.status(400).json({ error: 'hash_mismatch' });
    }

    const ext = deduceExtension(originalName, file.mimetype);
    const finalPath = path.join(MEDIA_ROOT, `${hash}${ext}`);

    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) {
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch (_) {}
      return res.status(200).json({ ok: true, hash, cached: true, path: `/media-root/${path.basename(finalPath)}` });
    }

    fs.renameSync(file.path, finalPath);

    return res.status(201).json({ ok: true, hash, cached: false, path: `/media-root/${path.basename(finalPath)}` });
  } catch (err) {
    try {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}
    return next(err);
  }
});

if (process.env.NODE_ENV !== 'production') {
  router.get('/debug/:hash', (req, res) => {
    const { hash } = req.params;
    const { originalName, container } = req.query;
    const candidates = getMediaCandidatePaths({ hash, originalName, container });
    const info = candidates.map((p) => {
      const exists = fs.existsSync(p);
      const stats = exists ? fs.statSync(p) : null;
      return {
        path: p,
        exists,
        size: stats?.size || 0,
        mtime: stats?.mtime?.toISOString() || null,
      };
    });
    res.json({ hash, candidates: info });
  });
}

module.exports = router;
