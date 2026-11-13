# Celilsemi Sam Erkiner Personal Application

This progressive web application is a personal page demo built with the Ionic Framework and Angular Framework intended to run on an Apache Server with LAMP Stack.

## Table of Contents
- [Getting Started](#getting-started)
- [Deploying as Progressive Web App](#deploying-as-progressive-web-app)


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

The hosting document root is shared with WordPress, the blog and the API. Use targeted file uploads into `app/`; do not use a whole-site archive deployment or replace the document root. Preserve the existing server redirects and the canonical URL and migration cleanup in `src/index.html`.
