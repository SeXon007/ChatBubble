const { copyFileSync, mkdirSync } = require('node:fs');
mkdirSync('dist/ui', { recursive: true });
mkdirSync('dist/assets', { recursive: true });
mkdirSync('dist/native', { recursive: true });
copyFileSync('src/native/window-target.ps1', 'dist/native/window-target.ps1');
copyFileSync('src/native/window-frame.cs', 'dist/native/window-frame.cs');
copyFileSync('src/native/install-update.ps1', 'dist/native/install-update.ps1');
copyFileSync('src/assets/app.ico', 'dist/assets/app.ico');
for (const file of ['index.html', 'style.css', 'settings.html', 'settings.css', 'pet.js']) copyFileSync(`src/ui/${file}`, `dist/ui/${file}`);
