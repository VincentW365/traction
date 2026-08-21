import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { validateEnv } from '@bsop/config';

async function bootstrap() {
  const env = validateEnv(process.env);

  const app = await NestFactory.create(AppModule);

  // CR-2026-087 — inspection photos and drawn signatures are posted as base64 data
  // URLs in the JSON body (there is no object store in this deployment, and Render's
  // free plan has no persistent disk). Express defaults to a 100 kB limit, which a
  // tablet photo blows past long before any DTO validation runs, producing an opaque
  // 413. The client downscales to roughly 150-300 kB; 8 MB leaves generous headroom
  // without inviting genuinely large uploads.
  app.use(json({ limit: '8mb' }));
  app.use(urlencoded({ extended: true, limit: '8mb' }));

  app.setGlobalPrefix('api/v1');

  // Allow one or more web origins. A single value preserves prior behavior; a
  // comma-separated list (e.g. localhost + LAN IPs for dev access from other
  // devices) is parsed into a trimmed array.
  const corsOrigin = env.API_CORS_ORIGIN.includes(',')
    ? env.API_CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : env.API_CORS_ORIGIN;

  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Bert's Service Operations Platform API")
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Cloud hosts (Render, Railway, etc.) assign the port via $PORT; fall back to
  // API_PORT locally. Bind 0.0.0.0 so the platform can route to it.
  const port = Number(process.env.PORT) || env.API_PORT;
  await app.listen(port, '0.0.0.0');
  console.warn(`BSOP API running on port ${port} (base path /api/v1)`);
  console.warn(`Swagger docs at /api/docs`);
}

bootstrap();
