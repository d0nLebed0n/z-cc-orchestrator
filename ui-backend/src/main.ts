import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { PORT, HOST, WEB_ORIGIN } from "./config";
import { Logger } from "@nestjs/common";

async function bootstrap(): Promise<void> {
  const logger = new Logger("UI-Backend");
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.enableCors({
    origin: WEB_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE"],
  });

  // Гарантируем, что SSE-соединения закрываются корректно.
  app.enableShutdownHooks();

  // Bind на localhost по умолчанию (review #1): API запускает агентов над
  // локальными репозиториями и не должен быть доступен по сети без аутентификации.
  // CORS ограничивает браузерные запросы, но НЕ является аутентификацией и не
  // мешает прямым HTTP-запросам. Remote-режим — только через явный HOST=0.0.0.0.
  await app.listen(PORT, HOST);
  const display = HOST === "0.0.0.0" ? `0.0.0.0:${PORT} (all interfaces — remote mode)` : `${HOST}:${PORT}`;
  logger.log(`listening on http://${display} (CORS for ${WEB_ORIGIN})`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
