# Workflow smoke test

Sam Erkiner's personal page is a progressive web app built with Ionic and Angular for deployment on an Apache server.

Run these commands in order from the repository root.

- `npm run build -- --configuration=production` uses the Angular CLI to create the production build in `app/`.
- `npm run test:ci` runs the Angular unit tests once in headless Chromium with the CI configuration and watch mode disabled.
- `npm run e2e` runs Playwright against the production build in headless Chromium. It checks the biography, profile image, desktop navigation, and mobile menus.
