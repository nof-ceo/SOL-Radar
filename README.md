# SOL Radar (macOS)
Требуется Node.js 18+.

    npm install
    npm start          # запуск
    npm run dist       # сборка .dmg в папке dist/

Необязательно: скопируйте config.example.json в config.json и заполните
xBearer (X API), discordToken + discordChannels (Discord-бот с доступом к каналам).
Без них приложение работает на биржах, DexScreener, RugCheck, Reddit и новостях.
