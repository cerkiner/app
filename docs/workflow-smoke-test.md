# Workflow smoke test

Sam Erkiner's personal site is a progressive web app built with Ionic and
Angular for deployment on an Apache server.

Run these npm commands from the repository root in order to follow the CI checks:

1. `npm run build -- --configuration=production` builds the production app with
   the Angular CLI and writes the deployable files to `app/`.
2. `npm run test:ci` runs Angular unit tests once in headless Chrome with the CI
   configuration and watch mode disabled.
3. `npm run e2e` runs Playwright tests in headless Chromium against the production
   build, checking the biography, profile image, and desktop and mobile navigation.
