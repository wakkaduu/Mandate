// Vercel entry point: the whole Express app runs as one serverless function (see vercel.json rewrites).
// Needs a remote database (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN): Vercel's filesystem is ephemeral.
import { createApp } from '../src/server.js';

export default createApp();
