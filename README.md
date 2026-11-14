# Sam Erkiner Personal Application

This progressive web application is a personal page demo built with the Ionic Framework and Angular Framework intended to run on an Apache Server with LAMP Stack.

## Table of Contents
- [Getting Started](#getting-started)
- [Deploying as Progressive Web App](#deploying-as-progressive-web-app)
- [Checking Changes](#checking-changes)


## Getting Started

Use Node 24 (managed by nvm):

```sh
nvm install
nvm use
npm ci
npm start
```

Open http://localhost:4200. The local server reloads when source files change.

## Deploying as Progressive Web App

1. Run `npm run build -- --configuration production`
2. Upload the generated `app/` files to `public_html/app/` on the Hostinger website `erkiner.com`. The public address is https://sam.erkiner.com/app/.
3. Upload supporting assets first, then `index.html` and finally `ngsw.json`. Retain previous hashed assets so existing visitors can finish using their cached version.
4. Verify the live page and service-worker resources after uploading. The deployment target is recorded in `.hostinger/site.json`.

GitHub Actions deploys validated builds after successful `master` push validation.
Set the four repository FTP secrets described in
[the deployment guide](.github/HOSTINGER_DEPLOYMENT.md). No variables are needed.
The guide also covers the optional connection check, retries and rollback.

The hosting document root is shared with WordPress, the blog and the API. Use targeted file uploads into `app/`; do not use a whole-site archive deployment or replace the document root. Preserve the existing server redirects and the canonical URL and migration cleanup in `src/index.html`.

## Checking Changes

Autonomous issue investigation, PR review and bounded CI repair are configured in
GitHub Actions. See [.github/CODEX_AUTOMATION.md](.github/CODEX_AUTOMATION.md) for
subscription credential setup, security boundaries and tests. All issues and PRs
are investigated automatically regardless of creator or repository visibility.
Failed CI starts repair on repository-owned feature branches automatically.

Use Node 24 from `.nvmrc` (`nvm install && nvm use`). Install the locked dependencies
and the single browser used by both test suites:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npx playwright install --no-shell chromium
```

On Linux, use `npx playwright install --with-deps --no-shell chromium` to also install
the browser's system dependencies. Python 3 is needed for the local test server.

Run the same checks as CI:

```sh
npm run build -- --configuration=production
npm run test:ci
npm run e2e
```

The browser suite serves the generated `app/` directory at
`http://127.0.0.1:4173/app/`. Build first; the suite never tests the development
server or deploys to production. It checks the biography, loaded profile image,
desktop navigation, and both mobile menus in headless Chromium. JavaScript errors,
console errors, and failed local asset requests fail the suite. Browser contexts
are isolated and tests have no automatic retries or screenshot comparisons.

On failure, screenshots, traces, and an HTML report are written under
`output/playwright/`. View the report with
`npx playwright show-report output/playwright/report`. GitHub retains failure
diagnostics for seven days.

The `CI` workflow runs `Validate app` on PRs targeting `master`, pushes to `master`,
and manual runs. New PR commits replace superseded runs. The repository's active
`master` ruleset requires this GitHub Actions check to pass against the current
base branch, requires a PR, blocks force pushes and deletion, and has no bypass
actors or required human approvals. These repository settings are managed in
GitHub, separately from this workflow. Green means the defined checks passed;
it does not cover other browser engines, native builds, or the WordPress theme.
