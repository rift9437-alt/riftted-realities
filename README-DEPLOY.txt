RIFTTED REALITIES — deploy notes
================================

Files needed on Render:
  index.html
  server.js
  package.json

Environment variables (Render):
  DATABASE_URL      Neon Postgres connection string (required)
  SESSION_SECRET    long random string (required in production)
  ADMIN_USERNAME    optional — creates first admin if missing
  ADMIN_PASSWORD    optional — min 10 characters
  NODE_ENV=production
  PORT              set by Render

Start command:
  npm start

Games: 17 total (including Clean Sweep #16 and Card Base War).
All game code is embedded inside index.html as data-game script blocks.
No games/ folder.

Clean Sweep saves progress in the browser (localStorage) for now.
Account-linked saves can be added later via existing /api routes.
