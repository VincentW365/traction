import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { validateEnv } from '@bsop/config';

async function bootstrap() {
  const env = validateEnv(process.env);

  const app = await NestFactory.create(AppModule);

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
