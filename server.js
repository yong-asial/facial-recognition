import { createApp, FACE_THRESHOLD } from './app.js';

const PORT = process.env.PORT || 3009;
createApp(process.env.DB_PATH ? { dbPath: process.env.DB_PATH } : {}).listen(PORT, () =>
  console.log(`http://localhost:${PORT}  (face threshold ${FACE_THRESHOLD})`));
