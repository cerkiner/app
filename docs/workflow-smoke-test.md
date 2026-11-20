# Workflow smoke test

Sam Erkiner’s personal page is a progressive web app built with Ionic and Angular for deployment on an Apache server.

Run these npm scripts in order to build the app and run the same test suites as CI.

1. `npm run build -- --configuration=production` creates the production build in `app/`.
2. `npm run test:ci` runs the Angular unit tests once in headless Chrome with the CI configuration.
3. `npm run e2e` runs Playwright against the production build in headless Chromium, checking the biography, profile image, and desktop and mobile navigation.
