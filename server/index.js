import { createApp } from './app.js';

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Для сервера нужен Node.js 22 или новее');
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть от 1024 до 65535');
  const server = createApp();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Выберите другой порт приложения.` : 'Не удалось запустить сервер');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`TKO: сервер запущен на 127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
