// Ollama vision-model checks. Used as a second layer on top of the
// browser-side face descriptor match.
const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5vl:32b';
// require = fail closed if Ollama is unreachable; off = skip Ollama checks
const MIN_CONFIDENCE = Number(process.env.OLLAMA_MIN_CONFIDENCE || 70);
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '1h';
const MODE = process.env.OLLAMA_MODE || 'require';

const b64 = (dataUrl) => dataUrl.replace(/^data:image\/\w+;base64,/, '');

async function ask(prompt, images) {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      keep_alive: KEEP_ALIVE,
      format: 'json',
      // Small context keeps a 32B model fully on the GPU (default 32k spills to CPU on 36GB).
      options: { temperature: 0, num_ctx: 4096 },
      messages: [{ role: 'user', content: prompt, images: images.map(b64) }],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.message.content);
}

async function guarded(fn) {
  if (MODE === 'off') return { ok: true, skipped: true };
  try {
    return await fn();
  } catch (e) {
    console.error('[ollama]', e.message);
    return { ok: false, reason: `Ollama check failed (${e.message}). Is Ollama running with ${MODEL}?` };
  }
}

// Enrollment: exactly one real, live, clearly visible face.
export const checkEnrollment = (image) =>
  guarded(async () => {
    const r = await ask(
      'You are a face-enrollment quality checker. Look at the image. Reply ONLY with JSON: ' +
        '{"one_face": boolean, "clear": boolean, "looks_like_photo_of_screen_or_print": boolean}. ' +
        'one_face = exactly one human face. clear = face unobstructed (no mask/sunglasses) and well lit.',
      [image],
    );
    if (!r.one_face) return { ok: false, reason: 'Exactly one face must be visible.' };
    if (!r.clear) return { ok: false, reason: 'Face is not clear. Remove masks/sunglasses and improve lighting.' };
    if (r.looks_like_photo_of_screen_or_print) return { ok: false, reason: 'Looks like a photo of a screen or print.' };
    return { ok: true };
  });

// Login: same person as enrolled image, and not a spoof.
export const checkSamePerson = (enrolledImage, liveImage) =>
  guarded(async () => {
    const r = await ask(
      'Image 1 is an enrolled reference photo. Image 2 is a live camera capture. ' +
        'Compare the facial structure (eye shape and spacing, nose, mouth, jawline, face shape, brows) of the two people. ' +
        'Ignore lighting, image quality, rotation, expression, hair and background. ' +
        'Reply ONLY with JSON: {"same_person": boolean, "confidence": integer 0-100, "looks_like_photo_of_screen_or_print": boolean}. ' +
        'confidence = how sure you are that both images show the same individual.',
      [enrolledImage, liveImage],
    );
    if (r.looks_like_photo_of_screen_or_print) return { ok: false, reason: 'Spoof suspected (photo of screen/print).' };
    if (!r.same_person || Number(r.confidence) < MIN_CONFIDENCE) return { ok: false, reason: 'Face did not match.' };
    return { ok: true };
  });

// Load the model into memory ahead of the first request (cold load can take 30s+).
export async function warmup() {
  if (MODE === 'off') return;
  try {
    await fetch(`${HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: KEEP_ALIVE, options: { num_ctx: 4096 } }),
    });
  } catch (e) { console.error('[ollama] warmup failed:', e.message); }
}

export const ollamaInfo = { HOST, MODEL, MODE };
