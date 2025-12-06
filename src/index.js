const express = require('express');
const cors = require('cors');

if (process.env.NODE_ENV !== 'production') {
  // Load environment variables from .env in non-production environments
  // eslint-disable-next-line global-require
  require('dotenv').config();
}

const EXPORT_AUTH_TOKEN = process.env.EXPORT_AUTH_TOKEN;
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const PORT = process.env.PORT || 4000;

if (!EXPORT_AUTH_TOKEN || !CORS_ORIGIN) {
  // eslint-disable-next-line no-console
  console.error('Missing required environment variables: EXPORT_AUTH_TOKEN and CORS_ORIGIN are required');
  process.exit(1);
}

const exportsRouter = require('./exportsRoutes');

const app = express();

app.use(express.json({ limit: '500mb' }));
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Export-Token'],
  }),
);

const authMiddleware = (req, res, next) => {
  const token = req.get('X-Export-Token');
  if (!token || token !== EXPORT_AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
};

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/exports', authMiddleware, exportsRouter);

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`dmosh-export-service listening on port ${PORT}`);
});
