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

  await app.listen(env.API_PORT);
  console.warn(
    `BSOP API running on http://localhost:${env.API_PORT}/api/v1`,
  );
  console.warn(
    `Swagger docs at http://localhost:${env.API_PORT}/api/docs`,
  );
}

bootstrap();
