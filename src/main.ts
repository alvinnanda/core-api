import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import fastifyCors from '@fastify/cors';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: true,
      bodyLimit: 30 * 1024 * 1024, // 30MB
      maxParamLength: 5000
    })
  );
  
  app.setGlobalPrefix('api');

  // Use environment variables for CORS configuration
  const frontendUrl = process.env.FRONTEND_URL || 'http://192.168.1.19:3000';
  
  // Updated CORS configuration
  await app.register(fastifyCors, {
    origin: [frontendUrl],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Origin', 
      'X-Requested-With',
      'Accept',
      'Content-Type', 
      'Authorization',
      'Cache-Control'
    ],
    exposedHeaders: [
      'Content-Type',
      'Cache-Control',
      'Content-Length',
      'Access-Control-Allow-Origin',
      'Access-Control-Allow-Headers',
      'Access-Control-Allow-Credentials'
    ],
    credentials: true,
    preflight: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
  });

  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true
  }));

  const port = parseInt(process.env.PORT, 10) || 3030;
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
