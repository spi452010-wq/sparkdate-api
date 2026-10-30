import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import authRoutes from './modules/auth/auth.routes';
import profileRoutes from './modules/profile/profile.routes';
import mediaRoutes from './modules/media/media.routes';
import adminRoutes from './modules/admin/admin.routes';
import adminAuthRoutes from './modules/admin/adminAuth.routes';
import adminEventRoutes from './modules/events/adminEvents.routes';
import { errorHandler } from './middleware/error';
import { AppError } from './utils/errors';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/profile', profileRoutes);
  app.use('/api/v1/media', mediaRoutes);
  app.use('/api/v1/admin/auth', adminAuthRoutes);
  app.use('/api/v1/admin/events', adminEventRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND')));
  app.use(errorHandler);
  return app;
}
