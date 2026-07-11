import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { PORT, WEB_ORIGIN } from "./config";
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

  await app.listen(PORT);
  logger.log(`listening on http://localhost:${PORT} (CORS for ${WEB_ORIGIN})`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
